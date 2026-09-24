import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { RemoteAccessConfig } from "@loom/shared";
import { canOpenRemoteListener, isAllInterfacesBindHost, isLoopbackBindHost, isTrustTierHookActive, remoteListenerRefusalReasons } from "./trust-tier.js";

// @decision 23496950 — the remote listener is a SEPARATE server; loopback (`app.server`) stays plain HTTP on
// PORT. Do not fold TLS back into `Fastify({ https })`, bypass `app.routing`, or drop the `upgrade` forwarder.

/** The remote listener's scheme + port once it is really listening — the fact `Origin` acceptance for a
 *  non-loopback peer is matched against (full origin: scheme + host + port). */
export interface RemoteEndpoint { scheme: "http" | "https"; port: number }

/** Mutable holder shared between the boot code (which fills it) and buildServer (which reads it per request
 *  and registers the onClose hook that calls `close`). `current === null` ⇒ no remote listener is open ⇒
 *  a non-loopback peer's Origin can never match. */
export interface RemoteEndpointRef {
  current: RemoteEndpoint | null;
  close?: () => Promise<void>;
}

export type RemoteListenerResult =
  | { opened: true; endpoint: RemoteEndpoint; server: http.Server | https.Server; forwardUpgrade: (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void; httpsActive: boolean; close: () => Promise<void> }
  | { opened: false; reasons: string[]; httpsActive: boolean };

/**
 * Slow-loris limits for the internet-facing, PRE-AUTH remote server. These are set EXPLICITLY — never copied
 * from `app.server`: Fastify leaves `requestTimeout` at 0 (none) and `keepAliveTimeout` at 72s, which would
 * make this listener weaker than plain Node (requestTimeout 300s, keepAliveTimeout 5s), and an unauthenticated
 * peer could announce a large Content-Length and hold the socket after a 401. Values, and why:
 *  - `headersTimeout` 10s — a legitimate client sends its header block in milliseconds; must be <= requestTimeout.
 *  - `requestTimeout` 30s — the WHOLE request (headers + body); API bodies are small JSON, so 30s is generous
 *    and an announced-but-never-sent body is cut at 30s rather than held indefinitely.
 *  - `keepAliveTimeout` 5s — an idle pre-auth keep-alive socket is released quickly (Node's own default).
 *  - `timeout` 60s — socket inactivity mid-request. Node clears it on an upgraded socket, so a live WS is not
 *    affected (checked with an idle ws against a 400ms timeout).
 *  - `connectionsCheckingInterval` 5s — how often Node enforces headers/requestTimeout (default 30s would make
 *    the effective bound up to 30s looser).
 * The loopback server keeps Fastify's own settings (loopback peers are not pre-auth strangers).
 */
export interface RemoteServerTimeouts {
  headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; timeout: number; connectionsCheckingInterval: number;
}
export const REMOTE_SERVER_TIMEOUTS: Readonly<RemoteServerTimeouts> = {
  headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, timeout: 60_000, connectionsCheckingInterval: 5_000,
};

export interface OpenRemoteListenerOpts {
  /** Test seam: override individual slow-loris limits (production passes none — see REMOTE_SERVER_TIMEOUTS). */
  timeouts?: Partial<RemoteServerTimeouts>;
  /** The port the loopback listener actually bound (0 never reaches here — pass the real bound port). */
  loopbackPort: number;
  tokenExists: boolean;
  ref: RemoteEndpointRef;
}

/** The remote port: explicit `remoteAccess.port`, else the loopback port + 1. */
export function resolveRemotePort(cfg: RemoteAccessConfig, loopbackPort: number): number {
  return cfg.port ?? loopbackPort + 1;
}

/**
 * Try to open the remote listener. NEVER throws: every refusal (no token, TLS material missing/unreadable/
 * invalid, wildcard bind without `allowedHosts`, port collision, listen failure) comes back as
 * `{opened:false, reasons}` so the caller can log it HONESTLY and carry on loopback-only.
 *
 * TLS is loaded here — two independent failure points (file read vs Node rejecting the material), both
 * degrading to `httpsActive:false`, never a throw. `httpsActive` is the ONE real signal the TLS mandate is
 * checked against; a non-tailnet bind with `httpsActive:false` is refused, never opened as plain HTTP.
 */
export async function openRemoteListener(app: FastifyInstance, cfg: RemoteAccessConfig, opts: OpenRemoteListenerOpts): Promise<RemoteListenerResult> {
  if (!cfg.enabled || isLoopbackBindHost(cfg.bindHost)) return { opened: false, reasons: [], httpsActive: false };

  let tlsOptions: { cert: Buffer; key: Buffer } | undefined;
  if (cfg.tls) {
    try {
      tlsOptions = { cert: fs.readFileSync(cfg.tls.certPath), key: fs.readFileSync(cfg.tls.keyPath) };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gateway] failed to read remoteAccess.tls cert/key (${(err as Error).message}).`);
    }
  }
  const to: RemoteServerTimeouts = { ...REMOTE_SERVER_TIMEOUTS, ...opts.timeouts };
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => { app.routing(req, res); };
  let server: http.Server | https.Server | undefined;
  let httpsActive = false;
  if (tlsOptions) {
    try {
      server = https.createServer({ ...tlsOptions, connectionsCheckingInterval: to.connectionsCheckingInterval }, handler);
      httpsActive = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gateway] remoteAccess.tls cert/key were read but Node rejected them as invalid TLS material (${(err as Error).message}).`);
    }
  }

  const reasons = remoteListenerRefusalReasons(cfg, opts.tokenExists, httpsActive);
  const port = resolveRemotePort(cfg, opts.loopbackPort);
  if (port === opts.loopbackPort) reasons.push(`remoteAccess.port (${port}) equals the loopback listener's port — the remote listener needs its own port`);
  if (!canOpenRemoteListener(cfg, opts.tokenExists, httpsActive) || reasons.length > 0) {
    server?.close();
    return { opened: false, reasons, httpsActive };
  }

  // Tailnet bind with no (loadable) TLS: encrypted by the tailnet itself — plain HTTP, as before.
  server ??= http.createServer({ connectionsCheckingInterval: to.connectionsCheckingInterval }, handler);
  const listening = server;

  // Explicit slow-loris limits (see REMOTE_SERVER_TIMEOUTS for the values and why they are NOT mirrored from
  // app.server). Only the malformed-request handling is shared: the app's `clientError` listeners are reused so
  // a bad request gets the same 400 handling, and `maxRequestsPerSocket` is mirrored (0 = unlimited on both).
  const src = app.server;
  listening.headersTimeout = to.headersTimeout;
  listening.requestTimeout = to.requestTimeout;
  listening.keepAliveTimeout = to.keepAliveTimeout;
  listening.timeout = to.timeout;
  listening.maxRequestsPerSocket = src.maxRequestsPerSocket;
  for (const l of src.listeners("clientError")) listening.on("clientError", l as (...a: unknown[]) => void);

  const forwardUpgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void => {
    app.server.emit("upgrade", req, socket, head);
  };
  listening.on("upgrade", forwardUpgrade);
  // Track every raw socket: an upgrade-shaped request leaves the http server's own connection bookkeeping, so
  // `closeAllConnections()` alone never reaches a WS socket (or a rejected-upgrade socket) — without this a
  // teardown could hang on a peer that never closes. On close every tracked socket is destroyed.
  const sockets = new Set<import("node:net").Socket>();
  listening.on("connection", (sock) => { sockets.add(sock); sock.once("close", () => sockets.delete(sock)); });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      listening.once("error", onError);
      listening.listen({ port, host: cfg.bindHost }, () => { listening.off("error", onError); resolve(); });
    });
  } catch (err) {
    listening.removeListener("upgrade", forwardUpgrade);
    return { opened: false, reasons: [`could not listen on ${cfg.bindHost}:${port} (${(err as Error).message})`], httpsActive };
  }

  const endpoint: RemoteEndpoint = { scheme: httpsActive ? "https" : "http", port: (listening.address() as AddressInfo).port };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      opts.ref.current = null;
      listening.removeListener("upgrade", forwardUpgrade);
      listening.close(() => resolve());
      listening.closeAllConnections();
      for (const sock of sockets) sock.destroy();
    });
    return closed;
  };
  opts.ref.current = endpoint;
  opts.ref.close = close;
  return { opened: true, endpoint, server: listening, forwardUpgrade, httpsActive, close };
}

