// The Atlas UI switch + empty shell (card 757c80dd, Atlas build plan P1-0 —
// docs/plans/atlas-ui/03-decomposition.md row P1-0).
//
// Three properties, in the order the card's DoD states them:
//   1. SWITCH OFF -> the classic shell is structurally IDENTICAL to what it was before this card.
//      Asserted against BASELINE_SHELL below: a fingerprint captured from a real build of the
//      PRE-change tree (the procedure is in the comment on that constant), not from this branch.
//   2. SWITCH ON  -> the empty Atlas frame renders, with zero console errors.
//   3. The Settings toggle actually SWITCHES the UI (an observable before/after, not just a rendered
//      control) and PERSISTS across a reload — in both directions, including back off again via the
//      shell's own escape hatch.
//
// Every assertion that something is ABSENT or UNCHANGED carries a POSITIVE CONTROL first: a
// fingerprint comparison and a zero-console-error count both read exactly the same whether the
// instrument works or is silently broken, so each is first shown firing against a known-bad state on
// the same page, at the same moment.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded here rather than imported: the
// e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec cannot pull a `src/` module in — the
// same reason fixtures/daemon.ts hardcodes `loom.setupWelcomeDismissed`.
const ATLAS_KEY = "loom.atlasUi";

// Pre-seed the switch ON for the page's FIRST paint, so a test never observes the classic shell
// flashing before Atlas takes over (the switch is read synchronously at module load, but the init
// script has to land before that).
//
// There is deliberately no "seed OFF" counterpart. Off IS the default — a context starts with empty
// storage, which is the state every real first-time visitor is in — and an init script is the wrong
// tool for it anyway: addInitScript re-runs on EVERY navigation, so a "seed off" script silently
// re-clears the key across a `reload()` and would make the persistence test below pass or fail for a
// reason that has nothing to do with the app (it failed exactly this way while being written).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, "1");
    } catch { /* storage unavailable — the spec's own assertions will say so */ }
  }, ATLAS_KEY);
}

// ── The shell fingerprint ──────────────────────────────────────────────────────────────────────
// Serializes the SHELL skeleton: every element under #root, EXCLUDING the descendants of <main>.
// Tag + class list (source order) + role + aria-label — no text, no ids, no inline styles — so it is
// a structural fingerprint, stable against live data while still failing on a changed element tree.
//
// SCOPE — what a green here does and does NOT prove. It covers the element tree from the app root down
// to and including <main>: an added or removed wrapper, a renamed class, a moved Sidebar, a changed
// layout chain, and any Atlas class leaking into the classic shell.
//
// It does NOT cover most of the cross-cutting chrome. Five of the six chrome components render null on
// a healthy daemon, so they contribute no node and dropping or reordering one would not move this
// fingerprint. `fakeUpdateAvailable` below forces the sixth (`UpdateBanner`) to render, which pins the
// BANNER SLOT — that a banner lands inside the page column, above <main>, in that chain — but not the
// relative order of the three banners, and not the overlays at all. Proving the chrome itself still
// works under both switch states is card P1-5's job, not this fingerprint's.
//
// <main>'s CONTENTS are also deliberately out of frame: they are the page body (live sessions, counts,
// timestamps), and this card changes the shell around the pages, not the pages.
async function shellSkeleton(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const describe = (el: Element) => {
      const raw = typeof el.className === "string" ? el.className.trim() : "";
      const cls = raw ? "." + raw.split(/\s+/).join(".") : "";
      const role = el.getAttribute("role");
      const label = el.getAttribute("aria-label");
      return el.tagName.toLowerCase() + cls
        + (role ? "[role=" + role + "]" : "")
        + (label ? "[aria-label=" + label + "]" : "");
    };
    const walk = (el: Element, depth: number) => {
      out.push("  ".repeat(depth) + describe(el));
      const tag = el.tagName.toLowerCase();
      // Two deliberate stops. <main> itself is shell, its children are the route's own content (see
      // SCOPE above). An <svg> is a decorative vector whose interior says nothing about shell
      // structure — descending into it would redden this spec for an unrelated nav-icon tweak, which
      // is the opposite of what it exists to catch. The svg ELEMENT is still recorded, so an icon
      // appearing or disappearing from the shell is caught.
      if (tag === "main" || tag === "svg") return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    const root = document.getElementById("root");
    if (root) for (const child of Array.from(root.children)) walk(child, 0);
    return out.join("\n");
  });
}

