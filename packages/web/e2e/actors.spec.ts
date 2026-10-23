// Actors spec (card 9d7af2f2) — proves the IA consolidation that merges the old /profiles and /skills pages
// into ONE "Actors" destination with a Profiles | Skills segmented switch. Coverage:
//   1. /actors renders the Segmented tabs and defaults to the Profiles body.
//   2. Switching to the Skills tab is an OBSERVABLE state change — the profiles body unmounts, the skills
//      body mounts (each keyed on distinctive body copy, so this proves the RIGHT body swapped, not just
//      that a tab highlighted).
//   3. The old routes redirect: /profiles → /actors (Profiles tab), /skills → /actors?tab=skills (Skills tab).
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
    await expect(page).toHaveURL(/\/actors\?tab=skills/);
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
    // /profiles → /actors (Profiles tab).
    await page.goto(`${loomDaemon.baseURL}/profiles`);
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/actors$/);

    // /skills → /actors?tab=skills (Skills tab).
    await page.goto(`${loomDaemon.baseURL}/skills`);
    await expect(page.getByText(SKILLS_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/actors\?tab=skills/);
  });

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
});
