// Settings narrow-viewport spec (card d2d5ce3f) — /settings must not scroll the PAGE sideways on a phone.
//
// THE DEFECT this locks down: the Settings field groups were fixed track lists (`1fr 1fr 1fr` /
// `1fr 1fr`). Two things combine to overflow the document at phone width:
//   1. A fixed track list never reduces its column count, so three fields stay side by side at 420px.
//   2. Each field is a <label> wrapping an <input>. An <input>'s intrinsic width (its default `size`,
//      ~20ch in the 13px mono field font) is the min-content floor of its grid item, and a grid item's
//      `min-width: auto` refuses to shrink past it — so the track list cannot compress even to the
//      width it has.
// Both are fixed in `.loom-field-grid*` (styles/global.css): the modifiers collapse the column count at
// the breakpoints, and `min-width: 0` on the items releases the intrinsic-width floor.
//
// INSTRUMENT + CONTROL. The assertion here is that something is ABSENT (zero page overflow), and a
// broken query returns zero exactly like a real fix does — so each test first runs a POSITIVE CONTROL at
// the same viewport, on the same page, against a KNOWN-BAD state: a deliberately over-wide element is
// injected, the measurement must report it, then it is removed. Only then does a zero reading mean
// anything. (`/overview` was the cross-page control used when this card was measured by hand; the
// injected control is the version that survives as a test, since it needs no second page to stay honest.)
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const PHONE = { width: 420, height: 900 };
const DESKTOP = { width: 1100, height: 900 };

// Sub-pixel layout rounding can leave a fraction of a pixel of scrollWidth on a page that visually does
// not scroll; 1px is the tolerance for that, not slack for a real overflow (the defect was ~300px).
const TOLERANCE_PX = 1;

type Overflow = { viewport: number; overflow: number; offenderCount: number; offenders: string[] };

// Page-level horizontal overflow plus WHICH elements cross the right edge — the offender list is what
// makes a failure actionable (this card was only actionable because the original finding attributed its
// offending elements to one specific grid rather than reporting a bare pixel count).
async function measureOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (Math.round(r.right) <= viewport + 1) continue;
      const cls = typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join(".")}`
        : "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      offenders.push(`<${el.tagName.toLowerCase()}${cls}> right=${Math.round(r.right)} "${text}"`);
    }
    return {
      viewport,
      overflow: Math.round(doc.scrollWidth - viewport),
      offenderCount: offenders.length,
      offenders: offenders.slice(0, 8),
    };
  });
}

function report(where: string, m: Overflow): string {
  return `${where} @${m.viewport}px: overflow=${m.overflow}px, ${m.offenderCount} element(s) past the right edge\n  ${m.offenders.join("\n  ")}`;
}

// Prove the measurement can return non-zero HERE — same page, same viewport, same query — before any
// zero reading from it is believed.
async function assertInstrumentFires(page: Page): Promise<void> {
  const CONTROL_WIDTH = 3000;
  await page.evaluate((w) => {
    const probe = document.createElement("div");
    probe.id = "loom-overflow-positive-control";
    probe.style.cssText = `width:${w}px;height:2px`;
    document.body.appendChild(probe);
  }, CONTROL_WIDTH);
  const fired = await measureOverflow(page);
  await page.evaluate(() => document.getElementById("loom-overflow-positive-control")?.remove());
  // A working instrument sees the injected element itself, and a document wide enough to hold it.
  expect(fired.offenderCount, `positive control did not register — ${report("control", fired)}`).toBeGreaterThan(0);
  expect(fired.overflow, `positive control did not widen the document — ${report("control", fired)}`)
    .toBeGreaterThan(CONTROL_WIDTH - fired.viewport - 100);
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Both the daemon-global ("Rate Limits") and project-scoped ("Orchestration Caps") field grids must be
// on screen before measuring — the project section renders only once its config query resolves, and
// those grids are exactly what is being measured.
async function openSettings(page: Page, baseURL: string, projectId: string) {
  await pinActiveProject(page, projectId);
  await page.goto(`${baseURL}/settings`);
  await expect(page.getByText("Orchestration Caps", { exact: true })).toBeVisible();
  await expect(page.getByText("Rate Limits", { exact: true })).toBeVisible();
}

test.describe("Settings responsive layout (card d2d5ce3f)", () => {
  test.use({ viewport: PHONE });

  test("does not overflow the page horizontally at 420px", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`settings-narrow-${Date.now()}`);
    await openSettings(page, loomDaemon.baseURL, project.id);

    await assertInstrumentFires(page);

    const measured = await measureOverflow(page);
    expect(measured.viewport).toBe(PHONE.width);
    expect(measured.offenderCount, report("/settings", measured)).toBe(0);
    expect(measured.overflow, report("/settings", measured)).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  // Not overflowing is only half of it: the collapsed single-column field must still be USABLE. A
  // render-only check would pass on a field squeezed to a few pixels, or on one covered by a sibling.
  // Type into it and require an observable state change — the value lands AND the page's dirty
  // indicator flips "saved" → "unsaved changes". Nothing is saved; the daemon is a throwaway anyway.
  test("a collapsed field is still typeable at 420px", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`settings-narrow-type-${Date.now()}`);
    await openSettings(page, loomDaemon.baseURL, project.id);

    // Several panels on this page carry their own "saved"/"unsaved changes" pair, so the witness is the
    // COUNT of dirty indicators moving 0 → 1, not one ambiguous element.
    const dirty = page.getByText("unsaved changes", { exact: true });
    await expect(dirty).toHaveCount(0);

    const maxWorkers = page
      .locator(`label:has(> span:text-is("Max workers / manager"))`)
      .locator("input");
    // A field crushed to a sliver is not usable even if it is technically in the DOM.
    const box = await maxWorkers.boundingBox();
    expect(box, "the Max workers field has no layout box at 420px").not.toBeNull();
    expect(box!.width, `Max workers field is only ${box!.width}px wide at 420px`).toBeGreaterThan(120);

    await maxWorkers.fill("7");
    await expect(maxWorkers).toHaveValue("7");
    await expect(dirty).toHaveCount(1);
  });
});

test.describe("Settings responsive layout — wide viewport is not regressed (card d2d5ce3f)", () => {
  test.use({ viewport: DESKTOP });

  // The narrow fix must not reflow desktop into a single column: at 1100px the three-up field groups
  // still render three-up. Witness: the first three fields of "Orchestration Caps" share one row (equal
  // `top`) and ascend left-to-right — true of a 3-column grid, false of a collapsed 1-column one.
  test("keeps the three-up field groups three-up at 1100px, and still does not overflow", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`settings-wide-${Date.now()}`);
    await openSettings(page, loomDaemon.baseURL, project.id);

    const labels = ["Max workers / manager", "Max managers (no scheduler effect)", "Recycle @ ctx ratio"];
    const boxes = [];
    for (const label of labels) {
      const box = await page.locator(`label:has(> span:text-is(${JSON.stringify(label)}))`).first().boundingBox();
      if (!box) throw new Error(`no Orchestration Caps field matched ${label}`);
      boxes.push(box);
    }
    const rowTops = boxes.map((b) => Math.round(b.y));
    expect(new Set(rowTops).size, `expected one row, got tops ${rowTops.join(", ")}`).toBe(1);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);

    const measured = await measureOverflow(page);
    expect(measured.offenderCount, report("/settings", measured)).toBe(0);
    expect(measured.overflow, report("/settings", measured)).toBeLessThanOrEqual(TOLERANCE_PX);
  });
});
