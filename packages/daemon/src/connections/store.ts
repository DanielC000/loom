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
import { hostRoundTrips } from "./hostForm.js";
import { daemonReservedPorts, validatePlainHttpHost } from "./lanHttp.js";
import type { ConnectionRow } from "../db.js";
import { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } from "@loom/shared";

/** A caller-correctable input problem from the ssh create/update paths — its message is FIXED text safe to
 *  show the caller (never submission-derived; see sshKey.ts's allowlist). Anything thrown that is NOT this
 *  (fs/envelope/sqlite faults) is a server fault: the REST routes answer it with a fixed 500, never its text. */
export class SshConnectionInputError extends Error {
  constructor(message: string) { super(message); this.name = "SshConnectionInputError"; }
}
import type { CodexProvider, ConnectionAuthScheme, ConnectionMetadata, OAuthProviderSlug, PlatformConfigOverride, SshCommandRule } from "@loom/shared";
import { codexProviderBindingError } from "../profiles/codex-provider.js";

/** The narrow db surface this module needs (mirrors CompanionConfigStore's shape in companion/store.ts). */
export interface ConnectionsDbStore {
  /** Optional: lets the plain-http host check read `remoteAccess.proxyPort` (the daemon's own ports are refused). */
  getPlatformConfig?(): PlatformConfigOverride;
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
    allowPlainHttp?: boolean;
  }): ConnectionRow;
  deleteConnection(id: string): void;
  updateConnectionTokens(id: string, patch: { secretBlob: string; tokenExpiresAt: string | null }): void;
  /** Rotate an api-key/bearer connection's secret in place (card 193de09e's re-provisioning path). */
  updateConnectionSecret(id: string, secretBlob: string): void;
  markConnectionNeedsReauth(id: string): void;
  /** Update an `ssh` connection's editable config (design record a3d5c7f4) — see `Db`'s own doc. */
  updateSshConnectionConfig(id: string, patch: { readOnly: boolean; commandAllowlist: string; riskyPatterns: string }): void;
  /** Owner edit over a fixed column whitelist (card 923dfc9d) — see `Db.updateConnection`. */
  updateConnection(id: string, patch: {
    name?: string; host?: string; authScheme?: ConnectionAuthScheme; secretBlob?: string;
    sshPort?: number; sshUser?: string; sshHostKeyFingerprint?: string;
    sshReadOnly?: boolean; sshCommandAllowlist?: string; sshRiskyPatterns?: string;
    allowPlainHttp?: boolean;
  }): void;
  /** The profiles' codexProvider bindings — read by an edit's host-change dependent check. */
  listProfiles(): Array<{ name: string; codexProvider?: CodexProvider | null }>;
  /** Resumable sessions' own pinned codexProvider (a resume re-reads the row, not the profile). */
  listResumableSessionsWithCodexProvider(): Array<{ id: string; codexProvider: CodexProvider }>;
}

/** A caller-correctable problem from `updateConnection`/`updateSshConnection` — fixed text, safe to show the
 *  caller (never echoes a submitted value). `status` is the HTTP code the route answers with. */
export class ConnectionInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); this.name = "ConnectionInputError"; }
}

/** What an owner edit reports: the metadata, the NAMES of the fields that changed (never values), and
 *  whether the secret was rotated. The REST route files the `connection_updated` audit event from this. */
