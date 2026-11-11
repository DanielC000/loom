// A dropped FILE must not navigate the Loom tab away (card 2170efab). Neither xterm nor the Composer
// handled dragover/drop, so Chrome's default applied: open the dropped file in the tab. Terminal.tsx and
// Composer.tsx now cancel dragover + drop for FILE drags only (DataTransfer.types contains "Files").
//
// The drop is SYNTHETIC: a DataTransfer built in the page and dispatched as dragover/drop events. A real
// OS drag cannot be driven by Playwright, and a synthetic event cannot itself trigger Chrome's
// open-the-file default, so the observable here is `event.defaultPrevented` (the thing the browser
// consults before applying that default) plus an unchanged URL and a surviving document sentinel.
// Not covered: a real OS-level file drag.
//
// Seeding (no-real-claude invariant): a `processState:"live"` DB row via loomDaemon.seedLiveSession.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";

const SENTINEL = "__loomFileDropSpec";

type DropResult = { dragover: boolean; drop: boolean };

/** Dispatch dragover then drop on `target` carrying either a file or plain text; report whether each
 *  event was cancelled. */
async function dropOn(target: Locator, kind: "file" | "text"): Promise<DropResult> {
  return target.evaluate((el, k) => {
    const dt = new DataTransfer();
    if (k === "file") dt.items.add(new File(["not really a png"], "pic.png", { type: "image/png" }));
    else dt.setData("text/plain", "just some dragged text");
    const fire = (type: string) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return { dragover: fire("dragover"), drop: fire("drop") };
  }, kind);
}

async function stillSameDocument(page: Page, url: string) {
  expect(page.url()).toBe(url);
  expect(await page.evaluate((s) => (window as unknown as Record<string, unknown>)[s], SENTINEL)).toBe(true);
}

test("a dropped file is cancelled on the terminal tile and on the Composer; text drops are untouched", async ({ page, loomDaemon }) => {
  const seeded = await loomDaemon.seedLiveSession({ role: "plain", ptyGeometry: { cols: 60, rows: 16 }, ptyBytes: "ready\r\n" });
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);
  await page.evaluate((s) => { (window as unknown as Record<string, unknown>)[s] = true; }, SENTINEL);
  const url = page.url();

  const xterm = page.locator(".xterm").first();
  const composer = page.getByTestId("composer");
  await expect(xterm).toBeVisible();
  await expect(composer).toBeVisible();

  for (const [name, target] of [["terminal", xterm], ["composer", composer.locator("textarea").first()]] as const) {
    const file = await dropOn(target, "file");
    expect(file, `${name}: file dragover cancelled`).toEqual({ dragover: true, drop: true });
    await stillSameDocument(page, url);

    // CONTROL: a text drag is left alone, so existing text drag/drop behaviour is unchanged.
    const text = await dropOn(target, "text");
    expect(text, `${name}: text drag not cancelled by the guard`).toEqual({ dragover: false, drop: false });
    await stillSameDocument(page, url);
  }
});