// The shell has async pieces: the Instrument Rail's footer only renders its running/paused pill and
// its version row once those two queries resolve (components/Sidebar.tsx), so a fingerprint taken
// straight after `goto` is a COIN FLIP on whether they are in it — measured, not theorised: two
// otherwise-identical capture runs disagreed on exactly those two rows. Sample until two consecutive
// reads agree, so the comparison is always against a settled shell rather than whichever paint the
// test happened to catch.
const SETTLE_INTERVAL_MS = 250;
const SETTLE_MAX_SAMPLES = 20;

async function settledShellSkeleton(page: Page): Promise<string> {
  let last = await shellSkeleton(page);
  for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const next = await shellSkeleton(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error(
    "the shell skeleton never settled over " +
      (SETTLE_INTERVAL_MS * SETTLE_MAX_SAMPLES) / 1000 +
      "s of sampling. Last read:\n" + last,
  );
}

// The classic shell's skeleton, CAPTURED FROM THE PRE-CHANGE TREE. Procedure, for whoever has to
// regenerate it: check this card's two source changes out of the way (`git checkout <base> --
// packages/web/src/App.tsx packages/web/src/styles/global.css`), `pnpm build`, run this file's
// switch-off test, and paste the "actual" it prints. It is NOT re-derived from this branch, because a
// baseline taken after the change cannot detect the change.
//
// A RED here means the classic shell moved. Through phases 1 and 2 of the Atlas plan that is a
// regression by definition (the plan's one hard rule: the old UI is not touched until phase 3), so
// treat it as a real failure, not a snapshot to bless. It is phase 3's switch-over/retirement cards
// that legitimately retire this constant.
const BASELINE_SHELL = [
  "div",
  "  aside.loom-rail[aria-label=Primary navigation]",
  "    button.loom-rail-brand",
  "      span.loom-rail-mark",
  "        svg",
  "      span.loom-rail-lbl.loom-rail-wordmark",
  "      span.loom-rail-pinbtn.loom-rail-revealonly",
  "        svg",
  "    div",
  "      button.loom-rail-proj",
  "        span.loom-rail-sig",
  "        span.loom-rail-lbl.loom-rail-proj-meta",
  "          span.loom-rail-eyebrow",
  "          span.loom-rail-proj-name",
  "        span.loom-rail-lbl.loom-rail-caret",
  "    nav.loom-rail-nav",
  "      div",
  "        div.loom-rail-grp.is-first",
  "        a.loom-rail-item.is-active",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "      div",
  "        div.loom-rail-sep",
  "        div.loom-rail-grp",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "          span.loom-rail-scopedot",
  "      div",
  "        div.loom-rail-sep",
  "        div.loom-rail-grp",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "      div",
  "        div.loom-rail-sep",
  "        div.loom-rail-grp",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "        a.loom-rail-item",
  "          span.loom-rail-ico",
  "            svg",
  "          span.loom-rail-lbl",
  "    div.loom-rail-foot",
  "      button.loom-rail-statrow",
  "        span.loom-rail-ico",
  "          svg",
  "        span.loom-rail-lbl",
  "      a.loom-rail-statrow",
  "        span.loom-rail-ico",
  "          svg",
  "        span.loom-rail-lbl",
  "        span.loom-rail-scopedot",
  "        span.loom-rail-lbl.loom-rail-runpill",
  "      div.loom-rail-ver",
  "  div.loom-railgutter",
  "  div",
  "    div[role=status]",
  "      span",
  "      span",
  "        span",
  "        span",
  "        span",
  "        span",
  "      span",
  "      button.loom-btn.loom-btn-primary",
  "      button",
  "    main",
].join("\n");

// Prove shellSkeleton can report a DIFFERENCE, here, now, on this page: wrap the shell root's first
// child in an extra div (the exact shape of the accident this comparison exists to catch) and require
// the fingerprint to move. Without this, an evaluate() that silently returned "" would "pass".
async function assertSkeletonInstrumentFires(page: Page): Promise<void> {
  const before = await shellSkeleton(page);
  await page.evaluate(() => {
    const root = document.getElementById("root");
    const first = root?.firstElementChild;
    if (!root || !first) throw new Error("positive control: #root has no element child to wrap");
    const probe = document.createElement("div");
    probe.id = "loom-skeleton-positive-control";
    root.insertBefore(probe, first);
    probe.appendChild(first);
  });
  const during = await shellSkeleton(page);
  await page.evaluate(() => {
    const probe = document.getElementById("loom-skeleton-positive-control");
    const root = document.getElementById("root");
    const inner = probe?.firstElementChild;
    if (probe && root && inner) { root.insertBefore(inner, probe); probe.remove(); }
  });
  expect(during, "positive control: an injected wrapper did not move the fingerprint").not.toBe(before);
  expect(await shellSkeleton(page), "positive control: removing the wrapper did not restore the fingerprint").toBe(before);
}

// Console + page errors, collected from before the first navigation. Returns the collected list plus
// its own positive control, so a zero reading is only ever believed from a collector shown to fire.
function collectConsoleErrors(page: Page): { errors: string[]; assertFires: () => Promise<void> } {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });
  page.on("pageerror", (err) => { errors.push("pageerror: " + err.message); });
  return {
    errors,
    assertFires: async () => {
      const probe = "loom-console-positive-control-" + Date.now();
      await page.evaluate((text) => { console.error(text); }, probe);
      await expect
        .poll(() => errors.some((e) => e.includes(probe)), {
          message: "positive control: the console collector never saw a deliberate console.error",
        })
        .toBe(true);
      // Drop the control's own entry so it doesn't pollute the real count.
      const at = errors.findIndex((e) => e.includes(probe));
      if (at >= 0) errors.splice(at, 1);
    },
  };
}