export interface ConnectionUpdateResult {
  metadata: ConnectionMetadata;
  changedFields: string[];
  secretRotated: boolean;
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
  // A stored host that today's validator refuses (a row written before it existed) — flagged, never fixed
  // silently. Absent (not false) on a valid row so every existing metadata shape stays byte-identical.
  const storedHostCheck = validateConnectionHost(row.host, hostKindOf(row));
  if (!storedHostCheck.ok) { base.invalidHost = true; base.invalidHostReason = storedHostCheck.error; }
  if (row.allowPlainHttp && (row.authScheme === "api-key" || row.authScheme === "bearer")) base.allowPlainHttp = true;
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
  name?: unknown; host?: unknown; authScheme?: unknown; secret?: unknown; allowPlainHttp?: unknown;
}, reservedPorts?: readonly number[]): { ok: true } | { ok: false; error: string } {
  if (!isNonBlankStr(input.name, CONNECTION_NAME_MAX)) {
    return { ok: false, error: `name must be a non-empty string of at most ${CONNECTION_NAME_MAX} characters` };
  }
  if (input.allowPlainHttp !== undefined && typeof input.allowPlainHttp !== "boolean") {
    return { ok: false, error: "allowPlainHttp, when given, must be a boolean" };
  }
  const hostCheck = validateConnectionHost(input.host, input.allowPlainHttp === true ? "http" : "https", reservedPorts);
  if (!hostCheck.ok) return hostCheck;
  if (typeof input.authScheme !== "string" || !CREATE_CONNECTION_SCHEMES.includes(input.authScheme as ConnectionAuthScheme)) {
    return { ok: false, error: "authScheme must be 'api-key' or 'bearer' (register an oauth2 connection via createOAuthConnection instead)" };
  }
  if (!isNonBlankStr(input.secret, CONNECTION_SECRET_MAX)) {
    return { ok: false, error: `secret must be a non-empty string of at most ${CONNECTION_SECRET_MAX} characters` };
  }
  return { ok: true };
}

/**
 * THE one host validator for every connection kind — the create paths and the update paths all
 * call this, never a private copy. `"https"` (api-key/bearer/oauth2) accepts a bare host or `host:port`
 * (port 1-65535; `:443` refused because `request.ts` asserts `url.host === host` and `URL` drops a default
 * port, so a stored `:443` could never resolve); `"ssh"` accepts a BARE host or IP only (the port is its own
 * field). Both refuse a scheme, a path/query/fragment/userinfo/backslash, whitespace and control
 * characters. A bracketed IPv6 literal is accepted (https: with optional port); an unbracketed IPv6 only for
 * ssh. Error strings are FIXED text and never echo the submitted host. Validates the TRIMMED value, exactly what
 * callers store.
 */
export function validateConnectionHost(host: unknown, kind: "https" | "ssh" | "http", reservedPorts?: readonly number[]): { ok: true } | { ok: false; error: string } {
  if (!isNonBlankStr(host, CONNECTION_HOST_MAX)) {
    return { ok: false, error: `host must be a non-empty string of at most ${CONNECTION_HOST_MAX} characters` };
  }
  const h = host.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(h)) return { ok: false, error: "host must not contain control characters" };
  if (/\s/.test(h)) return { ok: false, error: "host must not contain whitespace" };
  if (h.includes("://")) return { ok: false, error: "host must be a bare hostname, not a URL — remove the scheme (e.g. 'https://' or 'http://')" };
  if (/[/?#@\\]/.test(h)) return { ok: false, error: "host must not contain a path, query, fragment, user info or backslash (none of / ? # @ \\)" };
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(.*))?$/.exec(h);
  let portText: string | undefined;
  if (bracketed) {
    portText = bracketed[2];
  } else {
    const colons = h.split(":").length - 1;
    if (colons >= 2) {
      if (kind !== "ssh") return { ok: false, error: "an IPv6 host must be written in [brackets], e.g. [fd00::1]:8443" };
      if (!/^[0-9a-fA-F:.]+$/.test(h)) return { ok: false, error: "host is not a valid hostname or IP address" };
    } else if (colons === 1) {
      portText = h.slice(h.indexOf(":") + 1);
      if (kind === "ssh") return { ok: false, error: "host must be a bare hostname or IP with no port — set the port in the port field" };
      if (h.startsWith(":")) return { ok: false, error: "host is missing a hostname before the port" };
    }
  }
  if (bracketed && kind === "ssh") {
    if (portText !== undefined) return { ok: false, error: "host must be a bare hostname or IP with no port — set the port in the port field" };
  }
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535 || /^0/.test(portText)) {
      return { ok: false, error: "port must be a number between 1 and 65535 with no leading zero" };
    }
    if (portText === "443" && kind !== "http") return { ok: false, error: "drop ':443' — requests use https, whose default port is 443" };
    if (portText === "80" && kind === "http") return { ok: false, error: "drop ':80' — plain http's default port is 80" };
  }
  if (kind !== "ssh") {
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(h)) return { ok: false, error: "host must be ASCII — write an internationalised name in its punycode (xn--) form" };
    if (h.includes("%")) return { ok: false, error: "host must not contain percent-escapes" };
    if (!hostRoundTrips(h, kind === "http" ? "http" : "https")) return { ok: false, error: "use the canonical host form (lowercase ASCII, compressed IPv6, dotted-decimal IPv4)" };
  }
  if (kind === "http") return validatePlainHttpHost(h, reservedPorts);
  return { ok: true };
}

