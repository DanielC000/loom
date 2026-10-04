/**
 * Shared bounded-HTTP primitives for every outbound call that carries a secret in the request — an
 * OAuth token-endpoint exchange (`connections/oauth.ts`), an `authenticated_request` dispatch
 * (`connections/request.ts`), a pre-save credential probe (`connections/sonarqube.ts`), the Claude
 * plan-usage poller (`orchestration/usage-status.ts`), the Telegram attachment downloader
 * (`companion/telegram.ts`), and the alert/run webhook posters (`orchestration/alert-webhook.ts`,
 * `sessions/service.ts`) — card 731aa517 widened this beyond `connections/` to every secret-bearing
 * outbound fetch in the daemon, not just the connections subsystem.
 *
 * @decision 25c93b6f — every secret-bearing fetch under connections/ must go through this helper, never
 * a second hand-rolled implementation, and `treatRedirectAsError: false` must never spread beyond
 * request.ts's authenticated_request tool.
 *
 * Unconditional guarantees (shared by BOTH `guardedFetch` and `boundedFetch` below, since the latter is
 * built on the former):
 *  1. `redirect: "manual"`, ALWAYS — a redirect is never auto-followed, so a credential riding the
 *     request can never be re-sent to a 3xx `Location` the caller doesn't control. `treatRedirectAsError`
 *     (default `true`) only decides whether a 3xx counts as a **result** or an **error** for this call —
 *     it never affects whether the redirect is followed.
 *  2. An `AbortSignal` timeout bounds BOTH the `fetch()` call and the body read — a hung upstream
 *     resolves this call within `timeoutMs` no matter which phase it hangs in.
 *  3. The response body is capped WHILE STREAMING, never after buffering — `boundedFetch` enforces this
 *     itself (see `readBoundedBody`); a `guardedFetch` caller that streams the body itself (a binary
 *     download that can't be buffered as UTF-8 text) is responsible for enforcing its OWN cap on the
 *     `response.body` it gets back, using the SAME `signal` so a slow-drip stream stays bounded by the
 *     same timeout — card 731aa517's `companion/telegram.ts` is the concrete case: it streams straight to
 *     disk through its own byte-capped Transform rather than buffering, so it cannot use `boundedFetch`'s
 *     text-buffering wrapper, but still shares this file's ONE redirect+timeout guarantee via `guardedFetch`.
 *  4. A `guardedFetch`-level `network`/`timeout` error is ALWAYS a fixed, URL-free message (card 731aa517
 *     round 2) — a raw fetch/undici error is never passed through as-is, since undici embeds the full
 *     request URL verbatim in some of its own errors (e.g. "Failed to parse URL from <url>" on a
 *     malformed URL), and the URL is exactly what every caller here needs kept out of an agent-facing
 *     error. The error `code` (e.g. ECONNREFUSED, ERR_INVALID_URL) is kept when present — diagnostic
 *     without ever being able to carry a caller-supplied URL. Card 863d30c0: undici's real `fetch` never
 *     sets `err.code` itself — it throws a generic `TypeError: fetch failed` and puts the real code on
 *     `err.cause.code`, so the code is read from there (never from `err.cause.message`, which embeds
 *     host:port).
 */

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** AbortSignal timeout (ms). Stays armed until the caller calls the returned `cancelTimeout()` — for
   *  a streaming caller that means across its own body read too, not just this initial fetch(). */
  timeoutMs: number;
  /** fetch override — the hermetic test seam (never makes a real network call in tests). */
  fetchImpl?: typeof fetch;
  /** See the file-header doc above. Default `true`. */
  treatRedirectAsError?: boolean;
}

export type GuardedFetchResult =
  | { ok: true; response: Response; signal: AbortSignal; cancelTimeout: () => void }
  // Mirrors BoundedFetchResult's error variant minus the streaming-only "oversized" kind — a guardedFetch
  // caller hasn't read any body yet, so it can only ever fail at "network", "timeout" (the initial
  // fetch() call only — a caller streaming its own body is responsible for its OWN timeout-during-read
  // classification), or "redirect".
  | { ok: false; error: string; kind: "network" | "timeout" | "redirect"; status?: number };

