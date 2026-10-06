/**
 * The GATEWAY token: the credential a browser holds when it reaches the daemon through a trusted reverse proxy
 * (`tailscale serve` et al., card 4cbbc343) instead of directly on loopback. JSX-free on purpose — every predicate
 * below is pure and unit-tested by `test/gateway-credential.mjs`.
 *
 * It is a DIFFERENT credential from the loopback secret in `loopbackCredential.ts`, and the two must never share a
 * banner, a storage key or a discriminator:
 *   - the loopback secret authorises WRITES from a loopback browser (`loom open`); a proxied browser never holds it;
 *   - the gateway token authorises EVERY request (reads too) from a remote/proxied browser, and only reaches the
 *     Tier-1 surface.
 * @decision 093981dd — the loopback banner's `loom open` pointer is the wrong advice for a proxied browser, so this
 * file has its OWN discriminator (`code: "gateway-token-required"`, sent only in the remote 401) and its own copy.
 */
import {
  classifyCredentialProbe, pendingCandidateStore, type CredentialVerifyOutcome,
} from "./credentialVerify";
import { isWellFormedLoopbackToken } from "./loopbackCredential";

import type { GatewayTokenCloseChange } from "@loom/shared";

/** Per-ORIGIN storage key — a proxied browser's origin (`https://box.ts.net`) has its own localStorage, so this
 *  never collides with the loopback key on `http://127.0.0.1:4317`. */
const GATEWAY_TOKEN_STORAGE_KEY = "loom.gatewayToken";

/** Card a1ec70a6: where a candidate this path could not CHECK waits for a retry — its OWN hold, keyed apart
 *  from the loopback one, since the two are different credentials (see this file's header). */
const pendingGateway = pendingCandidateStore("loom.gatewayTokenPending");

/** The `code` the daemon puts in the 401 a gateway token would fix (gateway/server.ts, remote/proxy 401). */
export const GATEWAY_TOKEN_REQUIRED_CODE = "gateway-token-required";

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True when this page was NOT served from a loopback hostname — i.e. it reached the daemon through a proxy/remote
 *  origin and must present a gateway token. The dev `pnpm web` origin (127.0.0.1:5317) is loopback. */
export function isRemoteOrigin(hostname: string = typeof window !== "undefined" ? window.location.hostname : "127.0.0.1"): boolean {
  return !LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function readStorage(key: string): string | null {
  try { return typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; }
}

/** The captured gateway token, or null. */
export function getGatewayToken(): string | null { return readStorage(GATEWAY_TOKEN_STORAGE_KEY); }

/**
 * Persist a VERIFIED gateway token. Trimmed; an empty result is rejected. Not even a test-only seed
 * export: a test seeds its OWN fake localStorage, so this module exports no write path at all rather
 * than one it merely asks callers not to use.
 *
 * @decision a1ec70a6 — module-PRIVATE, like the loopback writer it mirrors: the only caller is
 * `storeVerifiedGatewayToken` below, so no call site can write the token without proving it first.
 */
function writeGatewayToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  try { window.localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, trimmed); return true; } catch { return false; }
}

/**
 * Capture `?gwtoken=` from the current URL, strip it from the visible URL at once (same hygiene as `captureTokenFromUrl`,
 * deliberately a SEPARATE param so the two credentials cannot be confused), and — only on a REMOTE origin — VERIFY it
 * against the daemon before persisting, exactly like the banner's paste path. A crafted link therefore can never overwrite
 * the owner's working stored token with a bad one: on failure the stored token is KEPT and the link's rejection is
 * surfaced (`gatewayLinkRejected`; the gateway banner as well when this browser holds no token). `verify` and
 * `reload` are injectable for the unit test. Resolves `"none"` (no param / loopback origin), `"stored"` or `"rejected"`.
 */
