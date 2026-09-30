/**
 * Pre-save credential check for the SonarQube connection preset (card 1e8e9b1e, DoD-1: "Validate the
 * host+token against a cheap read endpoint before saving"). HUMAN-only, called from the loopback REST
 * handler in `gateway/server.ts` BEFORE `createConnection` ever persists anything — this module never
 * touches the DB or the envelope; it only makes a live, bounded network probe with the plaintext token the
 * human just typed, and reports whether SonarQube accepted it.
 *
 * @decision 1e8e9b1e — never switch this probe to `/api/authentication/validate`: it returns
 * `{"valid":true}` for an anonymous request whenever the target instance allows anonymous browsing,
 * so a wrong/expired token would silently pass. `/api/users/current` genuinely requires authentication.
 */

import { boundedFetch } from "./boundedFetch.js";

const VALIDATE_TIMEOUT_MS = 8_000;
const VALIDATE_MAX_BYTES = 8_192;

export interface SonarQubeValidateDeps {
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
}

/** Build the probe URL from a BARE host (no scheme, no path) — mirrors `connections/request.ts`'s
 *  `buildRequestUrl` host discipline. Rejects a host the caller pasted a full URL/path into instead of a
 *  bare hostname, with a message that tells them what to fix rather than a raw URL-parse error. */
function buildValidateUrl(host: string): { ok: true; url: URL } | { ok: false; error: string } {
  try {
    const url = new URL(`https://${host}/api/users/current`);
    if (url.protocol !== "https:" || url.host !== host) {
      return { ok: false, error: "host must be a bare hostname (e.g. \"sonarcloud.io\" or \"sonarqube.example.com\"), not a full URL or path" };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, error: "host must be a bare hostname (e.g. \"sonarcloud.io\" or \"sonarqube.example.com\")" };
  }
}

/**
 * Probe `https://<host>/api/users/current` with the given token as a Bearer credential. Never persists
 * anything; a pure live check. Bounded by both a request timeout and a response-byte cap so a slow/huge
 * upstream can't hang the human-facing save flow.
 */
export async function validateSonarQubeCredential(
  deps: SonarQubeValidateDeps,
  host: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const built = buildValidateUrl(host);
  if (!built.ok) return built;

  const result = await boundedFetch(built.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: VALIDATE_TIMEOUT_MS,
    maxResponseBytes: VALIDATE_MAX_BYTES,
    fetchImpl: deps.fetchImpl,
    // A redirect from a SonarQube host during a token-validation probe is exactly as suspect as one from
    // an OAuth token endpoint — treat it as a hard error (the default) rather than following it or
    // reporting on whatever the redirect target sent back.
  });

  // Check the STATUS first, even when the body couldn't be read at all (an oversized or redirect
  // response still carries a status) — a 401/403 is an unambiguous "token rejected" regardless of body
  // size, and reporting that specific, actionable reason must never be masked by a generic byte-cap or
  // redirect error just because the body happened to be too large to read.
  if (result.status === 401 || result.status === 403) {
    return { ok: false, error: "SonarQube rejected the token — check it's a valid, non-expired User Token for this host" };
  }
  if (!result.ok) {
    if (result.kind === "timeout") return { ok: false, error: "the SonarQube host did not respond in time" };
    if (result.kind === "redirect") return { ok: false, error: "the SonarQube host attempted a redirect (not followed) — is the host correct?" };
    // An over-cap 2xx body is reported as a clean, explicit failure here (never silently truncated then
    // parsed) — a genuine /api/users/current response is always small, so an oversized one is itself
    // anomalous, the same posture this module already takes toward a redirect.
    if (result.kind === "oversized") return { ok: false, error: "the SonarQube host response was too large to validate" };
    return { ok: false, error: `could not reach the SonarQube host: ${result.error}` };
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, error: `SonarQube host responded with HTTP ${result.status} — is the host correct?` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return { ok: false, error: "SonarQube host did not return the expected JSON from /api/users/current — is the host correct?" };
  }
  const login = (parsed as { login?: unknown } | null)?.login;
  if (typeof login !== "string" || login.length === 0) {
    return { ok: false, error: "SonarQube accepted the request but returned no authenticated user — check the token" };
  }
  return { ok: true };
}
