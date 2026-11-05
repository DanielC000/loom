/**
 * Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation; extended in P5a with an
 * `oauth2` scheme). A named Connection (host + auth scheme + secret) is written only through the
 * HUMAN-only loopback REST surface (`gateway/server.ts`) — there is intentionally NO MCP path (same trust
 * posture as the vault/git/companion writers): an agent in an ordinary project session must never create,
 * list, or read a connection's secret (or, for `oauth2`, its token bundle). `host` is stored metadata only
 * in this phase — request-side host-allowlist ENFORCEMENT belongs to the authenticated-request tool (P2),
 * not this store.
 *
 * SECURITY (load-bearing): the secret is ENCRYPTED AT REST via the SAME envelope helper already used for
 * the Companion Telegram bot token (`keys/envelope.ts` — AES-256-GCM, a local LOOM_HOME key file, never
 * DB-backed-up). `listConnections`/`getConnectionMetadata` NEVER decrypt and NEVER return the blob — they
 * return `ConnectionMetadata` only (never the secret or, for `oauth2`, the token bundle/client secret).
 * `getSecretForUse` (api-key/bearer) and `getOAuthTokenBundle`/`ensureFreshOAuthToken` (`oauth2`, in
 * `connections/oauth.ts`) are the ONLY functions that return plaintext secret material — called only from
 * `connections/request.ts` (the P2 authenticated-request seam), server-side, never reachable over REST or
 * from an agent.
 */
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import { stripSshKeyPassphrase } from "./sshKey.js";
import type { ConnectionRow } from "../db.js";
import { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } from "@loom/shared";

/** A caller-correctable input problem from the ssh create/update paths — its message is FIXED text safe to
 *  show the caller (never submission-derived; see sshKey.ts's allowlist). Anything thrown that is NOT this
 *  (fs/envelope/sqlite faults) is a server fault: the REST routes answer it with a fixed 500, never its text. */
export class SshConnectionInputError extends Error {
  constructor(message: string) { super(message); this.name = "SshConnectionInputError"; }
}
import type { ConnectionAuthScheme, ConnectionMetadata, OAuthProviderSlug, SshCommandRule } from "@loom/shared";

/** The narrow db surface this module needs (mirrors CompanionConfigStore's shape in companion/store.ts). */
export interface ConnectionsDbStore {
  listConnections(): ConnectionRow[];
  getConnection(id: string): ConnectionRow | undefined;
  /** Exact-name lookup — the create-or-update seam for credential auto-provisioning v1 (card 193de09e). */
  getConnectionByName(name: string): ConnectionRow | undefined;
  createConnection(input: {
    name: string; host: string; authScheme: ConnectionAuthScheme; secretBlob: string;
    provider?: string | null; clientId?: string | null; authUrl?: string | null; tokenUrl?: string | null; scopes?: string | null;
    projectId?: string | null;
    sshPort?: number | null; sshUser?: string | null; sshHostKeyFingerprint?: string | null;
    sshReadOnly?: boolean; sshCommandAllowlist?: string; sshRiskyPatterns?: string;
  }): ConnectionRow;
  deleteConnection(id: string): void;
  updateConnectionTokens(id: string, patch: { secretBlob: string; tokenExpiresAt: string | null }): void;
  /** Rotate an api-key/bearer connection's secret in place (card 193de09e's re-provisioning path). */
  updateConnectionSecret(id: string, secretBlob: string): void;
  markConnectionNeedsReauth(id: string): void;
  /** Update an `ssh` connection's editable config (design record a3d5c7f4) — see `Db`'s own doc. */
  updateSshConnectionConfig(id: string, patch: { readOnly: boolean; commandAllowlist: string; riskyPatterns: string }): void;
}

/** Parse an `ssh_command_allowlist`/`ssh_risky_patterns` column back to a rule list. Every writer in this
 *  module only ever persists output from `validateSshCommandRuleList` below, so this never actually sees
 *  malformed JSON in practice — the try/catch is a defensive floor for a display path, not a validator. */
function parseSshRuleListColumn(json: string): SshCommandRule[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SshCommandRule[]) : [];
  } catch {
    return [];
  }
}

