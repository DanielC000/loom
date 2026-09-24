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

/** Card 9ccedbee's storage key. Per-ORIGIN: a tunnelled device's own origin never sees the host's copy. */
const LOOPBACK_TOKEN_STORAGE_KEY = "loom.loopbackToken";

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
 * Persist a token this browser obtained out-of-band (the banner's paste field). Trimmed, because the
 * value is copied by hand off the host and picks up whitespace/newlines on the way. An empty result is
 * rejected rather than stored — writing "" would read back as a captured-but-useless credential.
 */
export function setLoopbackToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  try {
    window.localStorage.setItem(LOOPBACK_TOKEN_STORAGE_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture `?token=` from the current URL into localStorage, then strip it from the visible URL so the
 * secret doesn't sit in the address bar / get shared by a copied link. This is `loom open`'s delivery
 * path (bin/loom.mjs `urlWithToken`), unchanged — extracted here from `lib/api.ts` so storage has ONE
 * owner. No-op off-browser (a non-DOM test harness) and no-op when there is no `token` param.
 */
export function captureTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  setLoopbackToken(token);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.toString());
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

/**
 * The shared `onError` for a mutation that alerts its raw message at its own call site, bypassing the
 * global handler in main.tsx. Byte-identical to the old inline `window.alert((e as Error).message)` for
 * every error EXCEPT the credential guard's, which the banner owns.
 *
 * @decision 093981dd — a mutation that alerts at its own call site must use THIS, not `window.alert`
 * directly, or a token-less browser gets the daemon's unrunnable "see `loom open`" advice once per
 * control. Found by the live repro AFTER the global handler alone looked sufficient.
 */
export function alertUnlessCredentialGuard(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  if (isCredentialGuardMessage(message)) return;
  window.alert(message);
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
  if (lockReason === null) return;
  lockReason = null;
  for (const fn of listeners) fn(null);
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
}
