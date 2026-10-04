/**
 * The loopback write credential: where this browser keeps it, and the "writes are locked" state the UI
 * shows when it doesn't have one. JSX-free on purpose — every predicate below is pure and unit-tested by
 * `test/loopback-credential.mjs`; the React surface is `components/CredentialBanner.tsx`.
 *
 * A browser that reached the daemon through a tunnel presents a LOOPBACK socket (so the daemon's write
 * guard applies) but has its own origin storage (so it holds no token) — reads render, writes 401, both
 * WebSocket panes fail their upgrade, and `loom open` is unrunnable there.
 *
 * @decision 093981dd — never show the paste field on a browser that already holds a token, and never
 * print or embed the secret itself in the instruction copy.
 */
import {
  classifyCredentialProbe, pendingCandidateStore, type CredentialVerifyOutcome,
} from "./credentialVerify";

/** Card 9ccedbee's storage key. Per-ORIGIN: a tunnelled device's own origin never sees the host's copy. */
const LOOPBACK_TOKEN_STORAGE_KEY = "loom.loopbackToken";

/** Where a candidate we could not CHECK waits for a retry — this tab only, and never read as a credential.
 *  See `credentialVerify.ts`'s `pendingCandidateStore` for why that is not the slot above. */
const pendingLoopback = pendingCandidateStore("loom.loopbackTokenPending");

