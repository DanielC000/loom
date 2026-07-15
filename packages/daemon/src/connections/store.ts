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
import type { ConnectionRow } from "../db.js";
import type { ConnectionAuthScheme, ConnectionMetadata, OAuthProviderSlug } from "@loom/shared";

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
  }): ConnectionRow;
  deleteConnection(id: string): void;
  updateConnectionTokens(id: string, patch: { secretBlob: string; tokenExpiresAt: string | null }): void;
  /** Rotate an api-key/bearer connection's secret in place (card 193de09e's re-provisioning path). */
  updateConnectionSecret(id: string, secretBlob: string): void;
  markConnectionNeedsReauth(id: string): void;
}

function toMetadata(row: ConnectionRow): ConnectionMetadata {
  const base: ConnectionMetadata = { id: row.id, name: row.name, host: row.host, authScheme: row.authScheme, projectId: row.projectId, createdAt: row.createdAt };
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
export const CONNECTION_AUTH_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer", "oauth2"];
/** `createConnection`'s OWN restricted subset — `oauth2` registration has a structurally different field
 *  set (provider/client id+secret/auth+token URLs, no single opaque `secret`) and goes through
 *  `createOAuthConnection` instead. */
const CREATE_CONNECTION_SCHEMES: readonly ConnectionAuthScheme[] = ["api-key", "bearer"];

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
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
 * CREATE-ONLY: provision a named api-key/bearer Connection with a plaintext secret — credential
 * auto-provisioning v1's core write (card 193de09e), called ONLY from the human-only answer boundary
 * (`POST /api/questions/:id/answer`'s credential branch in `gateway/server.ts`), never from an agent path.
 *
 * REFUSES (throws) if a connection by this EXACT name already exists, of ANY auth scheme — v1 deliberately
 * does NOT rotate-in-place (CR finding on this card): `getConnectionByName`'s lookup is GLOBAL and
 * scheme-agnostic, so silently rotating whatever it finds had two live failure modes — (a) provisioning an
 * api-key secret over an EXISTING `oauth2` connection of the same name would overwrite its token-bundle
 * blob with an api-key envelope while `authScheme` stayed `"oauth2"`, so a later `getOAuthTokenBundle`
 * (`JSON.parse` on now-api-key ciphertext) throws — a silent, hard-to-diagnose break; (b) connections have
 * no scope yet, so ANY manager could overwrite an UNRELATED project's api-key connection's secret just by
 * naming it, consent the human never gave. Refusing collision entirely closes both. `updateConnectionSecret`
 * stays on the db layer for a FUTURE scoped-rotation path once card f2abce7e (project-scoped connections)
 * makes "the connection I own" well-defined — a human can always rotate an existing connection today via
 * the Connections settings UI/REST in the meantime. Validates via the SAME `validateConnectionInput` bounds
 * `createConnection` enforces — throws a descriptive Error on invalid input, mirroring `createConnection`'s
 * own structural backstop. The plaintext `secret` is encrypted only inside the delegated `createConnection`
 * call, never here.
 *
 * Concurrency: a race between two answers naming the same new connection (both pass the collision check,
 * both create) is left unhandled in v1 — a single-human loopback daemon makes concurrent answers to the
 * SAME question effectively impossible, and this create-only refusal narrows the window further to two
 * DIFFERENT questions racing to create the identical name at the identical instant. Not worth a transaction
 * for that.
 *
 * SCOPED ROTATION (card f2abce7e unlocks this): when the caller passes `projectId` AND the existing
 * same-name row is scoped to that EXACT project, "the connection I own" is now well-defined — rotate its
 * secret in place via `updateConnectionSecret` (the reserved db-layer seam) instead of refusing. Every
 * OTHER collision still refuses exactly as before: a GLOBAL existing row, a row scoped to a DIFFERENT
 * project, or a caller with no `projectId` at all — so a project can never rotate a connection it doesn't
 * itself own, and the original create-only posture is unchanged for every caller that omits `projectId`.
 * Still guards failure mode (a) from the original design: rotation is refused (same collision error) when
 * the existing same-scope row isn't `api-key` — an `oauth2` row's secret_blob is a JSON token bundle, and
 * overwriting it with a plain api-key envelope while `authScheme` stayed `"oauth2"` would break the next
 * `getOAuthTokenBundle` (`JSON.parse` on now-api-key ciphertext).
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

/**
 * Decrypt a connection's secret for use. Returns the raw plaintext secret for api-key/bearer rows; the
 * seam the P2 authenticated-request tool calls, server-side only, to inject the secret into an outbound
 * request. Never expose this function's return value over REST or to an agent. Returns undefined for an
 * unknown id OR an `oauth2` row (its secret_blob is a JSON token bundle, not a raw secret — callers that
 * need an oauth2 access token must go through `ensureFreshOAuthToken`, which also handles refresh); throws
 * if the stored blob fails to decrypt (corrupt / wrong key), mirroring `decryptSecret`.
 *
 * P4↔P5a interaction: this is also the seam `index.ts`'s `resolveConnectionSecret` calls for a P4
 * capability grant's static env injection — the `undefined` returned for an `oauth2` row here is what
 * makes that injection correctly no-op for oauth2 (fail-closed, never a stale static token). The
 * human-facing guard against binding an oauth2 connection to such a grant in the first place lives at
 * profile-save time: `profiles/validate.ts` › `capabilityGrantBindingError`.
 */
export function getSecretForUse(db: ConnectionsDbStore, id: string, keyPath?: string): string | undefined {
  const row = db.getConnection(id);
  if (!row || row.authScheme === "oauth2") return undefined;
  return decryptSecret(row.secretBlob, keyPath);
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
