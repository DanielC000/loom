/**
 * Loom Companion — the DB-backed RUN-config layer (Companion epic Phase 3). Bridges the env-only spike
 * config (`config.ts` › readCompanionConfig) and the durable `companion_config` DB row so a human can
 * configure a companion WITHOUT editing a .env and restarting.
 *
 * Two responsibilities:
 *   1. `resolveCompanionConfig` — the BOOT resolver. Env (LOOM_COMPANION_*) is the BOOTSTRAP/override: if
 *      set, it SEEDS/overrides the DB row (token encrypted) BEFORE the gateway is built, then the effective
 *      CompanionConfig is built from the (DB-sourced) row — so env wins per the PL ruling, and a
 *      REST-configured companion with no env still comes up. No env + no enabled row ⇒ null (OFF,
 *      byte-identical to today).
 *   2. `maskCompanionConfig` — the REST masking edge. Turns a stored row (with the ENCRYPTED blob) into the
 *      human-facing CompanionConfigMasked: `configured:true` + the token's last 4 only, NEVER the token.
 *
 * SECURITY (load-bearing): the plaintext bot token exists only transiently — encrypted at rest via the
 * envelope helper (AES-256-GCM, LOOM_HOME key file), decrypted here only to hand the live gateway a token
 * to call Telegram or to derive the masked last-4. It is NEVER logged and NEVER returned in clear. Home is
 * NOT stored in the config row — it stays the single source of truth in app_meta (get/setCompanionHome).
 */
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import { readCompanionConfig, DEFAULT_HEARTBEAT_PROMPT, type CompanionConfig } from "./config.js";
import { TELEGRAM_CHANNEL } from "./telegram.js";
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
  }): CompanionConfigRow;
  getCompanionHome(): CompanionRoute | null;
  setCompanionHome(home: CompanionRoute): void;
}

/**
 * Build the effective CompanionConfig for boot from the DB, with env as bootstrap/override. Returns null
 * when neither env nor an enabled DB row configures a companion — the OFF path is byte-identical to today.
 * A row whose token blob can't be decrypted (corrupt / wrong key) is treated as OFF with a warning, never
 * a crash. `keyPath` overrides the envelope key file (test seam only).
 *
 * This is the BOOT resolver: it performs the env BOOTSTRAP write (seed/override the DB row + lay the home)
 * and then reads back the effective config via `resolveEffectiveConfig`. The hot-lifecycle controller uses
 * the side-effect-FREE `resolveEffectiveConfig` directly (a live REST reconcile must NOT re-bootstrap env).
 */
export function resolveCompanionConfig(
  db: CompanionConfigStore,
  env: NodeJS.ProcessEnv,
  keyPath?: string,
): CompanionConfig | null {
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
    // Seed the home target from env if unset (app_meta is the single source; a REST PUT can override later).
    if (!db.getCompanionHome()) db.setCompanionHome({ channel: envCfg.homeChannel, chatId: envCfg.homeChatId });
  }
  return resolveEffectiveConfig(db, env, keyPath);
}

/**
 * The side-effect-FREE effective-config resolver, factored out of `resolveCompanionConfig` so the hot
 * lifecycle controller can recompute "what the single live companion should be" on a REST config write
 * WITHOUT re-running the env bootstrap (which would re-encrypt/re-write the row every reconcile). It only
 * READS: picks the effective row (env's pinned session when env is present, else the single enabled row),
 * decrypts, and builds the CompanionConfig — or returns null (OFF) when no row configures a companion, a
 * disabled row, or a corrupt/undecryptable blob. Never writes, never throws. `keyPath` is the test seam.
 */
export function resolveEffectiveConfig(
  db: CompanionConfigStore,
  env: NodeJS.ProcessEnv,
  keyPath?: string,
): CompanionConfig | null {
  const envCfg = readCompanionConfig(env);
  // Effective row: env's session when env is present (boot upserted it), else the single enabled row.
  // Single-companion today: if a human left MORE THAN ONE enabled config on different sessions, only the
  // first comes up and the rest silently never do — warn (naming the count + chosen session) so that isn't
  // invisible. (A hard single-enabled invariant is a future decision; a warning is enough here.)
  let row: CompanionConfigRow | undefined;
  if (envCfg) {
    row = db.getCompanionConfig(envCfg.sessionId);
  } else {
    const enabled = db.listCompanionConfigs().filter((c) => c.enabled);
    const chosen = enabled[0];
    if (enabled.length > 1 && chosen) {
      // eslint-disable-next-line no-console
      console.warn(
        `[companion] ${enabled.length} enabled companion configs found — booting the FIRST (session ` +
          `${chosen.sessionId.slice(0, 8)}) and IGNORING the other ${enabled.length - 1}. Enable exactly one.`,
      );
    }
    row = chosen;
  }
  if (!row || !row.enabled) return null; // OFF — no env + no enabled row ⇒ byte-identical to today.

  // An IN-APP-ONLY companion stores NO token (empty blob): botToken stays null and the gateway comes up with
  // only the in-app adapter (no Telegram long-poll — see createCompanionGateway). This is a VALID armed
  // companion, NOT the OFF path. Only a NON-EMPTY blob is decrypted; a decrypt FAILURE there still ⇒ OFF.
  let botToken: string | null = null;
  if (row.botTokenBlob) {
    try {
      botToken = decryptSecret(row.botTokenBlob, keyPath);
    } catch {
      // A corrupt/undecryptable blob (e.g. a lost key file) — stay OFF rather than crash the daemon. Do NOT
      // log the blob; the reason is generic on purpose (no ciphertext / no key material in the log).
      // eslint-disable-next-line no-console
      console.warn(`[companion] stored config for session ${row.sessionId.slice(0, 8)} could not be decrypted — companion NOT started.`);
      return null;
    }
  }
  // Home comes from app_meta (the single source), with the env-style default (channel / allowedChatId).
  const home = db.getCompanionHome();
  return {
    botToken,
    allowedChatId: row.allowedChatId,
    sessionId: row.sessionId,
    chatScope: row.chatScope,
    homeChannel: home?.channel ?? row.channel,
    homeChatId: home?.chatId ?? row.allowedChatId,
    heartbeatIntervalMinutes: row.heartbeatIntervalMinutes,
    heartbeatPrompt: row.heartbeatPrompt || DEFAULT_HEARTBEAT_PROMPT,
  };
}

/**
 * Mask a stored run-config for a human REST read: `configured:true` + the token's last-4 only, NEVER the
 * token. Decrypts the blob solely to derive the last-4 (a corrupt blob yields an empty last-4, never a
 * throw). `home` is the app_meta home target (passed in — the single source). `env` (optional) is the
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
  const envPinned = !!env && readCompanionConfig(env)?.sessionId === row.sessionId;
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
    heartbeatIntervalMinutes: row.heartbeatIntervalMinutes,
    heartbeatPrompt: row.heartbeatPrompt || DEFAULT_HEARTBEAT_PROMPT,
    home,
    enabled: row.enabled,
    envPinned,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
