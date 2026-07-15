/**
 * The `authenticated_request` MCP tool's core logic (agent-tooling epic P2). Builds ON the P1 credential
 * store (`connections/store.ts`) — this module is the FIRST real caller of `getSecretForUse`. Every
 * load-bearing invariant from the design review lives here:
 *
 *  1. The agent NEVER sees the secret: it's decrypted server-side immediately before dispatch and
 *     redacted out of both the response body AND response headers before the result is returned (an echo
 *     endpoint that reflects the Authorization header back would otherwise leak it straight through).
 *  2. The host allowlist is STRUCTURAL, not a check: the request URL is built from the connection's
 *     stored `host` + the caller's `path` — the caller has no host parameter to attack. A belt-and-
 *     suspenders post-construction assertion (protocol === "https:" && url.host === host) plus a strict
 *     path validator (no leading "//", no backslashes, no embedded "://", no control chars) close the
 *     exotic-parser edge cases the plain string-concat can't be tricked by in the first place.
 *  3. Redirects are NEVER followed (`redirect: "manual"`) — a 3xx comes back to the caller as
 *     {status, location}; the credential is never sent to a redirect target. Because the URL is always
 *     re-derived from the connection's fixed host, reissuing a call can never reach a different host
 *     through this tool regardless of what an upstream redirect says.
 *  4. Bounded: an AbortSignal timeout caps the request, and the response body is read via a streamed
 *     reader that aborts once it exceeds the byte cap — both async, so a hung/huge upstream can't wedge
 *     the daemon event loop.
 *  5. An in-memory per-connection sliding-window rate limiter (the owner-veto-flagged spend guard).
 *
 * agent-tooling P5a: an `oauth2` connection's access token is obtained the SAME way as any other secret —
 * `ensureFreshOAuthToken` (connections/oauth.ts) is called at the identical "decrypt LAST" seam below,
 * transparently refreshing on/near expiry (with cross-caller dedupe) before every dispatch. Both the
 * agent-facing tool AND the PollService poller route through this one function, so both get refresh-on-use
 * for free — neither has its own token-freshness logic.
 *
 * The session-level allowlist (which connection ids a session may use at all) is enforced by the CALLER
 * (mcp/server.ts) before this module ever runs — this module additionally trusts nothing and is safe to
 * call directly in tests.
 */
import type { ConnectionsGuardConfig } from "@loom/shared";
import { getConnectionMetadata, getSecretForUse, isConnectionUsableByProject, type ConnectionsDbStore } from "./store.js";
import { ensureFreshOAuthToken } from "./oauth.js";

export interface AuthenticatedRequestInput {
  /** The P1 connection id to use (must be in the caller's session-pinned allowlist — checked by mcp/server.ts). */
  connection: string;
  /** Request path (+ optional query string). Must start with exactly one "/". Never a full URL. */
  path: string;
  /** HTTP method; defaults to GET. */
  method?: string;
  /** Extra request headers. The `Authorization` header (any case) is REJECTED — Loom injects it. */
  headers?: Record<string, string>;
  /** Request body. A plain string is sent verbatim; an object is JSON-stringified (defaults Content-Type). */
  body?: string | Record<string, unknown>;
}

export type AuthenticatedRequestResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; location?: string }
  | { ok: false; error: string };

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Path validation: reject anything that could confuse a URL parser into treating it as a new authority. */
function validatePath(path: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof path !== "string" || path.length === 0) return { ok: false, error: "path is required" };
  if (!path.startsWith("/")) return { ok: false, error: "path must start with '/'" };
  if (path.startsWith("//")) return { ok: false, error: "path must not start with '//' (protocol-relative)" };
  if (path.includes("\\")) return { ok: false, error: "path must not contain a backslash" };
  if (path.includes("://")) return { ok: false, error: "path must not contain an embedded scheme" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return { ok: false, error: "path must not contain control characters" };
  return { ok: true };
}

/**
 * Build the request URL from the connection's FIXED host + the caller's path — string concatenation,
 * never `new URL(callerInput)`. The post-construction assertion is belt-and-suspenders: since `path` is
 * appended AFTER a fully-specified "https://<host>" prefix, there is no character sequence in `path` that
 * URL parsing can reinterpret as a new authority (a leading "//" is already rejected by validatePath, and
 * any interior "//"/"@"/"://" in a path segment is just part of the path/query/fragment) — but asserting
 * it explicitly makes that guarantee load-bearing rather than merely believed.
 */
