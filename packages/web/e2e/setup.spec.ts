// Setup / onboarding spec (card 784d9b43) — proves the SETUP / ONBOARDING surface renders and is
// reachable in the seeded, isolated daemon, WITHOUT ever spawning a real claude. The onboarding surface is
// the reserved "Platform" home: one primary nav tab → /platform (App.tsx routes the legacy /setup there),
// which in the SHIPPING edition (the isolated daemon boots LOOM_DEV=0) renders the unified PlatformView
// shell's end-user edition — the user-facing "Platform" operator + Workspace Auditor go-live surface.
// Coverage:
//   1. The onboarding ENTRY is discoverable: the "Platform" header tab navigates to /platform and the
//      shipping surface renders (and, being shipping, NOT the dev "View as" preview toggle).
//   2. The surface's ONBOARDING AFFORDANCES render — the operator go-live ("Start Platform", the way a new
//      user gets their first project created), the Workspace Auditor ("Review my workspace"), and the
//      board/session/history scaffolding — with the operator asserted present + enabled but NEVER clicked.
//   3. The seeded state is honest end to end: GET /api/setup/home exposes the reserved "Platform" home + its
//      ungated-seeded operator + auditor agents, and its liveSessions is EMPTY — a REST-level proof that
//      neither the harness nor this spec spawned a real agent (the fixture pre-stamps the first-run marker).
//   4. The legacy /setup route redirects to the consolidated /platform surface.
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template and skills.spec.ts
// is the pattern for suppressing the first-run welcome modal.
//
// SAFETY (the whole reason this asserts on the shell, not a live agent): the isolated-daemon fixture forbids
// a real claude spawn (it fails loudly on a `[pty] spawn` / `first-run: auto-launched` boot log). So this
// spec drives the setup UI directly and asserts its affordances render — it NEVER clicks "Start Platform" /
// "Review my workspace", which would mint a real session. The empty-state + empty liveSessions are the
// positive proof that nothing spawned.
import { expect, test } from "./fixtures/daemon";

// The one-time first-run "Welcome to Loom" modal (App.tsx › FirstRunWelcome, a full-viewport overlay that
// intercepts every click on a projectless daemon) is dismissed globally by the fixture (fixtures/daemon.ts),
// so this spec is deterministic regardless of spec order and re-derives nothing.

test("the Platform nav tab reaches the shipping onboarding surface", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/`);

  // The onboarding entry is discoverable as a primary header tab (nav.tsx: Platform is `primary`, so it's a
  // top-level tab, not tucked in "More ▾"). NavTab renders an <a> whose accessible name is "Platform".
  const tab = page.getByRole("link", { name: "Platform", exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page).toHaveURL(/\/platform$/);

  // Shipping edition (the isolated daemon boots LOOM_DEV=0, so the dev "Loom Platform" home never seeds and
  // GET /api/platform/home 404s): the PlatformView shell mounts its end-user edition, NOT the developer
  // edition — so the dev-only "View as" preview toggle is absent.
  await expect(page.getByRole("group", { name: "Preview edition" })).toHaveCount(0);

  // The reserved "Platform" home header + its explainer copy (a substring unique to this surface).
  await expect(page.getByText("your workspace operator · hidden from the project picker", { exact: false })).toBeVisible();
});

test("the onboarding surface renders the operator + auditor entries and no live session", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/platform`);

  // The surface's descriptive header resolved (proves api.setupHome loaded, not just an empty shell).
  await expect(page.getByText("Platform is your friendly, user-facing workspace operator", { exact: false })).toBeVisible();

  // The operator go-live entry — how a new user gets their first project created (start the operator, tell
  // it what to build). Assert it's present + enabled, but NEVER click it: clicking spawns a REAL claude
  // session, which the isolated-daemon harness forbids. Offline (no live session) it reads "Start Platform".
  const start = page.getByRole("button", { name: "Start Platform", exact: true });
  await expect(start).toBeVisible();
  await expect(start).toBeEnabled();

  // The Workspace Auditor entry (the second reserved-home agent, seeded ungated alongside the operator).
  await expect(page.getByRole("button", { name: "Review my workspace", exact: true })).toBeVisible();

  // No session is live — the operator's empty-state is the positive proof that neither the harness nor this
  // spec spawned a real agent.
  await expect(page.getByText("No Platform session running. Start Platform above.", { exact: false })).toBeVisible();

  // The onboarding scaffolding renders: the go-live section, the operator terminal section, and the reserved
  // home's board (the reused Board component, scoped to the reserved home).
  await expect(page.getByText("Assistants", { exact: true })).toBeVisible();
  // "Operator session" is its own SectionLabel (no live pill), so exact-match it — a loose match would
  // trip strict-mode against the "every operator session …" history caption + the empty-state copy.
  await expect(page.getByText("Operator session", { exact: true })).toBeVisible();
  // The reserved home's board section: assert its unique descriptive caption (the "Your board" label shares
  // its SectionLabel with that span, so no element has exactly "Your board").
  await expect(page.getByText("your setup checklist + Auditor suggestions", { exact: false })).toBeVisible();
});

test("GET /api/setup/home exposes the seeded reserved home with no live session", async ({ loomDaemon }) => {
  // The setup home + its operator ("Platform") and Workspace Auditor agents seed UNGATED on the CORE path
  // (no LOOM_DEV), so an isolated shipping daemon already has them — this is the REST source the surface
  // above is built from.
  const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`);
  expect(res.ok).toBe(true);
  const home = (await res.json()) as {
    project: { name: string };
    agents: Array<{ name: string }>;
    liveSessions: unknown[];
  };

  expect(home.project?.name).toBe("Platform");
  const names = home.agents.map((a) => a.name);
  expect(names).toContain("Platform"); // the operator
  expect(names).toContain("Workspace Auditor"); // the de-privileged reviewer, seeded alongside

  // No live session — the fixture pre-stamps the first-run marker so no real claude auto-launches, and this
  // spec never clicked a Start control. This is the REST-level twin of the empty-state UI assertion above.
  expect(home.liveSessions).toEqual([]);
});

test("the legacy /setup route redirects to the consolidated /platform surface", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/setup`);

  // App.tsx maps /setup → <Navigate to="/platform" replace/>, so any lingering onboarding link lands on the
  // consolidated surface.
  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByText("your workspace operator · hidden from the project picker", { exact: false })).toBeVisible();
});
