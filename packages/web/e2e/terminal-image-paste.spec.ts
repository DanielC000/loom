// Card 3da47390 — an image-only paste in a terminal tile must send the CLI's image-paste key instead of an
// empty bracketed paste; text and mixed pastes must stay byte-identical to xterm's own paste.
//
// The assertions are on the WIRE: every `{type:"stdin"}` frame the page sends is recorded by wrapping
// `WebSocket.prototype.send` (observe-only, the recipe from terminal-reattach.spec.ts). The paste itself is a
// synthetic `ClipboardEvent` carrying a real `DataTransfer` (headless Chromium cannot hold a real image
// clipboard), dispatched on xterm's textarea — the element a real Ctrl+V paste targets. The browser's platform
// is pinned per test via an init script, because the key is chosen from it.
// The canned bytes turn bracketed-paste mode ON (`ESC[?2004h`), as claude's TUI does, so the text case
// proves xterm's own wrapping is what reaches the wire.
import { expect, test, type Page } from "./fixtures/daemon";

declare global {
  interface Window { __loomStdin?: string[] }
}

async function pinPlatformAndRecord(page: Page, platform: string) {
  await page.addInitScript((p) => {
    window.__loomStdin = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      if (typeof data === "string" && data.includes('"stdin"')) window.__loomStdin!.push(data);
      return send.call(this, data);
    };
    Object.defineProperty(navigator, "userAgentData", { value: { platform: p }, configurable: true });
  }, platform);
}

/** The data of every stdin frame sent so far, decoded. */
const sentBytes = (page: Page) =>
  page.evaluate(() => (window.__loomStdin ?? []).map((f) => (JSON.parse(f) as { data: string }).data));

async function openTerminal(page: Page, loomDaemon: Parameters<Parameters<typeof test>[2]>[0]["loomDaemon"]) {
  const seeded = await loomDaemon.seedLiveSession({
    role: "plain",
    ptyGeometry: { cols: 60, rows: 16 },
    ptyBytes: "\x1b[?2004hready-3da47390\r\n",
  });
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "ready-3da47390" })).toBeVisible();
  // POSITIVE CONTROL for every "what reached the wire" assertion below: a typed key must be recorded, or an
  // empty recording would look identical to a correct suppression.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("k");
  await expect.poll(() => sentBytes(page)).toContain("k");
}

/** Dispatches a paste whose clipboard holds the given parts on xterm's textarea. */
async function paste(page: Page, parts: { image?: boolean; text?: string; html?: string }) {
  await page.evaluate((p) => {
    const dt = new DataTransfer();
    if (p.text !== undefined) dt.setData("text/plain", p.text);
    if (p.html !== undefined) dt.setData("text/html", p.html);
    if (p.image) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".xterm-helper-textarea")!.dispatchEvent(ev);
  }, parts);
}

test("an image-only paste on a Windows browser sends ESC v, not an empty bracketed paste", async ({ page, loomDaemon }) => {
  await pinPlatformAndRecord(page, "Windows");
  await openTerminal(page, loomDaemon);
  const before = (await sentBytes(page)).length;
  await paste(page, { image: true });
  await expect.poll(async () => (await sentBytes(page)).slice(before)).toEqual(["\x1bv"]);
  // The one-time hint names where the image is read from.
  await expect(page.locator('[data-terminal-hint="image-paste"]')).toContainText("this computer's clipboard");
});

test("an image-only paste on a non-Windows browser sends 0x16", async ({ page, loomDaemon }) => {
  await pinPlatformAndRecord(page, "Linux");
  await openTerminal(page, loomDaemon);
  const before = (await sentBytes(page)).length;
  await paste(page, { image: true });
  await expect.poll(async () => (await sentBytes(page)).slice(before)).toEqual(["\x16"]);
});

test("a text paste is xterm's own bracketed paste, byte-identical, with no image key and no hint", async ({ page, loomDaemon }) => {
  await pinPlatformAndRecord(page, "Windows");
  await openTerminal(page, loomDaemon);
  const before = (await sentBytes(page)).length;
  await paste(page, { text: "C:\\x\\shot.png" });
  await expect.poll(async () => (await sentBytes(page)).slice(before)).toEqual(["\x1b[200~C:\\x\\shot.png\x1b[201~"]);
  await expect(page.locator('[data-terminal-hint="image-paste"]')).toHaveCount(0);
});

test("a mixed text+image clipboard behaves as text", async ({ page, loomDaemon }) => {
  await pinPlatformAndRecord(page, "Windows");
  await openTerminal(page, loomDaemon);
  const before = (await sentBytes(page)).length;
  await paste(page, { image: true, text: "caption", html: "<b>caption</b>" });
  await expect.poll(async () => (await sentBytes(page)).slice(before)).toEqual(["\x1b[200~caption\x1b[201~"]);
});
