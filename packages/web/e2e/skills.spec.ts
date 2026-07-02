// Skills spec (card 47cad3f8) — proves the Skills page (/skills) both RENDERS Loom's bundled skill store
// and reflects the server-derived customization state through the real human/REST path. Coverage:
//   1. The list renders the seeded/bundled CORE skills — the daemon seeds ~/.loom/skills from the bundled
//      assets at boot (seedGlobalSkills), so an isolated daemon already has them; no extra seeding needed.
//   2. Opening a skill loads its SKILL.md body into the editor and shows the "bundled" state.
//   3. Customized-vs-pristine state is OBSERVABLE end to end: a freshly seeded bundled skill is pristine
//      (no "customized" badge); editing its body + Save (the customize control) flips it to "customized"
//      via the server-derived state (mine ≠ base), confirmed in the UI, over REST, and across a reload.
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template.
//
// Skills are a DAEMON-GLOBAL store (not project-scoped) — no active-project pin is needed, unlike
// settings.spec.ts. The `loomDaemon` fixture is worker-scoped (one daemon for the whole run), so the
// customize test RESETS the skill it mutated back to shipped at the end (POST /reset) to keep the store
// pristine for any other spec sharing this daemon.
import { expect, test } from "./fixtures/daemon";

// CORE bundled skills seeded on every boot (packages/daemon/assets/skills) regardless of LOOM_DEV — the
// platform-* skills are dev-gated in the npm build, so we assert only on the always-present CORE set.
const CORE_SKILLS = ["worker", "orchestrate", "web-design", "task-start", "session-end", "pickup", "doc-hygiene"];

// The sidebar skill entries are <button>s whose text is "<name>  ·  bundled". Each CORE name is a unique
// substring across the button set, so a hasText filter pins exactly one. (Nav items are <a> links, not
// buttons, so they never collide.)
function skillButton(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("button").filter({ hasText: name }).first();
}

// A fresh isolated daemon has no ordinary projects, so the client shows the one-time first-run "Welcome to
// Loom" modal (App.tsx › FirstRunWelcome) — a full-viewport overlay that intercepts every click. It is
// gated on the `loom.setupWelcomeDismissed` localStorage flag, so pre-set it before any navigation (this
// harness never creates an ordinary project). Mirrors settings.spec.ts's addInitScript-before-goto pattern.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("loom.setupWelcomeDismissed", "1"));
});

test("the skills list renders the seeded bundled skills", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/skills`);

  // The panel header renders.
  await expect(page.getByText("Skills", { exact: true }).first()).toBeVisible();

  // Every CORE bundled skill shows up as a sidebar entry.
  for (const name of CORE_SKILLS) {
    await expect(skillButton(page, name)).toBeVisible();
  }

  // The entries are marked as bundled (Loom's shipped set, not user-local) — proves the list carries the
  // server-derived `bundled` flag, not just names.
  await expect(page.getByText("· bundled", { exact: false }).first()).toBeVisible();

  // Cross-check against the REST source the list is built from: the seeded store really holds these skills
  // and reports them bundled.
  const res = await fetch(`${loomDaemon.baseURL}/api/skills`);
  const skills = (await res.json()) as Array<{ name: string; bundled: boolean }>;
  for (const name of CORE_SKILLS) {
    expect(skills.find((s) => s.name === name)?.bundled).toBe(true);
  }
});

test("opening a skill loads its SKILL.md body", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/skills`);

  // Before selecting anything, the editor pane shows its empty-state hint.
  await expect(page.getByText("Select a skill to edit its SKILL.md", { exact: false })).toBeVisible();

  await skillButton(page, "web-design").click();

  // The editor mounts with a "· SKILL.md" header and the "bundled" badge for a shipped skill.
  await expect(page.getByText("· SKILL.md", { exact: false })).toBeVisible();
  await expect(page.getByText("bundled", { exact: true })).toBeVisible();

  // The textarea holds the ACTUAL body — a substring distinctive to web-design's SKILL.md, so this proves
  // the right skill's content loaded, not just that a textarea rendered.
  const editor = page.locator("textarea");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/deliberately designed/);
});

test("editing a bundled skill flips it from pristine to customized (observable before/after)", async ({ page, loomDaemon }) => {
  // Use a CORE skill and restore it at the end so the shared worker-scoped daemon stays pristine.
  const target = "pickup";
  await page.goto(`${loomDaemon.baseURL}/skills`);

  await skillButton(page, target).click();
  const editor = page.locator("textarea");
  await expect(editor).toBeVisible();

  // BEFORE: a freshly seeded bundled skill is pristine — no "customized" badge, no divergence banner.
  await expect(page.getByText("customized", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your saved copy differs from the current shipped version", { exact: false })).toHaveCount(0);
  // REST cross-check: the store agrees it is not customized.
  const before = await fetch(`${loomDaemon.baseURL}/api/skills`).then((r) => r.json()) as Array<{ name: string; customized?: boolean }>;
  expect(before.find((s) => s.name === target)?.customized ?? false).toBe(false);

  // ACT: exercise the customize control — append a marker line and Save (PUT /api/skills/:name → mine ≠ base).
  const marker = `\n<!-- e2e-customize-${Date.now()} -->\n`;
  const original = await editor.inputValue();
  await editor.fill(original + marker);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();

  // AFTER (observable #1 — UI): the server-derived state now reads "customized" in the header badge, and the
  // divergence banner appears (customized · no shipped update).
  await expect(page.getByText("customized", { exact: true })).toBeVisible();
  await expect(page.getByText("Your saved copy differs from the current shipped version", { exact: false })).toBeVisible();

  // AFTER (observable #2 — REST): the store the UI shares now flags the skill customized.
  await expect
    .poll(async () => {
      const skills = (await fetch(`${loomDaemon.baseURL}/api/skills`).then((r) => r.json())) as Array<{ name: string; customized?: boolean }>;
      return skills.find((s) => s.name === target)?.customized ?? false;
    })
    .toBe(true);

  // AFTER (observable #3 — persistence): a full reload re-derives the customized badge from the store, not
  // optimistic client state, and the saved body carries the marker.
  await page.reload();
  await skillButton(page, target).click();
  await expect(page.getByText("customized", { exact: true })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue(/e2e-customize-/);

  // CLEANUP: restore the skill to its shipped version so the shared daemon's store is pristine again.
  const reset = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/reset`, { method: "POST" });
  expect(reset.ok).toBe(true);
});
