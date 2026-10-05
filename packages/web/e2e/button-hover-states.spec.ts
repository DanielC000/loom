// Kit Button interaction states (card db040811). The Button component used to set its variant chrome
// (`background` / `border` / `color`) as an INLINE style while global.css declared the hover states as
// `.loom-btn-<variant>:not(:disabled):hover` CLASS rules. Inline beats class and none of those rules
// carries `!important`, so every one of the four hover rules — and the 80ms transition on `.loom-btn` —
// was dead: `getComputedStyle` at rest and during a real hover came back byte-identical for the whole
// app. The fix moved the rest chrome into the class rules. See docs/decisions/db040811-*.md.
//
// This spec is the regression guard, and it is deliberately shaped to FAIL on the pre-fix bundle rather
// than on a missing selector: every button it touches existed before the change, and the assertions are
// rest-vs-hover COMPARISONS on computed style, not the presence of any new markup or testid. Reverting
// `Button`'s inline chrome turns each `expect(hover).not.toBe(rest)` red on the property that variant's
// own rule targets, which is the mechanism — not a shape failure.
//
// Why /settings: it is a LIGHT page (no live-terminal mount — see CLAUDE.md on the cockpit renderer) that
// renders all four variants enabled at once, plus a disabled kit Button and a Button carrying a CALLER's
// own inline style. Every selector below is an existing role/title/testid, not one this card added.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";

/** The four properties the `.loom-btn*` rules in global.css actually target. */
interface Chrome {
  background: string;
  borderColor: string;
  color: string;
  cursor: string;
}

function readChrome(el: Locator): Promise<Chrome> {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return { background: s.backgroundColor, borderColor: s.borderTopColor, color: s.color, cursor: s.cursor };
  });
}

/**
 * Rest chrome, then chrome during a REAL pointer hover. Deliberately does NOT un-hover afterwards: moving
 * the mouse to a corner expands the collapsed primary-nav rail, which then intercepts pointer events and
 * makes the next `hover()` retry until the test times out. Each button's rest value is read BEFORE its own
 * hover, so a pointer still resting on the PREVIOUS button cannot contaminate it.
 */
async function restThenHover(page: Page, el: Locator): Promise<{ rest: Chrome; hover: Chrome }> {
  const rest = await readChrome(el);
  await el.hover();
  // Past the 80ms `background`/`border-color`/`color` transition declared on `.loom-btn`, so the reading
  // is the settled end state and not an intermediate frame.
  await expect
    .poll(async () => JSON.stringify(await readChrome(el)), { timeout: 4_000, intervals: [60] })
    .not.toBe(JSON.stringify(rest));
  return { rest, hover: await readChrome(el) };
}

test("every kit Button variant visibly changes on hover", async ({ page, loomDaemon }) => {
  // Four hover round trips plus a settings page that fetches a lot; comfortably above the 30s default.
  test.setTimeout(120_000);
  const project = await loomDaemon.createProject(`btn-hover-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
  await page.goto(loomDaemon.baseURL + "/settings");

  // ── default: the session-env "Add variable" button (no caller chrome of its own).
  // `.loom-btn-default:not(:disabled):hover` brightens the border to --loom-text-dim.
  const addVar = page.getByTestId("senv-add");
  await expect(addVar).toBeVisible();
  const def = await restThenHover(page, addVar);
  expect(def.hover.borderColor).not.toBe(def.rest.borderColor);
  expect(def.rest.cursor).toBe("pointer");

  // ── ghost: the remove button on a session-env row (only rendered once a row exists).
  // `.loom-btn-ghost:not(:disabled):hover` lifts the label to --loom-text.
  await addVar.click();
  const ghost = page.locator('[data-testid^="senv-remove-"]').first();
  await expect(ghost).toBeVisible();
  const gh = await restThenHover(page, ghost);
  expect(gh.hover.color).not.toBe(gh.rest.color);

  // ── primary: the connections "New connection" button.
  // `.loom-btn-primary:not(:disabled):hover` fills with --loom-phosphor-dim.
  const primary = page.getByRole("button", { name: "New connection" });
  await expect(primary).toBeVisible();
  const pri = await restThenHover(page, primary);
  expect(pri.rest.background).toBe("rgba(0, 0, 0, 0)");
  expect(pri.hover.background).not.toBe(pri.rest.background);

  // ── danger: the board ColumnManager's per-column delete.
  // `.loom-btn-danger:not(:disabled):hover` tints the background red.
  const danger = page.locator('button[title="Delete this column"]').first();
  await expect(danger).toBeVisible();
  const dan = await restThenHover(page, danger);
  expect(dan.rest.background).toBe("rgba(0, 0, 0, 0)");
  expect(dan.hover.background).not.toBe(dan.rest.background);
});

test("a kit Button hovers correctly through a caller's own inline style, and a disabled one does not", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  const project = await loomDaemon.createProject(`btn-hover-inline-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
  await page.goto(loomDaemon.baseURL + "/settings");

  // ColumnManager's "+ Add column" passes `style={{ borderStyle: "dashed" }}`. That inline longhand must
  // keep winning (the border stays dashed) while the variant's own `border-color` hover rule still
  // applies — the precise case the old all-inline chrome made impossible.
  const addColumn = page.getByRole("button", { name: "+ Add column" });
  await expect(addColumn).toBeVisible();
  await expect(addColumn).toHaveCSS("border-top-style", "dashed");
  const styled = await restThenHover(page, addColumn);
  expect(styled.hover.borderColor).not.toBe(styled.rest.borderColor);
  await expect(addColumn).toHaveCSS("border-top-style", "dashed");

  // A DISABLED kit Button must reach `.loom-btn:disabled { cursor: not-allowed; opacity: 0.45 }`. The
  // component used to set a flat inline `cursor: "pointer"`, which shadowed the cursor half of that rule;
  // it is now `disabled`-aware. "Rebind" is disabled until the repo-path field is edited.
  const rebind = page.getByRole("button", { name: "Rebind" }).first();
  await expect(rebind).toBeVisible();
  await expect(rebind).toBeDisabled();
  await expect(rebind).toHaveCSS("cursor", "not-allowed");
  await expect(rebind).toHaveCSS("opacity", "0.45");
});
