// Card 4cbbc343 — a browser reaching Loom through a trusted reverse proxy (the `tailscale serve` shape).
//
// WHAT THIS PROVES (the web half, end to end against a REAL daemon in trusted-proxy mode): the SPA shell loads
// without a token, the request that fails for want of one raises the GATEWAY banner (its own copy) and NEVER the
// loopback "writes are locked" banner, a pasted token is verified then stored on the proxy origin, and every request
// (reads included) then carries it — including the /ws/fleet upgrade, whose token rides the subprotocol, never the URL.
// A plain loopback page on the SAME daemon is untouched.
//
// HARNESS: this spec boots its OWN daemon (the shared `loomDaemon` fixture has no proxy listener and proxy mode needs a
// gateway token at boot), seeded through ./fixtures/gateway-proxy-seed.mjs. An in-test Node reverse proxy fronts the
// daemon's 127.0.0.1-only proxy listener, and Chromium is told `box.tail1.ts.net` resolves to 127.0.0.1, so the page's
// origin is a genuine non-loopback hostname. NOT covered: a real Tailscale node (Host/Origin/ws behaviour of Serve
// itself is unverified) — the daemon half is packages/daemon/test/remote-trusted-proxy-real.mjs.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { assertNoRealClaudeSpawn } from "./fixtures/daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_INDEX = path.join(REPO_ROOT, "packages", "daemon", "dist", "index.js");
const WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
const SEED_SCRIPT = path.join(__dirname, "fixtures", "gateway-proxy-seed.mjs");
const PROXY_HOST = "box.tail1.ts.net";

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`] } });

interface Rig { origin: string; token: string; loopbackURL: string; stop: () => Promise<void> }

async function startRig(): Promise<Rig> {
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
  front.on("upgrade", (cReq, cSock, head) => {
    const headers = forward(cReq.headers);
    const up = net.connect(target, "127.0.0.1", () => {
      up.write(`${cReq.method} ${cReq.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${String(v)}`).join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(cSock); cSock.pipe(up);
    });
    up.on("error", () => cSock.destroy());
    cSock.on("error", () => up.destroy());
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
    return { origin, token, loopbackURL, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

let rig: Rig;
test.beforeAll(async () => { rig = await startRig(); });
test.afterAll(async () => { await rig?.stop(); });
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { try { localStorage.setItem("loom.setupWelcomeDismissed", "1"); } catch { /* storage blocked */ } });
});

const gatewayBanner = (page: Page) => page.getByText("This address needs a gateway token.");
const loopbackBanner = (page: Page) => page.getByText("Writes are locked in this browser.");

test.describe("a browser behind a trusted reverse proxy", () => {
  test("the shell loads with no token, raises the GATEWAY banner (never the loopback one), then a pasted token unlocks it", async ({ page }) => {
    const authed: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/") && r.headers().authorization) authed.push(`${r.method()} ${new URL(r.url()).pathname} ${r.headers().authorization}`); });
    const sockets: { url: string; error: boolean }[] = [];
    page.on("websocket", (ws) => { const rec = { url: ws.url(), error: false }; sockets.push(rec); ws.on("socketerror", () => { rec.error = true; }); });

    // The shell itself is public to this class — the page renders, and the first API 401 raises the banner.
    await page.goto(rig.origin + "/");
    await expect(gatewayBanner(page)).toBeVisible();
    await expect(loopbackBanner(page)).toHaveCount(0); // the wrong credential's banner (loom open advice) must never show here

    // A wrong token is refused (verified against the daemon BEFORE it is stored) and nothing is stored.
    await page.getByLabel("Gateway token").fill("definitely-not-a-token");
    await page.getByRole("button", { name: "Use token" }).click();
    await expect(page.getByText("The daemon refused that token")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken"))).toBeNull();

    // The real one: verified, stored on THIS origin, the page reloads and the banner is gone.
    await page.getByLabel("Gateway token").fill(rig.token);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Use token" }).click()]);
    await expect(gatewayBanner(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken"))).toBe(rig.token);
    expect(await page.evaluate(() => localStorage.getItem("loom.loopbackToken")), "the LOOPBACK credential key is never touched").toBeNull();

    // Reads now carry the token (Tier-1 GETs are gated for this class, unlike loopback).
    await expect.poll(() => authed.some((a) => a.startsWith("GET /api/") && a.endsWith(`Bearer ${rig.token}`))).toBe(true);
    // ...and so does the live feed: /ws/fleet opened without an error and its URL carries NO token.
    await expect.poll(() => sockets.some((s) => s.url.includes("/ws/fleet"))).toBe(true);
    expect(sockets.filter((s) => s.url.includes("/ws/fleet")).every((s) => !s.url.includes(rig.token) && !s.url.includes("token="))).toBe(true);
    await expect.poll(() => sockets.filter((s) => s.url.includes("/ws/fleet")).some((s) => !s.error)).toBe(true);
    await expect(gatewayBanner(page)).toHaveCount(0);
  });

  test("?gwtoken= is VERIFIED, then captured into the gateway key and stripped from the address bar; the banner never appears", async ({ page }) => {
    await page.goto(`${rig.origin}/?gwtoken=${encodeURIComponent(rig.token)}`);
    // The capture verifies against the daemon and then reloads the page, so a read can land mid-navigation: retry through it.
    await expect.poll(async () => { try { return await page.evaluate(() => localStorage.getItem("loom.gatewayToken")); } catch { return "navigating"; } }).toBe(rig.token);
    expect(page.url()).not.toContain("gwtoken");
    await expect(gatewayBanner(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("loom.loopbackToken"))).toBeNull();
  });

  test("a crafted ?gwtoken= link with a REFUSED token never clobbers the token this browser already holds", async ({ page }) => {
    await page.goto(`${rig.origin}/?gwtoken=${encodeURIComponent(rig.token)}`);
    await expect.poll(async () => { try { return await page.evaluate(() => localStorage.getItem("loom.gatewayToken")); } catch { return "navigating"; } }).toBe(rig.token);
    await expect(gatewayBanner(page)).toHaveCount(0);

    await page.goto(`${rig.origin}/?gwtoken=lgw_not-a-real-token`);
    await expect(page.getByText("A link's gateway token was refused.")).toBeVisible();
    expect(page.url()).not.toContain("gwtoken");
    expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken")), "the working token is untouched").toBe(rig.token);
    await expect(gatewayBanner(page)).toHaveCount(0); // it does NOT claim a token is missing
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("A link's gateway token was refused.")).toHaveCount(0);
  });

  test("CONTROL: the same daemon's plain loopback page never shows the gateway banner", async ({ page }) => {
    await page.goto(rig.loopbackURL + "/");
    await expect(page.locator("body")).toContainText(/Loom|Overview|Board/);
    await expect(gatewayBanner(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken"))).toBeNull();
  });
});
