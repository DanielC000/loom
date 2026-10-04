/**
 * Loom Companion — the DB-backed RUN-config layer (Companion epic Phase 3, generalized to MULTI-companion
 * by the multi-companion runtime card). Bridges the env-only spike config (`config.ts` › readCompanionConfig)
 * and the durable `companion_config` DB row so a human can configure one or more companions WITHOUT editing
 * a .env and restarting.
 *
 * Two responsibilities:
 *   1. `resolveAllCompanionConfigs` — the BOOT resolver. Env (LOOM_COMPANION_*) is the BOOTSTRAP/override: if
 *      set, it SEEDS/overrides the DB row (token encrypted) BEFORE the gateway is built, then every ENABLED
 *      row's effective CompanionConfig is built (side-effect-free — see `resolveAllEnabledConfigs`) — so env
 *      wins per the PL ruling, and a REST-configured companion with no env still comes up. No env + no
 *      enabled rows ⇒ empty array (OFF, byte-identical to today).
 *   2. `maskCompanionConfig` — the REST masking edge. Turns a stored row (with the ENCRYPTED blob) into the
 *      human-facing CompanionConfigMasked: `configured:true` + the token's last 4 only, NEVER the token.
 *
 * SECURITY (load-bearing): the plaintext bot token exists only transiently — encrypted at rest via the
 * envelope helper (AES-256-GCM, LOOM_HOME key file), decrypted here only to hand the live gateway a token
 * to call Telegram or to derive the masked last-4. It is NEVER logged and NEVER returned in clear.
 *
 * Home is NOT stored in the config row — it stays in app_meta, PER SESSION (get/setCompanionHome(sessionId)),
 * with `resolveAllEnabledConfigs` resolving each row's OWN home.
 * @decision e849a487 — never reintroduce a single, daemon-wide home lookup here: every row must resolve
 * its own home from its own session id, or multi-companion messages cross-deliver to the wrong owner.
 */
import { createHash } from "node:crypto";
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import { readCompanionConfig, DEFAULT_HEARTBEAT_PROMPT, type CompanionConfig } from "./config.js";
import { TELEGRAM_CHANNEL } from "./telegram.js";
import { isLikelyGroupTelegramChatId, isNonNumericTelegramChatId } from "./types.js";
import { companionRouteBlockReason } from "./reconcile.js";
import type { CompanionConfigRow } from "../db.js";
import type { CompanionConfigMasked, CompanionRoute } from "@loom/shared";

/** The narrow db surface the resolver needs — the run-config accessors + the app_meta home store. */
export interface CompanionConfigStore {
  listCompanionConfigs(): CompanionConfigRow[];
  getCompanionConfig(sessionId: string): CompanionConfigRow | undefined;
  upsertCompanionConfig(input: {
    sessionId: string; botTokenBlob: string; channel: string; allowedChatId: string;
    chatScope: "dm" | "group"; heartbeatIntervalMinutes: number; heartbeatPrompt: string | null; enabled: boolean;
    provisioned?: boolean;
    name?: string;
    bindingsSeeded?: boolean;
  }): CompanionConfigRow;
  getCompanionHome(sessionId: string): CompanionRoute | null;
  setCompanionHome(sessionId: string, home: CompanionRoute): void;
  /** card 1b0df437 / ddf08614: the boot-time stale-home check below needs a session's live bindings to run
   *  the SAME `companionRouteBlockReason` decision `ChatGateway.deliveryBlockReason` runs (scope AND
   *  flaggedNonPrivate included, unlike `reconcile.ts`'s narrower `CompanionRouteReconcileStore` surface). */
  getCompanionBindingsForSession(sessionId: string): { channel: string; chatId: string; scope: "dm" | "group"; flaggedNonPrivate?: boolean }[];
  /** Narrowed session read (home-collision heartbeat de-dup, below) — most callers pass the real `Db`,
   *  whose `getSession` returns the full `Session`; only these fields are used here. `processState` +
   *  `archivedAt` gate LIVENESS (a dead-but-still-enabled companion must never win/suppress in the
   *  home-collision guard — see `isLiveSession`); `ctxTurns`/`createdAt` break ties among live members;
   *  `agentId` backs the same-agent collision guard (`findEnabledAgentCollision` below). */
  getSession(sessionId: string): { ctxTurns?: number | null; createdAt: string; processState: string; archivedAt?: string | null; agentId?: string } | undefined;
}

