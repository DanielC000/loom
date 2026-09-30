/**
 * Shared bounded-HTTP primitive for every outbound call under `connections/` that carries a secret in
 * the request — an OAuth token-endpoint exchange (`oauth.ts`), an `authenticated_request` dispatch
 * (`request.ts`), a pre-save credential probe (`sonarqube.ts`). One implementation, three call sites.
 *
 * @decision 25c93b6f — every secret-bearing fetch under connections/ must go through this helper, never
 * a second hand-rolled implementation, and `treatRedirectAsError: false` must never spread beyond
 * request.ts's authenticated_request tool.
 *
 * Unconditional guarantees:
 *  1. `redirect: "manual"`, ALWAYS — a redirect is never auto-followed, so a credential riding the
 *     request can never be re-sent to a 3xx `Location` the caller doesn't control. `treatRedirectAsError`
 *     (default `true`) only decides whether a 3xx counts as a **result** or an **error** for this call —
 *     it never affects whether the redirect is followed.
 *  2. An `AbortSignal` timeout bounds BOTH the `fetch()` call and the body read — a hung upstream
 *     resolves this call within `timeoutMs` no matter which phase it hangs in.
 *  3. The response body is capped WHILE STREAMING, never after buffering.
 */

export interface BoundedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** AbortSignal timeout (ms), covering both the fetch call and the streamed body read. */
  timeoutMs: number;
  /** Response body cap (bytes), enforced while streaming. */
  maxResponseBytes: number;
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
  /** See the file-header doc above. Default `true`. */
  treatRedirectAsError?: boolean;
}

export type BoundedFetchResult =
  | { ok: true; status: number; headers: Headers; text: string }
  // `status` is present whenever a real HTTP response actually arrived before the failure (redirect,
  // oversized, or a timeout during the body read) — absent for "network" and a timeout during the
  // INITIAL fetch() call, where no response ever came back. A caller that needs to classify by status
  // even when the body itself couldn't be read (e.g. sonarqube.ts: an oversized 401 body must still be
  // reported as "token rejected", not swallowed by a generic byte-cap error) reads this field directly —
  // do not force every such caller to re-derive it by re-deriving its own fetch call.
  | { ok: false; error: string; kind: "network" | "timeout" | "oversized" | "redirect"; status?: number };

/**
 * Read a fetch Response body bounded by `maxBytes` AND by `signal` (the SAME AbortController the caller
 * armed for the request timeout — kept alive across this read, not just the initial `fetch()` call). A
 * slow-drip upstream (headers arrive fast, body dribbles one byte at a time forever, staying under the
 * byte cap) would otherwise hang this read indefinitely — the byte cap alone does not bound TIME. Races
 * every `reader.read()` against the abort signal explicitly (rather than relying on a given Response's
 * ReadableStream to itself honor the signal, which a hand-rolled test stream — or a fetch implementation
 * that doesn't wire the signal into body consumption — would not do), so this is bounded regardless of
 * the underlying stream's own behavior.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string; kind: "timeout" | "oversized" }> {
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
          return { ok: false, error: `response exceeded the ${maxBytes}-byte cap`, kind: "oversized" };
        }
        chunks.push(value);
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, error: "request timed out", kind: "timeout" };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/** See the file-header doc above for the three guarantees this makes unconditionally. */
export async function boundedFetch(url: string | URL, opts: BoundedFetchOptions): Promise<BoundedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // Armed across BOTH the fetch AND the bounded body read below (cleared only in the outer finally) — see
  // guarantee 2 above: clearing this the instant fetch() resolves would disarm it for the whole body-read
  // phase, letting a stalled read hang past timeoutMs.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return isAbort
        ? { ok: false, error: "request timed out", kind: "timeout" }
        : { ok: false, error: (err as Error).message, kind: "network" };
    }

    const treatRedirectAsError = opts.treatRedirectAsError !== false;
    if (treatRedirectAsError && response.status >= 300 && response.status < 400) {
      // Cancel the stream (never read it) so the connection can be released — the body is never
      // surfaced either way, so there is nothing to gain by draining it first.
      await response.body?.cancel().catch(() => {});
      return { ok: false, error: `unexpected HTTP ${response.status} redirect (redirects are never followed)`, kind: "redirect", status: response.status };
    }

    const bodyResult = await readBoundedBody(response, opts.maxResponseBytes, controller.signal);
    if (!bodyResult.ok) return { ok: false, error: bodyResult.error, kind: bodyResult.kind, status: response.status };

    return { ok: true, status: response.status, headers: response.headers, text: bodyResult.text };
  } finally {
    clearTimeout(timer);
  }
}
