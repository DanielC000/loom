/**
 * Proving a candidate credential against the daemon, for BOTH credentials this app holds (the loopback
 * write secret, `lib/loopbackCredential.ts`; the gateway token, `lib/gatewayCredential.ts`). JSX-free on
 * purpose — the classifier and the hold are pure and unit-tested by `test/credential-verify.mjs`.
 *
 * Each path keeps its own PROBE, because what proves passage differs: loopback POSTs an empty patch to an
 * UPDATE-by-id route with a fresh uuid (its 404 IS the proof the write guard let us through), while the
 * gateway GETs a Tier-1 read (only a 2xx proves it). What they must NOT keep their own copy of is the
 * three-state ALGEBRA below.
 *
 * Collapsing the two failures into one boolean — a dropped request and a real 401 — is what made an
 * offline daemon and a reverse proxy's pre-auth 403 report a refusal nobody had observed.
 *
 * @decision a1ec70a6 — never show a refusal for anything but a real 401, and never store a credential on
 * an outcome short of `valid`.
 */

/**
 * `valid` — the credential got past the auth layer. `invalid` — the auth layer itself rejected it (a 401,
 * and nothing else). `unknown` — we learned nothing: the request never landed, or something answered that
 * is not evidence either way. Only `invalid` licenses a refusal in the UI; `unknown` means "ask again".
 */
export type CredentialVerifyOutcome = "valid" | "invalid" | "unknown";

/**
 * Run one credential probe and classify it. `provesPassage` is the PATH's own answer to "given this
 * non-401 status, did my probe reach its route?" — the classifier never guesses it, because a 404 is proof
 * on one path and meaningless on the other.
 *
 * The 401 check deliberately runs FIRST, so no path can opt out of it with a lax predicate, and a thrown
 * probe (offline, DNS, CORS, an aborted navigation) is `unknown` rather than a refusal.
 *
 * `provesRefusal` is the ONE narrow extension of that: a path whose auth layer can refuse a credential
 * with a status other than 401 (the gateway's failed-auth 429, which the daemon answers only to a token
 * that just FAILED verification — card cf9ebab9) says so here. It is consulted LAST, only for a response
 * that would otherwise be `unknown`, and it reads the BODY — so it is async, and anything it throws
 * (a non-JSON body, an already-consumed stream) falls back to `unknown` rather than rejecting.
 *
 * @decision a1ec70a6 — a path may widen what counts as a REFUSAL only for a status its own auth layer
 * authored. Never widen it to a status an intermediary could have produced: that fabricates the one
 * observation the whole three-state split exists to protect.
 */
export async function classifyCredentialProbe(
  probe: () => Promise<Response>,
  provesPassage: (status: number) => boolean,
  provesRefusal?: (response: Response) => Promise<boolean>,
): Promise<CredentialVerifyOutcome> {
  let response: Response;
  try {
    response = await probe();
  } catch {
    return "unknown"; // the request never reached the daemon, so the credential was never tested
  }
  if (response.status === 401) return "invalid";
  if (provesPassage(response.status)) return "valid";
  if (provesRefusal) {
    try {
      if (await provesRefusal(response)) return "invalid";
    } catch {
      /* an unreadable body proves nothing either way — fall through to `unknown` */
    }
  }
  return "unknown";
}

/**
 * Where a path parks a candidate it could not CHECK, so the user can retry instead of losing it. A
 * `?token=` link is `loom open`'s one-shot delivery of a secret the user may have no other copy of, and a
 * daemon that was briefly unreachable is the likeliest reason a check comes back `unknown` — so throwing
 * the candidate away on that outcome punishes the user for the daemon's downtime.
 *
 * A held candidate is NOT a credential: it lives in sessionStorage, never in the localStorage slot the
 * app authenticates from, and nothing ever AUTHENTICATES with it — only an explicit retry re-proves it,
 * and the rest of the app reads it for PRESENCE alone (both credential modules read it once at module
 * init, to decide whether a Retry affordance is outstanding). So "never STORE a credential unverified"
 * stays intact while the unknown case recovers.
 *
 * The lifetime is per-TAB, not per-visit: sessionStorage is scoped to one tab and invisible to others,
 * but the browser re-populates it on a tab restore and COPIES it into a duplicated tab — so the hold can
 * outlive the navigation that created it. That is the bound this buys over localStorage (no sharing
 * across tabs or windows, gone when the tab is genuinely closed), not a guarantee of a single read.
 *
 * @decision a1ec70a6 — do not move a held candidate to localStorage, and do not auto-retry it on a timer:
 * a retry is a guarded round trip the user asks for, visibly, once.
 */
export interface PendingCandidateStore {
  /** The held candidate, trimmed, or null when there is nothing to retry. */
  read(): string | null;
  /** Hold a candidate. An empty/whitespace value is not held — there would be nothing to retry. */
  write(candidate: string): void;
  /** Drop the candidate: it was stored, refused, or dismissed by the user. */
  clear(): void;
}

/** A hold on `key`. Every access is swallowed on failure (private mode, blocked site data) — a missing
 *  hold costs the retry affordance, never a render or a write. */
export function pendingCandidateStore(key: string): PendingCandidateStore {
  return {
    read() {
      try {
        const held = typeof window !== "undefined" ? window.sessionStorage.getItem(key) : null;
        return held && held.trim() ? held.trim() : null;
      } catch {
        return null;
      }
    },
    write(candidate: string) {
      const trimmed = candidate.trim();
      if (!trimmed) return;
      try {
        window.sessionStorage.setItem(key, trimmed);
      } catch {
        /* no hold, so no retry button — the paste field is still there */
      }
    },
    clear() {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* nothing to do: a hold we cannot remove is one we also cannot read */
      }
    },
  };
}