/**
 * Build the effective CompanionConfig set for boot from the DB, with env as bootstrap/override. Returns an
 * empty array when neither env nor any enabled DB row configures a companion — the OFF path is
 * byte-identical to today. A row whose token blob can't be decrypted (corrupt / wrong key) is dropped with
 * a warning, never a crash. `keyPath` overrides the envelope key file (test seam only).
 *
 * This is the BOOT resolver: it performs the env BOOTSTRAP write (seed/override the DB row + lay the home)
 * and then reads back every enabled config via `resolveAllEnabledConfigs`. The hot-lifecycle controller uses
 * the side-effect-FREE `resolveAllEnabledConfigs` directly (a live REST reconcile must NOT re-bootstrap env).
 */
export function resolveAllCompanionConfigs(
  db: CompanionConfigStore,
  env: NodeJS.ProcessEnv,
  keyPath?: string,
): CompanionConfig[] {
  const envCfg = readCompanionConfig(env);
  // The env spike path ALWAYS carries a token (readCompanionConfig returns null without one — the in-app-only
  // tokenless companion is a DB-provision-only shape, never an env config), so envCfg.botToken is non-null here.
  if (envCfg && envCfg.botToken) {
    // Env bootstrap/override: seed/override the DB row from env BEFORE the gateway is built (token encrypted).
    db.upsertCompanionConfig({
      sessionId: envCfg.sessionId,
      botTokenBlob: encryptSecret(envCfg.botToken, keyPath),
      channel: TELEGRAM_CHANNEL,
      allowedChatId: envCfg.allowedChatId,
      chatScope: envCfg.chatScope,
      heartbeatIntervalMinutes: envCfg.heartbeatIntervalMinutes,
      heartbeatPrompt: envCfg.heartbeatPrompt,
      enabled: true,
    });
    // Seed THIS session's home target from env if unset (app_meta is the source, PER SESSION; a REST PUT
    // can override later — never touches another companion's home).
    //
    // @decision 94754bbe — never seed a home that fails this check; ChatGateway.mayDeliverTo is the real
    // guarantee, but a bad env value should still surface as a loud setup log, not a silently-armed leak.
    if (!db.getCompanionHome(envCfg.sessionId)) {
      if (isNonNumericTelegramChatId(envCfg.homeChannel, envCfg.homeChatId)) {
        // card 1b0df437 item 3: disclosure-safe — the chatId itself is identifying and is omitted here,
        // same posture as ChatGateway.warnUnboundRouteRefused's runtime warning and the boot-time stale-
        // home warning below (daemon-output.log is a host-wide shared log, not a private one).
        console.error(
          `[companion] SETUP: session ${envCfg.sessionId.slice(0, 8)}'s env/bootstrap home target (channel=` +
            `${envCfg.homeChannel}) is not a numeric Telegram chat id — NO home was seeded. Fix ` +
            `LOOM_COMPANION_HOME_CHAT_ID (or LOOM_COMPANION_CHAT_ID) and restart, or set home via the REST ` +
            `admin surface (PUT /api/companion/home) instead.`,
        );
      } else {
        db.setCompanionHome(envCfg.sessionId, { channel: envCfg.homeChannel, chatId: envCfg.homeChatId });
      }
    }
  }
  warnStaleStoredHomes(db);
  return resolveAllEnabledConfigs(db, env, keyPath);
}

