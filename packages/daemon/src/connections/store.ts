/**
 * Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation). A named Connection
 * (host + auth scheme + secret) is written only through the HUMAN-only loopback REST surface
 * (`gateway/server.ts`) — there is intentionally NO MCP path (same trust posture as the vault/git/
 * companion writers): an agent in an ordinary project session must never create, list, or read a
 * connection's secret. `host` is stored metadata only in this phase — request-side host-allowlist
 * ENFORCEMENT belongs to a later phase's authenticated-request tool, not this store.
 *
 * SECURITY (load-bearing): the secret is ENCRYPTED AT REST via the SAME envelope helper already used for
 * the Companion Telegram bot token (`keys/envelope.ts` — AES-256-GCM, a local LOOM_HOME key file, never
 * DB-backed-up). `listConnections`/`getConnectionMetadata` NEVER decrypt and NEVER return the blob — they
 * return `ConnectionMetadata` only (name/host/authScheme/createdAt). `getSecretForUse` is the ONLY function
 * here that returns plaintext; it is UNCALLED anywhere in this phase (no P2 authenticated-request tool
 * yet) — it exists purely as the seam that phase will call server-side, and must never be reachable over
 * REST or from an agent.
 */
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import type { ConnectionRow } from "../db.js";
import type { ConnectionAuthScheme, ConnectionMetadata } from "@loom/shared";

/** The narrow db surface this module needs (mirrors CompanionConfigStore's shape in companion/store.ts). */
export interface ConnectionsDbStore {
  listConnections(): ConnectionRow[];
  getConnection(id: string): ConnectionRow | undefined;
  createConnection(input: { name: string; host: string; authScheme: ConnectionAuthScheme; secretBlob: string }): ConnectionRow;
  deleteConnection(id: string): void;
}

function toMetadata(row: ConnectionRow): ConnectionMetadata {
  return { id: row.id, name: row.name, host: row.host, authScheme: row.authScheme, createdAt: row.createdAt };
}

// Bounds + scheme enum — the SINGLE source of truth for both the REST handler's 400-mapping (it catches
// createConnection's thrown error) and this module's own structural backstop below. Keeping the numbers
// here (not duplicated in gateway/server.ts) means a future P2 caller that skips REST validation still
// can't persist an invalid/oversized connection — createConnection enforces this regardless of caller.
export const CONNECTION_NAME_MAX = 200;
export const CONNECTION_HOST_MAX = 300;
export const CONNECTION_SECRET_MAX = 8192;
export const CONNECTION_AUTH_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer"];

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
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
  if (typeof input.authScheme !== "string" || !CONNECTION_AUTH_SCHEMES.includes(input.authScheme as ConnectionAuthScheme)) {
    return { ok: false, error: "authScheme must be 'api-key' or 'bearer'" };
  }
  if (!isNonBlankStr(input.secret, CONNECTION_SECRET_MAX)) {
    return { ok: false, error: `secret must be a non-empty string of at most ${CONNECTION_SECRET_MAX} characters` };
  }
  return { ok: true };
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
  input: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string },
  keyPath?: string,
): ConnectionMetadata {
  const v = validateConnectionInput(input);
  if (!v.ok) throw new Error(v.error);
  const row = db.createConnection({
    name: input.name.trim(),
    host: input.host.trim(),
    authScheme: input.authScheme,
    secretBlob: encryptSecret(input.secret.trim(), keyPath),
  });
  return toMetadata(row);
}

/** Revoke (delete) a connection by id — idempotent, mirrors the db layer. */
export function deleteConnection(db: ConnectionsDbStore, id: string): void {
  db.deleteConnection(id);
}

/**
 * Decrypt a connection's secret for use. The ONLY function in this module (or this phase, anywhere in the
 * daemon) that returns plaintext secret material — NOT called anywhere in P1. This is the seam a later
 * phase's authenticated-request tool will call, server-side only, to inject the secret into an outbound
 * request. Never expose this function's return value over REST or to an agent. Returns undefined for an
 * unknown id; throws if the stored blob fails to decrypt (corrupt / wrong key), mirroring `decryptSecret`.
 */
export function getSecretForUse(db: ConnectionsDbStore, id: string, keyPath?: string): string | undefined {
  const row = db.getConnection(id);
  if (!row) return undefined;
  return decryptSecret(row.secretBlob, keyPath);
}