function toMetadata(row: ConnectionRow): ConnectionMetadata {
  const base: ConnectionMetadata = { id: row.id, name: row.name, host: row.host, authScheme: row.authScheme, projectId: row.projectId, createdAt: row.createdAt };
  if (row.authScheme === "ssh") {
    return {
      ...base,
      port: row.sshPort ?? undefined,
      user: row.sshUser ?? undefined,
      hostKeyFingerprint: row.sshHostKeyFingerprint ?? undefined,
      readOnly: row.sshReadOnly,
      commandAllowlist: parseSshRuleListColumn(row.sshCommandAllowlist),
      riskyCommandPatterns: parseSshRuleListColumn(row.sshRiskyPatterns),
    };
  }
  if (row.authScheme !== "oauth2") return base;
  return {
    ...base,
    provider: (row.provider as OAuthProviderSlug | null) ?? undefined,
    // Granted scopes are NON-secret (they ride in the consent URL, stored plaintext) — surface the
    // parsed list so the UI can show which products a connection covers. Space-joined column → array.
    scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
    // "connected" means at least one token exchange has ever succeeded — every exchange (initial consent
    // or refresh) sets tokenExpiresAt, so its presence is a reliable NON-SECRET proxy without decrypting.
    connected: row.tokenExpiresAt !== null,
    tokenExpiresAt: row.tokenExpiresAt,
    needsReauth: row.oauthNeedsReauth,
  };
}

// Bounds + scheme enum — the SINGLE source of truth for both the REST handler's 400-mapping (it catches
// createConnection's thrown error) and this module's own structural backstop below. Keeping the numbers
// here (not duplicated in gateway/server.ts) means a future P2 caller that skips REST validation still
// can't persist an invalid/oversized connection — createConnection enforces this regardless of caller.
export const CONNECTION_NAME_MAX = 200;
export const CONNECTION_HOST_MAX = 300;
export const CONNECTION_SECRET_MAX = 8192;
export const CONNECTION_URL_MAX = 2000;
/** The full auth-scheme enum (REST scheme-guards, the web scheme dropdown, docs). */
export const CONNECTION_AUTH_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer", "oauth2", "ssh"];
/** `createConnection`'s OWN restricted subset — `oauth2`/`ssh` registration each has a structurally
 *  different field set and goes through its own dedicated `create*Connection` function instead. */
const CREATE_CONNECTION_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer"];

// --- ssh connection type (design record a3d5c7f4) — bounds + the SAME CONNECTION_SECRET_MAX cap above
// bounds the private key (it's stored in the same secret_blob column every other scheme uses). ---------
export const SSH_USER_MAX = 256;
export const SSH_PORT_MIN = 1;
export const SSH_PORT_MAX = 65535;
export const SSH_DEFAULT_PORT = 22;
/** The exact form `ssh-keygen -l` prints: "SHA256:" + the 32-byte digest's base64, padding stripped (43
 *  chars) — verified against a real `ssh-keygen -lf` output in the design investigation. */
export const SSH_HOST_KEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
/** A single command-rule's `pattern` string length cap — generous for a realistic shell command/prefix/
 *  regex, small enough to block pathological input. */
export const SSH_COMMAND_PATTERN_MAX = 500;
/** Cap on a command allowlist's or risky-pattern list's entry COUNT — an abuse/sanity guard, not expected
 *  to bind any real owner-authored list. */
export const SSH_COMMAND_RULE_MAX_COUNT = 100;

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function isValidSshCommandRule(v: unknown): v is SshCommandRule {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r.kind !== "exact" && r.kind !== "prefix" && r.kind !== "regex") return false;
  if (typeof r.pattern !== "string" || r.pattern.length === 0 || r.pattern.length > SSH_COMMAND_PATTERN_MAX) return false;
  if (r.kind === "regex") {
    try {
      new RegExp(r.pattern);
    } catch {
      return false;
    }
  }
  return true;
}

/** Validate a command-rule list input (a connection's `commandAllowlist` or `riskyCommandPatterns`).
 *  `undefined` means "caller omitted it" — resolves to an empty list; the CALLER decides whether that
 *  means "no restriction" (allowlist) or "fall back to the shipped default" (risky patterns) — this
 *  function only ever validates a list that's actually present. */
function validateSshCommandRuleList(v: unknown, label: string): { ok: true; value: SshCommandRule[] } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > SSH_COMMAND_RULE_MAX_COUNT) {
    return { ok: false, error: `${label} must be an array of at most ${SSH_COMMAND_RULE_MAX_COUNT} rules` };
  }
  if (!v.every(isValidSshCommandRule)) {
    return {
      ok: false,
      error: `${label} entries must be {kind:"exact"|"prefix"|"regex", pattern:<non-empty string, at most ${SSH_COMMAND_PATTERN_MAX} chars>} (a "regex" pattern must compile)`,
    };
  }
  return { ok: true, value: v as SshCommandRule[] };
}