export async function captureGatewayTokenFromUrl(
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyGatewayTokenAgainstDaemon,
  reload: () => void = () => { window.location.reload(); },
  remote: boolean = isRemoteOrigin(),
): Promise<GatewayCaptureOutcome> {
  if (typeof window === "undefined") return "none";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("gwtoken");
  if (!token) return "none";
  // Best-effort, like its loopback twin: a throwing `replaceState` must not reject this promise (api.ts
  // calls it with a bare `void`) nor abandon the capture with the token still in the address bar.
  try {
    url.searchParams.delete("gwtoken");
    window.history.replaceState({}, "", url.toString());
  } catch { /* the param stays visible; the already-held check below still bounds the reload */ }
  if (!remote) return "none"; // nothing on a loopback origin ever reads a gateway token
  // Already holding exactly this token: nothing to prove and nothing to reconnect. Also the structural
  // guard against a reload loop, exactly as on the loopback path — if the strip above silently NO-OPPED
  // (or threw and was swallowed), the URL still carries the param, and an unconditional reload would
  // re-enter here on it forever.
  if (getGatewayToken() === token.trim()) return "stored";
  const outcome = await storeVerifiedGatewayToken(token, verify);
  if (outcome !== "stored") {
    if (outcome === "unverified") pendingGateway.write(token);
    else pendingGateway.clear();
    // Card a1ec70a6: the lock (which says "this address needs a token") is raised only for a token the
    // daemon actually REFUSED. An unanswered check proves nothing, so it must not assert one.
    noteGatewayLinkOutcome(outcome === "refused" ? "rejected" : outcome, outcome === "refused" && getGatewayToken() === null);
    return outcome === "refused" ? "rejected" : outcome;
  }
  clearGatewayLock();
  reload(); // requests already in flight carried no token; a reload is the simplest correct reconnect
  return "stored";
}

/**
 * The ONE way the gateway token is written: prove the candidate (three-state, through the shared
 * classifier), and only then store it. Same outcomes, and the same reasons for them, as the loopback
 * chokepoint `storeVerifiedLoopbackToken` — the two credentials differ, the rule does not.
 */
export async function storeVerifiedGatewayToken(
  token: string,
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyGatewayTokenAgainstDaemon,
): Promise<"stored" | "refused" | "unverified" | "unstorable"> {
  const candidate = token.trim();
  if (!candidate) return "refused";
  const outcome = await verify(candidate);
  if (outcome === "invalid") return "refused";
  if (outcome === "unknown") return "unverified";
  return writeGatewayToken(candidate) ? "stored" : "unstorable";
}

/** Re-check the candidate held by an earlier `"unverified"` capture — the gateway banner's Retry. A
 *  still-unknown retry keeps the hold; every other outcome is terminal and drops it. */
export async function retryPendingGatewayToken(
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyGatewayTokenAgainstDaemon,
  reload: () => void = () => { window.location.reload(); },
): Promise<GatewayCaptureOutcome> {
  const candidate = pendingGateway.read();
  if (!candidate) return "none";
  const outcome = await storeVerifiedGatewayToken(candidate, verify);
  if (outcome === "unverified") {
    noteGatewayLinkOutcome("unverified", false);
    return "unverified";
  }
  pendingGateway.clear();
  if (outcome !== "stored") {
    noteGatewayLinkOutcome(outcome === "refused" ? "rejected" : outcome, outcome === "refused" && getGatewayToken() === null);
    return outcome === "refused" ? "rejected" : outcome;
  }
  clearGatewayLock();
  reload();
  return "stored";
}

/** The candidate waiting on a retry, or null. Read by the banner to decide whether to offer one. */
export function pendingGatewayToken(): string | null {
  return pendingGateway.read();
}

