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
    // Seed the home target from env if unset (app_meta is the single source; a REST PUT can override later).
    if (!db.getCompanionHome()) db.setCompanionHome({ channel: envCfg.homeChannel, chatId: envCfg.homeChatId });
  }
  return resolveAllEnabledConfigs(db, env, keyPath);
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
  const home = db.getCompanionHome();
  const enabled = db.listCompanionConfigs().filter((c) => c.enabled);
  const configs: CompanionConfig[] = [];
  for (const row of enabled) {
    const cfg = buildConfigFromRow(row, home, keyPath);
    if (cfg) configs.push(cfg);
  }
  return configs;
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