function buildRequestUrl(host: string, path: string): URL {
  const url = new URL(`https://${host}${path}`);
  if (url.protocol !== "https:" || url.host !== host) {
    throw new Error("constructed request URL failed the host/protocol allowlist assertion");
  }
  return url;
}

/** Redact every literal occurrence of `secret` from `text`. A no-op on an empty/undefined secret. */
function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

// --- per-connection rate limiter (in-memory, daemon-process lifetime) ---------------------------------
const rateLimitState = new Map<string, number[]>();

/** True if `connectionId` may make another request now; records the attempt when it can. */
function checkRateLimit(connectionId: string, guard: ConnectionsGuardConfig, now: number): boolean {
  const cutoff = now - guard.rateLimitWindowMs;
  const recent = (rateLimitState.get(connectionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= guard.rateLimitMax) {
    rateLimitState.set(connectionId, recent);
    return false;
  }
  recent.push(now);
  rateLimitState.set(connectionId, recent);
  return true;
}

/** TEST-ONLY: clear all in-memory rate-limit state between test cases. */
export function __resetConnectionsRateLimitState(): void {
  rateLimitState.clear();
}

/**
 * Read a fetch Response body bounded by `maxBytes` AND by `signal` (the SAME AbortController the caller
 * armed for the request timeout — kept alive across this read, not just the initial `fetch()` call). A
 * slow-drip upstream (headers arrive fast, body dribbles one byte at a time forever, staying under the
 * byte cap) would otherwise hang this read indefinitely — the byte cap alone does not bound TIME. Races
 * every `reader.read()` against the abort signal explicitly (rather than relying on a given Response's
 * ReadableStream to itself honor the signal, which a hand-rolled test stream — or a stream from a fetch
 * implementation that doesn't wire the signal into body consumption — would not do), so this is bounded
 * regardless of the underlying stream's own behavior.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: true, text: "" };

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, error: `response exceeded the ${maxBytes}-byte cap` };
        }
        chunks.push(value);
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, error: "request timed out" };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

export interface AuthenticatedRequestDeps {
  db: ConnectionsDbStore;
  /** Envelope key-file override — the test seam (never touches the real ~/.loom in tests). */
  keyPath?: string;
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
  /** Clock override — the rate-limiter test seam. */
  now?: () => number;
}

/**
 * Perform a credential-injected HTTP request to a P1 connection. `sessionConnections` is the CALLING
 * session's pinned allowlist (mcp/server.ts resolves it from the session row and passes it in) — this is
 * the server-side double-check that backstops the tools/list omission (defense in depth: even if a
 * session somehow reached this function for a connection outside its grant, it is rejected here too).
 *
 * `callerProjectId` (card f2abce7e, project-scoped connections) is the CALLING session's own project —
 * threaded in server-side (mcp/server.ts's TaskMcpRouter already resolves session→project), never agent-
 * supplied. A project-scoped connection resolves ONLY when it matches (`isConnectionUsableByProject`); a
 * global (`projectId: null`) connection resolves regardless, exactly as every connection did before this
 * card. Optional + defaults to `undefined` so every existing caller/test that omits it is unaffected
 * (those connections are all created global, which passes the check for any caller).
 */