/** localStorage can throw (private mode, blocked site data) — never let that break a render or a write. */
function readStorage(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** The captured loopback token, or null if this browser has never captured one. */
export function getLoopbackToken(): string | null {
  return readStorage(LOOPBACK_TOKEN_STORAGE_KEY);
}

/**
 * Persist a VERIFIED token. Trimmed, because the value is copied by hand off the host and picks up
 * whitespace/newlines on the way. An empty result is rejected rather than stored — writing "" would read
 * back as a captured-but-useless credential.
 *
 * Not even a test-only seed export: a test seeds its OWN fake localStorage, so this module exports no
 * write path at all rather than one it merely asks callers not to use.
 *
 * @decision a1ec70a6 — module-PRIVATE, and it must stay that way: the only caller is
 * `storeVerifiedLoopbackToken` below, so no call site can write the secret without proving it first.
 */
function writeLoopbackToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  try {
    window.localStorage.setItem(LOOPBACK_TOKEN_STORAGE_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

/** What became of a candidate secret: stored, refused by the daemon, never checked, or unstorable here. */
export type LoopbackCaptureOutcome = "none" | "stored" | "rejected" | "unverified" | "unstorable";

/**
 * Capture `?token=` from the current URL, strip it from the visible URL at once so the secret doesn't sit
 * in the address bar / get shared by a copied link, and — card a1ec70a6 — VERIFY it against the daemon
 * through `storeVerifiedLoopbackToken` before persisting it. This is `loom open`'s delivery path
 * (bin/loom.mjs `urlWithToken`). `verify` and `reload` are injectable for the unit test.
 *
 * A candidate the daemon never answered for (`"unverified"`) is HELD for a retry rather than discarded —
 * `loom open`'s link may be the only copy of that secret the user has, and an unreachable daemon is the
 * likeliest reason a check comes back unknown.
 *
 * @decision a1ec70a6 — never store this param unverified: any link to `127.0.0.1:4317/?token=x` would
 * evict the browser's working credential and break every write. Strip the param either way, good or bad,
 * and claim a refusal ONLY for a real 401.
 */
export async function captureTokenFromUrl(
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyLoopbackToken,
  reload: () => void = () => { window.location.reload(); },
): Promise<LoopbackCaptureOutcome> {
  if (typeof window === "undefined") return "none";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return "none";
  // Best-effort: a `replaceState` that THROWS (a browser that has none, a hostile override) must not
  // reject this promise — api.ts calls us with a bare `void`, so that would surface as an unhandled
  // rejection AND leave the secret in the address bar with the capture half-done.
  try {
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* the param stays visible; the already-held check below still bounds the reload */
  }
  // Already holding exactly this secret: nothing to prove and nothing to reconnect. Also the structural
  // guard against a reload loop — if the strip above silently NO-OPPED (or threw and was swallowed), the
  // URL still carries the param, and an unconditional reload would re-enter here on it forever.
  if (getLoopbackToken() === token.trim()) return "stored";
  const outcome = await storeVerifiedLoopbackToken(token, verify);
  if (outcome !== "stored") {
    // Held only for the one outcome a retry can still change. A refusal is final (the daemon answered),
    // and an unstorable secret verified fine — holding either would offer a retry that cannot help.
    if (outcome === "unverified") pendingLoopback.write(token);
    else pendingLoopback.clear();
    noteLoopbackLinkOutcome(outcome === "refused" ? "rejected" : outcome);
    return outcome === "refused" ? "rejected" : outcome;
  }
  clearCredentialLock();
  reload(); // requests already in flight carried no token; a reload is the simplest correct reconnect
  return "stored";
}

/**
 * Re-check the candidate held by an earlier `"unverified"` capture — the banner's Retry. Resolves
 * `"none"` when there is nothing held; otherwise the same outcomes as a capture. A still-unknown retry
 * KEEPS the hold (the daemon may come back); every other outcome is terminal and drops it.
 */
export async function retryPendingLoopbackToken(
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyLoopbackToken,
  reload: () => void = () => { window.location.reload(); },
): Promise<LoopbackCaptureOutcome> {
  const candidate = pendingLoopback.read();
  if (!candidate) return "none";
  const outcome = await storeVerifiedLoopbackToken(candidate, verify);
  if (outcome === "unverified") {
    noteLoopbackLinkOutcome("unverified");
    return "unverified";
  }
  pendingLoopback.clear();
  if (outcome !== "stored") {
    noteLoopbackLinkOutcome(outcome === "refused" ? "rejected" : outcome);
    return outcome === "refused" ? "rejected" : outcome;
  }
  clearCredentialLock();
  reload();
  return "stored";
}

/** The candidate waiting on a retry, or null. Read by the banner to decide whether to offer one. */
export function pendingLoopbackToken(): string | null {
  return pendingLoopback.read();
}

/**
 * Does this failure mean "this browser has no local access credential, and supplying one would fix it"?
 * Keyed on the `loom open` pointer the daemon puts ONLY in the 401s a credential actually fixes.
 *
 * @decision 093981dd — do not widen this to a bare `status === 401`: that re-introduces misdirection
 * for remote and undeterminable-peer callers, for whom this secret is the wrong credential or no help.
 */
export function isCredentialGuardFailure(status: number, message: string): boolean {
  return status === 401 && isCredentialGuardMessage(message);
}

/**
 * The message-only half, for a caller holding a thrown Error and no status — the global mutation-error
 * handler, which suppresses its blocking `window.alert` for this one class because the banner already
 * says it, better, and without blocking. A page of failing writes would otherwise be a page of modals.
 */
export function isCredentialGuardMessage(message: string): boolean {
  return message.includes("loom open");
}

/** What an inline error shows in place of the daemon's unrunnable "see `loom open`" text. */
export const CREDENTIAL_LOCKED_TEXT = "Writes are locked — see the banner.";

/**
 * The text an INLINE mutation error should render: the raw message for every failure except the credential
 * guard's, which becomes a short pointer at the banner. Nullish in → undefined out, so it drops into the
 * existing `x.error?.message ?? fallback` shapes.
 *
 * @decision 093981dd — a mutation error rendered inline (`meta.inlineError`, or a child component handed
 * the Error) must go through THIS, not `.message`, or a token-less browser reads the daemon's "see
 * `loom open`" advice it cannot act on. Do not use it for GET/query errors: the guard exempts reads.
 */
export function errorText(e: null | undefined): undefined;
export function errorText(e: unknown): string;
export function errorText(e: unknown): string | undefined {
  if (e === null || e === undefined) return undefined;
  const message = e instanceof Error ? e.message : String(e);
  return isCredentialGuardMessage(message) ? CREDENTIAL_LOCKED_TEXT : message;
}

/**
 * Does a failed WebSocket tell us the same thing? A browser cannot read an upgrade's HTTP status, so this
 * INFERS the lock from the two facts it holds: the handshake itself was rejected (never reached `open`),
 * and this browser has no token at all.
 *
 * @decision 093981dd — a guard-less daemon also yields `token === null`, so this can false-positive;
 * keep the socket-sourced copy conditional, and never let it overwrite a write-sourced lock.
 */
export function isCredentialSocketFailure(everOpened: boolean, token: string | null): boolean {
  return !everOpened && token === null;
}

/**
 * Prove a candidate credential against the daemon BEFORE storing it, by sending the cheapest guarded
 * request that cannot change anything. `invalidateQueries()` can NOT do this job: the guard exempts
 * GET/HEAD entirely, so every read succeeds without a credential and a wrong paste would clear the
 * banner silently.
 *
 * The probe is `POST /api/agents/<fresh uuid>` with an empty patch — an UPDATE-by-id route, so there is
 * no create path to trip even if its validation ever loosens; a fresh v4 uuid cannot name a real agent,
 * so the 404 is structural; and an empty patch is a verified no-op even against a REAL id. All three
 * were checked against a live daemon on card 093981dd.
 *
 * 401 ⇒ the guard rejected this credential (`"invalid"` — the one outcome a refusal may be claimed for).
 * A 403 ⇒ the CSRF/Host hook refused us BEFORE the guard ever ran (a reverse-proxied origin); a 408/429
 * or any 5xx is as likely an intermediary's answer as the daemon's — all `"unknown"`, since none of them
 * TESTED the credential. Anything else means the guard let us through, INCLUDING the structural 404 this
 * probe expects.
 *
 * @decision 093981dd — never "verify" a pasted credential with a GET, and never clear the lock without
 * a guarded round-trip: reads are ungated, so a GET proves nothing about whether writes will work.
 */
export async function verifyLoopbackToken(token: string): Promise<CredentialVerifyOutcome> {
  return classifyCredentialProbe(
    () => fetch(`/api/agents/${crypto.randomUUID()}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
      body: "{}",
    }),
    // The guard runs ahead of the route, so reaching ANY of its own answers (404 for the fresh uuid, 400
    // on a validation change) proves passage. The excluded statuses are the ones nothing downstream of
    // the guard authored.
    (status) => status !== 403 && status !== 408 && status !== 429 && status < 500,
  );
}

/**
 * RFC 7230 §3.2.6 `token` chars — a WebSocket subprotocol list element must be composed ENTIRELY of
 * these, or the browser's own `new WebSocket(url, protocols)` throws SYNCHRONOUSLY. The real secret
 * (`getOrCreateLoopbackSecret`, daemon-side) is always hex, so a malformed candidate is not a live bug —
 * but `verifyLoopbackToken` above proves a candidate over an HTTP `Authorization` header, which accepts
 * characters a subprotocol can't carry, so a non-token-safe candidate could verify and be stored, then
 * get silently treated as absent by `socketAuth`'s own shape check, leaving `isCredentialSocketFailure`
 * (keyed on `token === null`) to misread the result.
 *
 * @decision 0045a8cb — the ONE place this shape rule is written: `storeVerifiedLoopbackToken` refuses a
 * malformed candidate before the round-trip, and `socketAuth` (`gatewayCredential.ts`) reuses this same
 * predicate for the loopback branch instead of a second hand-written rule.
 */
const LOOPBACK_TOKEN_CHARS_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** True when `token` is composed entirely of RFC 7230 `token` chars — safe to embed whole in a
 *  `Sec-WebSocket-Protocol` list entry, and what the real (hex) secret always is. */
export function isWellFormedLoopbackToken(token: string): boolean {
  return LOOPBACK_TOKEN_CHARS_RE.test(token);
}

/**
 * The ONE way this browser's loopback secret is ever written: prove the candidate with `verifyLoopbackToken`
 * (injectable for tests, never re-implemented by a caller), and only then write it. `"refused"` = empty, or
 * the daemon itself rejected it; `"unverified"` = the check never got an answer, so NOTHING is known about
 * it; `"unstorable"` = it verified but localStorage refused it (private mode). In all three failure cases
 * nothing is written, so whatever secret this browser already held is still there.
 *
 * A candidate that is not `isWellFormedLoopbackToken` is refused WITHOUT a round trip — it could still
 * verify over the HTTP probe below, but it would never actually work for a WebSocket upgrade (see that
 * predicate's own doc), so there is nothing to gain by asking the daemon about it first.
 *
 * @decision a1ec70a6 — every path that obtains a candidate secret (the banner's paste field, `loom open`'s
 * `?token=` link) goes through HERE, and `"unverified"` is never reported to the user as a refusal.
 */
export async function storeVerifiedLoopbackToken(
  token: string,
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyLoopbackToken,
): Promise<"stored" | "refused" | "unverified" | "unstorable"> {
  const candidate = token.trim();
  if (!candidate) return "refused";
  if (!isWellFormedLoopbackToken(candidate)) return "refused";
  const outcome = await verify(candidate);
  if (outcome === "invalid") return "refused";
  if (outcome === "unknown") return "unverified";
  return writeLoopbackToken(candidate) ? "stored" : "unstorable";
}

/** What put the UI into the locked state — a refused write, or a refused socket upgrade. */
export type CredentialLockReason = "write" | "socket";

let lockReason: CredentialLockReason | null = null;
const listeners = new Set<(reason: CredentialLockReason | null) => void>();

/** The current lock reason, or null when writes are believed fine. */
export function credentialLock(): CredentialLockReason | null {
  return lockReason;
}

/**
 * Record that the daemon refused us for want of a credential. A "write" reason wins over a "socket" one
 * and is never downgraded: a refused write is the direct, unambiguous observation, while a refused socket
 * is inferred (see `isCredentialSocketFailure`'s stated limit), so once we have the strong signal we keep
 * showing its wording. Re-notifying on an unchanged reason is skipped so a page full of failing panes
 * doesn't re-render the banner once per pane.
 */
export function noteCredentialLock(reason: CredentialLockReason): void {
  if (lockReason === reason) return;
  if (lockReason === "write" && reason === "socket") return;
  lockReason = reason;
  for (const fn of listeners) fn(lockReason);
}

/** Clear the lock — the user supplied a credential, so let the UI return to its normal state. */
export function clearCredentialLock(): void {
  dismissLoopbackLinkOutcome(); // a successful re-entry settles a stale link outcome too
  if (lockReason === null) return;
  lockReason = null;
  for (const fn of listeners) fn(null);
}

/**
 * What became of a `?token=` link's secret (card a1ec70a6) — its own signal, deliberately NOT a
 * `CredentialLockReason`: both lock reasons are direct OBSERVATIONS of the daemon refusing us (a write, an
 * upgrade), and a link outcome is neither — the browser's own credential may well still be working. The
 * banner renders on this alone, worded per outcome, and offers a Dismiss the lock reasons don't get.
 *
 * `"rejected"` is the daemon's own 401. `"unverified"` is "we never got an answer" — a candidate is HELD
 * for a retry, and the copy must not claim a refusal. `"unstorable"` is this browser refusing to keep a
 * secret that verified fine.
 */
export type LoopbackLinkOutcome = "rejected" | "unverified" | "unstorable";

// Seeded from the hold so the state survives a manual reload: the unknown path deliberately does NOT
// reload, and a user whose daemon was down will often refresh once it is back. Without this the retry
// affordance would vanish on that very reload, with the candidate still sitting in sessionStorage.
let linkOutcome: LoopbackLinkOutcome | null = pendingLoopback.read() ? "unverified" : null;
const linkListeners = new Set<(outcome: LoopbackLinkOutcome | null) => void>();

/** What a `?token=` link's secret came to, or null when no link outcome is outstanding. */
export function loopbackLinkOutcome(): LoopbackLinkOutcome | null {
  return linkOutcome;
}

export function noteLoopbackLinkOutcome(outcome: LoopbackLinkOutcome): void {
  if (linkOutcome === outcome) return; // a repeat on one page-load must not re-render the banner
  linkOutcome = outcome;
  for (const fn of linkListeners) fn(linkOutcome);
}

/**
 * Cleared by the banner's Dismiss, and by any successful re-entry (`clearCredentialLock` calls this).
 * Drops the held candidate too: dismissing IS the user saying they don't want that link's credential, and
 * a successful paste has made it moot — leaving it held would resurrect the notice on the next reload.
 */
export function dismissLoopbackLinkOutcome(): void {
  pendingLoopback.clear();
  if (linkOutcome === null) return;
  linkOutcome = null;
  for (const fn of linkListeners) fn(null);
}

export function subscribeLoopbackLinkOutcome(fn: (outcome: LoopbackLinkOutcome | null) => void): () => void {
  linkListeners.add(fn);
  return () => { linkListeners.delete(fn); };
}

/**
 * The banner's wording for a link outcome, kept HERE rather than in the JSX so it is pure and a test can
 * read every variant. `holdsToken` is whether this browser has a working secret of its own, which decides
 * whether anything is actually broken.
 *
 * @decision a1ec70a6 — only `"rejected"` may say the credential was refused; no variant may promise that
 * writes still work (the held secret is unproven here, and "Unlock writes" sits beside it); and no variant
 * may claim the daemon was unreachable, since a 403 or a throttle came FROM it.
 */
export function loopbackLinkCopy(
  outcome: LoopbackLinkOutcome,
  holdsToken: boolean,
  retryable: boolean = false,
): { headline: string; detail: string } {
  const lockNote = holdsToken
    ? "The one this browser already holds is unchanged."
    : "This browser holds none, so writes and live terminals stay locked.";
  if (outcome === "rejected") {
    return {
      headline: "A link's access credential was refused.",
      detail: holdsToken
        ? "The credential in the ?token= link you opened was not accepted, so it was NOT saved; the one this browser already holds is unchanged."
        : "The credential in the ?token= link you opened was not accepted, so it was NOT saved — and this browser holds none, so writes stay locked.",
    };
  }
  if (outcome === "unverified") {
    // `retryable` is whether the candidate is actually HELD. It can fail to be (a sessionStorage that
    // refused us), and then there is no Retry button — so the sentence that names one must not be printed.
    // And the reason is deliberately NOT "could not reach the daemon": `unknown` also covers answers the
    // daemon itself sent (a pre-auth 403, a throttle), where naming it unreachable is simply false.
    return {
      headline: "A link's access credential could not be checked.",
      detail: `Loom did not get an answer about the credential in the ?token= link you opened, so it was NOT saved — nothing about it is known either way. ${lockNote} ${
        retryable ? "Retry in a moment, or paste the credential below." : "Open the link again, or paste the credential below."}`,
    };
  }
  return {
    headline: "A link's access credential could not be saved.",
    detail: `The credential in the ?token= link you opened was accepted, but this browser refused to store it (private mode?). ${lockNote}`,
  };
}

/** Subscribe to lock changes; returns an unsubscribe. Shape matches React's `useSyncExternalStore`. */
export function subscribeCredentialLock(fn: (reason: CredentialLockReason | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only reset so each unit-test case starts from a known state. */
export function resetCredentialLockForTest(): void {
  lockReason = null;
  listeners.clear();
  linkOutcome = null;
  linkListeners.clear();
  pendingLoopback.clear();
}
