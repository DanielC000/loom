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

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(built.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return { ok: false, error: isAbort ? "the SonarQube host did not respond in time" : `could not reach the SonarQube host: ${(err as Error).message}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "SonarQube rejected the token — check it's a valid, non-expired User Token for this host" };
    }
    if (!response.ok) {
      return { ok: false, error: `SonarQube host responded with HTTP ${response.status} — is the host correct?` };
    }
    let text: string;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        text = "";
      } else {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > VALIDATE_MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
            chunks.push(value);
          }
        }
        text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      }
    } catch {
      return { ok: false, error: "the SonarQube host closed the connection before responding fully" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "SonarQube host did not return the expected JSON from /api/users/current — is the host correct?" };
    }
    const login = (parsed as { login?: unknown } | null)?.login;
    if (typeof login !== "string" || login.length === 0) {
      return { ok: false, error: "SonarQube accepted the request but returned no authenticated user — check the token" };
    }
    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}
