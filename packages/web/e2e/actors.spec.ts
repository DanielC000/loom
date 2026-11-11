// Actors spec (card 9d7af2f2) — proves the IA consolidation that merges the old /profiles and /skills pages
// into ONE "Actors" destination with a Profiles | Skills segmented switch. Coverage:
//   1. /actors renders the Segmented tabs and defaults to the Profiles body.
//   2. Switching to the Skills tab is an OBSERVABLE state change — the profiles body unmounts, the skills
//      body mounts (each keyed on distinctive body copy, so this proves the RIGHT body swapped, not just
//      that a tab highlighted).
//   3. The old routes redirect: /profiles and /skills land on the Workspace node's Actors tab
//      (/home?tab=actors, and &sub=skills for the Skills sub-tab).
//   4. PRESERVED gating: Skills' dev-only "Publish to repo" affordance stays gated. This fixture boots
//      LOOM_DEV=0 (see fixtures/daemon.ts), so /api/platform/home returns `project: null` (card 8d82be67 —
//      the route is always 200) → isDev=false → the Publish button is
//      HIDDEN on the Skills tab, while the always-present "Reset to shipped" bundled control DOES render —
//      proving the consolidation didn't drop the dev gate (not merely that nothing rendered).
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); skills.spec.ts / profiles-agents.spec.ts are the
// templates. Both stores are daemon-global (not project-scoped), so no active-project pin is needed. This spec
// never mutates a bundled profile/skill, so the shared worker-scoped daemon stays clean (no reset step).
import { expect, test } from "./fixtures/daemon";

// Distinctive body copy unique to each tab's editor shell — the Profiles list blurb vs the Skills list blurb.
// Keying on these (not the tab labels, which read "Profiles"/"Skills" in BOTH the Segmented and the panel)
// proves which BODY is mounted.
const PROFILES_BODY = /Reusable, cross-project rig/;
const SKILLS_BODY = /injected into every session as project-local/;

