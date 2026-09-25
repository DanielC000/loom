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

/** Per-ORIGIN storage key — a proxied browser's origin (`https://box.ts.net`) has its own localStorage, so this
 *  never collides with the loopback key on `http://127.0.0.1:4317`. */
const GATEWAY_TOKEN_STORAGE_KEY = "loom.gatewayToken";

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

/** Persist a gateway token the user obtained out-of-band. Trimmed; an empty result is rejected. */
export function setGatewayToken(token: string): boolean {
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
  verify: (token: string) => Promise<boolean> = verifyGatewayTokenAgainstDaemon,
  reload: () => void = () => { window.location.reload(); },
  remote: boolean = isRemoteOrigin(),
): Promise<"none" | "stored" | "rejected"> {
  if (typeof window === "undefined") return "none";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("gwtoken");
  if (!token) return "none";
  url.searchParams.delete("gwtoken");
  window.history.replaceState({}, "", url.toString());
  if (!remote) return "none"; // nothing on a loopback origin ever reads a gateway token
  if (!(await verify(token))) {
    noteGatewayLinkRejected(getGatewayToken() === null);
    return "rejected";
  }
  if (!setGatewayToken(token)) return "rejected";
  clearGatewayLock();
  reload(); // requests already in flight carried no token; a reload is the simplest correct reconnect
  return "stored";
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
 *  daemon's explicit `code` — never on a bare 401 (that would swallow the loopback guard's own 401s). */
export function isGatewayTokenRequired(status: number, body: unknown): boolean {
  return status === 401 && typeof body === "object" && body !== null && (body as { code?: unknown }).code === GATEWAY_TOKEN_REQUIRED_CODE;
}

/** What a WebSocket needs to present the right credential for this origin. Loopback: byte-identical to before
 *  (`?token=` carrying the LOOPBACK secret for the guarded term/companion sockets, nothing for the ungated fleet
 *  feed). Remote origin: the gateway token in the double-subprotocol the daemon's tier wall reads
 *  (`[loom.v1, loom.bearer.<token>]`) — never in the URL. */
export function socketAuth(kind: "term" | "companion" | "fleet", loopbackToken: string | null, remote: boolean = isRemoteOrigin(), gatewayToken: string | null = getGatewayToken()): { query: string; protocols?: string[] } {
  if (remote) return gatewayToken ? { query: "", protocols: ["loom.v1", `loom.bearer.${gatewayToken}`] } : { query: "" };
  if (kind === "fleet") return { query: "" };
  return { query: loopbackToken ? `?token=${encodeURIComponent(loopbackToken)}` : "" };
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
  dismissGatewayLinkRejected();
  if (!locked) return;
  locked = false;
  for (const fn of listeners) fn(false);
}
export function subscribeGatewayLock(fn: (locked: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** A `?gwtoken=` link whose token the daemon refused — shown as an error line even when the stored token still works. */
let linkRejected = false;
const linkListeners = new Set<(rejected: boolean) => void>();
export function gatewayLinkRejected(): boolean { return linkRejected; }
export function noteGatewayLinkRejected(alsoLock: boolean): void {
  if (!linkRejected) { linkRejected = true; for (const fn of linkListeners) fn(true); }
  if (alsoLock) noteGatewayLock();
}
export function dismissGatewayLinkRejected(): void {
  if (!linkRejected) return;
  linkRejected = false;
  for (const fn of linkListeners) fn(false);
}
export function subscribeGatewayLinkRejected(fn: (rejected: boolean) => void): () => void {
  linkListeners.add(fn);
  return () => { linkListeners.delete(fn); };
}
export function resetGatewayLockForTest(): void { locked = false; listeners.clear(); linkRejected = false; linkListeners.clear(); }

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
 * Prove a candidate gateway token against the daemon BEFORE storing it: `GET /api/version` is a Tier-1 read that a
 * remote-class request must authenticate, so 200 ⇔ the token verified (unlike loopback, where reads are ungated and
 * prove nothing). It changes nothing.
 */
export async function verifyGatewayTokenAgainstDaemon(token: string): Promise<boolean> {
  try {
    const r = await fetch("/api/version", { headers: { authorization: `Bearer ${token.trim()}` } });
    return r.ok;
  } catch {
    return false; // network failure — unverified, so the lock stays
  }
}