export async function performAuthenticatedRequest(
  deps: AuthenticatedRequestDeps,
  sessionConnections: string[],
  guard: ConnectionsGuardConfig,
  input: AuthenticatedRequestInput,
  callerProjectId?: string | null,
): Promise<AuthenticatedRequestResult> {
  const connectionId = input?.connection;
  if (typeof connectionId !== "string" || !connectionId) {
    return { ok: false, error: "connection is required" };
  }
  if (!sessionConnections.includes(connectionId)) {
    return { ok: false, error: "this session is not permitted to use that connection" };
  }
  const meta = getConnectionMetadata(deps.db, connectionId);
  if (!meta) return { ok: false, error: "connection not found" };
  // Fail-closed trust boundary: a cross-project session whose profile allowlists this id (e.g. a reused
  // Profile, or an owner misconfiguration) must resolve NOTHING for a project-scoped connection it doesn't
  // own. "connection not found" (not a scope-specific message) avoids confirming a scoped connection's
  // existence to a caller outside its project.
  if (!isConnectionUsableByProject(meta.projectId, callerProjectId ?? null)) {
    return { ok: false, error: "connection not found" };
  }

  const pathCheck = validatePath(input.path);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error };

  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return { ok: false, error: `unsupported method '${input.method}'` };

  const callerHeaders = input.headers ?? {};
  const rejectedKey = Object.keys(callerHeaders).find((k) => k.toLowerCase() === "authorization");
  if (rejectedKey) {
    return { ok: false, error: "the Authorization header is injected by Loom and may not be set by the caller" };
  }

  let url: URL;
  try {
    url = buildRequestUrl(meta.host, input.path);
  } catch {
    return { ok: false, error: "failed to construct a valid request URL for this connection's host" };
  }

  // The rate/spend guard counts only GENUINE dispatch attempts — checked here, AFTER every structural
  // validation above, so a caller's malformed path / forbidden header never burns budget it never spent.
  const now = (deps.now ?? Date.now)();
  if (!checkRateLimit(connectionId, guard, now)) {
    return {
      ok: false,
      error: `rate limit exceeded for this connection (max ${guard.rateLimitMax} requests per ${Math.round(guard.rateLimitWindowMs / 1000)}s)`,
    };
  }

  // Decrypt/refresh LAST (right before dispatch) so a rejected call never touches the envelope or fires a
  // refresh_token grant it doesn't need. For `oauth2`, `ensureFreshOAuthToken` (connections/oauth.ts)
  // transparently refreshes on/near expiry (with cross-caller dedupe) — this is the ONE seam both the
  // agent-facing tool AND the PollService poller reach, since both route through this function. `decryptSecret`
  // (the P1 envelope helper) THROWS on a corrupt/wrong-key blob — wrapped so that failure returns the
  // same graceful {ok:false} every other rejection does, instead of propagating an uncaught throw out of
  // the tool handler (no secret leak either way — the crypto error text carries no plaintext — but every
  // other failure path here is a clean return, and this one shouldn't be the lone exception).
  let secret: string | undefined;
  try {
    if (meta.authScheme === "oauth2") {
      const fresh = await ensureFreshOAuthToken({ db: deps.db, keyPath: deps.keyPath, fetchImpl: deps.fetchImpl, now: deps.now }, connectionId);
      if (!fresh.ok) return { ok: false, error: fresh.error };
      secret = fresh.accessToken;
    } else {
      secret = getSecretForUse(deps.db, connectionId, deps.keyPath);
    }
  } catch {
    return { ok: false, error: "connection secret unavailable" };
  }
  if (secret === undefined) return { ok: false, error: "connection not found" }; // revoked between metadata read and use

  const authHeader: Record<string, string> =
    meta.authScheme === "bearer" || meta.authScheme === "oauth2" ? { Authorization: `Bearer ${secret}` } : { "X-API-Key": secret };
  const headers: Record<string, string> = { ...callerHeaders, ...authHeader };

  let requestBody: string | undefined;
  if (input.body !== undefined && method !== "GET" && method !== "DELETE") {
    if (typeof input.body === "string") {
      requestBody = input.body;
    } else {
      requestBody = JSON.stringify(input.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  // Armed across BOTH the fetch AND the bounded body read below (cleared only in the outer finally) —
  // a slow-drip upstream (headers fast, body dribbled forever under the byte cap) must still be bounded
  // by requestTimeoutMs, not just by maxResponseBytes. Clearing this the instant fetch() resolves (headers
  // received) would disarm it for the whole body-read phase, letting a stalled read hang indefinitely.
  const timeout = setTimeout(() => controller.abort(), guard.requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        redirect: "manual", // NEVER auto-follow — invariant 3
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return { ok: false, error: isAbort ? "request timed out" : `request failed: ${(err as Error).message}` };
    }

    const bodyResult = await readBoundedBody(response, guard.maxResponseBytes, controller.signal);
    if (!bodyResult.ok) return { ok: false, error: bodyResult.error };

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return; // never forward Set-Cookie
      responseHeaders[key] = redact(value, secret);
    });

    const result: AuthenticatedRequestResult = {
      ok: true,
      status: response.status,
      headers: responseHeaders,
      body: redact(bodyResult.text, secret),
    };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) result.location = redact(location, secret);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