/** `{authorization}` for the gateway token, or `{}` when there is none. */
export function gatewayAuthHeaders(): Record<string, string> {
  const token = getGatewayToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Add the gateway token to a fetch init on a REMOTE origin (reads need it there, unlike loopback where GETs are
 * ungated). Returns `init` UNCHANGED on a loopback origin — the loopback path stays byte-identical — and never
 * overrides an `authorization` the caller already set.
 */
export function withGatewayAuth(init: RequestInit | undefined, remote: boolean = isRemoteOrigin()): RequestInit | undefined {
  if (!remote) return init;
  const headers = new Headers(init?.headers);
  if (headers.has("authorization")) return init;
  const auth = gatewayAuthHeaders().authorization;
  if (!auth) return init;
  headers.set("authorization", auth);
  return { ...init, headers };
}

/** Does this failure mean "this browser needs a gateway token, and supplying one would fix it"? Keyed ONLY on the
 *  daemon's explicit `code` — never on a bare 401 (that would swallow the loopback guard's own 401s). The code rides
 *  a 401, and (card cf9ebab9) also the failed-auth 429: the daemon answers that only to a request whose token just
 *  FAILED verification (verify-first), so a stale/revoked token on a throttled shared ip still surfaces the banner. */
export function isGatewayTokenRequired(status: number, body: unknown): boolean {
  return (status === 401 || status === 429) && typeof body === "object" && body !== null && (body as { code?: unknown }).code === GATEWAY_TOKEN_REQUIRED_CODE;
}

/** RFC 7230 §3.2.6 `token` chars — a WebSocket subprotocol list element must be composed ENTIRELY of
 *  these, or the browser's own `new WebSocket(url, protocols)` throws SYNCHRONOUSLY, before any network
 *  attempt is even made. A stored GATEWAY token can fail this (hand-edited, mangled by a copy/paste,
 *  captured from a malformed link) — `socketAuth` below treats a non-token-safe value as ABSENT rather
 *  than let that throw kill the socket outright: with no protocols offered, the daemon 401s as it always
 *  did for a missing credential, and the existing banner/paste recovery runs instead of the pane simply
 *  dying with no retry (card e4459829 round 2). The LOOPBACK secret's own shape check is the SAME rule,
 *  but lives as `isWellFormedLoopbackToken` in `loopbackCredential.ts` and is reused below rather than
 *  reimplemented (card 0045a8cb) — that module already owns every other loopback-secret invariant. */
const SUBPROTOCOL_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `token` if it's safe to embed whole in a `Sec-WebSocket-Protocol` list entry, else `null`. GATEWAY
 *  token only — the loopback branch of `socketAuth` reuses `isWellFormedLoopbackToken` instead. */
function asSubprotocolSafe(token: string | null): string | null {
  return token !== null && SUBPROTOCOL_TOKEN_RE.test(token) ? token : null;
}

/** What a WebSocket needs to present the right credential for this origin. Both loopback and remote now
 *  present their secret the SAME way — the double-subprotocol the daemon's tier wall / loopback
 *  write-guard read (`[loom.v1, loom.bearer.<token>]`) — never in the URL, closing the loopback secret's
 *  old `?token=` exposure (it used to ride the query string — would be logged verbatim by
 *  GATEWAY_LOG_SERIALIZERS if the gateway's request logger were ever enabled; the real exposure today is
 *  devtools/browser history and any proxy/tunnel access log the request passed through). The daemon still
 *  ALSO accepts a loopback `?token=` fallback (deprecated, kept for stale-bundle back-compat — see
 *  gateway/server.ts), but this client never sends one anymore. Remote presents the gateway token for
 *  EVERY kind including `fleet` (the remote tier gates reads too, unlike loopback); loopback presents
 *  nothing for `fleet` (that feed is ungated there — matches before). */
export function socketAuth(kind: "term" | "companion" | "fleet", loopbackToken: string | null, remote: boolean = isRemoteOrigin(), gatewayToken: string | null = getGatewayToken()): { query: string; protocols?: string[] } {
  if (remote) {
    const token = asSubprotocolSafe(gatewayToken);
    return token ? { query: "", protocols: ["loom.v1", `loom.bearer.${token}`] } : { query: "" };
  }
  if (kind === "fleet") return { query: "" };
  const token = loopbackToken !== null && isWellFormedLoopbackToken(loopbackToken) ? loopbackToken : null;
  return token ? { query: "", protocols: ["loom.v1", `loom.bearer.${token}`] } : { query: "" };
}

// ---- the gateway lock: its OWN state + subscription (never the loopback lock) -----------------------------------------
let locked = false;
const listeners = new Set<(locked: boolean) => void>();

export function gatewayLock(): boolean { return locked; }
export function noteGatewayLock(): void {
  if (locked) return;
  locked = true;
  for (const fn of listeners) fn(true);
}
export function clearGatewayLock(): void {
  dismissGatewayLinkOutcome();
  clearGatewayTokenRevoked();
  if (!locked) return;
  locked = false;
  for (const fn of listeners) fn(false);
}
export function subscribeGatewayLock(fn: (locked: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/**
 * What became of a `?gwtoken=` link's token — shown as an error line even when the stored token still works.
 * Card a1ec70a6 made it three-state for the same reason the loopback signal is (see `LoopbackLinkOutcome`):
 * `"rejected"` is the daemon's own 401, `"unverified"` means the check never got an answer (a candidate is
 * HELD for a retry and the copy must not claim a refusal), `"unstorable"` is this browser refusing it.
 */
export type GatewayLinkOutcome = "rejected" | "unverified" | "unstorable";
/** What a capture/retry came to. `"none"`: no param, or a loopback origin, or nothing held to retry. */
export type GatewayCaptureOutcome = "none" | "stored" | "rejected" | "unverified" | "unstorable";

// Seeded from the hold so the retry affordance survives a manual reload — see the loopback twin's note.
let linkOutcome: GatewayLinkOutcome | null = pendingGateway.read() ? "unverified" : null;
const linkListeners = new Set<(outcome: GatewayLinkOutcome | null) => void>();
export function gatewayLinkOutcome(): GatewayLinkOutcome | null { return linkOutcome; }
export function noteGatewayLinkOutcome(outcome: GatewayLinkOutcome, alsoLock: boolean): void {
  if (linkOutcome !== outcome) { linkOutcome = outcome; for (const fn of linkListeners) fn(outcome); }
  if (alsoLock) noteGatewayLock();
}
/** Cleared by the banner's Dismiss and by a successful re-entry; drops the held candidate with it. */
export function dismissGatewayLinkOutcome(): void {
  pendingGateway.clear();
  if (linkOutcome === null) return;
  linkOutcome = null;
  for (const fn of linkListeners) fn(null);
}
export function subscribeGatewayLinkOutcome(fn: (outcome: GatewayLinkOutcome | null) => void): () => void {
  linkListeners.add(fn);
  return () => { linkListeners.delete(fn); };
}

/**
 * The banner's wording for a gateway link outcome — the exact twin of `loopbackLinkCopy`, kept HERE rather
 * than in the JSX for the same reason: it is then pure, and a test can read every variant. `holdsToken` is
 * whether this browser has a token of its own; `retryable` is whether a candidate is genuinely HELD.
 *
 * @decision a1ec70a6 — only `"rejected"` may say the token was refused, no variant may claim the daemon was
 * unreachable (a 403 or a coded throttle came FROM it), and no variant may name a Retry the banner is not
 * rendering.
 */
export function gatewayLinkCopy(
  outcome: GatewayLinkOutcome,
  holdsToken: boolean,
  retryable: boolean = false,
): { headline: string; detail: string } {
  const lockNote = holdsToken
    ? "The token this browser already holds is unchanged."
    : "This browser holds none, so this address stays locked.";
  if (outcome === "rejected") {
    return {
      headline: "A link's gateway token was refused.",
      detail: holdsToken
        ? "The token in the ?gwtoken= link you opened was not accepted, so it was NOT saved; the token this browser already holds is unchanged."
        : "The token in the ?gwtoken= link you opened was not accepted, so it was NOT saved — and this browser holds none, so this address stays locked.",
    };
  }
  if (outcome === "unverified") {
    return {
      headline: "A link's gateway token could not be checked.",
      detail: `Loom did not get an answer about the token in the ?gwtoken= link you opened, so it was NOT saved — nothing about it is known either way. ${lockNote} ${
        retryable ? "Retry in a moment, or paste a token below." : "Open the link again, or paste a token below."}`,
    };
  }
  return {
    headline: "A link's gateway token could not be saved.",
    detail: `The token in the ?gwtoken= link you opened was accepted, but this browser refused to store it (private mode?). ${lockNote}`,
  };
}

/**
 * The gateway-token status change that just killed this browser's live sockets, as the daemon named it in
 * its 1008 close reason (`gateway/token-sockets.ts`). Card f8d2684d: a REVOKED (or paused/rotated/deleted)
 * token is a different failure from "this address needs a token" — the browser holds one and it used to
 * work — so the banner needs to say which happened, and `lib/socketReconnect.ts` resolves it from the
 * close reason rather than guessing. Distinct state from `locked`, but it SETS the lock too: every later
 * request with the dead token 401s anyway, and the banner's paste field is already the re-entry action.
 *
 * The four names are `GatewayTokenCloseChange` from `@loom/shared` — the same list the daemon builds its
 * close reason from (card 04314fbc), aliased here so every existing `GatewayTokenChange` import still
 * resolves while there is only ONE definition of what the four are.
 */
export type GatewayTokenChange = GatewayTokenCloseChange;
let tokenRevoked: GatewayTokenChange | null = null;
const revokedListeners = new Set<(change: GatewayTokenChange | null) => void>();
export function gatewayTokenRevoked(): GatewayTokenChange | null { return tokenRevoked; }
export function noteGatewayTokenRevoked(change: GatewayTokenChange): void {
  if (tokenRevoked !== change) {
    tokenRevoked = change;
    for (const fn of revokedListeners) fn(change);
  }
  noteGatewayLock(); // the banner (and its paste field) is the re-entry surface
}
/** Cleared only by a successful re-entry — `clearGatewayLock` calls this, so no caller has to remember to. */
export function clearGatewayTokenRevoked(): void {
  if (tokenRevoked === null) return;
  tokenRevoked = null;
  for (const fn of revokedListeners) fn(null);
}
export function subscribeGatewayTokenRevoked(fn: (change: GatewayTokenChange | null) => void): () => void {
  revokedListeners.add(fn);
  return () => { revokedListeners.delete(fn); };
}
export function resetGatewayLockForTest(): void { locked = false; listeners.clear(); linkOutcome = null; linkListeners.clear(); tokenRevoked = null; revokedListeners.clear(); pendingGateway.clear(); }

/**
 * A WebSocket upgrade that never opened, on a REMOTE origin holding no gateway token: note the gateway lock and
 * report `true` so the caller can say so. Returns `false` on a loopback origin (the caller then runs its existing
 * loopback-credential inference) and whenever a token IS held (a refused handshake is then not evidence of a
 * missing token — same stated limit as `isCredentialSocketFailure`).
 */
export function noteRemoteSocketRefusal(everOpened: boolean, remote: boolean = isRemoteOrigin(), gatewayToken: string | null = getGatewayToken()): boolean {
  if (!remote || everOpened || gatewayToken !== null) return false;
  noteGatewayLock();
  return true;
}

/**
 * What a probe of the token this browser ALREADY HOLDS came to. `"none"` is not an outcome ABOUT a token
 * (a loopback origin, or nothing held), so it must never read as a refusal.
 */
export type HeldGatewayTokenProbe = "none" | "valid" | "invalid" | "unknown";

/**
 * Probe the HELD gateway token against the daemon, to settle the one question a refused WebSocket upgrade
 * cannot answer by itself. On a remote origin with a dead token still in storage the upgrade 401s, so no
 * socket ever opens and the browser reports **1006** with an empty reason — there was no socket for the
 * daemon to close with its 1008 contract. `noteRemoteSocketRefusal` above returns `false` for precisely
 * this case (a token IS held, so a refused handshake is not evidence of a missing one), which leaves
 * "this token is dead" and "the daemon is restarting" indistinguishable at the close. They are not
 * indistinguishable over HTTP, so ask there instead of guessing.
 *
 * Three-state through the SHARED classifier, for the reason that algebra exists at all: only `"invalid"`
 * is the daemon's own refusal. `verifyGatewayTokenAgainstDaemon` read as a boolean is too coarse to drive
 * a retry STOP off — it reports a dropped request as a refusal, so a page would lock itself every time
 * the daemon merely restarted, which is the exact case the unbounded retry loop exists to heal.
 *
 * On `"invalid"` it raises the plain gateway LOCK — whose banner copy already says, accurately, that the
 * daemon refused the token this browser holds — and deliberately NOT `noteGatewayTokenRevoked`: that
 * state names WHICH of revoked/paused/rotated/deleted happened, and a 401 to a probe does not say which.
 * Picking one would fabricate the observation the three-state split protects.
 *
 * A REPLACED credential makes the whole verdict stale, so it comes back `"unknown"`. A probe is
 * asynchronous and the token can be swapped while one is in flight — a paste into the banner is exactly
 * that, and it clears the lock on its way through. `createRefusalEpisode`'s own generation fence does not
 * cover this: that fence drops a superseded `onDead`, which is the episode's decision to STOP a ladder,
 * while this side effect fires here, inside the probe, before any result reaches the episode at all.
 *
 * `"invalid"` would ALSO be a true statement about the token that was probed — but nothing downstream
 * wants a verdict on a token nobody holds any more, and reporting one decouples the two halves of the
 * stop. `"invalid"` is the ONE outcome that both raises the lock and ends a ladder, so returning it while
 * declining to raise the lock leaves "lock raised" and "ladder stopped" free to disagree: the ladder ends
 * on a freshly pasted, working credential with no banner up to explain it, and the same split covers the
 * cross-tab case (another tab's paste) and an A→B→A swap. `"unknown"` keeps the pair coupled and costs
 * nothing: it is non-stopping, so the episode simply re-asks — now about the token actually held — within
 * its own bounded `REFUSAL_EPISODE_MAX_UNKNOWN` budget.
 *
 * @decision a6d7bf36 — never stop a retry ladder on anything but `"invalid"`, and never claim a named
 * token-status change for a probe's 401.
 * @decision d56b12d8 — never report `"invalid"` for a probe of a token this browser no longer holds, and
 * never let `"invalid"` and the gateway lock come apart: that pair is one decision, not two.
 */
export async function probeHeldGatewayToken(
  verify: (token: string) => Promise<CredentialVerifyOutcome> = verifyGatewayTokenAgainstDaemon,
  remote: boolean = isRemoteOrigin(),
  gatewayToken: string | null = getGatewayToken(),
): Promise<HeldGatewayTokenProbe> {
  if (!remote || gatewayToken === null) return "none";
  const outcome = await verify(gatewayToken);
  if (outcome !== "invalid") return outcome;
  // Re-read LIVE, never the captured argument: the whole point is that storage may have changed since.
  if (getGatewayToken() !== gatewayToken) return "unknown";
  noteGatewayLock();
  return "invalid";
}

/**
 * Prove a candidate gateway token against the daemon BEFORE storing it: `GET /api/version` is a Tier-1 read that a
 * remote-class request must authenticate, so a 2xx ⇔ the token verified (unlike loopback, where reads are ungated and
 * prove nothing). It changes nothing.
 *
 * Classified by the SHARED three-state classifier, but with this path's OWN passage predicate: only a 2xx proves
 * passage here. A 404 — proof of passage on the loopback probe, whose route answers one — means an intermediary
 * answered instead of the daemon, so it proves nothing; `?gwtoken=`'s whole point is a reverse proxy in the path.
 *
 * @decision a1ec70a6 — the coded 429 is `invalid`, a BARE 429 stays `unknown`: never widen this to the status
 * alone. The daemon answers the coded one only to a token that just failed verification; a bare throttle is an
 * observation nobody made.
 */
export async function verifyGatewayTokenAgainstDaemon(token: string): Promise<CredentialVerifyOutcome> {
  return classifyCredentialProbe(
    () => fetch("/api/version", { headers: { authorization: `Bearer ${token.trim()}` } }),
    (status) => status >= 200 && status < 300,
    // `isGatewayTokenRequired` only ever says `true` for a 401 or 429 — and `classifyCredentialProbe`
    // already returns `invalid` for a 401 before this runs at all — so the ONLY status this can still
    // affirm for is 429. Checking that FIRST skips parsing a body (403/5xx/etc.) this predicate can never
    // affirm for anyway, and whose `.json()` the daemon never even wrote with this shape in mind.
    async (response) => response.status === 429 && isGatewayTokenRequired(response.status, await response.json()),
  );
}