/**
 * The project-scoping trust-boundary check (card f2abce7e): may a session belonging to `callerProjectId`
 * resolve a connection whose stored scope is `connectionProjectId`? `null` on the connection means GLOBAL
 * — usable by any caller, project-bound or not (today's behavior, unchanged). A non-null connection scope
 * is usable ONLY by the EXACT matching project — a caller with no project (`null`/`undefined`, e.g. a
 * platform-tier session) or a DIFFERENT project always fails closed. Called at every secret-resolution seam
 * (`connections/request.ts`'s `performAuthenticatedRequest`, `index.ts`'s `resolveConnectionSecret` for a
 * P4 capability grant) — never trust an allowlist alone, since a cross-project Profile could allowlist an
 * id it has no business reaching.
 */
export function isConnectionUsableByProject(connectionProjectId: string | null, callerProjectId: string | null | undefined): boolean {
  return connectionProjectId === null || connectionProjectId === (callerProjectId ?? null);
}

/**
 * Validate connection-creation input. Non-throwing — used by `createConnection` (below) to decide
 * whether to throw, and reusable by a caller that wants to pre-check before calling.
 */
export function validateConnectionInput(input: {
  name?: unknown; host?: unknown; authScheme?: unknown; secret?: unknown;
}): { ok: true } | { ok: false; error: string } {
  if (!isNonBlankStr(input.name, CONNECTION_NAME_MAX)) {
    return { ok: false, error: `name must be a non-empty string of at most ${CONNECTION_NAME_MAX} characters` };
  }
  if (!isNonBlankStr(input.host, CONNECTION_HOST_MAX)) {
    return { ok: false, error: `host must be a non-empty string of at most ${CONNECTION_HOST_MAX} characters` };
  }
  if (typeof input.authScheme !== "string" || !CREATE_CONNECTION_SCHEMES.includes(input.authScheme as ConnectionAuthScheme)) {
    return { ok: false, error: "authScheme must be 'api-key' or 'bearer' (register an oauth2 connection via createOAuthConnection instead)" };
  }
  if (!isNonBlankStr(input.secret, CONNECTION_SECRET_MAX)) {
    return { ok: false, error: `secret must be a non-empty string of at most ${CONNECTION_SECRET_MAX} characters` };
  }
  return { ok: true };
}

/** The one host check for an ssh target, shared by `validateSshConnectionInput` (create) and the
 *  Connections form's fingerprint probe route (card b5565d4c) so the two can never drift: non-blank, at
 *  most `CONNECTION_HOST_MAX` chars, and no control characters inside the trimmed value. The error strings
 *  are fixed and never echo the submitted host. */
