// The trusted-reverse-proxy rig (the `tailscale serve` shape, card 4cbbc343): an ISOLATED daemon on its own
// temp LOOM_HOME and an ephemeral port, fronted by an in-test Node reverse proxy, so a Playwright page can be
// served from a genuinely NON-loopback origin. Extracted from gateway-proxy.spec.ts (card f8d2684d) because a
// second spec now needs the same rig and two copies of a 90-line daemon launcher would drift.
//
// Why this and not the shared `loomDaemon` fixture: that fixture opens no proxy listener, and proxy mode needs
// a gateway token at boot. More to the point, a gateway token is the ONLY thing the daemon registers a socket
// under (`gateway/token-sockets.ts`) — a loopback page's sockets are not token-authenticated at all, so a
// revoke closes nothing there and the behaviour under test is unreachable.
//
// SAFETY (every rule the kickoff mandates): the home is a fresh mkdtemp, LOOM_PORT=0, the first-run marker is
// PRE-STAMPED by ./gateway-proxy-seed.mjs and LOOM_DEV/LOOM_SCHEDULER_ENABLED are off, so no Setup Assistant
// and no real `claude` ever starts (re-asserted via assertNoRealClaudeSpawn). The real daemon on 4317 and the
// real ~/.loom are never touched, and `stop()` kills only the child THIS rig spawned, by its own handle.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoRealClaudeSpawn } from "./daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DAEMON_INDEX = path.join(REPO_ROOT, "packages", "daemon", "dist", "index.js");
const WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
const SEED_SCRIPT = path.join(__dirname, "gateway-proxy-seed.mjs");

/** The non-loopback hostname the page is served from. Chromium is told it resolves to 127.0.0.1. */
export const PROXY_HOST = "box.tail1.ts.net";
/** Pass as `test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS })` so `PROXY_HOST` resolves locally. */
export const GATEWAY_PROXY_LAUNCH_OPTIONS = { args: [`--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`] };

export interface GatewayProxyRig {
  /** `http://box.tail1.ts.net:<port>` — the REMOTE-class origin the page under test is served from. */
  origin: string;
  /** The seeded gateway token's plaintext secret (what the browser stores and presents). */
  token: string;
  /** The daemon's own loopback base URL — the HUMAN surface, where a token is revoked/rotated/deleted. */
  loopbackURL: string;
  /** `Authorization` for a loopback WRITE: the daemon mints this guard secret before it listens (card 9ccedbee),
   *  so an unauthenticated non-GET `/api/*` 401s. Read from the rig's OWN home, never a shared one. */
  loopbackAuth: Record<string, string>;
  /** Everything the daemon logged, for a failure message or an assertNoRealClaudeSpawn re-check. */
  log: () => string;
  stop: () => Promise<void>;
}

export async function startGatewayProxyRig(): Promise<GatewayProxyRig> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-e2e-gwproxy-"));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  // 1. The FRONT proxy first: its port is part of the trusted origin, which the daemon must know at boot.
  let target = 0;
  const forward = (headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders => ({ ...headers, "x-forwarded-proto": "http" }); // Host preserved, like Serve
  const front = http.createServer((cReq, cRes) => {
    const up = http.request({ host: "127.0.0.1", port: target, method: cReq.method, path: cReq.url, headers: forward(cReq.headers), agent: false }, (uRes) => { cRes.writeHead(uRes.statusCode ?? 502, uRes.headers); uRes.pipe(cRes); });
    up.on("error", () => { cRes.writeHead(502); cRes.end(); });
    cReq.pipe(up);
  });
  // Upgraded (WebSocket) socket pairs are tracked and torn down in PAIRS. `pipe` alone does not propagate a
  // DESTROY: when the daemon `terminate()`s its end — which is exactly what a gateway-token revoke does
  // (`gateway/token-sockets.ts`) — the upstream half closes without an `end`, so the browser half would linger
  // half-open and `front.close()` would never fire its callback. That shows up as a 30s teardown hang in the
  // afterAll hook, long after the test body itself has passed.
  const upgraded = new Set<import("node:stream").Duplex>();
  front.on("upgrade", (cReq, cSock, head) => {
    const headers = forward(cReq.headers);
    const up = net.connect(target, "127.0.0.1", () => {
      up.write(`${cReq.method} ${cReq.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${String(v)}`).join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(cSock); cSock.pipe(up);
    });
    upgraded.add(cSock); upgraded.add(up);
    const teardown = () => { upgraded.delete(cSock); upgraded.delete(up); cSock.destroy(); up.destroy(); };
    up.on("error", teardown);
    cSock.on("error", teardown);
    up.on("close", teardown);
    cSock.on("close", teardown);
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const frontPort = (front.address() as net.AddressInfo).port;
  const origin = `http://${PROXY_HOST}:${frontPort}`;

  // 2. Seed the home (first-run marker + remoteAccess config + a gateway token), then boot the daemon against it.
  const token = execFileSync(process.execPath, [SEED_SCRIPT], {
    env: { ...process.env, LOOM_HOME: home, LOOM_TEST: "1", LOOM_E2E_REMOTE_ACCESS: JSON.stringify({ enabled: true, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: [origin] }) },
    encoding: "utf8",
  }).trim();
  let log = "";
  const child: ChildProcess = spawn(process.execPath, [DAEMON_INDEX], {
    env: { ...process.env, LOOM_HOME: home, LOOM_PORT: "0", LOOM_WEB_DIST: WEB_DIST, LOOM_DEV: "0", LOOM_SCHEDULER_ENABLED: "0", LOOM_PYTHON_NO_PROVISION: "1", LOOM_SUPPRESS_USAGE_POLLER: "1", LOOM_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => { log += c.toString(); });
  child.stderr?.on("data", (c: Buffer) => { log += c.toString(); });
  const stop = async (): Promise<void> => {
    const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    try { child.kill(); } catch { /* already gone */ }
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 8000))]);
    for (const sock of upgraded) { try { sock.destroy(); } catch { /* already gone */ } }
    upgraded.clear();
    await new Promise<void>((resolve) => { front.closeAllConnections?.(); front.close(() => resolve()); });
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  try {
    // Wait for BOTH listeners' log lines (the proxy listener's is logged after the loopback one).
    const deadline = Date.now() + 30_000;
    let proxyPort: number | null = null;
    let loopbackURL: string | null = null;
    while (Date.now() < deadline && (proxyPort === null || loopbackURL === null)) {
      loopbackURL = /listening on (http:\/\/\S+)/.exec(log)?.[1] ?? null;
      const m = /trusted-proxy listener: http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      proxyPort = m?.[1] ? Number(m[1]) : null;
      if (child.exitCode !== null) throw new Error(`daemon exited early (${child.exitCode}):\n${log}`);
      if (proxyPort === null || loopbackURL === null) await new Promise((r) => setTimeout(r, 100));
    }
    if (proxyPort === null || loopbackURL === null) throw new Error(`the daemon never opened its trusted-proxy listener. Log:\n${log}`);
    target = proxyPort;
    assertNoRealClaudeSpawn(log, "post-boot");
    // The guard secret is written before `app.listen()`, so by the time the listening line is logged the file
    // exists. Without it every loopback WRITE below 401s (and a silent 401 looks exactly like a clean no-op).
    const loopbackSecret = readFileSync(path.join(home, "gateway-loopback.key"), "utf8").trim();
    return { origin, token, loopbackURL, loopbackAuth: { Authorization: `Bearer ${loopbackSecret}` }, log: () => log, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