/** The validator kind a stored connection's host is judged under: its own opt-in decides the scheme. */
function hostKindOf(row: { authScheme: ConnectionAuthScheme; allowPlainHttp: boolean }): "https" | "ssh" | "http" {
  if (row.authScheme === "ssh") return "ssh";
  return row.allowPlainHttp && (row.authScheme === "api-key" || row.authScheme === "bearer") ? "http" : "https";
}

/** The ssh-target form of {@link validateConnectionHost}, shared by `validateSshConnectionInput` (create) and the
 *  Connections form's fingerprint probe route (card b5565d4c) so the two can never drift. */
export function validateSshHost(host: unknown): { ok: true } | { ok: false; error: string } {
  return validateConnectionHost(host, "ssh");
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
  input: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string; projectId?: string | null; allowPlainHttp?: boolean },
  keyPath?: string,
): ConnectionMetadata {
  const v = validateConnectionInput(input, daemonReservedPorts(db));
  if (!v.ok) throw new Error(v.error);
  const row = db.createConnection({
    name: input.name.trim(),
    host: input.host.trim(),
    authScheme: input.authScheme,
    secretBlob: encryptSecret(input.secret.trim(), keyPath),
    projectId: input.projectId ?? null,
    allowPlainHttp: input.allowPlainHttp === true,
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
 * Update an `ssh` connection's usage config — `readOnly` / `commandAllowlist` / `riskyCommandPatterns`
 * (design record a3d5c7f4: the risky-pattern list and allowlist are owner-editable per connection). A thin
 * wrapper over `updateSshConnection` (below), which also owns host/port/user/key/pin edits (card 923dfc9d)
 * and the re-pin rule. THROWS if `id` doesn't resolve to an `ssh` row, or on an invalid patch field. Any
 * field omitted from `patch` keeps its current stored value.
 */
export function updateSshConnectionConfig(
  db: ConnectionsDbStore,
  id: string,
  patch: { readOnly?: boolean; commandAllowlist?: SshCommandRule[]; riskyCommandPatterns?: SshCommandRule[] },
): ConnectionMetadata {
  return updateSshConnection(db, id, patch).metadata;
}

/** Trimmed non-blank string, or a fixed-text 400 — the name rule every scheme shares. */
function editedName(v: unknown): string {
  if (!isNonBlankStr(v, CONNECTION_NAME_MAX)) {
    throw new ConnectionInputError(`name must be a non-empty string of at most ${CONNECTION_NAME_MAX} characters`);
  }
  return v.trim();
}

/** A rename must not collide with ANY other row: `provisionConnection` and `getConnectionByName` resolve by
 *  exact name (card 193de09e), so a duplicate would make the by-name lookup ambiguous. */
function assertNameFree(db: ConnectionsDbStore, id: string, name: string): void {
  const other = db.getConnectionByName(name);
  if (other && other.id !== id) throw new ConnectionInputError("a connection with that name already exists", 409);
}

/**
 * A host change must keep every dependent invariant true (card 923dfc9d): a profile whose `codexProvider`
 * names this connection requires `endpointHostname(baseUrl) === endpointHostname(connection.host)`, and
 * `PtyHost` re-checks that at EVERY codex spawn and REFUSES on a mismatch — so letting the edit through would
 * brick those profiles' codex spawns. A RESUMABLE session pins its own `codexProvider` on its row and a
 * resume re-reads that (never the profile), so those sessions are checked too — a profile edited away from this
 * connection does not free a session still pinned to it. Runs the SAME `codexProviderBindingError` the
 * profile-save routes and the spawn use, so the rules cannot drift. Names profiles and sessions only
 * (never a secret).
 */
function assertHostKeepsCodexBindings(db: ConnectionsDbStore, id: string, newHost: string, scheme: ConnectionAuthScheme): void {
  const probe = { getConnection: () => ({ host: newHost, authScheme: scheme }) };
  const brokenProfiles: string[] = [];
  for (const p of db.listProfiles()) {
    const cp = p.codexProvider;
    if (!cp || cp.connectionId !== id) continue;
    if (codexProviderBindingError(cp, probe)) brokenProfiles.push(`"${p.name}"`);
  }
  const brokenSessions: string[] = [];
  for (const s of db.listResumableSessionsWithCodexProvider()) {
    if (s.codexProvider.connectionId !== id) continue;
    if (codexProviderBindingError(s.codexProvider, probe)) brokenSessions.push(s.id.slice(0, 8));
  }
  if (brokenProfiles.length > 0 || brokenSessions.length > 0) {
    const who = [
      ...(brokenProfiles.length > 0 ? [`profile(s) ${brokenProfiles.join(", ")}`] : []),
      ...(brokenSessions.length > 0 ? [`resumable session(s) ${brokenSessions.join(", ")}`] : []),
    ].join(" and ");
    throw new ConnectionInputError(
      `host change refused: ${who} use this connection as their codexProvider and the new host no longer matches the provider's baseUrl host — update or retire those first`,
      409,
    );
  }
}

const IMMUTABLE_CONNECTION_FIELDS = ["projectId", "provider", "clientId", "clientSecret", "authUrl", "tokenUrl", "scopes", "createdAt", "id"] as const;

/**
 * Owner edit of an api-key / bearer / oauth2 connection (card 923dfc9d). HUMAN-only REST (no MCP path).
 * Editable: `name`, `host` (every scheme); `authScheme` (api-key<->bearer only) and `secret` (api-key/bearer
 * only, WRITE-ONLY: absent or blank means UNCHANGED, never echoed). An oauth2 row takes name/host only —
 * its client id/secret/URLs/scopes would invalidate the stored token bundle, so those stay delete-and-recreate.
 * `projectId` is immutable (re-scoping could orphan grants held by other projects' agents). Anything else is a
 * 400 naming the field. The id (hence every agent grant / capability binding that stores it) is preserved.
 * An `ssh` row is edited via `updateSshConnection`.
 *
 * A change takes effect on the NEXT use: the next `authenticated_request`/`ssh_exec` tool call, the next
 * spawn for codexProvider/capability env — never retroactively inside an already-built spawn environment.
 * @decision 923dfc9d — do not echo a secret value anywhere (response, event, log) and do not add an MCP path.
 */
export function updateConnection(
  db: ConnectionsDbStore,
  id: string,
  patch: Record<string, unknown>,
  keyPath?: string,
): ConnectionUpdateResult {
  const row = db.getConnection(id);
  if (!row) throw new ConnectionInputError("no connection with that id", 404);
  if (row.authScheme === "ssh") throw new ConnectionInputError("an ssh connection is edited through PUT /api/connections/:id/ssh");
  const editable = row.authScheme === "oauth2" ? ["name", "host"] : ["name", "host", "authScheme", "secret", "allowPlainHttp"];
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined || editable.includes(key)) continue;
    // `projectId` echoing its current value is a harmless no-op; any other immutable/unknown key is refused.
    if (key === "projectId" && patch[key] === row.projectId) continue;
    const immutable = (IMMUTABLE_CONNECTION_FIELDS as readonly string[]).includes(key) || key === "secret";
    throw new ConnectionInputError(
      `${key} cannot be changed on a ${row.authScheme} connection (${immutable ? "immutable" : "unsupported"}; editable: ${editable.join(", ")}) — delete and re-create the connection to change it`,
    );
  }
  const next: Parameters<ConnectionsDbStore["updateConnection"]>[1] = {};
  const changed: string[] = [];
  if (patch.name !== undefined) {
    const name = editedName(patch.name);
    if (name !== row.name) { assertNameFree(db, id, name); next.name = name; changed.push("name"); }
  }
  let scheme = row.authScheme;
  if (patch.authScheme !== undefined) {
    if (patch.authScheme !== "api-key" && patch.authScheme !== "bearer") {
      throw new ConnectionInputError("authScheme must be 'api-key' or 'bearer'");
    }
    if (patch.authScheme !== row.authScheme) { scheme = patch.authScheme; next.authScheme = scheme; changed.push("authScheme"); }
  }
  // The plain-http opt-in (card 1d882a8c): owner-only, api-key/bearer only (oauth2 never reaches here — it is
  // not in its editable list). The host is judged under the EFFECTIVE flag, so a flag flip re-validates the host.
  let plainHttp = row.allowPlainHttp;
  if (patch.allowPlainHttp !== undefined) {
    if (typeof patch.allowPlainHttp !== "boolean") throw new ConnectionInputError("allowPlainHttp, when given, must be a boolean");
    if (patch.allowPlainHttp !== row.allowPlainHttp) {
      plainHttp = patch.allowPlainHttp;
      next.allowPlainHttp = plainHttp;
      changed.push("allowPlainHttp");
    }
  }
  const flagChanged = plainHttp !== row.allowPlainHttp;
  if (patch.host === undefined && flagChanged) {
    // Flipping the opt-in on an unchanged host: that stored host must be valid under the NEW form.
    const stored = validateConnectionHost(row.host, plainHttp ? "http" : "https", daemonReservedPorts(db));
    if (!stored.ok) throw new ConnectionInputError(stored.error);
  }
  if (patch.host !== undefined) {
    // The shared host validator, applied to a host that is actually CHANGING: a form that resends an
    // already-stored (legacy, flagged invalidHost) host must still be able to save its other edits —
    // unless the opt-in flag is itself flipping in this request, which changes what "valid" means.
    const hostShape = validateConnectionHost(patch.host, plainHttp ? "http" : "https", daemonReservedPorts(db));
    const host = typeof patch.host === "string" ? patch.host.trim() : "";
    if (!hostShape.ok && (host !== row.host || flagChanged)) throw new ConnectionInputError(hostShape.error);
    if (!isNonBlankStr(patch.host, CONNECTION_HOST_MAX)) {
      throw new ConnectionInputError(`host must be a non-empty string of at most ${CONNECTION_HOST_MAX} characters`);
    }
    if (host !== row.host) { assertHostKeepsCodexBindings(db, id, host, scheme); next.host = host; changed.push("host"); }
  }
  let secretRotated = false;
  if (patch.secret !== undefined && patch.secret !== null) {
    if (typeof patch.secret !== "string") throw new ConnectionInputError("secret, when given, must be a string");
    if (patch.secret.trim() !== "") {
      if (!isNonBlankStr(patch.secret, CONNECTION_SECRET_MAX)) {
        throw new ConnectionInputError(`secret must be at most ${CONNECTION_SECRET_MAX} characters`);
      }
      next.secretBlob = encryptSecret(patch.secret.trim(), keyPath);
      secretRotated = true;
    }
  }
  // A host change that also swaps api-key<->bearer is validated with the NEW scheme above; a scheme-only swap
  // between the two codex-bindable schemes can never break a binding, so it needs no dependent check.
  if (changed.length > 0 || secretRotated) db.updateConnection(id, next);
  return { metadata: getConnectionMetadata(db, id)!, changedFields: changed, secretRotated };
}

/**
 * Owner edit of an `ssh` connection (card 923dfc9d), the superset of the config-only update: `name`, `host`,
 * `port`, `user`, a rotated `privateKey` (+ optional `passphrase`, stripped in memory exactly like create),
 * `hostKeyFingerprint`, and the three usage fields. WRITE-ONLY key: absent or blank `privateKey` means
 * UNCHANGED, never echoed.
 *
 * A change of `host` or `port` REQUIRES a new `hostKeyFingerprint` in the same request — the pin is the host
 * KEY of the machine at that address, so keeping the old one would trust one machine's key for another
 * address; there is no "clear the pin" (an unpinned ssh connection is refused by `ssh_exec`). A `user`-only or
 * key-only change does NOT need a re-pin (the host key is unchanged). Editing host/port/user/pin changes
 * `sshApprovalAction`, so every pending/standing/deny hold for the old target stops matching by construction.
 * @decision 923dfc9d — a host/port change requires an EXPLICIT hostKeyFingerprint in the same request (it may equal the old pin when the owner re-confirms it); the old pin is never implicitly carried over.
 */
export function updateSshConnection(
  db: ConnectionsDbStore,
  id: string,
  patch: {
    name?: string; host?: string; port?: number; user?: string; privateKey?: string; passphrase?: string;
    hostKeyFingerprint?: string; readOnly?: boolean; commandAllowlist?: SshCommandRule[]; riskyCommandPatterns?: SshCommandRule[];
  },
  keyPath?: string,
): ConnectionUpdateResult {
  const row = db.getConnection(id);
  if (!row || row.authScheme !== "ssh") throw new SshConnectionInputError("no ssh connection with that id");
  const next: Parameters<ConnectionsDbStore["updateConnection"]>[1] = {};
  const changed: string[] = [];
  try {
    if (patch.name !== undefined) {
      const name = editedName(patch.name);
      if (name !== row.name) { assertNameFree(db, id, name); next.name = name; changed.push("name"); }
    }
    let host = row.host;
    if (patch.host !== undefined) {
      // validateSshHost IS the shared validator's ssh form; skipped only for a host that is not changing.
      const ok = validateSshHost(patch.host);
      if (!ok.ok && !(typeof patch.host === "string" && patch.host.trim() === row.host)) throw new SshConnectionInputError(ok.error);
      host = patch.host.trim();
    }
    let port = row.sshPort ?? SSH_DEFAULT_PORT;
    if (patch.port !== undefined) {
      if (typeof patch.port !== "number" || !Number.isInteger(patch.port) || patch.port < SSH_PORT_MIN || patch.port > SSH_PORT_MAX) {
        throw new SshConnectionInputError(`port must be an integer between ${SSH_PORT_MIN} and ${SSH_PORT_MAX}`);
      }
      port = patch.port;
    }
    const targetChanged = host !== row.host || port !== (row.sshPort ?? SSH_DEFAULT_PORT);
    if (host !== row.host) changed.push("host");
    if (port !== (row.sshPort ?? SSH_DEFAULT_PORT)) changed.push("port");
    if (patch.hostKeyFingerprint !== undefined && (typeof patch.hostKeyFingerprint !== "string" || !SSH_HOST_KEY_FINGERPRINT_RE.test(patch.hostKeyFingerprint.trim()))) {
      throw new SshConnectionInputError('hostKeyFingerprint must match "SHA256:<43-char base64 digest>" (the exact form `ssh-keygen -l` prints)');
    }
    if (targetChanged && patch.hostKeyFingerprint === undefined) {
      throw new SshConnectionInputError("changing the host or port requires a new hostKeyFingerprint in the same request (the pinned key belongs to the old address)");
    }
    if (patch.hostKeyFingerprint !== undefined && patch.hostKeyFingerprint.trim() !== row.sshHostKeyFingerprint) {
      next.sshHostKeyFingerprint = patch.hostKeyFingerprint.trim();
      changed.push("hostKeyFingerprint");
    }
    if (patch.user !== undefined) {
      if (!isNonBlankStr(patch.user, SSH_USER_MAX)) {
        throw new SshConnectionInputError(`user must be a non-empty string of at most ${SSH_USER_MAX} characters`);
      }
      if (patch.user.trim() !== row.sshUser) { next.sshUser = patch.user.trim(); changed.push("user"); }
    }
    const passphrase = patch.passphrase === "" ? undefined : patch.passphrase;
    if (passphrase !== undefined && typeof passphrase !== "string") throw new SshConnectionInputError("passphrase, when given, must be a string");
    let secretRotated = false;
    if (patch.privateKey !== undefined && typeof patch.privateKey === "string" && patch.privateKey.trim() !== "") {
      if (!isNonBlankStr(patch.privateKey, CONNECTION_SECRET_MAX)) {
        throw new SshConnectionInputError(`privateKey must be at most ${CONNECTION_SECRET_MAX} characters`);
      }
      const stripped = stripSshKeyPassphrase(patch.privateKey, passphrase);
      if (!stripped.ok) throw new SshConnectionInputError(stripped.error);
      next.secretBlob = encryptSecret(stripped.privateKeyPem, keyPath);
      secretRotated = true;
    } else if (patch.privateKey !== undefined && typeof patch.privateKey !== "string") {
      throw new SshConnectionInputError("privateKey, when given, must be a string");
    } else if (passphrase !== undefined) {
      throw new SshConnectionInputError("passphrase only applies together with a new privateKey");
    }
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
    // Host-dependent invariants: an ssh row is never a codexProvider (api-key/bearer only), so there is no
    // codex binding to re-check here; the pin re-pin rule above is its host invariant.
    if (host !== row.host) next.host = host;
    if (port !== (row.sshPort ?? SSH_DEFAULT_PORT)) next.sshPort = port;
    if (readOnly !== row.sshReadOnly) { next.sshReadOnly = readOnly; changed.push("readOnly"); }
    const allowJson = JSON.stringify(allow.value);
    if (allowJson !== row.sshCommandAllowlist) { next.sshCommandAllowlist = allowJson; changed.push("commandAllowlist"); }
    const riskyJson = JSON.stringify(risky.value);
    if (riskyJson !== row.sshRiskyPatterns) { next.sshRiskyPatterns = riskyJson; changed.push("riskyCommandPatterns"); }
    if (changed.length > 0 || secretRotated) db.updateConnection(id, next);
    return { metadata: getConnectionMetadata(db, id)!, changedFields: changed, secretRotated };
  } catch (err) {
    // One error class for the route: a generic rule from the shared helpers becomes the ssh class (same 400/409).
    if (err instanceof ConnectionInputError && !(err instanceof SshConnectionInputError)) {
      if (err.status === 400) throw new SshConnectionInputError(err.message);
    }
    throw err;
  }
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

/**
 * How the agent's CURRENT connection grants differ from what this session pinned at spawn. `added` counts
 * granted connections that exist and this caller's project can reach but the session lacks (never counts
 * one the caller couldn't use anyway, so it can't disclose an out-of-project connection); `removed` counts
 * pinned ids no longer granted. Counts only — never an id, name or host.
 */
export function connectionGrantDrift(
  db: ConnectionsDbStore,
  agentConnections: readonly string[] | null | undefined,
  sessionConnections: readonly string[],
  callerProjectId?: string | null,
): { added: number; removed: number } {
  const agentSet = new Set(agentConnections ?? []);
  const pinned = new Set(sessionConnections);
  let added = 0;
  for (const id of agentSet) {
    if (pinned.has(id)) continue;
    const meta = getConnectionMetadata(db, id);
    if (meta && isConnectionUsableByProject(meta.projectId, callerProjectId ?? null)) added++;
  }
  let removed = 0;
  for (const id of pinned) if (!agentSet.has(id)) removed++;
  return { added, removed };
}

/** The agent-facing sentence for a non-zero {@link connectionGrantDrift}; "" when there is no drift. Names the
 *  only real fixes: a human re-pinning the session's grants, or a fresh session. A recycle or resume does NOT
 *  pick grants up, so this never suggests one. */
export function grantDriftNote(drift: { added: number; removed: number }, sessionId: string): string {
  if (drift.added === 0 && drift.removed === 0) return "";
  const parts: string[] = [];
  if (drift.added > 0) parts.push(`${drift.added} connection(s) were granted to your agent after this session started and are NOT usable here`);
  if (drift.removed > 0) parts.push(`${drift.removed} connection(s) this session still holds are no longer granted to your agent`);
  return `${parts.join("; ")}. Recycling or resuming does not change this: ask your owner or manager to re-pin this session's grants (POST /api/sessions/${sessionId}/repin-grants) or to start a fresh session.`;
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
  const oauthHostCheck = validateConnectionHost(input.host, "https");
  if (!oauthHostCheck.ok) throw new Error(oauthHostCheck.error);
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
