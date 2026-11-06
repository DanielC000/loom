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
import {
  getConnectionMetadata, getSecretForUse, isConnectionUsableByProject, resolveUsableConnections,
  type ConnectionsDbStore, type UsableConnectionSummary,
} from "./store.js";
import { ensureFreshOAuthToken } from "./oauth.js";
import { boundedFetch } from "./boundedFetch.js";
import { apiKeyHeaderFor } from "./apiKeyHeader.js";
import { buildSecretRedactor, RedactionBudgetExceeded } from "./redact.js";
import { hostRoundTrips, type ConnectionUrlScheme } from "./hostForm.js";
import { createPinnedHttpFetch, daemonReservedPorts, resolveLanTarget, type LanTarget, type LookupImpl } from "./lanHttp.js";

export interface AuthenticatedRequestInput {
  /** The P1 connection's id, OR — card 298b826e — a NAME that matches exactly one connection in the
   *  caller's session-pinned allowlist (checked by mcp/server.ts). An id always takes priority: it is
   *  tried first, so a connection legitimately NAMED the same as another one's id is never shadowed. */
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
  // `usableConnections` (card 298b826e) rides every refusal that occurs while RESOLVING the caller's
  // `connection` input — not-permitted, not-found (missing metadata or out-of-project-scope), and
  // ambiguous-name — {id,name,host} ONLY, never the secret, and already scope-filtered by
  // `resolveUsableConnections` so it can never list a connection this caller's project can't reach. Absent
  // on every OTHER refusal (bad path/method, rejected header, rate limit, …) — those occur AFTER a
  // connection has already resolved, so there is nothing to disambiguate. This INCLUDES the late
  // "connection not found" right before dispatch (revoked between the metadata read and use, below) —
  // despite sharing its error text with the resolution-time not-found refusal above, it fires after
  // resolution already succeeded once, so it omits `usableConnections` too.
  | { ok: false; error: string; usableConnections?: UsableConnectionSummary[] };

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
function buildRequestUrl(host: string, path: string, scheme: ConnectionUrlScheme = "https"): URL {
  // `URL` lowercases the host, so the shared round-trip compares against the lowercased stored host: a
  // mixed-case host names the same server and must not fail the allowlist assertion. Checked BEFORE building
  // so a host URL would throw on (e.g. `[1.2.3.4]`) fails with the same allowlist error. The scheme is the
  // connection's own opt-in (never parsed out of `host`), and ONE helper serves both forms.
  if (!hostRoundTrips(host, scheme)) {
    throw new Error("constructed request URL failed the host/protocol allowlist assertion");
  }
  const url = new URL(`${scheme}://${host}${path}`);
  if (url.protocol !== `${scheme}:` || url.host !== host.toLowerCase()) {
    throw new Error("constructed request URL failed the host/protocol allowlist assertion");
  }
  return url;
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

export interface AuthenticatedRequestDeps {
  db: ConnectionsDbStore;
  /** Envelope key-file override — the test seam (never touches the real ~/.loom in tests). */
  keyPath?: string;
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
  /** Clock override — the rate-limiter test seam. */
  now?: () => number;
  /** DNS override for an opt-in plain-http connection — the hermetic test seam (never a real lookup in tests). */
  lookupImpl?: LookupImpl;
  /** Builds the fetch pinned to the CHECKED address for an opt-in plain-http connection. Test seam only — the
   *  default dials the address via `node:http`. */
  pinnedFetchFactory?: (target: LanTarget) => typeof fetch;
  /** Per-redact-call wall-clock budget override. Test seam only (a negative value is an already-spent budget);
   *  the default is `REDACT_BUDGET_MS`. */
  redactBudgetMs?: number;
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
  const requested = input?.connection;
  if (typeof requested !== "string" || !requested) {
    return { ok: false, error: "connection is required" };
  }

  // The caller's USABLE allowlist (card 298b826e) — {id,name,host}, already scope-filtered by
  // `resolveUsableConnections`. This is the ONLY list ever handed back to the caller below, and NAME
  // resolution below searches only THIS list — a connection outside `callerProjectId`'s scope can
  // therefore never be matched, listed, or confirmed to exist by name, exactly preserving the raw-id
  // path's existing fail-closed "connection not found" (never scope-specific) wording further down.
  const usable = resolveUsableConnections(deps.db, sessionConnections, callerProjectId);

  let connectionId: string;
  if (sessionConnections.includes(requested)) {
    // Exact id match against the RAW pinned allowlist — byte-identical to pre-298b826e behavior: an id
    // outside the caller's project scope, or one whose metadata is gone, still falls through to the SAME
    // "connection not found" refusal below (never a different message).
    connectionId = requested;
  } else {
    // Not a raw id on this session's allowlist — try NAME resolution, but only against the already
    // scope-filtered `usable` list, never the raw one (see the comment above `usable`).
    const matches = usable.filter((c) => c.name === requested);
    const onlyMatch = matches.length === 1 ? matches[0] : undefined;
    if (onlyMatch) {
      connectionId = onlyMatch.id;
    } else if (matches.length > 1) {
      return {
        ok: false,
        error: `"${requested}" matches ${matches.length} of this session's allowlisted connections by name — use the id instead.`,
        usableConnections: matches,
      };
    } else {
      return { ok: false, error: "this session is not permitted to use that connection", usableConnections: usable };
    }
  }

  const meta = getConnectionMetadata(deps.db, connectionId);
  if (!meta) return { ok: false, error: "connection not found", usableConnections: usable };
  // Fail-closed trust boundary: a cross-project session whose profile allowlists this id (e.g. a reused
  // Profile, or an owner misconfiguration) must resolve NOTHING for a project-scoped connection it doesn't
  // own. "connection not found" (not a scope-specific message) avoids confirming a scoped connection's
  // existence to a caller outside its project. `usableConnections` is safe to attach regardless — it
  // never includes the connection that just failed this check, by construction of `usable` above.
  if (!isConnectionUsableByProject(meta.projectId, callerProjectId ?? null)) {
    return { ok: false, error: "connection not found", usableConnections: usable };
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

  // The owner's plain-http opt-in (card 1d882a8c) is honoured ONLY for api-key/bearer — an oauth2 row's
  // token exchange stays https, and an ssh row never reaches this tool's HTTP path.
  const plainHttp = meta.allowPlainHttp === true && (meta.authScheme === "api-key" || meta.authScheme === "bearer");
  let url: URL;
  try {
    url = buildRequestUrl(meta.host, input.path, plainHttp ? "http" : "https");
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

  // Plain http: resolve the host ONCE now, require the RESOLVED address(es) to be private LAN (the DNS-rebinding
  // guard — see lanHttp.ts for the exact class rules), and PIN the dispatch to that address so nothing is
  // resolved again between this check and the connect. Placed after the rate limit so a caller cannot use
  // refused calls to drive unbounded DNS, and before the secret is decrypted so a refusal never touches it.
  let dispatchFetch = deps.fetchImpl;
  if (plainHttp) {
    const lan = await resolveLanTarget(meta.host, { lookupImpl: deps.lookupImpl, timeoutMs: guard.requestTimeoutMs, reservedPorts: daemonReservedPorts(deps.db) });
    if (!lan.ok) return { ok: false, error: lan.error };
    dispatchFetch = (deps.pinnedFetchFactory ?? ((t: LanTarget) => createPinnedHttpFetch(t)))(lan.target);
  }

  // Decrypt/refresh LAST (right before dispatch) so a rejected call never touches the envelope or fires a
  // refresh_token grant it doesn't need. For `oauth2`, `ensureFreshOAuthToken` (connections/oauth.ts)
  // transparently refreshes on/near expiry (with cross-caller dedupe) — this is the ONE seam both the
  // agent-facing tool AND the PollService poller reach, since both route through this function. `decryptSecret`
  // (the P1 envelope helper) THROWS on a corrupt/wrong-key blob — wrapped so that failure returns the
  // same graceful {ok:false} every other rejection does, instead of propagating an uncaught throw out of
  // the tool handler (no secret leak either way — the crypto error text carries no plaintext — but every
  // other failure path here is a clean return, and this one shouldn't be the lone exception).
  // A stored api-key header name that today's validator refuses fails closed BEFORE the secret is decrypted
  // or any fetch happens; fixed text, never the name or the secret.
  if (meta.invalidApiKeyHeader) return { ok: false, error: "connection api key header is invalid; edit the connection" };
  let secret: string | undefined;
  try {
    if (meta.authScheme === "oauth2") {
      const fresh = await ensureFreshOAuthToken({ db: deps.db, keyPath: deps.keyPath, fetchImpl: deps.fetchImpl, now: deps.now, guard }, connectionId);
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
    meta.authScheme === "bearer" || meta.authScheme === "oauth2" ? { Authorization: `Bearer ${secret}` } : { [apiKeyHeaderFor(meta.apiKeyHeader)]: secret };
  // A caller header that differs from the injected credential header only by case would travel beside it
  // (an object spread is case-sensitive), so Loom's own credential header always wins outright.
  const authKeyLower = Object.keys(authHeader)[0]!.toLowerCase();
  const keptCallerHeaders = Object.fromEntries(Object.entries(callerHeaders).filter(([k]) => k.toLowerCase() !== authKeyLower));
  const headers: Record<string, string> = { ...keptCallerHeaders, ...authHeader };

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

  // treatRedirectAsError: false — invariant 3. A 3xx is NEVER auto-followed (boundedFetch's redirect:
  // "manual" is unconditional) but IS surfaced to the caller as {status, location} data, since the caller
  // can't see the credential either way and may legitimately want to know a resource moved.
  const result = await boundedFetch(url, {
    method,
    headers,
    body: requestBody,
    timeoutMs: guard.requestTimeoutMs,
    maxResponseBytes: guard.maxResponseBytes,
    fetchImpl: dispatchFetch,
    treatRedirectAsError: false,
  });
  if (!result.ok) return { ok: false, error: result.error };

  // Exact secret plus its common re-encodings (redact.ts), computed once for body, headers and location.
  const redact = buildSecretRedactor(secret, deps.redactBudgetMs);
  try {
    const responseHeaders: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return; // never forward Set-Cookie
      responseHeaders[key] = redact(value);
    });

    const final: AuthenticatedRequestResult = {
      ok: true,
      status: result.status,
      headers: responseHeaders,
      body: redact(result.text),
    };
    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.get("location");
      if (location) final.location = redact(location);
    }
    return final;
  } catch (err) {
    // Fail closed: redaction is linear, so this is defence in depth. NEVER fall back to the unredacted response.
    if (err instanceof RedactionBudgetExceeded) return { ok: false, error: "response redaction exceeded its time budget; the response was withheld" };
    throw err;
  }
}
