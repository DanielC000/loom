/**
 * The owner-chosen request header that carries an api-key connection's secret (card 0683ac4d; the first
 * consumer is Plex's `X-Plex-Token`). HUMAN-only: set over the loopback REST create/PATCH and the Settings
 * forms, never an MCP tool and never agent-writable. Unset = `X-API-Key`, byte-identical to before.
 *
 * @decision 0683ac4d — never accept a framing/hop-by-hop/credential header name here, and never expose this field on an MCP surface.
 */

export const DEFAULT_API_KEY_HEADER = "X-API-Key";
export const API_KEY_HEADER_MAX = 64;

/** RFC 7230 §3.2.6 `token` (the grammar of a header field-name). */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Names the owner may not point the secret at: request framing, connection management, and the credential
 *  headers Loom already owns (`Authorization` belongs to bearer; `Cookie` is a session credential). `Proxy-*`
 *  is a prefix rule, handled in the validator. Compared case-insensitively. */
const FORBIDDEN_HEADER_NAMES = new Set([
  "host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive", "cookie", "authorization",
  // Body-describing headers (the JSON Content-Type is only added when no key already lower-cases to it, so the secret would BECOME it).
  "content-type", "content-encoding", "content-range",
  // Headers default access-log formats record, and headers proxies/CORS middleware record or reflect.
  "user-agent", "referer", "forwarded", "via", "x-real-ip", "origin",
  // Request-semantics headers a secret must never ride in (`expect` also makes undici throw).
  "expect", "accept", "range", "cache-control", "pragma",
]);
/** Prefix rules, same case-insensitive comparison: proxy hops, forwarded-for chains, content negotiation, conditionals. */
const FORBIDDEN_HEADER_PREFIXES = ["proxy-", "x-forwarded-", "accept-", "if-"];

/** Fixed-text result — never echoes the submitted name. `value` is the trimmed name to store. */
export function validateApiKeyHeaderName(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "apiKeyHeader, when given, must be a string" };
  const name = v.trim();
  if (name.length === 0 || name.length > API_KEY_HEADER_MAX) {
    return { ok: false, error: `apiKeyHeader must be a header name of 1 to ${API_KEY_HEADER_MAX} characters` };
  }
  if (!TOKEN_RE.test(name)) {
    return { ok: false, error: "apiKeyHeader must be a valid HTTP header name (letters, digits and !#$%&'*+-.^_`|~ only)" };
  }
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADER_NAMES.has(lower) || FORBIDDEN_HEADER_PREFIXES.some((p) => lower.startsWith(p))) {
    return { ok: false, error: "apiKeyHeader may not be a framing, connection-management, proxy, content, caching, negotiation, logged or credential header (e.g. Host, Content-*, Connection, Proxy-*, X-Forwarded-*, Accept*, If-*, User-Agent, Referer, Origin, Cookie, Authorization)" };
  }
  return { ok: true, value: name };
}

/** Fixed text for a stored name today's validator refuses — never echoes the name. */
export const INVALID_STORED_API_KEY_HEADER_REASON = "the stored API key header name is no longer allowed; edit the connection to choose another";

/** The header the api-key secret is sent in: the stored override, else the default. */
export function apiKeyHeaderFor(stored: string | null | undefined): string {
  return stored && stored.length > 0 ? stored : DEFAULT_API_KEY_HEADER;
}
