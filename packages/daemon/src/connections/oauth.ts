/**
 * OAuth2 authorization-code + PKCE support (agent-tooling epic P5a) — the loopback-redirect flow
 * (RFC 8252) on top of the P1/P5a credential store. Everything here is either HUMAN-only-triggered
 * (`gateway/server.ts`'s consent-initiate REST route + the `GET /oauth/callback` route the user's OWN
 * browser hits) or server-internal (the lazy refresh-on-use seam `connections/request.ts` calls before
 * every dispatch) — no MCP tool ever reaches this module, same trust posture as `connections/store.ts`.
 */
import { randomBytes, createHash } from "node:crypto";
import type { ConnectionsDbStore } from "./store.js";
import { getOAuthTokenBundle, saveOAuthTokens, markConnectionNeedsReauth, type OAuthTokenBundle } from "./store.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh RFC 7636 PKCE code_verifier (43-128 chars; 32 random bytes base64url-encoded is well within range). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** The S256 code_challenge derived from a code_verifier (RFC 7636 §4.2). */
export function codeChallengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** A fresh random `state` param — doubles as the CSRF token correlating the callback to its initiator. */
export function generateOAuthState(): string {
  return base64url(randomBytes(24));
}

// --- Pending consent correlation (in-memory, bounded TTL, one-shot) ---------------------------------
// Keyed by the OAuth `state` param: holds which connection this consent is for + the PKCE code_verifier
// the callback needs to complete the token exchange. NOT persisted — a daemon restart mid-consent simply
// invalidates any in-flight consent (the human re-initiates; nothing security-sensitive is lost, since no
// token was ever issued for it).
export interface PendingOAuthConsent {
  connectionId: string;
  codeVerifier: string;
  createdAt: number;
}

const DEFAULT_PENDING_CONSENT_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a human to complete a browser consent

export class PendingOAuthConsents {
  private readonly map = new Map<string, PendingOAuthConsent>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = DEFAULT_PENDING_CONSENT_TTL_MS) {}

  create(state: string, connectionId: string, codeVerifier: string): void {
    this.sweep();
    this.map.set(state, { connectionId, codeVerifier, createdAt: this.now() });
  }

  /** One-shot: a state is consumed (removed) whether or not it was found, so a state can never be replayed. */
  consume(state: string): PendingOAuthConsent | undefined {
    this.sweep();
    const entry = this.map.get(state);
    if (entry) this.map.delete(state);
    return entry;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [state, entry] of this.map) {
      if (entry.createdAt < cutoff) this.map.delete(state);
    }
  }
}

// --- Token endpoint calls (RFC 6749 §4.1.3 authorization_code / §6 refresh_token, form-encoded) ---------
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Seconds until expiry, per RFC 6749 §5.1. */
  expires_in?: number;
  token_type?: string;
}
export type OAuthTokenResult = { ok: true; tokens: OAuthTokenResponse } | { ok: false; error: string };