test.describe("actors (Profiles + Skills consolidation)", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts).

  test("/actors renders the Segmented radiogroup and defaults to the Profiles body", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);

    // Both segments render as an accessible radiogroup (the shared Segmented primitive, card 3f28f1c3).
    await expect(page.getByRole("radio", { name: "Profiles" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Skills" })).toBeVisible();

    // Default tab = Profiles: the Profiles body is mounted, the Skills body is not.
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page.getByText(SKILLS_BODY)).toHaveCount(0);
    // The Profiles segment reads checked; Skills does not.
    await expect(page.getByRole("radio", { name: "Profiles" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Skills" })).toHaveAttribute("aria-checked", "false");
  });

  test("switching to the Skills tab swaps the mounted body (observable before/after)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);

    // BEFORE: the Profiles body is mounted, the Skills body is absent.
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page.getByText(SKILLS_BODY)).toHaveCount(0);

    // ACT: click the Skills segment.
    await page.getByRole("radio", { name: "Skills" }).click();

    // AFTER (observable #1 — DOM swap): the Skills body is now mounted and the Profiles body is gone.
    await expect(page.getByText(SKILLS_BODY)).toBeVisible();
    await expect(page.getByText(PROFILES_BODY)).toHaveCount(0);
    // AFTER (observable #2 — selection + URL): the Skills segment reads checked and the tab is pinned in the URL.
    await expect(page.getByRole("radio", { name: "Skills" })).toHaveAttribute("aria-checked", "true");
    // The Actors page is the Workspace node's Actors tab; its own Profiles|Skills sub-tab rides `sub=`.
    await expect(page).toHaveURL(/\/home\?tab=actors&sub=skills/);
  });

  test("the Profiles|Skills switch is one Tab stop, and arrow keys move AND select (card 3f28f1c3)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);

    const group = page.getByRole("radiogroup", { name: "Actors — Profiles or Skills" });
    await expect(group).toBeVisible();
    const profiles = group.getByRole("radio", { name: "Profiles" });
    const skills = group.getByRole("radio", { name: "Skills" });

    // ONE tab stop: only the checked segment is in the tab order (roving tabindex) — the attribute
    // contract, plus the behavior it buys: focusing the active segment and pressing Tab moves OUT of
    // the group entirely (there is no second stop to land on), rather than onto "Skills".
    await expect(profiles).toHaveAttribute("tabindex", "0");
    await expect(skills).toHaveAttribute("tabindex", "-1");

    await profiles.evaluate((n: HTMLElement) => n.focus());
    await expect(profiles).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(skills).not.toBeFocused();
    await expect(profiles).not.toBeFocused();

    // Land back on the group the same way a real Tab walk would, to continue the arrow-key assertions.
    await profiles.evaluate((n: HTMLElement) => n.focus());
    await expect(profiles).toBeFocused();

    // BEFORE: Profiles is checked and mounted, Skills is not.
    await expect(skills).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();

    // ArrowRight moves AND selects — the same onChange a click would fire, with an observable DOM
    // change (not just a highlight): the mounted body swaps, aria-checked flips on BOTH segments, and
    // the roving tabindex moves with it.
    await page.keyboard.press("ArrowRight");
    await expect(skills).toBeFocused();
    await expect(skills).toHaveAttribute("aria-checked", "true");
    await expect(profiles).toHaveAttribute("aria-checked", "false");
    await expect(skills).toHaveAttribute("tabindex", "0");
    await expect(profiles).toHaveAttribute("tabindex", "-1");
    await expect(page.getByText(SKILLS_BODY)).toBeVisible();
    await expect(page.getByText(PROFILES_BODY)).toHaveCount(0);

    // ArrowLeft wraps back.
    await page.keyboard.press("ArrowLeft");
    await expect(profiles).toBeFocused();
    await expect(profiles).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
  });

  test("the old /profiles and /skills routes redirect to the consolidated Actors page", async ({ page, loomDaemon }) => {
    // /profiles → /actors → the Workspace node's Actors tab (Profiles sub-tab, the default).
    await page.goto(`${loomDaemon.baseURL}/profiles`);
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/home\?tab=actors$/);

    // /skills → /actors?tab=skills → the Actors tab with its Skills sub-tab (`sub=` on the host node).
    await page.goto(`${loomDaemon.baseURL}/skills`);
    await expect(page.getByText(SKILLS_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/home\?tab=actors&sub=skills/);
  });

  // Card 4d3418cb (audit A-09 + A-16). A selected list row used the primary CTA fill, which inverted the row
  // and left its muted secondary text (role label / "· bundled") at ~2:1. It now reads as the kit's neutral
  // `loom-btn-on` selection, so the muted text clears WCAG AA. Profile names also start at one x, because the
  // icon slot is a fixed width whether or not the profile has an icon. Measured in BOTH themes, since the
  // tokens differ per theme.
  for (const theme of ["dark", "light"] as const) {
    test(`a selected Profiles/Skills row keeps its secondary text >= 4.5:1, and profile names align (${theme})`, async ({ page, loomDaemon }) => {
      await page.goto(`${loomDaemon.baseURL}/actors`);
      await page.evaluate((t) => localStorage.setItem("loom.theme", t), theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // Selected row's background vs each of its text runs, as a WCAG contrast ratio. Colors go through a 1px
      // canvas so an oklch() token resolves to the sRGB the screen actually shows.
      const measure = (row: import("@playwright/test").Locator) => row.evaluate((b: HTMLElement) => {
        const rgb = (c: string) => { const x = document.createElement("canvas").getContext("2d")!; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const lum = (c: number[]) => { const [r = 0, g = 0, bl = 0] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        const bg = lum(rgb(getComputedStyle(b).backgroundColor));
        const leaves = [...b.querySelectorAll("span")].filter((s) => !s.children.length && /\w/.test(s.textContent ?? ""));
        return { cls: b.className, ratios: leaves.map((s) => { const l = lum(rgb(getComputedStyle(s).color)); return (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05); }) };
      });

      // Measure the row at REST, not hovered: park the pointer at the right edge (the left edge would hover
      // the nav rail open over the content).
      const parkPointer = async () => { const v = page.viewportSize()!; await page.mouse.move(v.width - 2, v.height / 2); };

      const profileRows = page.locator(".loom-actor-split > :first-child button[title]");
      // Pinned on the NAME span, exactly: rows carry a description line now (card 4a5f13ec), and other
      // profiles' descriptions mention "QA Tester", so a contains-match resolves to several rows.
      const qa = profileRows.filter({ has: page.getByText("QA Tester", { exact: true }) });
      await qa.click();
      // Soft assertions throughout, so one run reports every check that fails rather than only the first.
      await expect.soft(qa).toHaveAttribute("aria-pressed", "true");
      await expect.soft(profileRows.and(page.locator("[aria-pressed=true]"))).toHaveCount(1);
      await parkPointer();
      const p = await measure(qa);
      expect.soft(p.cls).not.toContain("loom-btn-primary");
      expect.soft(p.ratios.length).toBeGreaterThanOrEqual(2); // the name AND the role label
      for (const r of p.ratios) expect.soft(r).toBeGreaterThanOrEqual(4.5);

      // A-16: every profile name starts at the same x, iconed or not (the seeded set has both kinds).
      const lefts = await profileRows.evaluateAll((rows) => rows.map((r) => {
        const name = [...r.querySelectorAll("span")].find((s) => getComputedStyle(s).flexGrow === "1");
        return Math.round(name!.getBoundingClientRect().left);
      }));
      expect(lefts.length).toBeGreaterThan(1);
      expect.soft(new Set(lefts).size).toBe(1);

      await page.getByRole("radio", { name: "Skills" }).click();
      const worker = page.locator(".loom-actor-split > :first-child button[title]").filter({ hasText: /^worker/ });
      await worker.click();
      await expect.soft(worker).toHaveAttribute("aria-pressed", "true");
      await parkPointer();
      const s = await measure(worker);
      expect.soft(s.cls).not.toContain("loom-btn-primary");
      expect.soft(s.ratios.length).toBeGreaterThanOrEqual(1); // the "· bundled" run
      for (const r of s.ratios) expect.soft(r).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the dev-only 'Publish to repo' gate is preserved on the Skills tab (hidden in the shipping edition)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);

    // Open a seeded bundled skill (sidebar rows are <button>s; the unique name pins one — the Segmented tabs
    // are role="radio", so they never collide with this button filter).
    await page.getByRole("button").filter({ hasText: "loom-pickup" }).first().click();
    await expect(page.getByText("· SKILL.md", { exact: false })).toBeVisible();

    // The always-present bundled control renders — so the editor really mounted (this isn't a false negative).
    await expect(page.getByRole("button", { name: /reset to shipped/i })).toBeVisible();

    // PRESERVED GATE: LOOM_DEV=0 ⇒ isDev=false ⇒ the "Publish to repo" affordance is hidden.
    await expect(page.getByRole("button", { name: /publish to repo/i })).toHaveCount(0);
  });

  // Card 4a5f13ec (audit A-32 / A-40): the Profiles list filters on name, description and role label, a
  // no-match query says so, and the empty editor pane is a guide rather than one grey sentence.
  test("the profiles filter narrows the list, and the empty pane is a guide", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);
    const rows = page.locator(".loom-actor-split > :first-child button[title]");
    const qa = rows.filter({ has: page.getByText("QA Tester", { exact: true }) });
    await expect(qa).toBeVisible();
    const total = await rows.count();
    expect(total).toBeGreaterThan(1);
    await expect(page.getByTestId("profiles-guide")).toContainText("Select a profile to edit it");
    await expect(page.getByTestId("profiles-guide")).toContainText("Update available");

    const filter = page.getByRole("textbox", { name: "Filter profiles" });
    await filter.fill("QA Tester");
    await expect(qa).toBeVisible();
    await expect.poll(() => rows.count()).toBeLessThan(total);
    await expect(page.getByTestId("profiles-filter-count")).toHaveText(new RegExp(`^\\d+/${total}$`));

    await filter.fill("zz-no-profile-matches-this");
    await expect(rows).toHaveCount(0);
    await expect(page.getByText("No profiles match the filter.")).toBeVisible();

    await filter.fill("");
    await expect(rows).toHaveCount(total);
  });
});
