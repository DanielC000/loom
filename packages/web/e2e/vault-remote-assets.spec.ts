// Card f7525818 — vault raw assets on a REMOTE origin.
//
// WHAT THIS PROVES, and why it needs a remote origin to prove it: `/api/projects/:id/vault/raw` is Tier-1,
// which means Authorization-Bearer-only for a non-loopback peer — and a browser attaches nothing to an
// `<img src>`, an `<object data>` or an `<a href download>`. So behind a reverse proxy every vault image
// was a broken box, the PDF embed was blank, "Download file" saved the daemon's JSON 401 body under the
// real file's name, and the binary card's size read "unknown" (its HEAD probe was not even Tier-1).
// NONE of that is visible on loopback, where reads are ungated — which is exactly why it shipped.
//
// Each assertion here is written so a 401 FAILS it rather than passing quietly: an image is checked by
// `naturalWidth`, a download by its real decoded BYTES, and the size by the actual file length.
//
// HARNESS: the trusted-proxy rig from gateway-proxy.spec.ts (its own daemon + LOOM_HOME + first-run marker,
// an in-test reverse proxy, and Chromium told `box.tail1.ts.net` resolves to 127.0.0.1 so the page origin is
// a genuine non-loopback hostname). The project is seeded in the DB by ./fixtures/vault-remote-seed.mjs
// rather than over REST, because every write route is Tier-0 and therefore unreachable from this origin.
// The LOOPBACK control at the end runs against the SAME daemon: it is what separates "the fix works" from
// "this spec would pass against anything".
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── Fixtures, all byte-exact so an assertion can name the real size/content ─────────────────────────
// A real 64x64 PNG (a solid square). `naturalWidth === 64` is the whole point: a 401 or a blocked load
// leaves it 0, so this cannot pass on a broken image the way a visibility check would.
const PNG_64 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeElEQVR4nO3PUQkAIBTAwNfJtKbVEH4cwmABbrPO/rrhgga0"
  + "oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEAL"
  + "GtCCBrSgAS1oQAseu1+IsaWKj/q+AAAAAElFTkSuQmCC",
  "base64",
);
// A minimal but genuinely well-formed one-page PDF, so Chromium's native viewer actually instantiates
// rather than erroring out on a stub.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n"
  + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
  + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
  + "trailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);
// An opaque binary with a distinctive, exact length — the number the binary card's HEAD probe must show
// instead of "unknown size".
const BIN_BYTES = Buffer.alloc(4242, 0x5a);
const BIN_SIZE_LABEL = "4.1 KB"; // humanSize(4242) in pages/Vault.tsx

// A HOSTILE vault SVG. Vault bytes are untrusted — an agent's `vault_write`, a research import, anything
// the owner dropped in the folder — and an SVG is a full scriptable document whenever a browser is made to
// NAVIGATE to it rather than decode it in an `<img>`. This one renders as a plain 48×48 square (so the
// "does it still display?" leg is real) and its `<script>` copies the gateway token straight out of
// whatever origin's `localStorage` it lands in, under `SVG_MARKER_KEY`. Writing the TOKEN rather than a
// flag is deliberate: the assertion then names the exact thing that would have been exfiltrated.
const SVG_MARKER_KEY = "loom.e2e.svgScriptRan";
const EVIL_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">`
  + `<rect width="48" height="48" fill="#33ff99"/>`
  + `<script type="application/ecmascript"><![CDATA[`
  + `try { localStorage.setItem(${JSON.stringify(SVG_MARKER_KEY)}, localStorage.getItem("loom.gatewayToken") || "reached-storage-but-no-token"); }`
  + ` catch (e) { /* an opaque origin cannot touch storage — which is the point */ }`
  + `]]></script></svg>\n`,
  "utf8",
);

interface Rig { origin: string; token: string; loopbackURL: string; projectId: string; stop: () => Promise<void> }