export function validateSshHost(host: unknown): { ok: true } | { ok: false; error: string } {
  if (!isNonBlankStr(host, CONNECTION_HOST_MAX)) {
    return { ok: false, error: `host must be a non-empty string of at most ${CONNECTION_HOST_MAX} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(host.trim())) return { ok: false, error: "host must not contain control characters" };
  return { ok: true };
}

/**
 * Validate `createSshConnection`'s input (design record a3d5c7f4). Non-throwing, mirrors
 * `validateConnectionInput`'s shape. Does NOT parse/decrypt the private key itself — that's
 * `stripSshKeyPassphrase`'s job (`createSshConnection` calls it separately, AFTER this passes), so the
 * "oversize key" and "encrypted key without passphrase" DoD cases are checked by two different layers:
 * this function catches a key over `CONNECTION_SECRET_MAX` before ever touching the parser; a key that's
 * small enough but genuinely encrypted-without-a-passphrase is caught by `stripSshKeyPassphrase` instead.
 */
export function validateSshConnectionInput(input: {
  name?: unknown; host?: unknown; port?: unknown; user?: unknown; privateKey?: unknown; passphrase?: unknown;
  hostKeyFingerprint?: unknown; readOnly?: unknown; commandAllowlist?: unknown; riskyCommandPatterns?: unknown;
}):
  | { ok: true; port: number; readOnly: boolean; commandAllowlist: SshCommandRule[]; riskyCommandPatterns: SshCommandRule[] }
  | { ok: false; error: string } {
  if (!isNonBlankStr(input.name, CONNECTION_NAME_MAX)) {
    return { ok: false, error: `name must be a non-empty string of at most ${CONNECTION_NAME_MAX} characters` };
  }
  const host = validateSshHost(input.host);
  if (!host.ok) return host;
  const port = input.port === undefined ? SSH_DEFAULT_PORT : input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < SSH_PORT_MIN || port > SSH_PORT_MAX) {
    return { ok: false, error: `port must be an integer between ${SSH_PORT_MIN} and ${SSH_PORT_MAX}` };
  }
  if (!isNonBlankStr(input.user, SSH_USER_MAX)) {
    return { ok: false, error: `user must be a non-empty string of at most ${SSH_USER_MAX} characters` };
  }
  if (!isNonBlankStr(input.privateKey, CONNECTION_SECRET_MAX)) {
    return { ok: false, error: `privateKey must be a non-empty string of at most ${CONNECTION_SECRET_MAX} characters` };
  }
  if (input.passphrase !== undefined && typeof input.passphrase !== "string") {
    return { ok: false, error: "passphrase, when given, must be a string" };
  }
  if (typeof input.hostKeyFingerprint !== "string" || !SSH_HOST_KEY_FINGERPRINT_RE.test(input.hostKeyFingerprint)) {
    return { ok: false, error: 'hostKeyFingerprint must match "SHA256:<43-char base64 digest>" (the exact form `ssh-keygen -l` prints)' };
  }
  const readOnly = input.readOnly === undefined ? true : input.readOnly;
  if (typeof readOnly !== "boolean") {
    return { ok: false, error: "readOnly, when given, must be a boolean" };
  }
  const allow = validateSshCommandRuleList(input.commandAllowlist, "commandAllowlist");
  if (!allow.ok) return allow;
  const risky = input.riskyCommandPatterns === undefined
    ? { ok: true as const, value: [...DEFAULT_SSH_RISKY_COMMAND_PATTERNS] }
    : validateSshCommandRuleList(input.riskyCommandPatterns, "riskyCommandPatterns");
  if (!risky.ok) return risky;
  return { ok: true, port, readOnly, commandAllowlist: allow.value, riskyCommandPatterns: risky.value };
}

/** List every stored connection as metadata only — never the secret. */
export function listConnections(db: ConnectionsDbStore): ConnectionMetadata[] {
  return db.listConnections().map(toMetadata);
}

/** Read one connection's metadata by id, or undefined when absent — never the secret. */
export function getConnectionMetadata(db: ConnectionsDbStore, id: string): ConnectionMetadata | undefined {
  const row = db.getConnection(id);
  return row ? toMetadata(row) : undefined;
}

/**
 * Create a new connection. VALIDATES (name/host/authScheme/secret bounds) and THROWS a descriptive Error
 * on an invalid input — the structural backstop: this holds regardless of caller, so a future P2 caller
 * that skips its own pre-validation still can't persist an invalid/oversized connection (the REST handler
 * pre-checks for a friendly 400, but this is the authoritative enforcement point). Name/host/secret are
 * trimmed before storage (a pasted trailing newline on a token is never persisted). The plaintext `secret`
 * is encrypted here (via the envelope helper) before it ever reaches the db layer —
 * `ConnectionsDbStore.createConnection` only ever sees ciphertext. `keyPath` overrides the envelope key
 * file (test seam only — never touch the real ~/.loom in tests).
 */
export function createConnection(
  db: ConnectionsDbStore,
  input: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string; projectId?: string | null },
  keyPath?: string,
): ConnectionMetadata {
  const v = validateConnectionInput(input);
  if (!v.ok) throw new Error(v.error);
  const row = db.createConnection({
    name: input.name.trim(),
    host: input.host.trim(),
    authScheme: input.authScheme,
    secretBlob: encryptSecret(input.secret.trim(), keyPath),
    projectId: input.projectId ?? null,
  });
  return toMetadata(row);
}

/** Revoke (delete) a connection by id — idempotent, mirrors the db layer. */
export function deleteConnection(db: ConnectionsDbStore, id: string): void {
  db.deleteConnection(id);
}

/**
 * Create a new `ssh` connection (design record a3d5c7f4). VALIDATES (`validateSshConnectionInput`) and
 * THROWS a descriptive Error on an invalid input — the structural backstop, same posture as
 * `createConnection`. The submitted `privateKey` is parsed via `stripSshKeyPassphrase` (owner decision 5:
 * strip the passphrase at create time, in memory, and never store it) — a key that's encrypted with no
 * (or a wrong) passphrase THROWS here rather than storing something still-encrypted. Only the resulting
 * PASSPHRASE-FREE PEM is ever passed to `encryptSecret` — the original `passphrase` string is never
 * persisted in any form. `keyPath` overrides the envelope key file (test seam only).
 */
export function createSshConnection(
  db: ConnectionsDbStore,
  input: {
    name: string; host: string; port?: number; user: string; privateKey: string; passphrase?: string;
    hostKeyFingerprint: string; readOnly?: boolean; commandAllowlist?: SshCommandRule[]; riskyCommandPatterns?: SshCommandRule[];
    projectId?: string | null;
  },
  keyPath?: string,
): ConnectionMetadata {
  const v = validateSshConnectionInput(input);
  if (!v.ok) throw new SshConnectionInputError(v.error);
  const stripped = stripSshKeyPassphrase(input.privateKey, input.passphrase);
  if (!stripped.ok) throw new SshConnectionInputError(stripped.error);
  const row = db.createConnection({
    name: input.name.trim(),
    host: input.host.trim(),
    authScheme: "ssh",
    secretBlob: encryptSecret(stripped.privateKeyPem, keyPath),
    projectId: input.projectId ?? null,
    sshPort: v.port,
    sshUser: input.user.trim(),
    sshHostKeyFingerprint: input.hostKeyFingerprint.trim(),
    sshReadOnly: v.readOnly,
    sshCommandAllowlist: JSON.stringify(v.commandAllowlist),
    sshRiskyPatterns: JSON.stringify(v.riskyCommandPatterns),
  });
  return toMetadata(row);
}

/**
 * Decrypt an `ssh` connection's private key for use — mirrors `getSecretForUse`, for the passphrase-free
 * PEM an `ssh` row's secret_blob holds. Never call over REST/MCP; the exec core (card f6647205) is the
 * ONLY intended caller. Returns undefined for an unknown id or a non-ssh row; throws if the stored blob
 * fails to decrypt (corrupt/wrong key), mirroring `decryptSecret`.
 */
export function getSshPrivateKeyForUse(db: ConnectionsDbStore, id: string, keyPath?: string): string | undefined {
  const row = db.getConnection(id);
  if (!row || row.authScheme !== "ssh") return undefined;
  return decryptSecret(row.secretBlob, keyPath);
}

/**
 * Update an `ssh` connection's EDITABLE config — `readOnly` / `commandAllowlist` / `riskyCommandPatterns`
 * only (design record a3d5c7f4: the risky-pattern list and allowlist are owner-editable per connection).
 * Deliberately does NOT touch host/port/user/the private key/the host-key fingerprint — those identify or
 * authenticate the connection, not how it's used, and rotating them is a separate (not-yet-built)
 * operation. THROWS if `id` doesn't resolve to an `ssh` row, or on an invalid patch field. Any field
 * omitted from `patch` keeps its current stored value.
 */
export function updateSshConnectionConfig(
  db: ConnectionsDbStore,
  id: string,
  patch: { readOnly?: boolean; commandAllowlist?: SshCommandRule[]; riskyCommandPatterns?: SshCommandRule[] },
): ConnectionMetadata {
  const row = db.getConnection(id);
  if (!row || row.authScheme !== "ssh") throw new SshConnectionInputError("no ssh connection with that id");
  const readOnly = patch.readOnly === undefined ? row.sshReadOnly : patch.readOnly;
  if (typeof readOnly !== "boolean") throw new SshConnectionInputError("readOnly, when given, must be a boolean");
  const allow = patch.commandAllowlist === undefined
    ? { ok: true as const, value: parseSshRuleListColumn(row.sshCommandAllowlist) }
    : validateSshCommandRuleList(patch.commandAllowlist, "commandAllowlist");
  if (!allow.ok) throw new SshConnectionInputError(allow.error);
  const risky = patch.riskyCommandPatterns === undefined
    ? { ok: true as const, value: parseSshRuleListColumn(row.sshRiskyPatterns) }
    : validateSshCommandRuleList(patch.riskyCommandPatterns, "riskyCommandPatterns");
  if (!risky.ok) throw new SshConnectionInputError(risky.error);
  db.updateSshConnectionConfig(id, { readOnly, commandAllowlist: JSON.stringify(allow.value), riskyPatterns: JSON.stringify(risky.value) });
  return getConnectionMetadata(db, id)!;
}

/**
 * CREATE-ONLY: provision a named api-key/bearer Connection with a plaintext secret — credential
 * auto-provisioning v1's core write (card 193de09e), called ONLY from the human-only answer boundary
 * (`POST /api/questions/:id/answer`'s credential branch in `gateway/server.ts`), never from an agent path.
 *
 * REFUSES (throws) if a connection by this EXACT name already exists, of ANY auth scheme — deliberate,
 * not a bug.
 * @decision 193de09e — never turn this refusal into rotate-in-place: it can clobber an oauth2
 * token-bundle blob or silently overwrite another project's secret without consent.
 *
 * SCOPED ROTATION: a caller passing a `projectId` matching the existing same-name row's scope may
 * rotate its secret in place via `updateConnectionSecret` instead of being refused; every OTHER
 * collision still refuses exactly as before.
 * @decision f2abce7e — scoped rotation must stay gated to an exact-same-project api-key row; never
 * widen it to a non-api-key row — that would clobber an oauth2 token bundle.
 *
 * Validates via the SAME `validateConnectionInput` bounds `createConnection` enforces — throws a
 * descriptive Error on invalid input, mirroring `createConnection`'s own structural backstop. The
 * plaintext `secret` is encrypted only inside the delegated `createConnection` call, never here.
 */
export function provisionConnection(
  db: ConnectionsDbStore,
  input: { name: string; host: string; secret: string; projectId?: string | null },
  keyPath?: string,
): ConnectionMetadata {
  const v = validateConnectionInput({ name: input.name, host: input.host, authScheme: "api-key", secret: input.secret });
  if (!v.ok) throw new Error(v.error);
  const existing = db.getConnectionByName(input.name.trim());
  if (existing) {
    if (input.projectId && existing.projectId === input.projectId && existing.authScheme === "api-key") {
      db.updateConnectionSecret(existing.id, encryptSecret(input.secret.trim(), keyPath));
      return getConnectionMetadata(db, existing.id)!;
    }
    throw new Error(
      `a Connection named "${input.name.trim()}" already exists — provisioning only creates NEW connections in v1. ` +
        "Rotate an existing one via the Connections settings UI instead.",
    );
  }
  return createConnection(db, { name: input.name, host: input.host, authScheme: "api-key", secret: input.secret, projectId: input.projectId ?? null }, keyPath);
}

/** The ONLY auth schemes `getSecretForUse` will ever decrypt — an ALLOWLIST, not a denylist of the
 *  schemes known to need their own seam instead. A denylist fails OPEN the moment a new scheme is added
 *  and nobody remembers to add it here too; this allowlist fails CLOSED for that same future scheme by
 *  construction (card f9972a3d, Code Review round 2). */
const RAW_SECRET_AUTH_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer"];

/**
 * Decrypt a connection's secret for use. Returns the raw plaintext secret for api-key/bearer rows ONLY
 * (see `RAW_SECRET_AUTH_SCHEMES` above) — the seam the P2 authenticated-request tool calls, server-side
 * only, to inject the secret into an outbound request. Never expose this function's return value over
 * REST or to an agent. Returns undefined for an unknown id, an `oauth2` row (its secret_blob is a JSON
 * token bundle, not a raw secret — callers that need an oauth2 access token must go through
 * `ensureFreshOAuthToken`, which also handles refresh), an `ssh` row, or any OTHER/future scheme.
 *
 * @decision a3d5c7f4 — never let an `ssh` row's secret_blob (the private key) reach this function's
 * return value; `getSshPrivateKeyForUse` is the dedicated seam for it instead.
 *
 * Throws if the stored blob fails to decrypt (corrupt / wrong key), mirroring `decryptSecret`.
 *
 * P4↔P5a interaction: this is also the seam `index.ts`'s `resolveConnectionSecret` calls for a P4
 * capability grant's static env injection — the `undefined` returned for an `oauth2` row here is what
 * makes that injection correctly no-op for oauth2 (fail-closed, never a stale static token). The
 * human-facing guard against binding an oauth2 connection to such a grant in the first place lives at
 * profile-save time: `profiles/validate.ts` › `capabilityGrantBindingError`.
 */
export function getSecretForUse(db: ConnectionsDbStore, id: string, keyPath?: string): string | undefined {
  const row = db.getConnection(id);
  if (!row || !RAW_SECRET_AUTH_SCHEMES.includes(row.authScheme)) return undefined;
  return decryptSecret(row.secretBlob, keyPath);
}

/**
 * Card f2abce7e's P4-capability fail-closed composition, extracted to a single tested owner (test-fidelity
 * follow-up, card 34ea225d): `getConnectionMetadata` + `isConnectionUsableByProject` + `getSecretForUse`,
 * checking project scope BEFORE decrypting. Returns undefined for an unresolvable/revoked connection, a
 * project-scope mismatch (fail-closed), or a decrypt failure — `index.ts`'s `resolveConnectionSecret`
 * calls this directly so the production closure and the test exercise the exact same code.
 */
export function resolveScopedConnectionSecret(db: ConnectionsDbStore, connectionId: string, projectId?: string | null): string | undefined {
  try {
    const meta = getConnectionMetadata(db, connectionId);
    if (!meta || !isConnectionUsableByProject(meta.projectId, projectId ?? null)) return undefined;
    return getSecretForUse(db, connectionId);
  } catch { return undefined; }
}

/** A connection a session may actually resolve — `{id, name, host}` only, NEVER the secret. */
export interface UsableConnectionSummary {
  id: string;
  name: string;
  host: string;
}

/**
 * The session's own USABLE connection allowlist (card 298b826e): every id on `sessionConnections` (the
 * session-row-pinned allowlist) that ALSO passes `isConnectionUsableByProject` for `callerProjectId`,
 * resolved to non-secret display metadata. "Usable" means both — a connection pinned on the allowlist
 * (e.g. a stale or misconfigured profile) that this caller's own project can't reach is deliberately
 * EXCLUDED here, never just filtered at display time: this is the single list the `authenticated_request`
 * tool's description and every not-permitted/not-found refusal surface back to the agent, so listing an
 * out-of-project connection here would leak its existence to a caller who could never resolve it anyway —
 * the exact leak `connections/request.ts`'s own "connection not found" (never scope-specific) wording is
 * already careful not to cause. A revoked/unresolvable id (metadata missing) is silently dropped, same as
 * `resolveScopedConnectionSecret`'s own fail-closed posture.
 *
 * An `ssh` connection is excluded too (Code Review round 2, card f9972a3d): `authenticated_request` never
 * dispatches one (`getSecretForUse` fails closed for it — see `RAW_SECRET_AUTH_SCHEMES` above), so
 * listing it here would advertise a connection this tool can only ever refuse with an uninformative
 * "connection not found" — never advertise what you can't actually serve.
 */
export function resolveUsableConnections(
  db: ConnectionsDbStore,
  sessionConnections: string[],
  callerProjectId?: string | null,
): UsableConnectionSummary[] {
  const out: UsableConnectionSummary[] = [];
  for (const id of sessionConnections) {
    const meta = getConnectionMetadata(db, id);
    if (!meta) continue;
    if (meta.authScheme === "ssh") continue;
    if (!isConnectionUsableByProject(meta.projectId, callerProjectId ?? null)) continue;
    out.push({ id: meta.id, name: meta.name, host: meta.host });
  }
  return out;
}

/** The `ssh` connections among `sessionConnections` that this caller's project can reach — the list the
 *  `ssh_exec` tool registers on and describes. `{id,name,host}` only, never any key material. */
export function resolveUsableSshConnections(
  db: ConnectionsDbStore,
  sessionConnections: string[],
  callerProjectId?: string | null,
): UsableConnectionSummary[] {
  const out: UsableConnectionSummary[] = [];
  for (const id of sessionConnections) {
    const meta = getConnectionMetadata(db, id);
    if (!meta || meta.authScheme !== "ssh") continue;
    if (!isConnectionUsableByProject(meta.projectId, callerProjectId ?? null)) continue;
    out.push({ id: meta.id, name: meta.name, host: meta.host });
  }
  return out;
}

// --- OAuth2 (agent-tooling epic P5a): authorization-code + PKCE registration + token-bundle seams -------
// Everything below is HUMAN-only-triggered (REST, `gateway/server.ts`) or server-internal (the lazy
// refresh-on-use seam in `connections/request.ts` / `connections/oauth.ts`) — no MCP tool ever reaches
// this surface, same trust posture as the rest of this module.

/** Code-constant seed templates for the two named providers — non-secret (no client id/secret here; the
 *  human supplies those at registration). "custom" is NOT a template: the human supplies authUrl/tokenUrl/
 *  scopes directly for it. */
export interface OAuthProviderTemplate {
  provider: "google" | "github";
  name: string;
  authUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
}
export const OAUTH_PROVIDER_TEMPLATES: Record<"google" | "github", OAuthProviderTemplate> = {
  google: {
    provider: "google", name: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["openid", "email"],
  },
  github: {
    provider: "github", name: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["repo"],
  },
};

/** The decrypted shape of an `oauth2` connection's secret_blob — ONE envelope blob holds all of it. */
export interface OAuthTokenBundle {
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** ISO expiry of `accessToken`; null before the first successful exchange. */
  expiresAt: string | null;
}

function isValidHttpsUrl(v: unknown, max: number): boolean {
  if (!isNonBlankStr(v, max)) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

/**
 * Register a new `oauth2` connection (the "per-provider app registration" step — human supplies
 * client_id/secret + auth/token URLs + scopes for a provider). Creates the row with an EMPTY token bundle
 * (no access/refresh token yet — `connected` reads false until a consent round-trip completes). Validates
 * + THROWS a descriptive Error on invalid input, mirroring `createConnection`'s structural backstop.
 */
export function createOAuthConnection(
  db: ConnectionsDbStore,
  input: {
    name: string; host: string; provider: OAuthProviderSlug;
    clientId: string; clientSecret: string; authUrl: string; tokenUrl: string; scopes: string[];
    projectId?: string | null;
  },
  keyPath?: string,
): ConnectionMetadata {
  if (!isNonBlankStr(input.name, CONNECTION_NAME_MAX)) {
    throw new Error(`name must be a non-empty string of at most ${CONNECTION_NAME_MAX} characters`);
  }
  if (!isNonBlankStr(input.host, CONNECTION_HOST_MAX)) {
    throw new Error(`host must be a non-empty string of at most ${CONNECTION_HOST_MAX} characters`);
  }
  if (input.provider !== "google" && input.provider !== "github" && input.provider !== "custom") {
    throw new Error("provider must be 'google', 'github', or 'custom'");
  }
  if (!isNonBlankStr(input.clientId, CONNECTION_HOST_MAX)) {
    throw new Error("clientId must be a non-empty string");
  }
  if (!isNonBlankStr(input.clientSecret, CONNECTION_SECRET_MAX)) {
    throw new Error("clientSecret must be a non-empty string");
  }
  if (!isValidHttpsUrl(input.authUrl, CONNECTION_URL_MAX)) {
    throw new Error("authUrl must be a non-empty https:// URL");
  }
  if (!isValidHttpsUrl(input.tokenUrl, CONNECTION_URL_MAX)) {
    throw new Error("tokenUrl must be a non-empty https:// URL");
  }
  if (!Array.isArray(input.scopes) || !input.scopes.every((s) => typeof s === "string" && s.length > 0)) {
    throw new Error("scopes must be an array of non-empty strings");
  }

  const bundle: OAuthTokenBundle = { clientSecret: input.clientSecret.trim(), accessToken: null, refreshToken: null, expiresAt: null };
  const row = db.createConnection({
    name: input.name.trim(), host: input.host.trim(), authScheme: "oauth2",
    secretBlob: encryptSecret(JSON.stringify(bundle), keyPath),
    provider: input.provider, clientId: input.clientId.trim(), authUrl: input.authUrl.trim(), tokenUrl: input.tokenUrl.trim(),
    scopes: input.scopes.join(" "), projectId: input.projectId ?? null,
  });
  return toMetadata(row);
}

/**
 * Decrypt an `oauth2` connection's token bundle for internal use — mirrors `getSecretForUse`, but for the
 * JSON bundle shape. Never call over REST/MCP. Returns undefined for an unknown id or a non-oauth2 row.
 */
export function getOAuthTokenBundle(db: ConnectionsDbStore, id: string, keyPath?: string): OAuthTokenBundle | undefined {
  const row = db.getConnection(id);
  if (!row || row.authScheme !== "oauth2") return undefined;
  return JSON.parse(decryptSecret(row.secretBlob, keyPath)) as OAuthTokenBundle;
}

/**
 * Persist a fresh token bundle for an `oauth2` connection — re-encrypts the WHOLE bundle (the initial
 * consent exchange, or a later refresh) and clears `needsReauth`. Never call over REST/MCP.
 */
export function saveOAuthTokens(db: ConnectionsDbStore, id: string, bundle: OAuthTokenBundle, keyPath?: string): void {
  db.updateConnectionTokens(id, { secretBlob: encryptSecret(JSON.stringify(bundle), keyPath), tokenExpiresAt: bundle.expiresAt });
}

/** Mark an `oauth2` connection as needing re-authentication (a refresh attempt failed — revoked/invalid). */
export function markConnectionNeedsReauth(db: ConnectionsDbStore, id: string): void {
  db.markConnectionNeedsReauth(id);
}