export interface BoundedFetchOptions extends GuardedFetchOptions {
  /** Response body cap (bytes), enforced while streaming. */
  maxResponseBytes: number;
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

/**
 * The shared fetch+redirect-guard leg, factored out of `boundedFetch` below (card 731aa517) so a caller
 * that must stream its own body (can't buffer-and-decode-as-text — a binary download being written to
 * disk under its own byte cap, e.g. `companion/telegram.ts`) still gets the SAME unconditional
 * `redirect:"manual"` + timeout guarantee, without being forced through `boundedFetch`'s UTF-8 text
 * buffering. On `{ok:true}` the caller owns `response`/`signal` from here on — it must keep using
 * `signal` for its own body read (so a slow-drip stream is bounded by the SAME timeout, exactly like
 * `boundedFetch`'s `readBoundedBody` below) and must call `cancelTimeout()` itself once done (success,
 * error, or its own cap trip) — this function does NOT clear the timer on the `{ok:true}` path, since
 * the operation the timer bounds is not yet finished.
 */
export async function guardedFetch(url: string | URL, opts: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const cancelTimeout = () => clearTimeout(timer);

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
    cancelTimeout();
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) return { ok: false, error: "request timed out", kind: "timeout" };
    // Card 731aa517 round 2: never pass a raw fetch/undici error message through as-is — undici embeds
    // the full request URL verbatim in some of its own errors (e.g. "Failed to parse URL from
    // http://.../bot123:SECRET/x" on a malformed URL), and the URL is exactly what a secret-bearing
    // caller here needs to keep out of an agent-facing error. Map to a fixed, URL-free message, keeping
    // the error `code` when present — diagnostic without ever being able to carry a caller-supplied URL.
    // Card 863d30c0: Node's real `fetch` (undici) wraps the underlying socket/DNS error as `err.cause`,
    // NOT `err.code` — the top-level error is always a generic `TypeError: fetch failed` with
    // `code: undefined`; the real code (ECONNREFUSED/ENOTFOUND/ERR_INVALID_URL) lives on `err.cause.code`.
    // Check the top-level `code` first (so a non-undici `fetchImpl` — a test double, or a future engine —
    // that DOES set it directly still works), then fall back to `err.cause?.code`. Never read
    // `err.cause?.message` — undici's cause often embeds the host:port, which must stay out of this
    // agent-facing error.
    const topCode = (err as { code?: unknown } | null)?.code;
    const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    const code = typeof topCode === "string" && topCode ? topCode : causeCode;
    const suffix = typeof code === "string" && code ? ` (${code})` : "";
    return { ok: false, error: `network error${suffix}`, kind: "network" };
  }

  const treatRedirectAsError = opts.treatRedirectAsError !== false;
  if (treatRedirectAsError && response.status >= 300 && response.status < 400) {
    // Cancel the stream (never read it) so the connection can be released — the body is never
    // surfaced either way, so there is nothing to gain by draining it first.
    await response.body?.cancel().catch(() => {});
    cancelTimeout();
    return { ok: false, error: `unexpected HTTP ${response.status} redirect (redirects are never followed)`, kind: "redirect", status: response.status };
  }

  return { ok: true, response, signal: controller.signal, cancelTimeout };
}

/** See the file-header doc above for the three guarantees this makes unconditionally. */
export async function boundedFetch(url: string | URL, opts: BoundedFetchOptions): Promise<BoundedFetchResult> {
  const guarded = await guardedFetch(url, opts);
  if (!guarded.ok) return guarded;
  try {
    const bodyResult = await readBoundedBody(guarded.response, opts.maxResponseBytes, guarded.signal);
    if (!bodyResult.ok) return { ok: false, error: bodyResult.error, kind: bodyResult.kind, status: guarded.response.status };

    return { ok: true, status: guarded.response.status, headers: guarded.response.headers, text: bodyResult.text };
  } finally {
    guarded.cancelTimeout();
  }
}
