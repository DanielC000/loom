/**
 * Plain-http-to-a-private-host support for a connection the OWNER opted in (`allowPlainHttp`, card 1d882a8c).
 * This RELAXES an egress control, so every rule lives here, in one place, and fails closed:
 *
 * @decision 1d882a8c — never accept loopback/link-local via DNS, never re-resolve between check and connect, never follow a redirect.
 *
 *  1. Address classification is numeric (parsed bytes, never a string prefix), on the address that will
 *     actually be dialled. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is classified as the embedded IPv4.
 *  2. What a CONFIGURED host may resolve to depends on how it is written:
 *     - an IP literal: RFC 1918 / ULA / loopback / link-local, as written;
 *     - exactly `localhost`: every resolved address must be loopback;
 *     - any other DNS name (including `.local`): every resolved address must be RFC 1918 or fc00::/7 ULA.
 *       A name that resolves to loopback or link-local is REFUSED (a LAN name rebinding onto the daemon's own
 *       loopback port, or onto 169.254.169.254, is the attack), and ONE public/other address among several
 *       refuses the lot.
 *  3. The request is PINNED to the address that was checked: `createPinnedHttpFetch` dials that IP literal
 *     directly (host header = the configured host), so there is no second resolution between check and connect.
 *
 * The pinned fetch is a `fetch`-shaped adapter over `node:http` so it plugs into `boundedFetch` via `fetchImpl`
 * (decision 25c93b6f: every secret-bearing fetch goes through that helper). It uses `agent:false` (one fresh
 * connection per request, no reuse), never follows a redirect (a 3xx is returned as a Response for
 * `guardedFetch` to treat), honours the AbortSignal, and throws only URL-free errors (code kept).
 */
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { resolveConfig, type PlatformConfigOverride } from "@loom/shared";
import { PORT } from "../paths.js";

export type AddressClass = "private" | "loopback" | "link-local" | "other";

/**
 * The daemon's OWN listening ports (its listen `PORT`, plus `remoteAccess.proxyPort` when set), read from the
 * live sources, never hardcoded. A loopback-class target on one of these would hairpin the request into the
 * daemon itself (its CSRF/Host hook accepts a loopback Host with no Origin), so it is refused for every scheme.
 * `db` is optional: without it only `PORT` is known.
 */
export function daemonReservedPorts(db?: { getPlatformConfig?: () => PlatformConfigOverride }): number[] {
  const ports = [PORT];
  try {
    const override = db?.getPlatformConfig?.();
    const proxy = resolveConfig(undefined, override).remoteAccess.proxyPort;
    if (typeof proxy === "number") ports.push(proxy);
  } catch { /* an unreadable config leaves PORT alone */ }
  return ports;
}

export const DAEMON_SELF_TARGET_REFUSED = "refused: the host points at this daemon's own port";

function parseIPv4(s: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  if (m.slice(1).some((p) => /^0\d/.test(p))) return undefined; // leading zero: octal/decimal ambiguity — never accepted
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : undefined;
}

/** IPv6 text -> 16 bytes (handles `::` and an embedded dotted IPv4 tail), or undefined when malformed. */
function parseIPv6(input: string): number[] | undefined {
  let s = input;
  const pct = s.indexOf("%"); // zone id — irrelevant to the class
  if (pct >= 0) s = s.slice(0, pct);
  if (!net.isIPv6(s)) return undefined;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    tail = v4;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const groups = halves.length === 1 ? head : [...head, ...new Array<number>(fill).fill(0), ...rest];
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length === 4) { bytes[12] = tail[0]!; bytes[13] = tail[1]!; bytes[14] = tail[2]!; bytes[15] = tail[3]!; }
  return bytes;
}

function classifyV4(o: number[]): AddressClass {
  const [a, b] = o as [number, number, number, number];
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  return "other";
}

/** Classify one IP literal. Anything unparseable, or outside the named ranges, is `"other"`. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const v4 = parseIPv4(bare);
  if (v4) return classifyV4(v4);
  const b = parseIPv6(bare);
  if (!b) return "other";
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 15) && b[15] === 1) return "loopback"; // ::1
  // ::ffff:0:0/96 — classify the embedded IPv4 (so ::ffff:127.0.0.1 is loopback, ::ffff:8.8.8.8 is other).
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12, 16));
  if ((b[0]! & 0xfe) === 0xfc) return "private"; // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local"; // fe80::/10
  return "other";
}

/** The hostname part of a validated `host[:port]`, without IPv6 brackets, plus the port (80 when absent). */
export function splitHostPort(host: string): { hostname: string; port: number } {
  const u = new URL(`http://${host}`);
  const hostname = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  return { hostname, port: u.port === "" ? 80 : Number(u.port) };
}

export type LanHostCheck = { ok: true } | { ok: false; error: string };

/**
 * SAVE-time check for an opt-in connection: the configured host must be a private/loopback/link-local IP
 * literal, `localhost`, or a hostname (which can only be judged at request time, when it resolves). A PUBLIC
 * IP literal is refused up front so the owner hears it at save, not at first use.
 */