// Force ONE real piece of cross-cutting chrome to render. Without this every one of the six chrome
// components is null on a healthy throwaway daemon (no credential fault, no gateway lock, a
// from-source daemon reports packaged:false), so the fingerprint below would contain NO chrome node at
// all and could not notice one being dropped or reordered — it would only be proving that six nulls
// render as six nulls. `UpdateBanner` is the one that can be forced purely client-side, by answering
// its own status read; the response is fiction, and nothing in these tests clicks its action (that
// would POST /internal/update at the daemon).
async function fakeUpdateAvailable(page: Page) {
  await page.route("**/api/update-status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packaged: true,
        channel: "stable",
        installed: "0.0.1",
        latest: "0.0.2",
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }),
    }),
  );
}

const rail = (page: Page) => page.locator(".loom-rail");
const atlas = (page: Page) => page.getByTestId("atlas-shell");

test.describe("Atlas UI switch (card 757c80dd)", () => {
  test("switch OFF renders the classic shell, structurally unchanged from before this card", async ({ page, loomDaemon }) => {
    // No seeding: an untouched browser is the default state, and the card's own requirement is that
    // the default is OFF. Asserting the empty key first makes that an explicit claim rather than an
    // assumption riding underneath the fingerprint comparison.
    await fakeUpdateAvailable(page);
    await page.goto(loomDaemon.baseURL + "/");
    expect(await page.evaluate((k) => localStorage.getItem(k), ATLAS_KEY),
      "a fresh browser already had the Atlas switch set").toBeNull();
    await expect(rail(page)).toBeVisible();

    // The Atlas shell must be absent in every way it could be detected — the component, and the
    // stylesheet classes it is the only consumer of.
    await expect(atlas(page)).toHaveCount(0);
    expect(
      await page.locator('[class*="loom-atlas"]').count(),
      "switch off still rendered an element carrying an Atlas shell class",
    ).toBe(0);

    // The forced chrome node, asserted before the comparison: if the fixture ever stops producing it,
    // this fails here with a clear reason instead of quietly reducing the baseline to chrome-free.
    await expect(page.locator('[role="status"]').filter({ hasText: "A new Loom release is available" }))
      .toBeVisible();

    // The two last-to-arrive footer rows, waited for explicitly as well as by the settle loop below:
    // naming them makes a genuine disappearance fail HERE, with a clear message, instead of surfacing
    // as an opaque fingerprint diff.
    await expect(page.locator(".loom-rail-runpill")).toBeVisible();
    await expect(page.locator(".loom-rail-ver")).toBeVisible();

    await assertSkeletonInstrumentFires(page);

    const actual = await settledShellSkeleton(page);
    expect(actual, "the classic shell's structure changed. Actual fingerprint:\n" + actual + "\n").toBe(BASELINE_SHELL);
  });

  test("switch ON renders the empty Atlas frame with zero console errors", async ({ page, loomDaemon }) => {
    const consoleErrors = collectConsoleErrors(page);
    await seedAtlasOn(page);
    await fakeUpdateAvailable(page);
    await page.goto(loomDaemon.baseURL + "/");

    await expect(atlas(page)).toBeVisible();
    // The classic rail is replaced, not merely hidden: exactly one shell is ever mounted.
    await expect(rail(page)).toHaveCount(0);

    // The frame the card promises: an entity tree, a breadcrumb trail, a node header, and an empty
    // node body. No nodes yet, by design — the tree says so rather than rendering nothing at all.
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    await expect(page.getByTestId("atlas-tree")).toContainText("No nodes yet");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();
    await expect(page.getByTestId("atlas-empty")).toBeVisible();

    // The `banners` slot is really wired, not just declared: the same forced banner the switch-off
    // baseline pins renders INSIDE the Atlas frame too. Nothing else in this spec would notice if
    // AtlasShell silently dropped the prop.
    await expect(atlas(page).locator('[role="status"]').filter({ hasText: "A new Loom release is available" }))
      .toBeVisible();

    // Any URL lands on the frame (the shell's catch-all route), never a blank column.
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByTestId("atlas-empty")).toBeVisible();

    // Settle first: a zero read taken the instant the frame appears can simply predate an error that
    // a still-in-flight request was about to log.
    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();
    expect(
      consoleErrors.errors,
      "Atlas frame logged " + consoleErrors.errors.length + " console error(s)",
    ).toEqual([]);
  });

  test("the Settings toggle switches the UI and persists across a reload, both ways", async ({ page, loomDaemon }) => {
    await page.goto(loomDaemon.baseURL + "/settings");

    // BEFORE: the classic shell, and the toggle reporting the classic UI as the live one.
    await expect(rail(page)).toBeVisible();
    await expect(atlas(page)).toHaveCount(0);
    // Located through the switch's own testid + case-insensitive names: the Segmented kit uppercases
    // its labels in CSS, and Chromium folds text-transform into the computed accessible name, so an
    // exact-case name match here would be matching a presentation detail.
    const uiSwitch = page.getByTestId("atlas-ui-switch");
    const classicTab = uiSwitch.getByRole("tab", { name: /^classic$/i });
    const atlasTab = uiSwitch.getByRole("tab", { name: /^atlas preview$/i });
    await expect(classicTab).toHaveAttribute("aria-selected", "true");
    await expect(atlasTab).toHaveAttribute("aria-selected", "false");

    // EXERCISE it. AFTER: the shell has actually swapped, not just the control's own appearance.
    await atlasTab.click();
    await expect(atlas(page)).toBeVisible();
    await expect(rail(page)).toHaveCount(0);

    // PERSISTS: a full reload comes back on Atlas, from storage alone.
    await page.reload();
    await expect(atlas(page)).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), ATLAS_KEY)).toBe("1");

    // And back: the frame's own escape hatch is the only way out while the tree has no Settings node,
    // so it has to work — otherwise the switch is a one-way door.
    await page.getByTestId("atlas-leave").click();
    await expect(rail(page)).toBeVisible();
    await expect(atlas(page)).toHaveCount(0);

    // OFF persists too (the key is removed, not left at some other value).
    await page.reload();
    await expect(rail(page)).toBeVisible();
    await expect(atlas(page)).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), ATLAS_KEY)).toBeNull();
  });

  // The owner's standing rule: unfinished input is never destroyed. Swapping the shell unmounts every
  // page in the tab, so a switch flipped in ANOTHER tab must not take this one's half-typed agent
  // prompt or unsaved Settings form down with it. The other tab's choice is offered, not applied.
  test("a switch flipped in another tab does not swap this tab's shell", async ({ page, context, loomDaemon }) => {
    await page.goto(loomDaemon.baseURL + "/");
    await expect(rail(page)).toBeVisible();
    await expect(page.getByTestId("atlas-switch-notice")).toHaveCount(0);

    // A second page in the SAME context: same origin, same storage, so its write fires a real
    // `storage` event in the first page — exactly the production cross-tab path.
    const other = await context.newPage();
    try {
      await other.goto(loomDaemon.baseURL + "/settings");
      await other.getByTestId("atlas-ui-switch").getByRole("tab", { name: /^atlas preview$/i }).click();
      // The writing tab DOES swap: that one is its own deliberate action.
      await expect(other.getByTestId("atlas-shell")).toBeVisible();

      // This tab is offered the change and keeps its shell. The notice is the positive half of the
      // assertion: without it, "shell unchanged" would also pass if the event never arrived at all,
      // which would make the no-swap claim vacuous.
      await expect(page.getByTestId("atlas-switch-notice")).toBeVisible();
      await expect(rail(page)).toBeVisible();
      await expect(atlas(page)).toHaveCount(0);

      // And it is genuinely a deferral, not a drop: a reload applies what the other tab chose.
      await page.reload();
      await expect(atlas(page)).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});
