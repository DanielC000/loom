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
 * Is this element the one a real pointer at its own centre would land on? `true` when `elementFromPoint`
 * returns it or one of its descendants (an icon button's own `<svg>`/glyph counts). This is what makes a
 * `force: true` hover honest — `force` skips the actionability "stable" check, which is what a button
 * positioned over a settling terminal needs, but it would ALSO skip the receives-pointer-events check, so
 * a covered element could otherwise report a false hover result. Assert this first, force second.
 */
function isTopmostAtCentre(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === node || node.contains(top);
  });
}

/**
 * Rest chrome, then chrome during a REAL pointer hover. Deliberately does NOT un-hover afterwards: moving
 * the mouse to a corner expands the collapsed primary-nav rail, which then intercepts pointer events and
 * makes the next `hover()` retry until the test times out. Each button's rest value is read BEFORE its own
 * hover, so a pointer still resting on the PREVIOUS button cannot contaminate it.
 *
 * Pass `{ force: true }` only for a control positioned over a live terminal, whose font settle jitters it
 * a sub-pixel forever so the stability check never resolves — and only after `isTopmostAtCentre`.
 *
 * ⚠️ The returned `hover` is the FIRST reading that differs from rest, which on a class-driven hover is an
 * INTERPOLATED frame of the 80ms `.loom-btn` transition, not the settled end state. Use it for
 * `expect(hover).not.toBe(rest)` only. To name an exact hover value, hover and then assert with
 * `toHaveCSS`, which retries until it settles (card aac0de44 measured `rgb(102, 110, 119)` out of this
 * helper where the settled value was `rgb(138, 146, 155)`).
 */
async function restThenHover(page: Page, el: Locator, opts?: { force?: boolean }): Promise<{ rest: Chrome; hover: Chrome }> {
  const rest = await readChrome(el);
  await el.hover(opts);
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

// ── Card 6cefdf25: the CALL-SITE half of the same defect ──────────────────────────────────────────
// `db040811` fixed the kit component but left the residual it had itself measured: a call site that
// states `color`/`background` in its own inline `style` shadows its hover rule just as completely,
// by correct cascade. Four existed; they now pass a `.loom-btn-muted` / `-accent` / `-on` modifier
// class as `className` instead. Each test below pins the REST computed value first (it must be
// byte-identical to the token the inline style used — this change is not allowed to restyle anything)
// and then asserts a real hover moves it. Reverting a call site to its inline `color` turns the
// rest-vs-hover comparison red; every selector used already existed. See
// docs/decisions/6cefdf25-caller-chrome-in-classes.md.
//
// `--loom-text-muted` #5a636c = rgb(90, 99, 108); `--loom-cyan` #5bc8ff = rgb(91, 200, 255);
// `--loom-phosphor` #2ee66e = rgb(46, 230, 110); `--loom-phosphor-dim` = rgba(46, 230, 110, 0.15).

test("the first-run welcome's muted 'Maybe later' hovers (App.tsx)", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  // FirstRunWelcome renders only while GET /api/projects resolves EMPTY. The `loomDaemon` fixture is
  // worker-scoped and SHARED, so sibling specs leave ordinary projects behind — stub the response
  // instead of depending on daemon state, and undo the fixture's global welcome-dismissal for this
  // page only (fixtures/daemon.ts sets it on the context, so this later init script wins).
  await page.route(
    (url) => url.pathname === "/api/projects",
    (route) => (route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      : route.fallback()),
  );
  await page.addInitScript(() => {
    try { localStorage.removeItem("loom.setupWelcomeDismissed"); } catch { /* storage may be unavailable */ }
  });
  await page.goto(loomDaemon.baseURL + "/settings");

  const dialog = page.getByRole("dialog", { name: "Welcome to Loom" });
  await expect(dialog).toBeVisible();
  const maybeLater = dialog.getByRole("button", { name: "Maybe later" });
  await expect(maybeLater).toBeVisible();
  // Rest is unchanged: the same --loom-text-muted the inline `color` set.
  await expect(maybeLater).toHaveCSS("color", "rgb(90, 99, 108)");
  const ml = await restThenHover(page, maybeLater);
  expect(ml.hover.color).not.toBe(ml.rest.color);
});

