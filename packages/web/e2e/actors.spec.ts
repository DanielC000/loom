// Actors spec (card 9d7af2f2) — proves the IA consolidation that merges the old /profiles and /skills pages
// into ONE "Actors" destination with a Profiles | Skills segmented switch. Coverage:
//   1. /actors renders the Segmented tabs and defaults to the Profiles body.
//   2. Switching to the Skills tab is an OBSERVABLE state change — the profiles body unmounts, the skills
//      body mounts (each keyed on distinctive body copy, so this proves the RIGHT body swapped, not just
//      that a tab highlighted).
//   3. The old routes redirect: /profiles → /actors (Profiles tab), /skills → /actors?tab=skills (Skills tab).
//   4. PRESERVED gating: Skills' dev-only "Publish to repo" affordance stays gated. This fixture boots
//      LOOM_DEV=0 (see fixtures/daemon.ts), so /api/platform/home 404s → isDev=false → the Publish button is
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

  test("/actors renders the Segmented tabs and defaults to the Profiles body", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);

    // Both tabs render as an accessible tablist (the shared Segmented primitive).
    await expect(page.getByRole("tab", { name: "Profiles" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Skills" })).toBeVisible();

    // Default tab = Profiles: the Profiles body is mounted, the Skills body is not.
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page.getByText(SKILLS_BODY)).toHaveCount(0);
    // The Profiles tab reads selected; Skills does not.
    await expect(page.getByRole("tab", { name: "Profiles" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "false");
  });

  test("switching to the Skills tab swaps the mounted body (observable before/after)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/actors`);

    // BEFORE: the Profiles body is mounted, the Skills body is absent.
    await expect(page.getByText(PROFILES_BODY)).toBeVisible();
    await expect(page.getByText(SKILLS_BODY)).toHaveCount(0);

    // ACT: click the Skills tab.
    await page.getByRole("tab", { name: "Skills" }).click();

    // AFTER (observable #1 — DOM swap): the Skills body is now mounted and the Profiles body is gone.
    await expect(page.getByText(SKILLS_BODY)).toBeVisible();
    await expect(page.getByText(PROFILES_BODY)).toHaveCount(0);
    // AFTER (observable #2 — selection + URL): the Skills tab reads selected and the tab is pinned in the URL.
    await expect(page.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/actors\?tab=skills/);
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
    // are role="tab", so they never collide with this button filter).
    await page.getByRole("button").filter({ hasText: "loom-pickup" }).first().click();
    await expect(page.getByText("· SKILL.md", { exact: false })).toBeVisible();

    // The always-present bundled control renders — so the editor really mounted (this isn't a false negative).
    await expect(page.getByRole("button", { name: /reset to shipped/i })).toBeVisible();

    // PRESERVED GATE: LOOM_DEV=0 ⇒ isDev=false ⇒ the "Publish to repo" affordance is hidden.
    await expect(page.getByRole("button", { name: /publish to repo/i })).toHaveCount(0);
  });
});