// Boot-time backstop: checked for EVERY enabled row (not just the env-pinned session), WARNING ONLY.
// @decision 1b0df437 — never reintroduce a shape-only check here; use the same predicate as
// deliveryBlockReason (companionRouteBlockReason, reconcile.ts) — see card ddf08614.
function warnStaleStoredHomes(db: CompanionConfigStore): void {
  for (const row of db.listCompanionConfigs()) {
    if (!row.enabled) continue;
    const home = db.getCompanionHome(row.sessionId);
    if (!home) continue;
    const binding = db.getCompanionBindingsForSession(row.sessionId).find((b) => b.channel === home.channel && b.chatId === home.chatId);
    // card c7d7b43a: this caller HAS its own sessionId (row.sessionId) — pass it so an in-app home whose
    // chatId doesn't actually match this session (corrupt state, or a future bug) is caught here too, not
    // just at the delivery chokepoint.
    const reason = companionRouteBlockReason(home, binding, row.sessionId);
    if (reason === undefined) continue;
    // card 5ba1c39f: a foreign-session in-app home has no binding to "pair or bind" — it's an ownership
    // mismatch, not a missing/unbound chat. Branch on the ACTUAL reason instead of reusing the unbound
    // message for every non-undefined case.
    if (reason === "route-foreign-session") {
      // eslint-disable-next-line no-console
      console.error(
        `[companion] SETUP: session ${row.sessionId.slice(0, 8)}'s STORED home target (channel=` +
          `${home.channel}) names a route owned by another session — proactive delivery (heartbeat/` +
          `reminder/attention-push) to it is refused at the outbound chokepoint and will stay refused ` +
          `until it's fixed. Update it via PUT /api/companion/home to a route this session actually owns.`,
      );
      continue;
    }
    if (reason === "route-flagged-non-private") {
      // card 7e4db63f: a binding flagged non-private at runtime IS live (shape-fine, has a row) — branch on
      // the ACTUAL reason here too, same as the foreign-session case above, instead of falling through to
      // the badShape ternary below, which would wrongly say "no live binding... pair or bind first" for a
      // binding that is in fact live and just flagged.
      // eslint-disable-next-line no-console
      console.error(
        `[companion] SETUP: session ${row.sessionId.slice(0, 8)}'s STORED home target (channel=` +
          `${home.channel}) is flagged non-private — proactive delivery (heartbeat/reminder/attention-push) ` +
          `to it is refused at the outbound chokepoint (card 1b0df437) and will stay refused until it's ` +
          `fixed. If this is genuinely a shared chat, re-bind it with scope "group"; otherwise remove and ` +
          `re-add this channel (this also clears any home/reminder pinned to it), or update the home via ` +
          `PUT /api/companion/home.`,
      );
      continue;
    }
    const badShape = isNonNumericTelegramChatId(home.channel, home.chatId) || isLikelyGroupTelegramChatId(home.channel, home.chatId);
    // card 1b0df437 item 3: disclosure-safe — never the chatId itself (identifying), only the channel and
    // which of the two distinct problems applies (bad shape vs. a shape that's fine but unbound).
    // eslint-disable-next-line no-console
    console.error(
      badShape
        ? `[companion] SETUP: session ${row.sessionId.slice(0, 8)}'s STORED home target (channel=` +
            `${home.channel}) is not shaped like a private Telegram chat id — proactive delivery (heartbeat/` +
            `reminder/attention-push) to it is refused at the outbound chokepoint (card 1b0df437) and will ` +
            `stay refused until it's fixed. Update it via PUT /api/companion/home, or bind it with scope ` +
            `"group" first if this is actually a group/channel handle you want as home.`
        : `[companion] SETUP: session ${row.sessionId.slice(0, 8)}'s STORED home target (channel=` +
            `${home.channel}) has no live binding backing it — proactive delivery (heartbeat/reminder/` +
            `attention-push) to it is refused at the outbound chokepoint (card 1b0df437) and will stay ` +
            `refused until it's fixed. Pair or bind this chat first (Companion → Access, or DM pairing), or ` +
            `update the home via PUT /api/companion/home.`,
    );
  }
}

/**
 * The side-effect-FREE effective-config-SET resolver, factored out of `resolveAllCompanionConfigs` so the
 * hot lifecycle controller can recompute "which companions should be live" on a REST config write WITHOUT
 * re-running the env bootstrap (which would re-encrypt/re-write the row every reconcile). It only READS:
 * builds a CompanionConfig for EVERY enabled row (multi-companion runtime — every enabled config is armed,
 * not just the oldest), dropping a row that fails to decrypt (corrupt/undecryptable blob — logged, never a
 * crash). The env-pinned session (when env is present) is just one more enabled row here — env's own
 * upsert already flipped it `enabled:true`, so it needs no special-casing beyond the bootstrap write above.
 * Never writes, never throws. `keyPath` is the test seam.
 */