export interface GatewayListenersOpts {
  /** Loopback listener port (0 = OS-assigned, used by tests). */
  port: number;
  remoteAccess: RemoteAccessConfig;
  /** Evaluated once, after the loopback listener is up. */
  tokenExists: () => boolean;
  ref: RemoteEndpointRef;
  /** Called with fastify's own listen address once the loopback listener is up, BEFORE the remote one opens. */
  onLoopbackListening?: (boundAddress: string) => void;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  timeouts?: Partial<RemoteServerTimeouts>;
}

/**
 * The ONE boot composition of both listeners — used by index.ts and by the real-listen test, so the test
 * exercises the real wiring instead of a copy. Order matters: the LOOPBACK listener (plain HTTP on 127.0.0.1)
 * opens first and a failure to bind it throws (fatal, as always); the REMOTE listener opens second and any
 * refusal or bind failure only warns, leaving the daemon loopback-only with an honest log line.
 */
export async function startGatewayListeners(app: FastifyInstance, opts: GatewayListenersOpts): Promise<{ boundAddress: string; loopbackPort: number; remote: RemoteListenerResult | null }> {
  const log = opts.log ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
  const boundAddress = await app.listen({ port: opts.port, host: "127.0.0.1" });
  const loopbackPort = (app.server.address() as AddressInfo).port;
  opts.onLoopbackListening?.(boundAddress);
  const cfg = opts.remoteAccess;
  if (!isTrustTierHookActive(cfg)) return { boundAddress, loopbackPort, remote: null };
  const remote = await openRemoteListener(app, cfg, { loopbackPort, tokenExists: opts.tokenExists(), ref: opts.ref, timeouts: opts.timeouts });
  if (remote.opened) {
    log.info(`[gateway] remote listener: ${remote.endpoint.scheme}://${cfg.bindHost}:${remote.endpoint.port} (loopback stays plain HTTP on 127.0.0.1:${loopbackPort}).`);
    // P5b hardening follow-up (card 80e2093f, item 2): 0.0.0.0/:: is an explicit, owner-decided supported
    // LAN-in-scope bind mode (still gated by the token+TLS wall) — but binding every interface should never
    // be SILENT. Log it plainly the one time it's actually opened, distinct from the routine listen line.
    if (isAllInterfacesBindHost(cfg.bindHost)) {
      log.warn(`[gateway] Loom gateway remote listener bound to all interfaces (${cfg.bindHost}) — reachable from your local network (still gated by the access token + TLS + the remoteAccess.allowedHosts Host allowlist).`);
    }
  } else {
    log.warn(`[gateway] remoteAccess.enabled with bindHost=${cfg.bindHost} but ${remote.reasons.join("; ")} — NOT opening a remote listener. The daemon is loopback-only: plain HTTP on 127.0.0.1:${loopbackPort}.`);
  }
  return { boundAddress, loopbackPort, remote };
}