export function validatePlainHttpHost(host: string, reservedPorts: readonly number[] = daemonReservedPorts()): LanHostCheck {
  let hostname: string; let port: number;
  try { ({ hostname, port } = splitHostPort(host)); } catch { return { ok: false, error: "host is not valid for plain http" }; }
  if ((hostname === "localhost" || classifyAddress(hostname) === "loopback") && reservedPorts.includes(port)) {
    return { ok: false, error: DAEMON_SELF_TARGET_REFUSED };
  }
  if (net.isIP(hostname)) {
    return classifyAddress(hostname) === "other"
      ? { ok: false, error: "plain http is only allowed for a private LAN address (10.x, 172.16-31.x, 192.168.x, loopback, link-local or fc00::/7)" }
      : { ok: true };
  }
  return { ok: true };
}

export const PLAIN_HTTP_REFUSED = "plain http refused: the host does not resolve to a private LAN address";

/** `addresses` is the full CHECKED set, in lookup order (a connect failure falls through to the next); `address` is the first. */
export interface LanTarget { address: string; addresses?: string[]; port: number; hostHeader: string }

export type LookupImpl = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupImpl = async (hostname) => {
  const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/**
 * REQUEST-time resolve+check. Resolves a hostname ONCE, applies the class rules in the file header to EVERY
 * returned address, and returns the single address to pin. A lookup failure, an empty answer, or any address
 * outside the allowed class refuses (fixed text — never the host or address).
 */
export async function resolveLanTarget(
  host: string, opts: { lookupImpl?: LookupImpl; timeoutMs: number; reservedPorts?: readonly number[] },
): Promise<{ ok: true; target: LanTarget } | { ok: false; error: string }> {
  const refuse = { ok: false as const, error: PLAIN_HTTP_REFUSED };
  let hostname: string; let port: number;
  try { ({ hostname, port } = splitHostPort(host)); } catch { return refuse; }

  let addresses: string[];
  const isLiteral = net.isIP(hostname) !== 0;
  if (isLiteral) {
    addresses = [hostname];
  } else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        (opts.lookupImpl ?? defaultLookup)(hostname),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lookup timed out")), opts.timeoutMs); }),
      ]);
    } catch {
      return refuse;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (addresses.length === 0) return refuse;
  const classes = addresses.map(classifyAddress);
  const allowed = isLiteral
    ? classes.every((c) => c !== "other")
    : hostname === "localhost"
      ? classes.every((c) => c === "loopback")
      : classes.every((c) => c === "private");
  if (!allowed) return refuse;
  // Hairpin guard, whatever the scheme: a loopback-class address on one of the daemon's OWN ports would reach
  // the daemon's gateway (loopback Host, no Origin), so it is refused. Fixed text, never the host.
  const reserved = opts.reservedPorts ?? daemonReservedPorts();
  if (reserved.includes(port) && classes.some((c) => c === "loopback")) return { ok: false, error: DAEMON_SELF_TARGET_REFUSED };
  return { ok: true, target: { address: addresses[0]!, addresses, port, hostHeader: host } };
}

const HOP_BY_HOP_DROPPED = new Set(["host", "connection", "transfer-encoding", "content-length", "upgrade", "keep-alive", "proxy-authorization"]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export interface PinnedRequestSeam { request: typeof http.request }

/**
 * A `fetch`-shaped function that dials ONLY `target.address:target.port` (an IP literal — no lookup happens),
 * sending `Host: target.hostHeader`. The URL passed in supplies the path/query only; its authority is ignored,
 * so the connection can never go anywhere but the pinned address. `agent:false`; redirects are never followed.
 */
export function createPinnedHttpFetch(target: LanTarget, seam: PinnedRequestSeam = { request: http.request }): typeof fetch {
  // Try each CHECKED address in order; only a pre-response connect failure falls through to the next. The set is
  // exactly what `resolveLanTarget` checked — never an address from anywhere else. The caller's AbortSignal
  // (the connections request timeout) bounds the whole sequence.
  const addresses = target.addresses && target.addresses.length > 0 ? target.addresses : [target.address];
  const CONNECT_FAILURES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let last: unknown;
    for (const address of addresses) {
      try {
        return await dialOnce(address, target, seam, input, init);
      } catch (err) {
        last = err;
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code !== "string" || !CONNECT_FAILURES.has(code)) throw err;
        if (init?.signal?.aborted) throw err;
      }
    }
    throw last;
  }) as typeof fetch;
}

function dialOnce(
  address: string, target: LanTarget, seam: PinnedRequestSeam, input: string | URL | Request, init?: RequestInit,
): Promise<Response> {
  return ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    const given = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(given)) {
      if (!HOP_BY_HOP_DROPPED.has(k.toLowerCase())) headers[k] = v;
    }
    headers.Host = target.hostHeader;
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body));
    const signal = init?.signal ?? undefined;
    const fail = (err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      const e = new Error("network error") as Error & { code?: string };
      if (typeof code === "string") e.code = code;
      reject(e);
    };
    if (signal?.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
    const req = seam.request({
      host: address, port: target.port, method: init?.method ?? "GET", path: `${u.pathname}${u.search}`,
      headers, agent: false,
    }, (res) => {
      const out = new Headers();
      try {
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      } catch {
        res.destroy();
        fail(new Error("bad response headers"));
        return;
      }
      const status = res.statusCode ?? 0;
      const resp = new Response(NULL_BODY_STATUS.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: out });
      if (NULL_BODY_STATUS.has(status)) res.resume();
      resolve(resp);
    });
    const onAbort = () => { req.destroy(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", (err) => { if (!signal?.aborted) fail(err); });
    if (body !== undefined) req.write(body);
    req.end();
  }))(input, init);
}