async function postTokenRequest(fetchImpl: typeof fetch, tokenUrl: string, params: Record<string, string>): Promise<OAuthTokenResult> {
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    return { ok: false, error: `token request failed: ${(err as Error).message}` };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `token endpoint returned ${response.status}: ${text.slice(0, 500)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `token endpoint returned non-JSON response: ${text.slice(0, 200)}` };
  }
  const tokens = parsed as OAuthTokenResponse;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    return { ok: false, error: "token endpoint response is missing access_token" };
  }
  // expires_in comes from an UNTRUSTED response — a non-finite value (a hostile/nonconforming endpoint
  // sending e.g. "abc" or Infinity) would otherwise reach `new Date(now + expires_in * 1000)` downstream
  // and throw RangeError. Sanitize at the source so every caller (the callback route + refresh-on-use)
  // sees either a genuine finite number or undefined (falsy → treated as "unknown expiry", fail-safe: a
  // null expiresAt forces refresh-on-use rather than trusting a bogus one).
  if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in)) {
    delete tokens.expires_in;
  }
  return { ok: true, tokens };
}

/** Exchange an authorization code + PKCE verifier for a token set (the initial consent completion). */
export function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  tokenUrl: string,
  params: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthTokenResult> {
  return postTokenRequest(fetchImpl, tokenUrl, {
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
}

/** Exchange a refresh token for a fresh access token (RFC 6749 §6). */
export function refreshOAuthToken(
  fetchImpl: typeof fetch,
  tokenUrl: string,
  params: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<OAuthTokenResult> {
  return postTokenRequest(fetchImpl, tokenUrl, {
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });
}

// --- Refresh-on-use, with per-connection dedupe ----------------------------------------------------
// Module-scope, daemon-process lifetime — mirrors the P2 rate-limit Map in connections/request.ts. Keyed
// by connection id: while a refresh for connection X is in flight, every OTHER concurrent caller for X
// awaits the SAME promise instead of firing its own refresh_token grant. This matters because a provider
// may ROTATE (invalidate) the old refresh token on each use — two concurrent refreshes would race to spend
// the same refresh token, and the loser would either get a stale/invalid one back or silently invalidate
// the winner's freshly-issued token.
const inFlightRefresh = new Map<string, Promise<EnsureFreshResult>>();

/** Refresh proactively once within this many ms of expiry, not exactly at it (clock skew + request latency). */
const EXPIRY_BUFFER_MS = 60_000;

export type EnsureFreshResult = { ok: true; accessToken: string } | { ok: false; error: string };

export interface EnsureFreshTokenDeps {
  db: ConnectionsDbStore;
  /** Envelope key-file override — the test seam (never touches the real ~/.loom in tests). */
  keyPath?: string;
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
  /** Clock override — the expiry/dedupe test seam. */
  now?: () => number;
}

/**
 * Return a fresh access token for an `oauth2` connection, refreshing lazily if the current token is
 * absent or within EXPIRY_BUFFER_MS of expiring. This is the ONLY place a refresh_token grant is ever
 * fired — both the `authenticated_request` MCP tool AND the PollService poller reach it transparently via
 * `connections/request.ts`'s `performAuthenticatedRequest`. On an unrecoverable refresh failure (revoked /
 * invalid_grant / no refresh token on file) the connection is marked `needsReauth` and this returns a
 * clean `{ok:false}` — never a stale token, never a throw.
 */
export async function ensureFreshOAuthToken(deps: EnsureFreshTokenDeps, connectionId: string): Promise<EnsureFreshResult> {
  const row = deps.db.getConnection(connectionId);
  if (!row || row.authScheme !== "oauth2") return { ok: false, error: "not an oauth2 connection" };
  if (!row.tokenUrl || !row.clientId) return { ok: false, error: "oauth2 connection is missing its provider configuration" };

  let bundle: OAuthTokenBundle | undefined;
  try {
    bundle = getOAuthTokenBundle(deps.db, connectionId, deps.keyPath);
  } catch {
    return { ok: false, error: "connection token bundle unavailable" };
  }
  if (!bundle) return { ok: false, error: "connection not found" };

  const now = (deps.now ?? Date.now)();
  const expiresAtMs = bundle.expiresAt ? Date.parse(bundle.expiresAt) : NaN;
  const stillFresh = !!bundle.accessToken && Number.isFinite(expiresAtMs) && expiresAtMs - now > EXPIRY_BUFFER_MS;
  if (stillFresh) return { ok: true, accessToken: bundle.accessToken! };

  if (!bundle.refreshToken) {
    markConnectionNeedsReauth(deps.db, connectionId);
    return { ok: false, error: "connection needs re-authentication (no refresh token on file)" };
  }

  const existing = inFlightRefresh.get(connectionId);
  if (existing) return existing;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const clientSecret = bundle.clientSecret;
  const refreshToken = bundle.refreshToken;
  const promise = (async (): Promise<EnsureFreshResult> => {
    try {
      const result = await refreshOAuthToken(fetchImpl, row.tokenUrl!, { clientId: row.clientId!, clientSecret, refreshToken });
      if (!result.ok) {
        markConnectionNeedsReauth(deps.db, connectionId);
        return { ok: false, error: `connection needs re-authentication (refresh failed: ${result.error})` };
      }
      const newExpiresAt = result.tokens.expires_in ? new Date(now + result.tokens.expires_in * 1000).toISOString() : null;
      const newBundle: OAuthTokenBundle = {
        clientSecret,
        accessToken: result.tokens.access_token,
        refreshToken: result.tokens.refresh_token ?? refreshToken, // not every provider rotates the refresh token
        expiresAt: newExpiresAt,
      };
      saveOAuthTokens(deps.db, connectionId, newBundle, deps.keyPath);
      return { ok: true, accessToken: newBundle.accessToken! };
    } finally {
      inFlightRefresh.delete(connectionId);
    }
  })();
  inFlightRefresh.set(connectionId, promise);
  return promise;
}

/** TEST-ONLY: clear in-flight refresh dedupe state between test cases. */
export function __resetOAuthRefreshState(): void {
  inFlightRefresh.clear();
}
