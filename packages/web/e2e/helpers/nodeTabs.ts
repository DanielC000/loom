// The Atlas node tab row has TWO halves since card d4350286: the tabs the row has room for, and the
// ones folded into its trailing "More ⋯" menu. Which tabs land where is WIDTH-DERIVED and therefore
// not knowable from a spec — on a node whose row carries a KPI strip (every tab but Overview, card
// 7874e8c2) the fold starts at 1440 and is deeper at the e2e default 1280 viewport.
//
// 🔴 SO `page.getByTestId("atlas-tab-<key>")` IS NO LONGER A COMPLETE WAY TO REACH A NODE TAB. A tab
// sitting in the menu has no `atlas-tab-` element at all until it is selected, so a spec that clicks
// one directly fails with a timeout that reads like a missing feature rather than a moved affordance.
// Use these two helpers instead of re-deriving the split — they are the one place that knows it.
//
// ⛔ These are for a NODE tab row (`atlas-node-tabs`). A page's own sub-tabs are a different control
// (`Segmented`, role=radiogroup since card 3f28f1c3) and never fold.
//
// Scoping: a page can mount more than one `NodeTabs` (the Companion node renders its modes inside the
// Workspace node's own tab panel), so both helpers take an optional `scope` — pass the owning
// `atlas-node-tabs` locator when more than one row is on the page. Unscoped reads the whole page,
// which is correct and unambiguous on every other node.
import { expect, type Locator, type Page } from "../fixtures/daemon";

const MORE = "atlas-node-tabs-more";
const MENU = "atlas-node-tabs-menu";

function within(page: Page, scope?: Locator) {
  return {
    row: (scope ?? page.locator('[data-testid="atlas-node-tabs"]')),
    more: (scope ?? page).getByTestId(MORE),
    menu: (scope ?? page).getByTestId(MENU),
  };
}

/** The keys of the tabs currently IN the row — i.e. what a reader can see without opening anything. */
export async function nodeTabRowKeys(page: Page, scope?: Locator): Promise<string[]> {
  const { row } = within(page, scope);
  await expect(row.first()).toBeVisible();
  return row.first().locator('[role="tab"]').evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, "")).filter(Boolean));
}

/**
 * Every key the node declares — the row's, then the folded ones in declaration order. Opening the
 * menu to read it is the only way to see the second half, so this leaves the menu CLOSED again
 * (Escape) rather than handing the caller a page in a state it did not ask for.
 */
export async function nodeTabKeys(page: Page, scope?: Locator): Promise<string[]> {
  const row = await nodeTabRowKeys(page, scope);
  const { more, menu } = within(page, scope);
  if (await more.count() === 0) return row;
  await more.first().click();
  await expect(menu.first()).toBeVisible();
  const folded = await menu.first().locator('[role="menuitem"]').evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, "")).filter(Boolean));
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  return [...row, ...folded];
}

/**
 * Select a node tab by key, through whichever half currently holds it, and wait for it to read
 * selected. A tab chosen from the menu is pulled back INTO the row by the active-tab rule (see
 * docs/decisions/d4350286-atlas-node-tab-overflow.md), which is why the post-condition below is the
 * same `atlas-tab-<key>` assertion either way.
 */
export async function openNodeTab(page: Page, key: string, scope?: Locator): Promise<void> {
  const { more, menu } = within(page, scope);
  const inRow = (scope ?? page).getByTestId(`atlas-tab-${key}`);
  if (await inRow.count() > 0) {
    await inRow.first().click();
  } else {
    await expect(more.first(), `tab "${key}" is in neither the row nor a More menu`).toBeVisible();
    await more.first().click();
    await expect(menu.first()).toBeVisible();
    await (scope ?? page).getByTestId(`atlas-more-item-${key}`).first().click();
    await expect(menu).toHaveCount(0);
  }
  await expect((scope ?? page).getByTestId(`atlas-tab-${key}`).first()).toHaveAttribute("aria-selected", "true");
}