async function startRig(): Promise<Rig> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-e2e-vaultremote-"));
  const home = path.join(scratch, "home");
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  for (const d of [home, repoDir, vaultDir, path.join(vaultDir, "Design")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);

  writeFileSync(path.join(vaultDir, "pic.png"), PNG_64);
  writeFileSync(path.join(vaultDir, "doc.pdf"), PDF_BYTES);
  writeFileSync(path.join(vaultDir, "opaque.bin"), BIN_BYTES);
  writeFileSync(path.join(vaultDir, "evil.svg"), EVIL_SVG);
  writeFileSync(path.join(vaultDir, "Design", "inline.png"), PNG_64);
  // The markdown consumer: an inline image resolved through the vault, NOT an external http(s) one.
  writeFileSync(path.join(vaultDir, "Note.md"), "# Inline asset\n\n![a vault image](Design/inline.png)\n", "utf8");

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

  // 2. Seed the home (first-run marker + remoteAccess + a gateway token + the vault project), then boot.
  const seeded = execFileSync(process.execPath, [SEED_SCRIPT], {
    env: {
      ...process.env, LOOM_HOME: home, LOOM_TEST: "1",
      LOOM_E2E_REMOTE_ACCESS: JSON.stringify({ enabled: true, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: [origin] }),
      LOOM_E2E_REPO_PATH: repoDir, LOOM_E2E_VAULT_PATH: vaultDir,
    },
    encoding: "utf8",
  }).trim();
  const [token, projectId] = seeded.split("\t");
  if (!token || !projectId) throw new Error(`seed script returned an unusable line: ${JSON.stringify(seeded)}`);

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
    return { origin, token, loopbackURL, projectId, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

let rig: Rig;
test.beforeAll(async () => { rig = await startRig(); });
test.afterAll(async () => { await rig?.stop(); });

// Open the vault page on the PROXY origin with the gateway token already stored and the seeded project
// pinned active, so each test lands straight on the surface under examination.
async function openRemoteVault(page: Page) {
  await page.addInitScript(([tok, id]) => {
    try {
      localStorage.setItem("loom.gatewayToken", tok);
      localStorage.setItem("loom.projectId", id);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, [rig.token, rig.projectId] as const);
  await page.goto(`${rig.origin}/vault`);
  // Precondition: the token really is in force. Without this a later failure is ambiguous between "the
  // asset fix is broken" and "this page was never authenticated at all".
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
}

const treeRow = (page: Page, name: string) => page.locator("button.loom-tree-row").filter({ hasText: name });

test.describe("vault raw assets on a remote (proxied) origin", () => {
  test("PRECONDITION: the raw URL the app used to hand the browser is genuinely refused on this origin", async ({ page }) => {
    // This is the defect in one line, and it is what makes every other test in this file meaningful. If
    // a credential-less raw load ever starts succeeding here, the rest of this spec passes vacuously.
    //
    // Driven from INSIDE the page, not via `page.request`: the `--host-resolver-rules` mapping that makes
    // this hostname resolve is a BROWSER flag, and Playwright's Node-side request context does not honour
    // it (it fails ENOTFOUND). Fetching from the page is also the faithful model — it is the same origin
    // and the same credential-less load an `<img src>` performs.
    await page.goto(`${rig.origin}/`);
    const rawPath = `/api/projects/${rig.projectId}/vault/raw?path=pic.png`;

    const refused = await page.evaluate(async (u) => (await fetch(u)).status, rawPath);
    expect(refused, "a credential-less raw load must be refused on a remote origin").toBe(401);

    // The same URL WITH the bearer works — so the refusal is about the CREDENTIAL, not a broken route.
    const allowed = await page.evaluate(async ([u, tok]) => {
      const r = await fetch(u, { headers: { authorization: `Bearer ${tok}` } });
      return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
    }, [rawPath, rig.token] as const);
    expect(allowed.status).toBe(200);
    expect(allowed.bytes).toBe(PNG_64.length);

    // ...and the literal shape of the defect: an <img> pointed at that bare URL never decodes, so the
    // `naturalWidth === 64` assertions in the next test are measuring something that can genuinely fail.
    const bareImgWidth = await page.evaluate((u) => new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve(0);
      img.src = u;
    }), rawPath);
    expect(bareImgWidth, "the pre-fix consumer: a bare <img src> on the raw URL loads nothing").toBe(0);
  });

  test("an image RENDERS (naturalWidth > 0), in the viewer and inline in markdown", async ({ page }) => {
    await openRemoteVault(page);

    await treeRow(page, "pic.png").click();
    const viewer = page.locator("main img").first();
    await expect(viewer).toBeVisible();
    // The real intrinsic width of the fixture. A 401 (or any failed load) leaves this 0, so this cannot
    // pass on a broken image — which is precisely how the pre-fix behaviour presented.
    await expect.poll(() => viewer.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64);
    await expect.poll(() => viewer.evaluate((e: HTMLImageElement) => e.complete && e.naturalHeight)).toBe(64);

    // The markdown consumer is a SEPARATE code path (Markdown.tsx's `AssetImage`), so it gets its own leg.
    // No folder expansion needed: the inline image resolves against the FULL vault tree, not the visible rows.
    const assetFetches: string[] = [];
    page.on("request", (r) => { if (r.url().includes("vault/raw") && r.url().includes("inline.png")) assetFetches.push(r.url()); });

    await treeRow(page, "Note.md").click();
    const inline = page.locator("main img.md-img").first();
    await expect(inline).toBeVisible();
    await expect.poll(() => inline.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64);

    // `AssetImage` is a COMPONENT TYPE handed to Markdown, so an inline arrow would be a NEW type on every
    // render — React would remount every inline image and (here, where each one is an authenticated blob)
    // re-fetch it. Typing in the file filter re-renders the pane that owns ContentView without changing
    // the open note, so a remount-per-render shows up as a growing fetch count; a stable identity does not.
    // (The filter narrows the visible TREE only; `files` stays the whole vault, so the image still resolves.)
    const before = assetFetches.length;
    expect(before, "the inline asset is fetched at least once, to render it").toBeGreaterThan(0);
    for (const ch of ["p", "i", "c"]) await page.getByPlaceholder("Filter files…").press(ch);
    await expect(page.getByPlaceholder("Filter files…")).toHaveValue("pic");
    await expect.poll(() => inline.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64); // still rendered
    expect(assetFetches.length, "three re-renders must not re-fetch the inline asset").toBe(before);
  });

  test("a SCRIPTABLE image never gets a same-origin URL — the 'open image in new tab' move cannot reach the app's storage", async ({ page, context }) => {
    // THE HAZARD. An `<img src>` is safe for an SVG — it decodes, it never scripts — but the URL in that
    // `src` is not private to the `<img>`: "Open image in new tab", dragging it to the address bar, or any
    // future consumer can navigate to it. An OBJECT URL inherits the app's own origin, so navigating to one
    // minted `image/svg+xml` renders the vault's bytes as a top-level document ON THIS ORIGIN, where its
    // `<script>` runs with the `localStorage` that holds the gateway token. The daemon's own defences
    // against exactly this (`Content-Security-Policy: sandbox`, `Content-Disposition: attachment`, card
    // 68bef69c) are RESPONSE HEADERS and do not survive into a blob, so the client has to refuse the
    // same-origin URL itself.
    await openRemoteVault(page);
    await treeRow(page, "evil.svg").click();

    const viewer = page.locator("main img").first();
    await expect(viewer).toBeVisible();
    // It still RENDERS. The fix is not "stop displaying SVGs" — a remote origin must not be feature-poorer
    // than loopback, where the direct URL displays this file fine.
    await expect.poll(() => viewer.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(48);

    const marker = () => page.evaluate((k) => {
      try { return localStorage.getItem(k); } catch { return "storage-unreadable"; }
    }, SVG_MARKER_KEY);

    // ── POSITIVE CONTROL: the pre-fix shape, rebuilt here, so the null assertion below can genuinely fail ──
    // A same-origin `blob:` of these exact bytes with their real type — precisely what the app used to hand
    // the `<img>`. Opening it in a new tab must steal the token. This proves the navigation, the SVG's
    // script and the cross-tab storage read all work in THIS rig; without it, "the marker is null" could be
    // passing because the browser refused the navigation, or the script never ran, or the read is blind.
    const evilBlobUrl = await page.evaluate(async (p) => {
      const r = await fetch(p, { headers: { authorization: `Bearer ${localStorage.getItem("loom.gatewayToken") ?? ""}` } });
      return URL.createObjectURL(new Blob([await r.blob()], { type: "image/svg+xml" }));
    }, `/api/projects/${rig.projectId}/vault/raw?path=evil.svg`);
    expect(evilBlobUrl.startsWith("blob:")).toBe(true);

    const controlTab = await context.newPage();
    await controlTab.goto(evilBlobUrl); // resolves on `load`, and an inline <script> runs during parse
    await controlTab.close();
    expect(await marker(), "POSITIVE CONTROL: a same-origin blob: of this SVG DOES script this origin and read its token")
      .toBe(rig.token);

    // Clear it, and verify the clear actually took — otherwise the real leg below could inherit a stale null.
    await page.evaluate((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } }, SVG_MARKER_KEY);
    expect(await marker()).toBeNull();

    // ── THE REAL LEG: the URL the app itself rendered, driven through the same navigation ────────────────
    const src = await viewer.getAttribute("src");
    expect(src, "the SVG viewer must resolve to some URL").toBeTruthy();
    // STRUCTURAL: not same-origin. This is the whole fix in one assertion.
    expect(src?.startsWith("blob:"), `a scriptable image must not get a same-origin blob url (got ${src?.slice(0, 32)}…)`).toBe(false);
    expect(src?.startsWith("data:image/svg+xml"), "it is carried as a data: URL, which has no origin to inherit").toBe(true);

    const openedTab = await context.newPage();
    // A top-level navigation to exactly what the app rendered. Chrome REFUSING a top-level `data:`
    // navigation is one of the two defences here, not a failure — so a throw is recorded, not rethrown; the
    // assertion is about storage either way. (The other defence is the opaque origin, which is what makes
    // this safe in a browser that does navigate.)
    let navigated = true;
    try { await openedTab.goto(src as string); } catch { navigated = false; }
    await openedTab.close();
    expect(await marker(), `the app-rendered URL let the vault SVG script this origin (top-level navigation ${navigated ? "succeeded" : "was refused by the browser"})`)
      .toBeNull();
  });

  test("a PDF loads into the embed", async ({ page }) => {
    await openRemoteVault(page);
    await treeRow(page, "doc.pdf").click();

    // The embed is mounted at all, with a resolved source — not the bare raw URL that would 401, and not
    // the error card (PdfView renders a card INSTEAD of an <object> when the fetch fails, so a count of 1
    // here already excludes that path).
    const object = page.locator("main object[type='application/pdf']");
    await expect(object).toHaveCount(1);
    await expect.poll(() => object.getAttribute("data")).toMatch(/^blob:/);
    await expect(page.getByText(/Couldn’t load this PDF/)).toHaveCount(0);

    // THE WITNESS: the bytes behind that source are the real PDF, not a 401 body. Read back through the
    // page, because an attribute check alone cannot tell a working object URL from a dangling one.
    //
    // ⚠️ Deliberately NOT asserted: that Chromium actually PAINTS the PDF. `<object>` keeps its fallback
    // children in the DOM either way, and whether the headless build instantiates the native viewer is a
    // property of the browser, not of this card — asserting it would make this spec fail for a reason the
    // fix neither caused nor could fix. What this card owns is that the embed gets authenticated bytes.
    const head = await object.evaluate(async (el: HTMLObjectElement) => {
      const r = await fetch(el.getAttribute("data") as string);
      return { magic: new TextDecoder().decode((await r.arrayBuffer()).slice(0, 8)), type: r.headers.get("content-type") };
    });
    expect(head.magic).toBe("%PDF-1.4");
    // The blob keeps application/pdf (lib/vaultAsset.ts `viewBlobType`) — <object> needs the real type to
    // reach the native viewer, and a PDF is the one non-image type that keeps it.
    expect(head.type).toBe("application/pdf");
  });

  test("the binary card shows the REAL size (its HEAD probe is authenticated), and Download saves real bytes", async ({ page }) => {
    await openRemoteVault(page);
    await treeRow(page, "opaque.bin").click();

    // The HEAD probe behind this used not to be Tier-1 at all, so this read "unknown size" remotely.
    await expect(page.getByText(BIN_SIZE_LABEL)).toBeVisible();
    await expect(page.getByText("unknown size")).toHaveCount(0);

    const download = page.waitForEvent("download");
    // A BUTTON remotely, not a link — see the next test for why that distinction is the fix.
    await page.getByRole("button", { name: "Download file" }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("opaque.bin");

    // THE WITNESS: the saved file's actual BYTES. The pre-fix failure saved a JSON 401 body under this
    // same name — a filename assertion alone would have passed on it, which is why the content is read.
    const savedPath = await saved.path();
    const bytes = readFileSync(savedPath);
    expect(bytes.length, "a 401 JSON body is ~20 bytes; the real file is 4242").toBe(BIN_BYTES.length);
    expect(bytes.equals(BIN_BYTES)).toBe(true);
  });

  test("remotely, Download has NO bare URL to fall through to, and a same-tick double click fetches once", async ({ page }) => {
    await openRemoteVault(page);
    await treeRow(page, "opaque.bin").click();

    // STRUCTURAL, and the stronger half of the fix: the raw URL is not in the DOM at all on this origin.
    // It used to sit on a live `<a href … download>` with the click merely intercepted, which every route
    // that bypasses the handler still reaches — a middle-click, a ⌘/Ctrl-click, "Open link in a new tab",
    // or a second click while "Preparing…" (the old guard returned on `busy` WITHOUT preventDefault). Each
    // loads the URL credential-less, i.e. a 401, and `download=` then saves that JSON body under the real
    // file's name. A `<button>` has no navigable target for any of those to resolve to.
    await expect(page.getByRole("button", { name: "Download file" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Download file" })).toHaveCount(0);
    await expect(page.locator('main a[href*="vault/raw"]'), "no bare raw URL anywhere in the viewer on a remote origin").toHaveCount(0);

    // BEHAVIOURAL: two clicks in ONE tick. `busy` is React state, so it is still false in the handler's
    // closure for the second click — a `if (busy) return` guard cannot see it and both clicks would fetch
    // (and save) the file. Only a synchronously-updated ref catches this, which is what the fix uses.
    const rawGets: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && r.url().includes("vault/raw") && r.url().includes("opaque.bin")) rawGets.push(r.url());
    });

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download file" }).evaluate((el: HTMLElement) => { el.click(); el.click(); });
    const saved = await download;

    // The save is real bytes, not a 401 body, under the real name.
    expect(saved.suggestedFilename()).toBe("opaque.bin");
    expect(readFileSync(await saved.path()).equals(BIN_BYTES), "a 401 JSON body is ~20 bytes; the real file is 4242").toBe(true);

    // Exactly ONE fetch. Ordering is sound rather than a race: both clicks were dispatched synchronously, so
    // a second fetch would have been INITIATED (and recorded — `request` fires at request start) before this
    // first one's response, which the awaited download above has already consumed.
    expect(rawGets.length, `expected a single authenticated fetch, saw ${rawGets.length}`).toBe(1);
  });

  // ── Card aac0de44, site 2: the download control's own hover ────────────────────────────────────────
  // `VaultDownloadLink` built both of its branches from one `shared` inline style that restated
  // `.loom-btn-primary`'s own rest chrome (`color`/`border`, the --loom-phosphor tokens, verbatim), and
  // the <button> branch added `background: "transparent"` on top. That last one is the live defect:
  // `.loom-btn-primary:not(:disabled):hover { background: var(--loom-phosphor-dim) }` is the variant's
  // ONLY hover rule, so an inline `background` shadowed it completely and the remote download button was
  // visually inert on hover. The <a> branch set no background and hovered correctly all along — which is
  // why this needs the REMOTE origin to measure at all, and why the loopback control below is its pair.
  // Every inline chrome declaration is gone; the rest appearance is pinned first, then a real hover.
  test("the remote download BUTTON hovers (its inline background no longer shadows the variant rule)", async ({ page }) => {
    await openRemoteVault(page);
    await treeRow(page, "opaque.bin").click();

    const button = page.getByRole("button", { name: "Download file" });
    await expect(button).toBeVisible();
    // REST, byte-identical to the deleted inline values: --loom-phosphor #2ee66e on a 1px phosphor
    // border, and `.loom-btn`'s transparent base where the inline `background: "transparent"` was.
    await expect(button).toHaveCSS("color", "rgb(46, 230, 110)");
    await expect(button).toHaveCSS("border-top-color", "rgb(46, 230, 110)");
    await expect(button).toHaveCSS("border-top-width", "1px");
    await expect(button).toHaveCSS("border-top-style", "solid");
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    // HOVER. `toHaveCSS` retries, so it reads the settled end state past the 80ms `.loom-btn`
    // transition rather than an interpolated frame mid-flight.
    await button.hover();
    await expect(button).toHaveCSS("background-color", "rgba(46, 230, 110, 0.15)");
    // The fill is the whole rule — the label and border must not move with it.
    await expect(button).toHaveCSS("color", "rgb(46, 230, 110)");
    await expect(button).toHaveCSS("border-top-color", "rgb(46, 230, 110)");
  });

  test("CONTROL: on the SAME daemon's loopback origin the consumers still use the plain raw URL", async ({ page }) => {
    // Loopback reads are ungated, so the direct URL is kept there deliberately — the browser streams it,
    // range-requests a big PDF for the native viewer, and writes a download straight to disk. This control
    // is what stops the fix from quietly becoming "everything goes through a blob everywhere".
    await page.addInitScript((id) => {
      try { localStorage.setItem("loom.projectId", id); localStorage.setItem("loom.setupWelcomeDismissed", "1"); } catch { /* storage blocked */ }
    }, rig.projectId);
    await page.goto(`${rig.loopbackURL}/vault`);

    await treeRow(page, "pic.png").click();
    const viewer = page.locator("main img").first();
    await expect(viewer).toHaveAttribute("src", /\/vault\/raw\?path=/);
    await expect.poll(() => viewer.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64);

    // ...including the SVG. The data: URL above is a REMOTE-ONLY measure: it exists because an object URL
    // would be same-origin, and on loopback there is no blob in the first place. (The daemon's CSP sandbox +
    // `Content-Disposition: attachment` — card 68bef69c — are what cover a navigation to this direct URL,
    // and they DO apply here because this is a real HTTP response rather than a blob.)
    await treeRow(page, "evil.svg").click();
    const svg = page.locator("main img").first();
    await expect(svg).toHaveAttribute("src", /\/vault\/raw\?path=evil\.svg/);
    await expect.poll(() => svg.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(48);

    await treeRow(page, "opaque.bin").click();
    // Still a real LINK here, with the bare href — the <button> is the remote branch only. This is the
    // contrast that stops the fix becoming "everything is a fetch-and-save button everywhere".
    const link = page.getByRole("link", { name: "Download file" });
    await expect(link).toHaveAttribute("href", /\/vault\/raw\?path=/);
    await expect(page.getByRole("button", { name: "Download file" })).toHaveCount(0);
    await expect(page.getByText(BIN_SIZE_LABEL)).toBeVisible();

    // The <a> half of card aac0de44: it shares the same `shared` style object as the remote <button>,
    // so its rest appearance must be identical AND unchanged — and because it never set a `background`
    // of its own, its hover worked before the fix too. Asserting it here is what shows the fix did not
    // disturb the branch that was already correct. (`:not(:disabled)` matches an <a>: `:disabled` only
    // ever matches a form control, so the variant's hover rule reaches this element.)
    await expect(link).toHaveCSS("color", "rgb(46, 230, 110)");
    await expect(link).toHaveCSS("border-top-color", "rgb(46, 230, 110)");
    await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await link.hover();
    await expect(link).toHaveCSS("background-color", "rgba(46, 230, 110, 0.15)");
  });
});