export function resolveAllEnabledConfigs(
  db: CompanionConfigStore,
  _env: NodeJS.ProcessEnv,
  keyPath?: string,
): CompanionConfig[] {
  const enabled = db.listCompanionConfigs().filter((c) => c.enabled);
  const configs: CompanionConfig[] = [];
  // SAME-TOKEN COLLISION GUARD (companion multi-bot-token collision guard): Telegram allows only ONE
  // getUpdates long-poll consumer per bot token — arming two ENABLED configs on the same token would leave
  // the 2nd thrashing forever on HTTP 409 (silent inbound loss for that companion). `enabled` is read
  // oldest-first (db.listCompanionConfigs ORDER BY created_at, rowid), so keeping the FIRST config seen per
  // token and skipping the rest arms the OLDEST companion deterministically — a safety net independent of
  // the provision/config-set REST guard (findEnabledTokenCollision below), which should catch this earlier.
  // Distinct tokens (the normal multi-companion case) are completely unaffected.
  const armedByTokenFingerprint = new Map<string, string>(); // fingerprint -> sessionId already armed on it
  for (const row of enabled) {
    // PER-ROW home (multi-companion cross-delivery fix, task e849a487): each session's home is read from
    // ITS OWN app_meta key, never a single value shared across every row in this loop.
    const home = db.getCompanionHome(row.sessionId);
    const cfg = buildConfigFromRow(row, home, keyPath);
    if (!cfg) continue;
    if (cfg.botToken) {
      const fingerprint = tokenFingerprint(cfg.botToken);
      const armedBy = armedByTokenFingerprint.get(fingerprint);
      if (armedBy) {
        // eslint-disable-next-line no-console
        console.warn(
          `[companion] session ${cfg.sessionId.slice(0, 8)} shares its Telegram bot token with already-armed session ${armedBy.slice(0, 8)} — Telegram allows only ONE getUpdates consumer per token, so this companion is NOT armed. Give it its own bot token to run both concurrently.`,
        );
        continue;
      }
      armedByTokenFingerprint.set(fingerprint, cfg.sessionId);
    }
    configs.push(cfg);
  }
  suppressDuplicateHomeHeartbeats(db, configs);
  return configs;
}

/**
 * SAME-HOME COLLISION GUARD: the per-row home resolution above is correct (each config reads its OWN
 * session's app_meta home) — but two DIFFERENT enabled sessions can resolve their home to the SAME route,
 * and `CompanionHeartbeatWatcher` is armed 1-per-session with no cross-session scoping (controller.ts), so
 * both would otherwise fire and duplicate a proactive message.
 * @decision f1d7a22b — deliberately narrow: suppress ONLY the heartbeat, ONLY among LIVE members —
 * widening scope or dropping the liveness filter below reopens the orphan-silence this guard prevents.
 *
 * Mirrors the token-fingerprint guard's shape (group by a fingerprint, keep exactly one) — but narrower:
 * only the HEARTBEAT is suppressed on the losing session(s) (by zeroing `heartbeatIntervalMinutes`, the
 * existing "no heartbeat" convention — see `CompanionConfig.heartbeatIntervalMinutes`), never the whole
 * config. Its gateway/reminders/chat stay fully armed. Competition is restricted to LIVE, non-archived
 * members (`isLiveSession`): a companion's `companion_config` row survives its session's pty death
 * (`enabled` stays untouched — see controller.ts's `onSessionExit`), so an unfiltered dead-but-still-
 * enabled session could WIN the group and silence a live sibling's heartbeat — the exact orphan-silence
 * this guard exists to prevent. Winner selection: see `mostActive` below. Mutates
 * `heartbeatIntervalMinutes` of the losing config(s) in place.
 *
 * @decision 134368ac — re-arming a suppressed survivor when the WINNER itself later exits is handled
 * in controller.ts's `onSessionExit`, not here — do not duplicate that re-arm logic in this function.
 */