test("the column manager's 'key' toggle hovers in BOTH its muted and accented states (ColumnManager.tsx)", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const project = await loomDaemon.createProject(`btn-key-tone-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
  await page.goto(loomDaemon.baseURL + "/settings");

  // One `key` button per column; the default board seeds seven, so there are always at least two. Two
  // DISTINCT rows are what make both states measurable: `restThenHover` deliberately leaves the pointer
  // on whatever it just hovered, so a second reading on the SAME button would read its hover as its rest.
  const keys = page.locator('button[title="Advanced: edit the stable column key"]');
  await expect(keys.first()).toBeVisible();
  expect(await keys.count(), "the default board seeds enough columns for two key toggles").toBeGreaterThan(1);
  const closedKey = keys.first();
  const openKey = keys.nth(1);

  // Open the SECOND row first. This parks the pointer on it, which is exactly why the closed reading
  // below (on the FIRST row) is clean.
  await openKey.click();
  await expect(openKey).toHaveAttribute("aria-expanded", "true");

  // CLOSED → `.loom-btn-muted`: rest is the --loom-text-muted the inline `color` set, and the modifier's
  // own hover rule lifts the label to --loom-text.
  await expect(closedKey).toHaveAttribute("aria-expanded", "false");
  await expect(closedKey).toHaveCSS("color", "rgb(90, 99, 108)");
  const closed = await restThenHover(page, closedKey);
  expect(closed.hover.color).not.toBe(closed.rest.color);

  // OPEN → `.loom-btn-accent`: rest is the same --loom-cyan as before. Its hover tints the background
  // and KEEPS the accent, so hovering an open toggle no longer reads as it switching off — which is what
  // the bare ghost hover rule would have done once the inline `color` stopped shadowing it.
  await expect(openKey).toHaveCSS("color", "rgb(91, 200, 255)");
  const open = await restThenHover(page, openKey);
  expect(open.hover.background).not.toBe(open.rest.background);
  expect(open.hover.color).toBe(open.rest.color);
});

test("the composer's presets trigger and the popover's icon buttons hover (Composer.tsx / PresetPrompts.tsx)", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  // Hermetic seed, same recipe as composer-preset-insert.spec.ts: one global preset (so the popover
  // renders its per-row Edit/Delete icon buttons) plus the reserved Platform operator session as a
  // CANNED pty — no real claude is ever spawned.
  const LABEL = "E2E · hover the icon buttons";
  const PROMPT = "E2E-HOVER-PRESET: nothing is ever sent from this spec.";
  const created = await (await fetch(`${loomDaemon.baseURL}/api/preset-prompts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, prompt: PROMPT }),
  })).json();
  expect(created.id, "the preset should be created").toBeTruthy();

  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();
  await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: "LOOM-BTN-HOVER\r\nhover the presets trigger and its popover icons\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(700); // let the height-budget measure + font scale settle before interacting

  const trigger = page.getByRole("button", { name: "Preset prompts" }).first();
  await expect(trigger).toBeVisible();

  // CLOSED trigger: no modifier, so this is the plain ghost hover. It worked before this card and must
  // keep working — the conditional inline chrome that shadowed it only applied in the OPEN state.
  // Forced past the stability check (it sits over the terminal), but only after proving it is the element
  // a real pointer at that spot would actually hit.
  // The platform tile is taller than the 1280×720 viewport, so the composer's corner cluster starts
  // BELOW the fold — `elementFromPoint` is viewport-relative and answers null out there, which is not the
  // same fact as "something covers it". Scroll it in first so every reachability answer below is real.
  // A plain DOM scroll, NOT `scrollIntoViewIfNeeded()` — that is an action and runs the same stability
  // check the terminal's endless sub-pixel font settle never satisfies.
  await trigger.evaluate((node) => node.scrollIntoView({ block: "center" }));
  expect(await isTopmostAtCentre(trigger), "the closed trigger should be pointer-reachable").toBe(true);
  const closedTrigger = await restThenHover(page, trigger, { force: true });
  expect(closedTrigger.hover.color).not.toBe(closedTrigger.rest.color);

  // Open the popover. `force` bypasses the actionability "stable" check — the corner button sits over the
  // terminal, whose font settle can jitter it a sub-pixel (composer-preset-insert.spec.ts forces for the
  // same reason). This also parks the pointer on the trigger, keeping the first icon reading below clean.
  await trigger.click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Preset prompts" });
  await expect(dialog).toBeVisible();

  // The OPEN trigger now carries `.loom-btn-on` — the same --loom-phosphor label and --loom-phosphor-dim
  // fill its inline style used, so the open appearance is unchanged. Its hover rule is NOT asserted here:
  // the popover is `position:absolute; inset 0/0/0; z-index:30` over the same corner, so it covers the
  // trigger and no real pointer can reach it while open (measured below, so this is a fact about the
  // layout rather than an untested excuse). The class still matters: it is what keeps the open state out
  // of the inline style, where it would shadow the hover rule for every future layout too.
  await expect(trigger).toHaveClass(/\bloom-btn-on\b/);
  await expect(trigger).toHaveCSS("color", "rgb(46, 230, 110)");
  await expect(trigger).toHaveCSS("background-color", "rgba(46, 230, 110, 0.15)");
  expect(await isTopmostAtCentre(trigger), "the open popover is expected to cover its own trigger").toBe(false);

  // ── PresetPrompts' IconButton, both forms. These are RAW `loom-btn loom-btn-<variant>` elements that
  // used to restate the variant's own `color` inline — identical value, total shadowing. Rest must be
  // unchanged (--loom-text-dim / --loom-red, i.e. exactly what the variant class already sets).
  // Park the pointer on inert copy first. The popover rises OVER the corner the pointer was left on by
  // the opening click, so without this the first icon measured is already in its hover state and its
  // "rest" reading is a lie. The dialog's top-left is the "Preset prompts" section label — the "+ Add"
  // button is at the other end of that row.
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox, "the popover should have a layout box").toBeTruthy();
  await page.mouse.move(dialogBox!.x + 4, dialogBox!.y + 4);

  const editIcon = dialog.getByRole("button", { name: `Edit ${LABEL}` });
  await expect(editIcon).toBeVisible();
  await expect(editIcon).toHaveCSS("color", "rgb(138, 146, 155)");
  expect(await isTopmostAtCentre(editIcon), "the edit icon should be pointer-reachable").toBe(true);
  const edit = await restThenHover(page, editIcon, { force: true });
  expect(edit.hover.color).not.toBe(edit.rest.color);

  const deleteIcon = dialog.getByRole("button", { name: `Delete ${LABEL}` });
  await expect(deleteIcon).toBeVisible();
  await expect(deleteIcon).toHaveCSS("color", "rgb(255, 92, 92)");
  expect(await isTopmostAtCentre(deleteIcon), "the delete icon should be pointer-reachable").toBe(true);
  const del = await restThenHover(page, deleteIcon, { force: true });
  expect(del.hover.background).not.toBe(del.rest.background);
  // The danger icon keeps its red label and its own transparent border — the hover rule only tints.
  expect(del.hover.color).toBe(del.rest.color);
  await expect(deleteIcon).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");

  // ── Card aac0de44, site 1: the preset ROW button, the residual `6cefdf25` measured and left open.
  // It is a RAW `loom-btn loom-btn-default` that stated `color: --loom-text` (the variant's own rest
  // token, verbatim) AND `border: 1px solid --loom-border-strong` as a SHORTHAND. The shorthand is the
  // live defect: it expands to `border-color`, so it shadowed `.loom-btn-default:not(:disabled):hover`'s
  // `border-color: --loom-text-dim` and the row was measurably inert — rest and hover both
  // `{ bg rgba(0,0,0,0), bc rgb(42,50,58), color rgb(230,234,237) }`. (A `borderStyle` LONGHAND does
  // NOT shadow it; "+ Add column" above is that control.) Both declarations are gone; the variant class
  // supplies the identical rest chrome, asserted below BEFORE the hover.
  //
  // Its rest reading is clean without re-parking: the pointer is sitting on the DELETE ICON, a flex
  // SIBLING of this button rather than an ancestor or a child of it, so nothing hovers the row itself.
  // (That adjacency is the trap `hover-measurement-needs-pointer-parking` records — check it, don't
  // assume it, and never read two states off the same element back to back.)
  const row = dialog.locator(`button.loom-btn-default[title="${PROMPT}"]`);
  await expect(row).toHaveCount(1);
  // --loom-text #e6eaed and --loom-border-strong #2a323a: byte-identical to the deleted inline values.
  await expect(row).toHaveCSS("color", "rgb(230, 234, 237)");
  await expect(row).toHaveCSS("border-top-color", "rgb(42, 50, 58)");
  await expect(row).toHaveCSS("border-top-width", "1px");
  await expect(row).toHaveCSS("border-top-style", "solid");
  expect(await isTopmostAtCentre(row), "the preset row should be pointer-reachable").toBe(true);

  // Deliberately NOT via `restThenHover`: that helper polls only until the value CHANGES and then reads
  // once, so what it hands back is an INTERPOLATED frame of the 80ms `.loom-btn` transition — fine for
  // the `.not.toBe(rest)` comparisons above, useless for naming an exact end state. Measured here:
  // it returned `rgb(102, 110, 119)`, partway between the rest border and the real hover value.
  // `toHaveCSS` retries, so it settles.
  await row.hover({ force: true });
  // --loom-text-dim #8a929b = rgb(138, 146, 155). The border is the ONLY thing that moves.
  await expect(row).toHaveCSS("border-top-color", "rgb(138, 146, 155)");
  await expect(row).toHaveCSS("color", "rgb(230, 234, 237)");
  await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
