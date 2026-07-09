// e2e spec — the Platform view (card 7da74b06). Builds on the merged isolated-daemon harness
// (card c3fd1d68): every test extends `test` from ./fixtures/daemon so it runs against ONE isolated,
// seeded daemon that serves both the API and the built web app.
//
// WHICH EDITION RENDERS IN THE DEFAULT STATE — this is the whole reason the spec asserts what it does:
// Platform.tsx picks the edition from GET /api/platform/home (the reserved "Loom Platform" dev home).
// That home only seeds under LOOM_DEV=1; the fixture boots the daemon with LOOM_DEV=0 (see
// fixtures/daemon.ts), so /api/platform/home 404s and the page renders the SHIPPING End-User surface
// (the unified PlatformView shell driven by the end-user edition config) — the "Platform" operator +
// Workspace Auditor, no "View as" toggle.
//
// The reserved "Platform" home + its operator + Workspace Auditor agents are seeded on the CORE boot
// path (seedSetupHome / seedSetupAuditorAgent in daemon index.ts) regardless of LOOM_DEV, so the
// End-User surface renders with real data even in this isolated boot — no extra seeding needed here.
//
// MODE-GATING NOTE (reported up): the PlatformView developer edition (Lead/Auditor go-live grid,
// Sessions, Auditor schedules) AND the client-only "View as: Developer | End-user" toggle are only
// reachable when the daemon runs LOOM_DEV=1 (so the reserved "Loom Platform" home exists). The current
// fixture is LOOM_DEV=0-only, so those dev-edition surfaces are out of reach for this spec; covering them
// would need a LOOM_DEV=1 daemon variant in the shared fixture.
//
// Kept LIGHT + non-terminal: no session is spawned, so the page mounts no live PTY tiles — the spec
// asserts on the page's sections/controls and an in-page sub-surface toggle, never a terminal stream.
import { expect, test } from "./fixtures/daemon";

test.describe("platform view (end-user edition)", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts), so
  // no spec re-derives it — in-page clicks land on the actual controls regardless of spec order.

  test("renders the operator, auditor and board sections it presents", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/platform`);

    // We are on the End-User Platform surface — its distinctive lead-in copy (never in the dev edition).
    await expect(page.getByText(/your workspace operator/i)).toBeVisible();

    // Agent controls: the singleton operator's Start button + the create-only auditor's Review button.
    await expect(page.getByRole("button", { name: "Start Platform" })).toBeVisible();
    await expect(page.getByRole("button", { name: /review my workspace/i })).toBeVisible();

    // The section scaffold the page presents (all rendered from the seeded reserved home).
    await expect(page.getByText("Assistants", { exact: true })).toBeVisible();
    await expect(page.getByText("Operator session", { exact: true })).toBeVisible();
    await expect(page.getByText("Auditor session", { exact: true })).toBeVisible();
    // "Your board" section label carries an always-present descriptive span, so match that unique copy
    // (an exact "Your board" match would miss — the label element's text is label + description).
    await expect(page.getByText(/your setup checklist \+ Auditor suggestions/i)).toBeVisible();

    // Dev-only surfaces must NOT be present in this LOOM_DEV=0 boot (asserts the edition split holds).
    await expect(page.getByRole("group", { name: "Preview edition" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /spawn lead/i })).toHaveCount(0);
  });

  test("navigating a sub-surface produces an observable change (startup-prompt disclosure)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/platform`);

    // Each agent card carries a collapsed "Startup prompt" disclosure (AgentPromptEditor). Drive the
    // operator's (the first one): expanding it swaps a read-only preview for the edit sub-surface.
    const disclosure = page.getByRole("button", { name: /startup prompt/i }).first();
    await expect(disclosure).toBeVisible();

    // BEFORE: collapsed — no prompt editor is open, so no "Save prompt" control exists anywhere.
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: /save prompt/i })).toHaveCount(0);

    await disclosure.click();

    // AFTER: the SAME control now reports expanded, and the edit sub-surface mounts. "Save prompt" is a
    // clean, unambiguous witness — that button exists ONLY inside an open startup-prompt editor (the
    // always-visible auditor-schedule cron field would make a generic textbox check a false positive).
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByPlaceholder("The kickoff prompt this agent boots with…")).toBeVisible();
    await expect(page.getByRole("button", { name: /save prompt/i })).toBeVisible();

    // Collapsing it back removes the edit sub-surface again — a clean, reversible observable change.
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: /save prompt/i })).toHaveCount(0);
  });
});
