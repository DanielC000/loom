// Card 76227b26 — prove the inbox attachment manifest's REMOTE-origin branches end to end.
//
// Gap recorded by card 19b7cf7a (docs/decisions/19b7cf7a-inbox-attachment-manifest.md): on a remote
// origin the manifest renders an image via a credentialed fetch→blob (VaultAsset's mode split reused),
// shows "preview needs loopback access" instead of mounting an iframe for HTML, and disables `Open ↗`
// with a reason. Those three branches were pinned ONLY by the pure helpers (packages/web/test/
// questions.mjs, both origin polarities) — never by an end-to-end remote render. This spec is that render.
//
// HARNESS: the same trusted-proxy rig as vault-remote-assets.spec.ts (its own daemon + LOOM_HOME + first-
// run marker, an in-test reverse proxy, Chromium told `box.tail1.ts.net` resolves to 127.0.0.1 so the page
// origin is a genuine non-loopback hostname) — reused rather than re-derived. The project + a manager
// session + a Request carrying one image + one html attachment are seeded in the DB by the SAME
// ./fixtures/vault-remote-seed.mjs this sibling spec uses (extended, card 76227b26, to ALSO stage a
// question when LOOM_E2E_SEED_QUESTION is set), because every write route — `/internal/test/seed`
// included — is Tier-0 and therefore unreachable from this origin.
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
const SEED_SCRIPT = path.join(__dirname, "fixtures", "vault-remote-seed.mjs");
const PROXY_HOST = "box.tail1.ts.net";

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`] } });

const REQUEST_TITLE = "76227b26-remote-attachments-ask";
const IMAGE_LABEL = "gate-strip.png";
const HTML_LABEL = "mockup.html";

interface Rig { origin: string; token: string; loopbackURL: string; projectId: string; questionId: string; stop: () => Promise<void> }

async function startRig(): Promise<Rig> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-e2e-inboxremote-"));
  const home = path.join(scratch, "home");
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  for (const d of [home, repoDir, vaultDir]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);

  // 1. The FRONT proxy first: its port is part of the trusted origin, which the daemon must know at boot.
  let target = 0;
  const forward = (headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders => ({ ...headers, "x-forwarded-proto": "http" });
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

  // 2. Seed the home (first-run marker + remoteAccess + a gateway token + the project + the question/
  // attachments), then boot.
  const seeded = execFileSync(process.execPath, [SEED_SCRIPT], {
    env: {
      ...process.env, LOOM_HOME: home, LOOM_TEST: "1",
      LOOM_E2E_REMOTE_ACCESS: JSON.stringify({ enabled: true, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: [origin] }),
      LOOM_E2E_REPO_PATH: repoDir, LOOM_E2E_VAULT_PATH: vaultDir, LOOM_E2E_SEED_QUESTION: "1",
    },
    encoding: "utf8",
  }).trim();
  const [token, projectId, questionId] = seeded.split("\t");
  if (!token || !projectId || !questionId) throw new Error(`seed script returned an unusable line: ${JSON.stringify(seeded)}`);

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
    return { origin, token, loopbackURL, projectId, questionId, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

let rig: Rig;
test.beforeAll(async () => { rig = await startRig(); });
test.afterAll(async () => { await rig?.stop(); });

async function openRemoteInboxDialog(page: Page) {
  await page.addInitScript((tok: string) => {
    try {
      localStorage.setItem("loom.gatewayToken", tok);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, rig.token);
  await page.goto(`${rig.origin}/inbox`);
  // Precondition: the token really is in force. Without this a later failure is ambiguous between "the
  // remote attachment fix is broken" and "this page was never authenticated at all".
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);

  const row = page.locator("main").getByTestId("request-row").filter({ hasText: REQUEST_TITLE });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Answer →" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(REQUEST_TITLE)).toBeVisible();
  return dialog;
}

test.describe("inbox attachment manifest on a remote (proxied) origin (card 76227b26)", () => {
  test("(1) the image attachment renders from a blob: URL whose fetched content-type is image/*", async ({ page }) => {
    const dialog = await openRemoteInboxDialog(page);
    const imageRow = dialog.getByTestId("attachment-row").filter({ hasText: IMAGE_LABEL });
    await imageRow.locator("button").first().click();

    const pane = dialog.getByTestId("attachment-preview");
    await expect(pane).toHaveAttribute("data-preview-mode", "image");
    await expect(pane).toContainText(IMAGE_LABEL);

    const img = pane.locator("img");
    await expect(img).toBeVisible();
    // STRUCTURAL: a same-origin blob: URL, never the bare Tier-1 route (which a remote <img src> cannot
    // authenticate) and never a data: URL (that carve-out is for a SCRIPTABLE image type only — see
    // decision f7525818 — and this PNG is not one).
    await expect.poll(() => img.getAttribute("src")).toMatch(/^blob:/);
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64);

    // THE WITNESS: the bytes behind that blob: URL really are an image/* type, not a 401 body or the
    // inert download fallback — read back through the page, the same discipline vault-remote-assets.spec.ts
    // uses for its own blob: URLs (an attribute check alone cannot tell a real image blob from a dangling
    // or mistyped one).
    const src = await img.getAttribute("src");
    const head = await page.evaluate(async (u) => {
      const r = await fetch(u as string);
      return { type: r.headers.get("content-type"), byteLength: (await r.arrayBuffer()).byteLength };
    }, src);
    expect(head.type).toBe("image/png");
    expect(head.byteLength).toBeGreaterThan(0);
  });

  test("(2) the html attachment shows the loopback note and never mounts an iframe", async ({ page }) => {
    const dialog = await openRemoteInboxDialog(page);
    const htmlRow = dialog.getByTestId("attachment-row").filter({ hasText: HTML_LABEL });
    await htmlRow.locator("button").first().click();

    const pane = dialog.getByTestId("attachment-preview");
    await expect(pane).toHaveAttribute("data-preview-mode", "html-needs-loopback");
    await expect(pane).toContainText(HTML_LABEL);
    await expect(pane).toContainText(/needs loopback access/);

    // STRUCTURAL: no iframe ever mounts for this mode, on this origin — decision 19b7cf7a forbids an
    // `<iframe src>` fallback through a blob:/srcdoc/data: document on ANY origin, and here there is no
    // frame element at all rather than one pointed at something that would 401.
    await expect(dialog.getByTestId("attachment-preview-frame")).toHaveCount(0);
  });

  test("(3) Open is disabled on both rows, with the remote-access reason", async ({ page }) => {
    const dialog = await openRemoteInboxDialog(page);
    const rows = dialog.getByTestId("attachment-row");
    await expect(rows).toHaveCount(2);

    for (const label of [IMAGE_LABEL, HTML_LABEL]) {
      const row = rows.filter({ hasText: label });
      const openAction = row.getByTestId("attachment-open");
      // A new-tab navigation carries no Authorization header on ANY kind, so remotely every row's Open
      // action is disabled — never a live `<a href>` a click could still reach (middle-click, ⌘/Ctrl-click,
      // "open in new tab" all bypass a click handler the same way the vault download button's did).
      await expect(openAction).toBeDisabled();
      await expect(openAction).toHaveAttribute("title", /needs loopback access/);
    }
    // And the pane's own Open action agrees — it is the SAME action, not a second implementation that
    // could drift from the row's.
    await expect(dialog.getByTestId("attachment-preview").getByTestId("attachment-open")).toBeDisabled();
  });

  test("(4) no Bearer token ever appears in a URL — the credential rides a header, never a query string", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => { urls.push(r.url()); });
    let imageAuthHeader: string | null = null;
    page.on("request", (r) => {
      if (r.url().includes("/attachments/")) imageAuthHeader = r.headers().authorization ?? imageAuthHeader;
    });

    const dialog = await openRemoteInboxDialog(page);
    // Drive every preview branch that fetches anything, so this sweep covers the full surface.
    await dialog.getByTestId("attachment-row").filter({ hasText: IMAGE_LABEL }).locator("button").first().click();
    await expect(dialog.getByTestId("attachment-preview")).toHaveAttribute("data-preview-mode", "image");
    await dialog.getByTestId("attachment-row").filter({ hasText: HTML_LABEL }).locator("button").first().click();
    await expect(dialog.getByTestId("attachment-preview")).toHaveAttribute("data-preview-mode", "html-needs-loopback");

    // THE NEGATIVE: scan every request URL this flow made. The token is a high-entropy secret, so a
    // substring match is a sound check — if it ever rode in a URL (a query string, a path segment), it
    // would appear verbatim in at least one of these.
    const leaked = urls.filter((u) => u.includes(rig.token));
    expect(leaked, `token must never appear in a URL; saw it in: ${JSON.stringify(leaked)}`).toHaveLength(0);

    // THE POSITIVE CONTROL: the credential really did flow, just on the Authorization HEADER of the
    // attachment fetch — proving the scan above is discriminating (a daemon that never even tried to
    // authenticate would also show zero URL leaks, which would make the negative check vacuous).
    expect(imageAuthHeader).toBe(`Bearer ${rig.token}`);
  });
});