function suppressDuplicateHomeHeartbeats(db: CompanionConfigStore, configs: CompanionConfig[]): void {
  const byHome = new Map<string, CompanionConfig[]>(); // "channel\0chatId" -> every armed config on it
  for (const cfg of configs) {
    if (cfg.heartbeatIntervalMinutes <= 0) continue; // already off — nothing to de-dup
    // A home-LESS config (no explicit home AND no real fallback chat — the in-app-only companion with
    // neither a Telegram allowedChatId nor an explicit home) has no shared destination two sessions could
    // actually collide on: `buildConfigFromRow`'s fallback (home?.chatId ?? row.allowedChatId) leaves
    // `homeChatId` as the EMPTY STRING for this shape, so two such sessions would otherwise both key to
    // `"in-app\0"` and wrongly dedup against each other. Key those by sessionId instead — unique per
    // session, so each keeps its own heartbeat — while a config with a real non-empty homeChatId (a bound
    // Telegram chat, or an explicitly-set home) still groups on the shared `channel\0chatId` destination.
    const key = cfg.homeChatId ? `${cfg.homeChannel}\0${cfg.homeChatId}` : `\0unset\0${cfg.sessionId}`;
    const group = byHome.get(key);
    if (group) group.push(cfg);
    else byHome.set(key, [cfg]);
  }
  for (const group of byHome.values()) {
    // Only LIVE, non-archived sessions may compete for — or be silenced by — this guard (see the
    // @decision 134368ac note above for the reverse gap — a winner's exit — and how it's re-armed).
    const liveGroup = group.filter((cfg) => isLiveSession(db, cfg.sessionId));
    if (liveGroup.length < 2) continue;
    const winner = mostActive(db, liveGroup);
    for (const cfg of liveGroup) {
      if (cfg === winner) continue;
      // eslint-disable-next-line no-console
      console.warn(
        `[companion] session ${cfg.sessionId.slice(0, 8)} resolves the same home as already-armed session ${winner.sessionId.slice(0, 8)} — only one heartbeat is armed per home to avoid duplicate proactive messages.`,
      );
      cfg.heartbeatIntervalMinutes = 0;
    }
  }
}

/** True iff `sessionId` is a LIVE, non-archived session — the liveness gate for the home-collision guard
 *  above. An unknown session (e.g. a test fixture with no session row) is never live. */
function isLiveSession(db: CompanionConfigStore, sessionId: string): boolean {
  const session = db.getSession(sessionId);
  return !!session && session.processState === "live" && !session.archivedAt;
}

/** Pick the config with the most real activity in a same-home group of LIVE sessions: highest `ctxTurns`
 *  wins; a tie (including both unmeasured) goes to the OLDEST session by `createdAt`. */
function mostActive(db: CompanionConfigStore, group: CompanionConfig[]): CompanionConfig {
  return group.reduce((best, cur) => {
    const a = sessionActivity(db, cur.sessionId);
    const b = sessionActivity(db, best.sessionId);
    return a.ctxTurns > b.ctxTurns || (a.ctxTurns === b.ctxTurns && a.createdAt < b.createdAt) ? cur : best;
  });
}

function sessionActivity(db: CompanionConfigStore, sessionId: string): { ctxTurns: number; createdAt: string } {
  const session = db.getSession(sessionId);
  return { ctxTurns: session?.ctxTurns ?? 0, createdAt: session?.createdAt ?? "" };
}

/** Non-secret grouping key for a decrypted bot token (sha256 hex) — used ONLY to detect two configs sharing
 *  the same Telegram token without comparing plaintext directly. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Provision/config-set precondition companion to the reconcile safety net above: does `candidateToken`
 * (plaintext) already belong to a DIFFERENT enabled companion? A shared Telegram token is never valid (only
 * one getUpdates consumer per token), so a REST write can reject before the arm even attempts it — catching
 * the collision at configuration time instead of leaving it to the reconcile-time skip-and-warn. Returns the
 * colliding row's sessionId, or undefined when clear. `excludeSessionId` skips the row being written itself
 * (re-saving your OWN config without changing the token is not a collision). A row whose blob fails to
 * decrypt is skipped (not a comparable token), never thrown.
 */
export function findEnabledTokenCollision(
  db: CompanionConfigStore,
  candidateToken: string,
  excludeSessionId?: string,
  keyPath?: string,
): string | undefined {
  const candidateFingerprint = tokenFingerprint(candidateToken);
  for (const row of db.listCompanionConfigs()) {
    if (!row.enabled || !row.botTokenBlob || row.sessionId === excludeSessionId) continue;
    let token: string;
    try {
      token = decryptSecret(row.botTokenBlob, keyPath);
    } catch {
      continue; // corrupt/undecryptable — not a comparable token, never throw
    }
    if (tokenFingerprint(token) === candidateFingerprint) return row.sessionId;
  }
  return undefined;
}

/**
 * Same-agent collision guard (companion "+ New companion" auto-new-agent, e6f68bc4): does ANOTHER enabled
 * companion config already run on the SAME agentId? Mirrors `findEnabledTokenCollision`'s shape (scan every
 * enabled row, skip the row being written itself via `excludeSessionId`), but the candidate isn't a secret —
 * it's the session's agentId, read via `getSession`. Only a row whose OWN session is still LIVE (not
 * archived/exited — `isLiveSession`) counts as a collision: a companion whose session died leaves its config
 * row `enabled` (see controller.ts's `onSessionExit`), so treating that stale row as "occupying" the agent
 * would wrongly block re-provisioning onto it. Returns the colliding row's sessionId, or undefined when clear.
 */
export function findEnabledAgentCollision(
  db: CompanionConfigStore,
  agentId: string,
  excludeSessionId?: string,
): string | undefined {
  for (const row of db.listCompanionConfigs()) {
    if (!row.enabled || row.sessionId === excludeSessionId) continue;
    const session = db.getSession(row.sessionId);
    if (!session || session.agentId !== agentId) continue;
    if (!isLiveSession(db, row.sessionId)) continue;
    return row.sessionId;
  }
  return undefined;
}

/**
 * The ONE resolver for what a row's proactive home actually routes to: the stored app_meta `home` when
 * set, else the row's own channel/allowedChatId (the live fallback — see `CompanionConfigMasked.allowedChatId`'s
 * own doc on this second job). Shared by `buildConfigFromRow` (the send path) and `maskCompanionConfig`'s
 * `effectiveHome` (card 9a42e660) so a masked read reports the SAME target the send path would actually use,
 * never a re-derivation that could drift from it.
 */
function resolveHomeRoute(home: CompanionRoute | null, row: CompanionConfigRow): CompanionRoute {
  return { channel: home?.channel ?? row.channel, chatId: home?.chatId ?? row.allowedChatId };
}

/**
 * Build a single CompanionConfig from an ENABLED row (caller filters on `enabled` — this never re-checks
 * it), or null when the token blob fails to decrypt (corrupt / lost key — logged, never a crash). Shared by
 * `resolveAllEnabledConfigs` for every enabled row.
 */
function buildConfigFromRow(row: CompanionConfigRow, home: CompanionRoute | null, keyPath?: string): CompanionConfig | null {
  // An IN-APP-ONLY companion stores NO token (empty blob): botToken stays null and the gateway comes up with
  // only the in-app adapter (no Telegram long-poll — see createCompanionGateway). This is a VALID armed
  // companion, NOT the OFF path. Only a NON-EMPTY blob is decrypted; a decrypt FAILURE there still ⇒ dropped.
  let botToken: string | null = null;
  if (row.botTokenBlob) {
    try {
      botToken = decryptSecret(row.botTokenBlob, keyPath);
    } catch {
      // A corrupt/undecryptable blob (e.g. a lost key file) — drop this one rather than crash the daemon (or
      // the rest of the enabled set). Do NOT log the blob; the reason is generic on purpose (no ciphertext /
      // no key material in the log).
      // eslint-disable-next-line no-console
      console.warn(`[companion] stored config for session ${row.sessionId.slice(0, 8)} could not be decrypted — companion NOT started.`);
      return null;
    }
  }
  // Home comes from app_meta (the single source), with the env-style default (channel / allowedChatId).
  const effectiveHome = resolveHomeRoute(home, row);
  return {
    botToken,
    allowedChatId: row.allowedChatId,
    sessionId: row.sessionId,
    chatScope: row.chatScope,
    homeChannel: effectiveHome.channel,
    homeChatId: effectiveHome.chatId,
    heartbeatIntervalMinutes: row.heartbeatIntervalMinutes,
    heartbeatPrompt: row.heartbeatPrompt || DEFAULT_HEARTBEAT_PROMPT,
    bindingsSeeded: row.bindingsSeeded,
  };
}

/**
 * Mask a stored run-config for a human REST read: `configured:true` + the token's last-4 only, NEVER the
 * token. Decrypts the blob solely to derive the last-4 (a corrupt blob yields an empty last-4, never a
 * throw). `home` is THIS row's OWN app_meta home target (the caller resolves it via
 * `db.getCompanionHome(row.sessionId)` — never a value shared across rows). `env` (optional) is the
 * process env: when a LOOM_COMPANION_* config is set for THIS row's sessionId, `envPinned` is true — env
 * would OVERRIDE this row on the next boot, so the UI can warn instead of silently reverting a REST edit.
 * `keyPath` is the test seam.
 */
export function maskCompanionConfig(
  row: CompanionConfigRow,
  home: CompanionRoute | null,
  env?: NodeJS.ProcessEnv,
  keyPath?: string,
): CompanionConfigMasked {
  // In-app-only companion (empty blob) ⇒ no token configured, empty last-4. Only a NON-EMPTY blob is
  // decrypted for its last-4 (a corrupt blob yields an empty last-4, never a throw).
  const tokenConfigured = !!row.botTokenBlob;
  let tokenLast4 = "";
  if (tokenConfigured) {
    try {
      tokenLast4 = decryptSecret(row.botTokenBlob, keyPath).slice(-4);
    } catch {
      tokenLast4 = ""; // corrupt/undecryptable blob — never leak, never throw
    }
  }
  // ONE env resolve serves both `envPinned` and `heartbeatPromptDefault` below — and it is deliberately
  // `readCompanionConfig`, the SAME resolver the boot path feeds its row write from, not a re-derivation of
  // the `LOOM_COMPANION_HEARTBEAT_PROMPT || DEFAULT` precedence. That matters for the half-configured case:
  // env carrying ONLY a heartbeat prompt (no token/chat/session) resolves to null here, so it pins nothing
  // and reports nothing — exactly as the boot path treats it.
  const envCfg = env ? readCompanionConfig(env) : null;
  const envPinned = !!envCfg && envCfg.sessionId === row.sessionId;
  return {
    sessionId: row.sessionId,
    configured: true,
    tokenConfigured,
    provisioned: row.provisioned,
    tokenLast4,
    name: row.name,
    channel: row.channel,
    allowedChatId: row.allowedChatId,
    chatScope: row.chatScope,
    // card 72bd4322: the human UI cannot derive this (zero bindings is ambiguous between never-seeded and
    // seeded-then-revoked — see CompanionConfigMasked.bindingsSeeded's own doc), so it rides the config read.
    bindingsSeeded: row.bindingsSeeded,
    heartbeatIntervalMinutes: row.heartbeatIntervalMinutes,
    // card b95e3bd0: carry the RAW stored value (null when unset) rather than pre-resolving to the
    // default — resolving here is what let a save that never touched this field pin today's default
    // text as a permanent override. heartbeatPromptDefault lets the caller render/apply the default
    // without destroying the stored-vs-default distinction.
    heartbeatPrompt: row.heartbeatPrompt,
    // card e731bc77: report what UNSET actually resolves to for THIS companion, not the bare constant. For
    // an env-pinned row, `LOOM_COMPANION_HEARTBEAT_PROMPT` is what the boot path writes into the row
    // (`resolveAllCompanionConfigs`), so a cleared override is re-pinned to the env text on the next start
    // — reporting the constant there made the UI's placeholder misstate what the heartbeat will send.
    // `envCfg.heartbeatPrompt` is already env-or-constant, so an env-pinned row with no prompt var set
    // still reports the constant. ⚠️ SCOPE: this is the DURABLE answer, which the `envPinned` callout the
    // UI already renders also speaks to. Within the CURRENT process a REST-cleared override resolves to the
    // constant instead — the hot reconcile runs `resolveAllEnabledConfigs` (no env bootstrap), so the env
    // text only re-lands at boot. Don't "fix" that divergence here: it belongs to env precedence, not to
    // this masking edge.
    heartbeatPromptDefault: envPinned ? envCfg.heartbeatPrompt : DEFAULT_HEARTBEAT_PROMPT,
    home,
    // card 9a42e660: `home` above is the RAW stored value (null when unset) — a masked read otherwise says
    // "no home" for a companion whose heartbeat actually has one, since the send path falls back to
    // allowedChatId (`buildConfigFromRow`). `effectiveHome` reports what an unset home resolves to, through
    // the SAME `resolveHomeRoute` the send path itself calls, never a re-derivation that could drift from it.
    effectiveHome: resolveHomeRoute(home, row),
    enabled: row.enabled,
    envPinned,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
