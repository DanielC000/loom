// The Atlas Platform node (card c07ff42a, Atlas build plan P2-4 — docs/plans/atlas-ui/03-decomposition.md
// row P2-4). Behind the Atlas switch, today's single-column Platform page becomes a five-tab node (Home /
// Cadence / History / Board / Findings) carrying BOTH editions: both go-live cards, both session layouts,
// both cadence variants, both histories, its own board, and Findings with inline Adopt / Dismiss.
//
// WHICH EDITION RENDERS, AND WHY THIS SPEC MOCKS ONE ROUTE
// Platform.tsx picks the edition from `GET /api/platform/home` — the reserved "Loom Platform" dev home,
// which only seeds under LOOM_DEV=1. The fixture boots the daemon with LOOM_DEV=0 (fixtures/daemon.ts), so
// that route returns `project: null` (card 8d82be67 — the route is always 200) and the page renders the
// SHIPPING end-user edition. platform.spec.ts reports that as a
// hard limit ("covering the dev edition would need a LOOM_DEV=1 daemon variant"). This spec reaches it by
// fulfilling THAT ONE ROUTE — the same signal the page already reads, with the REAL reserved home as its
// payload — so the edition fork is exercised through the production code path rather than a second one.
// Nothing else is mocked: every read and write below hits the real daemon.
//
// ⚠️ The mock is a CLIENT-side fiction about which home exists, never about what the daemon permits. The
// contrast case that proves it (@decision 8adccd37's prohibition, asserted directly in the first test):
// previewing "End-user" from the mocked dev install leaves the operator's go-live button DISABLED, while
// the REAL end-user edition — same edition config, no mock — has it ENABLED. If the preview could unlock
// anything, those two readings would agree. They must not.
//
// Kept LIGHT + non-terminal: no session is ever spawned (the fixture's no-spawn guard forbids it), so no
// live PTY tile mounts. Spawn controls are asserted present/enabled/disabled and never clicked.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Pins the active project, but only while the key is still absent: addInitScript re-runs on every
// navigation (reload included), so an unconditional write would re-pin on a later leg and measure the
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

// lib/Platform.tsx's own persisted toggle key. Seeded so a preview test lands ALREADY in the End-user
// view rather than clicking across — a click would also need the Developer view's queries to settle
// first, and an intercepting route (below) is registered before the first navigation.
const VIEW_AS_KEY = "loom.platformViewAs";
async function seedViewAsEndUser(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "enduser"); } catch { /* storage unavailable — assertions will say so */ }
  }, VIEW_AS_KEY);
}

/**
 * Record — and BLOCK — every mutating `/api/` request the page attempts (card b472645a).
 *
 * `route.abort()` rather than a fulfil: the recorded path IS the evidence, and nothing must reach the
 * daemon (the fixture's no-spawn guard forbids a real claude spawn, so a control that still fires has to
 * be stopped in the browser, not answered). GETs `fallback()` to the next handler, which is why this must
 * be registered AFTER `serveDevPlatformHome` — Playwright runs route handlers LIFO, so the catcher sees
 * every request first and the home mock still gets its own GET.
 */
async function blockMutations(page: Page): Promise<string[]> {
  const sent: string[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (req.method() !== "GET" && pathname.startsWith("/api/")) {
      sent.push(`${req.method()} ${pathname}`);
      return route.abort();
    }
    return route.fallback();
  });
  return sent;
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Names/titles go into regexes below, and the daemon hands back what it STORED rather than what was
// asked for — so escape rather than assume the stored form is metacharacter-free.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type HomeAgent = { id: string; name: string; profileId: string | null };
type SetupHome = {
  project: { id: string; name: string };
  agents: HomeAgent[];
  resolvedLead: { agentId: string | null; role: string | null };
};

/** The REAL reserved home, read through the route the end-user edition itself reads. */
async function readSetupHome(d: LoomDaemon): Promise<SetupHome> {
  const res = await fetch(`${d.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${d.loopbackSecret}` } });
  if (!res.ok) throw new Error(`GET /api/setup/home -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as SetupHome;
}

/**
 * Serve `GET /api/platform/home` as a 200 carrying the REAL reserved home, which is what flips
 * Platform.tsx to the dev edition (and renders the "View as" toggle at all).
 *
 * The dev edition resolves its auditor by profile role "auditor", then by the name "Platform Auditor";
 * the real home's auditor is role "workspace-auditor" named "Workspace Auditor", so it is renamed HERE,
 * in the payload, to exercise that name fallback. Everything else — the project, the agent IDs, the
 * operator (whose profile role genuinely IS "platform") — is the real row, so the prompt editor, the
 * board and the findings read all run against real data.
 *
 * Also asserts the fixture's identity before trusting it: a payload built from the wrong home, or from a
 * home that lost its auditor, would otherwise render a plausible, screenshot-able, wrong page.
 */
async function serveDevPlatformHome(page: Page, d: LoomDaemon): Promise<SetupHome> {
  const home = await readSetupHome(d);
  expect(home.project.name, "the reserved home this spec builds its dev payload from").toBe("Platform");
  const operator = home.agents.find((a) => a.name === "Platform");
  const auditor = home.agents.find((a) => a.name === "Workspace Auditor");
  expect(operator, "the reserved home's operator agent").toBeTruthy();
  expect(auditor, "the reserved home's workspace-auditor agent").toBeTruthy();

  const payload = {
    project: home.project,
    agents: home.agents.map((a) => (a.id === auditor!.id ? { ...a, name: "Platform Auditor" } : a)),
    liveSessions: [],
  };
  // `**` so it matches whatever origin this worker's daemon bound to. `fallback()` on anything else that
  // happens to route through the same handler would be wrong here — the pattern is exact.
  await page.route("**/api/platform/home", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(payload),
  }));
  return home;
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Platform node tabs" });
// Segmented uppercases its labels in CSS, and Chromium folds `text-transform` into the accessible name —
// so tab names are matched case-insensitively (measured on P1-0 gotcha 5 / P1-3 gotcha 1).
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}$`, "i") });

async function openTab(page: Page, name: string) {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
}

// The View-as control Platform.tsx renders ABOVE whichever layout mounts (dev installs only).
const viewAs = (page: Page, label: string) =>
  page.getByRole("group", { name: "Preview edition" }).getByRole("button", { name: label });

// ── Scopes: WHERE a text assertion is allowed to look ───────────────────────────────────────────
//
// 🔴 A bare `page.getByText("<word>", {exact:true})` is unsafe on this page for TWO independent
// reasons, and the fix differs per reason:
//
//   1. EVERY PANEL IS MOUNTED (inactive ones carry `hidden`, card c07ff42a round 2), so a string the
//      active panel shows may ALSO sit in a hidden panel's DOM. ⇒ a PRESENCE check must name its
//      panel, or it is a strict-mode violation waiting on whichever string collides next.
//   2. THE NAV CHROME RENDERS NODE LABELS AS EXACT TEXT. `AtlasTree` draws one
//      `<span class="loom-atlas-lbl">` per node from `NAV_PAGES`/`ATLAS_HOMES` in src/nav.tsx — so
//      every nav LABEL is a live exact-text match anywhere on the page. That is what broke this spec:
//      P2-2 added an `ATLAS_HOMES` node labelled **"Agents"**, which is also this page's dev-edition
//      section label, and `getByText("Agents", {exact:true})` began resolving to two elements.
//
// ⇒ `panel()` for PRESENCE (reason 1, and it happens to fix reason 2 as well).
// ⇒ `content()` where an ABSENCE has to survive reason 2 — see its own note below.
//
// ⛔ Do NOT reach for `.first()` to settle either one: it silences the violation by reading whichever
// element the DOM happened to order first, which is the chrome exactly as often as the panel.
const panel = (page: Page, tabKey: string) => page.getByTestId(`platform-panel-${tabKey}`);

// The content column, excluding the nav chrome. In BOTH shells the chrome is a SIBLING of `<main>`
// (`AtlasTree` beside `.loom-atlas-main` in components/AtlasShell.tsx; `Sidebar` beside `<main>` in
// App.tsx), so this scope spans every panel while owning none of the tree's/rail's own labels.
//
// ⚠️ ABSENCE ASSERTIONS STAY PAGE-WIDE BY DEFAULT — scoping an absence narrows the very thing it is
// trying to rule out, which is this spec's own standing rule. `content()` is the ONE deliberate
// exception, and only for a string the CHROME legitimately renders in BOTH editions: a page-wide
// "Agents" is absent from nowhere, because the tree node is there whichever edition is in view, so
// the page-wide form would assert something false rather than something strong. `content()` keeps
// the claim as broad as it can honestly be — every panel, no chrome — instead of shrinking it to one.
const content = (page: Page) => page.locator("main");

test.describe("Atlas Platform node (card c07ff42a)", () => {
  // ── 1. The edition toggle flips every forked element, both directions ──────────────────────────────
  test("switch ON: the View-as toggle flips each dev-only and end-user-only element, both ways", async ({ page, loomDaemon }) => {
    await serveDevPlatformHome(page, loomDaemon);
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/platform`);

    // The Atlas frame, provably — otherwise every assertion below could be measuring the classic page.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(tabs(page)).toBeVisible();

    // ── DEVELOPER (the default view on a dev install) ──
    // Per tab, a marker that exists ONLY in this edition, plus the end-user twin asserted ABSENT. The
    // presence assertion leads in each pair: it is the one that retries until the tab's data has landed,
    // whereas a leading `toHaveCount(0)` is satisfied by a tab that is still loading (card 625d791c).
    await expect(page.getByText(/the management layer above all projects/i)).toBeVisible();
    await expect(page.getByText(/your cross-project workspace agent/i)).toHaveCount(0);

    // The section label, read INSIDE the Home panel. Page-wide this also matches the Atlas tree's own
    // "Agents" node (src/nav.tsx `ATLAS_HOMES`) — see the scope note above.
    await expect(panel(page, "home").getByText("Agents", { exact: true })).toBeVisible();
    await expect(page.getByText("Assistants", { exact: true })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /^spawn lead$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^start platform$/i })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /^spawn auditor$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /review my workspace/i })).toHaveCount(0);

    // The dev GRID layout's own live-count span; the end-user SPLIT layout has no such span and instead
    // names its two single-session sections. (The tree's project row also carries a live count, but as a
    // bare number — `AtlasTree`'s `.loom-atlas-live` — so it cannot match this "(N live)" shape.)
    await expect(panel(page, "home").getByText(/^\(\d+ live\)$/)).toBeVisible();
    await expect(page.getByText("Operator session", { exact: true })).toHaveCount(0);

    await openTab(page, "Cadence");
    await expect(panel(page, "cadence").getByRole("button", { name: /^add cadence$/i })).toBeVisible();
    await expect(page.getByText(/^Run automatically$/)).toHaveCount(0);

    await openTab(page, "History");
    // Dev COLLAPSES each history behind a disclosure button; the end-user edition renders them as plain
    // expanded sections, so the *role* differs, not just the label.
    await expect(panel(page, "history").getByRole("button", { name: /lead history/i })).toBeVisible();
    await expect(panel(page, "history").getByRole("button", { name: /auditor history/i })).toBeVisible();
    await expect(page.getByText(/every operator session — when it ran/i)).toHaveCount(0);

    await openTab(page, "Board");
    await expect(panel(page, "board").getByText(/Auditor findings \+ manager escalations/i)).toBeVisible();
    await expect(page.getByText(/your setup checklist \+ Auditor suggestions/i)).toHaveCount(0);

    await openTab(page, "Findings");
    await expect(panel(page, "findings").getByText(/every finding the Auditor has filed/i)).toBeVisible();
    await expect(page.getByText(/every improvement the Auditor has suggested/i)).toHaveCount(0);

    // ── THE FLIP ──
    await viewAs(page, "End-user").click();
    await expect(viewAs(page, "End-user")).toHaveAttribute("aria-pressed", "true");
    await expect(viewAs(page, "Developer")).toHaveAttribute("aria-pressed", "false");
    // MEASURED: the toggle remounts the shell (Platform.tsx keys it by edition) but the node KEEPS its
    // tab, because the tab lives in the URL rather than in component state — flipping the preview does
    // not throw away where you were. Pinned here so a later "reset to Home on toggle" change has to be a
    // deliberate one. Every marker below is read per tab, so walk back to Home explicitly.
    await expect(tab(page, "Findings")).toHaveAttribute("aria-selected", "true");
    await openTab(page, "Home");

    // ── END-USER (previewed) — the exact complement, same order ──
    await expect(page.getByText(/your cross-project workspace agent/i)).toBeVisible();
    await expect(page.getByText(/the management layer above all projects/i)).toHaveCount(0);

    // The Atlas identity strip drops the classic label's leading "Platform" word — the node head owns
    // the page's one <h1>, so repeating it would read as a second heading. This is the exact regex the
    // switch-OFF test asserts VISIBLE on the classic page, read here against the same edition's copy.
    await expect(page.getByText(/^Platform\s*Platform\s*your cross-project workspace agent/)).toHaveCount(0);

    await expect(panel(page, "home").getByText("Assistants", { exact: true })).toBeVisible();
    // ⚠️ `content()`, not page-wide: the Atlas tree's own "Agents" node renders in BOTH editions, so a
    // page-wide absence here asserts something FALSE rather than something strong. This still spans
    // every panel — it only declines to read the nav chrome. See the scope note at the top.
    //
    // POSITIVE CONTROL on the scope, immediately before relying on it: a `toHaveCount(0)` inside a
    // scope that resolved to NOTHING passes for the wrong reason, and reads identically to a real
    // absence. This pins that `main` is present and is the populated content column, so the next line
    // is measuring the string rather than an empty subtree.
    await expect(content(page)).toBeVisible();
    await expect(content(page).getByText(/your cross-project workspace agent/i)).toBeVisible();
    await expect(content(page).getByText("Agents", { exact: true })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^spawn lead$/i })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /review my workspace/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^spawn auditor$/i })).toHaveCount(0);

    await expect(panel(page, "home").getByText("Operator session", { exact: true })).toBeVisible();
    await expect(panel(page, "home").getByText("Auditor session", { exact: true })).toBeVisible();
    await expect(page.getByText(/^\(\d+ live\)$/)).toHaveCount(0);

    // 🔴 THE TRUST BOUNDARY, asserted here and nowhere else: previewing the end-user edition from a dev
    // install must not make its operator spawnable (the underlying agent is never upgraded to the Lead),
    // so Platform.tsx passes `previewOnly` and the button is held. The REAL end-user edition — same
    // edition config, no mock — has this button ENABLED; the last test in this file reads it that way.
    // Two different answers from the same config is what proves the toggle changed the VIEW only.
    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeDisabled();
    await expect(page.getByText(/Preview only on a dev install/i).first()).toBeVisible();

    await openTab(page, "Cadence");
    await expect(panel(page, "cadence").getByText(/^Run automatically$/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^add cadence$/i })).toHaveCount(0);

    await openTab(page, "History");
    await expect(panel(page, "history").getByText(/every operator session — when it ran/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /lead history/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /auditor history/i })).toHaveCount(0);

    await openTab(page, "Board");
    await expect(panel(page, "board").getByText(/your setup checklist \+ Auditor suggestions/i)).toBeVisible();
    await expect(page.getByText(/Auditor findings \+ manager escalations/i)).toHaveCount(0);

    await openTab(page, "Findings");
    await expect(panel(page, "findings").getByText(/every improvement the Auditor has suggested/i)).toBeVisible();
    await expect(page.getByText(/every finding the Auditor has filed/i)).toHaveCount(0);

    // ── AND BACK: the dev set returns, the end-user set is gone. Without this leg the flip above could
    // be a one-way collapse into the end-user view rather than a switch. ──
    await viewAs(page, "Developer").click();
    await expect(viewAs(page, "Developer")).toHaveAttribute("aria-pressed", "true");
    // Same URL-held-tab behaviour as the first flip — walk back to Home before reading Home's markers.
    await openTab(page, "Home");
    await expect(page.getByText(/the management layer above all projects/i)).toBeVisible();
    await expect(panel(page, "home").getByText("Agents", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^spawn lead$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^spawn auditor$/i })).toBeVisible();
    await expect(panel(page, "home").getByText(/^\(\d+ live\)$/)).toBeVisible();
    await expect(page.getByText(/your cross-project workspace agent/i)).toHaveCount(0);
    await expect(page.getByText("Assistants", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^start platform$/i })).toHaveCount(0);
    await expect(page.getByText(/Preview only on a dev install/i)).toHaveCount(0);

    await openTab(page, "Cadence");
    await expect(panel(page, "cadence").getByRole("button", { name: /^add cadence$/i })).toBeVisible();
    await expect(page.getByText(/^Run automatically$/)).toHaveCount(0);
  });

  // ── 2. The node's own board is the PLATFORM home's, never the active project's ─────────────────────
  test("switch ON: the Board tab shows the Platform home's cards and never the active project's", async ({ page, loomDaemon }) => {
    const home = await readSetupHome(loomDaemon);
    const platformCard = uniq("platformcard-SENTINEL");
    const projectCard = uniq("projectcard-SENTINEL");
    // One card on each board, each title unique to its own board — so neither polarity can pass
    // vacuously, and the assertion is driven by the page's own project-scoped read.
    const seededPlatformTask = await loomDaemon.createTask(home.project.id, { title: platformCard, columnKey: "inbox" });
    // The project name deliberately shares no stem with either card title: Playwright text matching is
    // substring + case-insensitive and has hijacked a locator on this suite before (card 921e06b0).
    const project = await loomDaemon.createProject(uniq("atlasplat-zulu"));
    await loomDaemon.createTask(project.id, { title: projectCard, columnKey: "inbox" });

    try {
      await seedAtlasOn(page);
      await pinProject(page, project.id);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=board`);

      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(tab(page, "Board")).toHaveAttribute("aria-selected", "true");
      // The active project is genuinely the OTHER one — otherwise "the project's card is absent" would
      // hold for a reason that has nothing to do with the Board tab's scoping.
      await expect(page.getByTestId("atlas-project-node")).toContainText(project.name);

      // Presence scoped to the Board panel (every panel is mounted, only inactive ones `hidden`);
      // absence stays page-wide, which is the stronger claim and the one that matters here.
      await expect(page.getByTestId("platform-panel-board").getByText(platformCard, { exact: true })).toBeVisible();
      await expect(page.getByText(projectCard, { exact: true })).toHaveCount(0);

      // The inverse, on the ordinary project Board node: the active project's card, and not the
      // Platform home's. Same two locators, opposite readings — so the pair measures scoping, not the
      // mere existence of one card.
      await page.goto(`${loomDaemon.baseURL}/board`);
      await expect(page.getByText(projectCard, { exact: true })).toBeVisible();
      await expect(page.getByText(platformCard, { exact: true })).toHaveCount(0);
    } finally {
      // The reserved home's board is shared with every other spec on this worker's daemon — leave it as
      // it was found rather than leaving an attention-shaped row behind (card 1d3192dc trap 1).
      await fetch(`${loomDaemon.baseURL}/api/tasks/${seededPlatformTask.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 3. Findings: inline Adopt / Dismiss, with an observable before/after ───────────────────────────
  test("switch ON: the Findings tab adopts and dismisses the auditor's preset suggestions", async ({ page, loomDaemon }) => {
    const toAdopt = uniq("suggest-ADOPTME");
    const toDismiss = uniq("suggest-DROPME");
    const adopted = await seedSuggestion(loomDaemon, toAdopt, "Run the adopt-path check");
    const dismissed = await seedSuggestion(loomDaemon, toDismiss, "Run the dismiss-path check");

    try {
      await seedAtlasOn(page);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=findings`);

      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(tab(page, "Findings")).toHaveAttribute("aria-selected", "true");

      const findings = panel(page, "findings");
      const row = (label: string) => findings.locator("div").filter({ hasText: new RegExp(escapeRe(label)) }).last();

      // ── BEFORE: both suggestions are offered, and no preset carries either label yet. ──
      await expect(findings.getByText(toAdopt, { exact: true })).toBeVisible();
      await expect(findings.getByText(toDismiss, { exact: true })).toBeVisible();
      expect(await presetLabels(loomDaemon)).not.toContain(toAdopt);

      // ── DISMISS: that row leaves, the other stays (so the click is scoped to its own row), and no
      //    preset was minted. ──
      await row(toDismiss).getByRole("button", { name: "Dismiss" }).click();
      await expect(page.getByText(toDismiss, { exact: true })).toHaveCount(0);
      await expect(findings.getByText(toAdopt, { exact: true })).toBeVisible();
      expect(await presetLabels(loomDaemon)).not.toContain(toDismiss);

      // ── ADOPT: the row leaves AND a real preset now exists under that label — the write, read back
      //    through the daemon's own route rather than inferred from the row disappearing. ──
      await row(toAdopt).getByRole("button", { name: "Adopt" }).click();
      await expect(page.getByText(toAdopt, { exact: true })).toHaveCount(0);
      await expect
        .poll(async () => await presetLabels(loomDaemon), { message: "the adopted preset should exist" })
        .toContain(toAdopt);

      // Both consumed ⇒ the suggestions section renders nothing at all, exactly as the composer popover's
      // own copy of it does — while the tab itself is still there, so this is a section that removed
      // itself rather than a page that broke. (Deliberately NOT asserted via the findings list's empty
      // state: another test in this file seeds findings onto the same worker daemon, and an assertion
      // that only holds in declaration order is a trap for whoever reorders them.)
      await expect(page.getByText(/^Suggested presets$/)).toHaveCount(0);
      await expect(findings.getByText(/every improvement the Auditor has suggested/i)).toBeVisible();
    } finally {
      // Preset prompts + suggestions are a DAEMON-GLOBAL store shared with every other spec on this
      // worker (the composer-preset specs read the same list), so anything seeded here is cleaned up
      // whatever happened above — a leftover suggestion would surface in an unrelated spec's popover.
      await dismissSuggestion(loomDaemon, adopted.id);
      await dismissSuggestion(loomDaemon, dismissed.id);
      await deletePresetsLabelled(loomDaemon, [toAdopt, toDismiss]);
    }
  });

  // ── 4. Findings: the filed-findings list, and the edition's own event kind as its scope ───────────
  test("switch ON: the Findings tab lists filed findings and is scoped by the edition's event kind", async ({ page, loomDaemon }) => {
    const home = await readSetupHome(loomDaemon);
    const mineTitle = uniq("finding-MINE");
    const theirsTitle = uniq("finding-THEIRS");
    const card = await loomDaemon.createTask(home.project.id, { title: mineTitle, columnKey: "inbox" });

    // The end-user edition (the default on this LOOM_DEV=0 boot) reads `workspace_audit_suggestion`.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: `e2e-auditor-${Date.now()}`, kind: "workspace_audit_suggestion",
      taskId: card.id, detail: { severity: "high", title: mineTitle },
    });
    // The DEV edition's kind. It must NOT appear here: the kind is what scopes a findings read to one
    // home, so a leak would show the dev Platform board's findings to an end user.
    //
    // ⚠️ It is filed against a taskId with NO board card, DELIBERATELY. Pointing it at `card.id` (the
    // obvious thing, and what this test did first) makes the absence assertion UNFALSIFIABLE: FindingRow
    // prefers the BOARD's title over the event's frozen `detail.title`, so a leaked row would have
    // rendered `mineTitle` and `theirsTitle` would be absent from the DOM whether the leak happened or
    // not. With no card to resolve, a leaked row is forced to render `theirsTitle` — which is the only
    // state in which the check below can fail.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: `e2e-auditor-${Date.now()}`, kind: "audit_finding",
      taskId: `e2e-no-such-card-${Date.now()}`, detail: { severity: "critical", title: theirsTitle },
    });

    try {
      await seedAtlasOn(page);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=findings`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      // ⚠️ SCOPED to the findings panel. Every panel is MOUNTED (only the inactive ones are `hidden`),
      // so this card's title is also in the DOM inside the hidden Board panel — a page-wide text match
      // is a strict-mode violation, and a `.first()` would have quietly read whichever came first.
      const panel = page.getByTestId("platform-panel-findings");

      // The row renders with the severity the event carried and the title the BOARD holds (not the
      // frozen one in `detail`, which is what a retitled card would diverge from).
      await expect(panel.getByText(mineTitle, { exact: true })).toBeVisible();
      await expect(panel.getByText("high", { exact: true })).toBeVisible();
      // Absence stays PAGE-WIDE, deliberately: scoping an absence check narrows the very thing it is
      // trying to rule out. `theirsTitle` belongs to no board card, so nothing else can render it.
      await expect(page.getByText(theirsTitle, { exact: true })).toHaveCount(0);
      // Belt and braces on the same leak, counted rather than named: a dev-kind row would show up as a
      // SECOND finding row even if its title somehow resolved to something else.
      await expect(panel.locator('[data-testid="platform-finding"]')).toHaveCount(1);

      // The row's one affordance: it hands the finding to the Board tab, which opens its card's dialog.
      // That is the whole point of listing findings here — triage still happens on the board.
      await page.getByRole("link", { name: /open on the board/i }).first().click();
      await expect(tab(page, "Board")).toHaveAttribute("aria-selected", "true");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The dossier header carries the card's short id; the title lives in an editable INPUT, whose value
      // `toContainText` cannot see — so assert the two separately rather than against the dialog's text.
      await expect(dialog).toContainText(`Task · ${card.id.slice(0, 8)}`);
      await expect(dialog.locator("input").first()).toHaveValue(mineTitle);
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/tasks/${card.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 5. A tab switch must never destroy unfinished input ───────────────────────────────────────────
  // The owner's standing rule: a user's unsaved input is never destroyed. Rendering only the active tab
  // would unmount the other four, silently discarding the local React state inside them — and a tab
  // click is not consent to discard a half-written prompt. All five panels therefore stay MOUNTED and
  // the inactive ones are `hidden`.
  //
  // Three DIFFERENT state shapes, because one would not generalise: an AgentPromptEditor draft (useState
  // inside a disclosure that is itself local state), a typed-but-unsaved cron expression on another tab,
  // and a live session tile's composer draft. Nothing here is ever SAVED — the assertion is that the
  // unsaved text survives, so saving it would measure the wrong thing (and write to a real agent).
  test("switch ON: a tab switch preserves unsaved drafts on every panel", async ({ page, loomDaemon }) => {
    const home = await readSetupHome(loomDaemon);
    // A live operator session so the Home tab mounts a real session tile with its composer. Seeded as a
    // DB row (never startSession — the fixture's no-spawn guard), so the terminal attach is a no-op and
    // the assertion below is on the card's composer, not a pty stream. Auto-archived after this test by
    // the fixture's own `autoIsolation`, so setup.spec.ts's "no live session" claim stays true.
    expect(home.resolvedLead.agentId, "the reserved home resolved no operator agent").toBeTruthy();
    await loomDaemon.seedLiveSession({
      project: home.project, agentId: home.resolvedLead.agentId!, agentName: "Platform",
      role: "platform", id: "e2eplatdraft",
    });

    const promptDraft = "DRAFT-prompt-do-not-lose-me";
    const cronDraft = "7 7 * * *";
    const composerDraft = "DRAFT-composer-do-not-lose-me";

    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/platform`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    // ── HOME: open the operator's startup-prompt editor and type into it, without saving. ──
    const disclosure = page.getByRole("button", { name: /startup prompt/i }).first();
    await disclosure.click();
    const promptBox = page.getByPlaceholder("The kickoff prompt this agent boots with…");
    await expect(promptBox).toBeVisible();
    await promptBox.fill(promptDraft);

    // ── HOME: the live tile's composer, the same page but a different component's own draft store. ──
    const composerBox = page.getByPlaceholder("Send a turn to this session", { exact: false });
    await expect(composerBox).toBeVisible();
    await composerBox.fill(composerDraft);

    // ── CADENCE: a typed cron on a DIFFERENT panel, so the test covers losing the panel you left AND
    //    the panel you are standing on. ──
    await openTab(page, "Cadence");
    const cronBox = page.getByPlaceholder("0 9 * * *");
    await expect(cronBox).toBeVisible();
    await cronBox.fill(cronDraft);

    // ── Leave via a THIRD tab, so neither draft is merely surviving an A↔B flip. ──
    await openTab(page, "Board");
    await openTab(page, "Home");

    // The prompt draft survived — AND so did the disclosure being open, which is its own piece of local
    // state and the thing that would have had to be re-opened to even see the text.
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByPlaceholder("The kickoff prompt this agent boots with…")).toHaveValue(promptDraft);
    await expect(page.getByPlaceholder("Send a turn to this session", { exact: false })).toHaveValue(composerDraft);

    await openTab(page, "Cadence");
    await expect(page.getByPlaceholder("0 9 * * *")).toHaveValue(cronDraft);

    // The inactive panels are HIDDEN, not merely off-screen: `hidden` is what keeps them out of the
    // accessibility tree and the tab order, so a keyboard user never lands on a control they cannot see.
    // Asserted on the live DOM rather than inferred from the attribute being in the source.
    await expect(page.getByTestId("platform-panel-cadence")).toBeVisible();
    for (const other of ["home", "history", "board", "findings"]) {
      await expect(page.getByTestId(`platform-panel-${other}`)).toBeHidden();
    }
  });

  // ── 6. Switch OFF: the classic Platform page is untouched ─────────────────────────────────────────
  test("switch OFF: the classic Platform page keeps its single-column stack and grows no tabs", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/platform`);

    // The classic shell, provably — otherwise this test could pass while measuring the frame it exists
    // to prove was left alone.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(0);

    // Its own heading — the word "Platform", then the resolved home's name badge, then the edition's
    // muted span, all in one label. The Atlas layout deliberately drops that leading word (the node head
    // already owns the page's one <h1>), so a label leading with "Platform" twice is classic-only. The
    // first test asserts the complement under Atlas. `.first()` because the wrapper around this label
    // and its paragraph matches the same leading text.
    const classicHeading = /^Platform\s*Platform\s*your cross-project workspace agent/;
    await expect(content(page).getByText(classicHeading).first()).toBeVisible();

    // The distinguishing property of the single-column stack: sections that Atlas puts on SEPARATE tabs
    // are all on screen AT ONCE here. Checking them together is what makes this a stack assertion rather
    // than five independent "a section exists" ones.
    //
    // Scoped to `content()` for the same reason the Atlas legs are scoped, in the other shell: the
    // classic `Sidebar` rail draws the SAME `NAV_PAGES` labels as exact text, so an unscoped presence
    // check here is one label rename away from the strict-mode violation that broke this spec.
    await expect(content(page).getByText("Assistants", { exact: true })).toBeVisible();
    await expect(content(page).getByText("Operator session", { exact: true })).toBeVisible();
    await expect(content(page).getByText("Auditor session", { exact: true })).toBeVisible();
    await expect(content(page).getByText(/your setup checklist \+ Auditor suggestions/i)).toBeVisible();
    // The end-user cadence form still rides in the auditor card — the classic placement, which the Atlas
    // layout moves to its own tab. Visible here means that move did not leak back into this page. (There
    // is deliberately no "Auditor schedule" SECTION on this edition: that heading belongs to the dev
    // list variant, and in Atlas to the Cadence tab that now hosts both.)
    await expect(content(page).getByText(/^Run automatically$/)).toBeVisible();

    // And the REAL end-user edition leaves the operator spawnable — the contrast case for the first
    // test's `previewOnly` disabled reading. Asserted, never clicked (the fixture forbids a real spawn).
    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeEnabled();
    await expect(page.getByText(/Preview only on a dev install/i)).toHaveCount(0);
    // No dev-only surface on this LOOM_DEV=0 boot, under either shell.
    await expect(page.getByRole("group", { name: "Preview edition" })).toHaveCount(0);
  });

  // ── 7. The SAME trust boundary, under the CLASSIC layout ──────────────────────────────────────────
  // `previewOnly` is handed to the shared agents section once PER LAYOUT, so the thread is only as
  // strong as its weakest mount: regressing the CLASSIC mount to `previewOnly={false}` would re-enable
  // "Start Platform" in a dev install's End-user preview — minting a stray role:"platform" session on a
  // Getting-Started agent that §1c says is never upgraded to the Lead — while every Atlas-side assertion
  // in this file stayed green, because they only ever walk the OTHER layout.
  //
  // This mirrors the Atlas-side reading in test 1 exactly, with the switch OFF. platform-edition.mjs
  // pins the same property structurally (mount count == previewOnly hop count); this is its behavioural
  // twin, and the pair is what makes a one-sided regression impossible to land quietly.
  test("switch OFF: the classic dev End-user preview also holds the operator's go-live", async ({ page, loomDaemon }) => {
    await serveDevPlatformHome(page, loomDaemon);
    await page.goto(`${loomDaemon.baseURL}/platform`);

    // The classic shell, provably — this test is worthless if it is reading the Atlas layout.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(0);

    // Developer view first: the dev operator IS spawnable, so the disabled reading below is a change of
    // state and not simply how this page always renders.
    await expect(page.getByRole("button", { name: /^spawn lead$/i })).toBeEnabled();

    await viewAs(page, "End-user").click();
    await expect(viewAs(page, "End-user")).toHaveAttribute("aria-pressed", "true");

    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeDisabled();
    await expect(page.getByText(/Preview only on a dev install/i).first()).toBeVisible();
  });

  // ── 8. card b472645a — the preview sends NO request, from ANY control, under BOTH shells ───────────
  //
  // Tests 1 and 7 read the operator spawn's DISABLED attribute. That is necessary and not sufficient:
  // seven further controls were measured FIRING real requests in this exact preview — the auditor spawn,
  // both prompt editors (via the button AND the textarea's own Ctrl/Cmd+Enter), the cadence create, and
  // the Stop buttons. A disabled-attribute assertion cannot see any of them, so these tests assert the
  // ONE property that covers every control at once: with every mutating request intercepted and aborted,
  // the recorded count must be ZERO after clicking each one.
  //
  // ⚠️ The aborting route is what makes this safe to run on the fixture at all — the no-spawn guard
  // forbids a real claude spawn, so a control that DOES fire must never reach the daemon. It also means
  // a FAILURE here is observed as a recorded request, never as a side effect.
  for (const atlas of [true, false]) {
    const shell = atlas ? "switch ON" : "switch OFF";

    test(`${shell}: no control in the dev End-user preview sends a request`, async ({ page, loomDaemon }) => {
      const home = await serveDevPlatformHome(page, loomDaemon);
      if (atlas) await seedAtlasOn(page);
      await seedViewAsEndUser(page);
      const sent = await blockMutations(page);
      await page.goto(`${loomDaemon.baseURL}/platform`);

      // Provably the right shell AND the right view — every zero below is worthless if this page is the
      // real end-user edition (no previewOnly) or the Developer view (different controls entirely).
      await expect(page.getByTestId("atlas-shell")).toHaveCount(atlas ? 1 : 0);
      await expect(viewAs(page, "End-user")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(/your cross-project workspace agent/i).first()).toBeVisible();

      // (a) Both go-live cards. The operator's disabled state is tests 1/7's reading; the AUDITOR's is
      // new — `endUserEdition.auditorCreateOnly` makes its edition gate ignore `live` entirely, so
      // before this card it was enabled unconditionally and really spawned.
      await expect(page.getByRole("button", { name: /^start platform$/i })).toBeDisabled();
      await expect(page.getByRole("button", { name: /review my workspace/i })).toBeDisabled();

      // (b) Both prompt editors — the Save button AND the textarea's own Ctrl/Cmd+Enter save path. The
      // field is read-only, so `fill` cannot even make a draft: both legs assert that too, because a
      // typed-but-unsavable draft would still be a draft the user could lose.
      const expanders = page.getByRole("button", { name: /startup prompt/i });
      await expect(expanders).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        await expanders.nth(i).click();
        const ta = page.locator("textarea").first();
        await expect(ta).toBeVisible();
        const before = await ta.inputValue();
        await ta.pressSequentially("mutation-probe");
        expect(await ta.inputValue(), "a read-only prompt field must not accept typing").toBe(before);
        await expect(page.getByRole("button", { name: /^save prompt$/i })).toBeDisabled();
        await ta.press("Control+Enter");
        await expanders.nth(i).click();
      }

      // (c) The cadence form, NO-SCHEDULE state — the only control that renders is "Schedule". Phase B
      // below seeds a real schedule so the other four (Save / Enable / Disable / Remove) are exercised
      // too, rather than left to the structural pin alone.
      if (atlas) await openTab(page, "Cadence");
      await expect(page.getByText(/^Run automatically$/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^schedule$/i })).toBeDisabled();
      if (atlas) await openTab(page, "Home");

      // Clicking a disabled button records nothing by construction, so the assertion so far rests on the
      // disabled attributes. `force` dispatches the click anyway — past the disabled attribute, straight
      // at the handler — so a control that is merely STYLED disabled, or whose handler is still wired,
      // is caught here rather than passing on appearance.
      for (const name of [/^start platform$/i, /review my workspace/i, /^schedule$/i]) {
        const b = page.getByRole("button", { name });
        if (await b.count()) await b.first().click({ force: true }).catch(() => { /* a held control may refuse */ });
      }

      expect(sent, "the dev End-user preview must send NO mutating request").toEqual([]);

      // ── PHASE B — the controls that need pre-existing STATE to render at all ──
      // Run History's RESUME (the round-2 Code Review's Critical: it un-archives AND respawns the
      // previewed home's own session) needs an EXITED run; the cadence form's Save / Enable / Remove
      // need an existing schedule. Neither is live, so neither disturbs the spawn readings above.
      const operator = home.agents.find((a) => a.name === "Platform")!;
      const auditor = home.agents.find((a) => a.name === "Workspace Auditor")!;
      const tag = `b472645a-${atlas ? "atlas" : "classic"}-${Date.now()}`;
      // `enabled: false` deliberately — the fixture boots LOOM_SCHEDULER_ENABLED=0 so nothing can fire,
      // and a disabled row keeps that true even if that ever changes.
      const schedule = await seedWorkspaceAuditorSchedule(loomDaemon, auditor.id, `cad-${tag}`);
      try {
        await loomDaemon.seedLiveSession({ project: home.project, agentId: operator.id, role: "platform",
          id: `exited-op-${tag}`, processState: "exited" });
        await loomDaemon.seedLiveSession({ project: home.project, agentId: auditor.id, role: "workspace-auditor",
          id: `exited-aud-${tag}`, processState: "exited" });
        await page.reload();
        await expect(viewAs(page, "End-user")).toHaveAttribute("aria-pressed", "true");

        // Resume, in BOTH history sections. The end-user edition renders history EXPANDED, so these need
        // no disclosure click — which is exactly why the gap mattered.
        if (atlas) await openTab(page, "History");
        const resumes = page.getByRole("button", { name: /^resume$/i });
        // A FLOOR, not an exact count: the two rows seeded above are the minimum, and the daemon is
        // shared across this file's tests, so an earlier test's exited row legitimately adds more.
        // Pinning an exact number here would make this assertion depend on declaration order.
        await expect.poll(() => resumes.count(), { message: "both seeded exited runs should offer Resume" })
          .toBeGreaterThanOrEqual(2);
        for (let i = 0; i < await resumes.count(); i++) {
          await expect(resumes.nth(i)).toBeDisabled();
          await resumes.nth(i).click({ force: true }).catch(() => { /* held */ });
        }
        expect(sent, "Resume must not respawn the previewed home's session").toEqual([]);

        // The cadence form's other three controls, now that a schedule exists.
        if (atlas) await openTab(page, "Cadence");
        // ⚠️ Save is dirty-gated as well as held, so `toBeDisabled` on it ALONE would pass even with no
        // gate at all (nothing has edited the cron). The load-bearing assertion is that the FIELD is
        // read-only, which is also what makes Save unreachable — read it the same way the prompt editor's
        // leg does, by typing and reading the value back.
        const cron = page.getByPlaceholder("0 9 * * *").first();
        await expect(cron).toBeVisible();
        const cronBefore = await cron.inputValue();
        await cron.pressSequentially("5");
        expect(await cron.inputValue(), "a read-only cron field must not accept typing").toBe(cronBefore);
        await expect(page.getByRole("button", { name: /^save$/i })).toBeDisabled();
        // These two are NOT dirty-gated, so their disabled reading is load-bearing on its own.
        await expect(page.getByRole("button", { name: /^enable$|^disable$/i })).toBeDisabled();
        await expect(page.getByRole("button", { name: /^remove$/i })).toBeDisabled();
        for (const name of [/^save$/i, /^enable$|^disable$/i, /^remove$/i]) {
          await page.getByRole("button", { name }).first().click({ force: true }).catch(() => { /* held */ });
        }
        expect(sent, "no cadence control in the preview may reach the daemon").toEqual([]);
        if (atlas) await openTab(page, "Home");

        // ── PHASE C — Stop needs a LIVE session. Seeded LAST, because a live operator session flips the
        // spawn button's own label to "Live" and disables it via the edition's singleton gate, which
        // would have masked every spawn reading above (measured; it cost a full red run).
        await loomDaemon.seedLiveSession({ project: home.project, agentId: operator.id, role: "platform",
          id: `live-op-${tag}` });
        await page.reload();
        await expect(viewAs(page, "End-user")).toHaveAttribute("aria-pressed", "true");

        const stops = page.getByRole("button", { name: /^stop$/i });
        // The agent card's Stop. The session TILE's own lifecycle button is GONE in a preview
        // (`lifecycle="none"`), which is why this is a count of 1 and not 2 — that absence is the gate.
        await expect(stops).toHaveCount(1);
        await expect(stops.first()).toBeDisabled();
        await stops.first().click({ force: true }).catch(() => { /* held */ });

        expect(sent, "no Stop in the preview may reach the daemon either").toEqual([]);
      } finally {
        // Schedules are a DAEMON-GLOBAL store shared with every other spec on this worker's daemon — a
        // leftover row would surface on the Schedules page in an unrelated spec.
        await deleteSchedule(loomDaemon, schedule.id);
      }
    });
  }

  // ── 9. THE CONTRAST CASE for test 8 — the same controls on a REAL end-user install DO fire ────────
  //
  // Without this, test 8 is satisfied by a gate that disabled the shipping UI too: "zero requests" is
  // also what a broken page produces. Same aborting counter, same clicks, opposite expectation — so the
  // pair proves the gate discriminates on `previewOnly` rather than on the control being dead.
  // ⚠️ Run under BOTH shells. The gate is threaded once PER LAYOUT, so an over-gate is per-layout too:
  // a mount that passed `previewOnly` unconditionally would disable the SHIPPING end-user surface on
  // that one layout, and a classic-only contrast test would never see it. The preview legs above already
  // run per shell; this is their missing twin on the other side of the contrast.
  for (const atlas of [false, true]) {
  const shellLabel = atlas ? "switch ON" : "switch OFF";
  test(`${shellLabel}: the same controls on a REAL end-user install DO send their requests`, async ({ page, loomDaemon }) => {
    const home = await readSetupHome(loomDaemon);
    const operator = home.agents.find((a) => a.name === "Platform")!;
    const auditor = home.agents.find((a) => a.name === "Workspace Auditor")!;
    const tag = `contrast-${Date.now()}`;
    // The same pre-existing state Phase B of test 8 seeds, so the two tests exercise the SAME control
    // set and the comparison is like-for-like rather than "the preview had more controls".
    const schedule = await seedWorkspaceAuditorSchedule(loomDaemon, auditor.id, `cad-${tag}`);
    try {
      await loomDaemon.seedLiveSession({ project: home.project, agentId: operator.id, role: "platform",
        id: `exited-op-${tag}`, processState: "exited" });
      await loomDaemon.seedLiveSession({ project: home.project, agentId: auditor.id, role: "workspace-auditor",
        id: `live-aud-${tag}` });

      if (atlas) await seedAtlasOn(page);
      const sent = await blockMutations(page);
      await page.goto(`${loomDaemon.baseURL}/platform`);
      // No mock ⇒ the shipping edition, with no preview toggle at all. The shell is asserted too: this
      // test's whole value is that it reads the OTHER layout from the one a classic-only run would.
      await expect(page.getByTestId("atlas-shell")).toHaveCount(atlas ? 1 : 0);
      await expect(page.getByRole("group", { name: "Preview edition" })).toHaveCount(0);
      await expect(page.getByText(/your cross-project workspace agent/i).first()).toBeVisible();

      await page.getByRole("button", { name: /^start platform$/i }).click();
      await page.getByRole("button", { name: /review my workspace/i }).click();

      const expander = page.getByRole("button", { name: /startup prompt/i }).first();
      await expander.click();
      const ta = page.locator("textarea").first();
      await ta.fill("contrast-case-edit");
      await page.getByRole("button", { name: /^save prompt$/i }).first().click();
      // The Ctrl/Cmd+Enter save path too. The preview leg asserts this SECOND trigger silent; without
      // the same keystroke here, "silent" would also be satisfied by a shortcut that never worked.
      await ta.fill("contrast-case-edit-via-shortcut");
      await ta.press("Control+Enter");

      if (atlas) await openTab(page, "Cadence");
      await expect(page.getByText(/^Run automatically$/)).toBeVisible();
      // Save is dirty-gated, so the cron must actually change first — and that the field ACCEPTS this
      // edit is itself the contrast to the preview leg, where the same `fill` cannot change it.
      const cron = page.getByPlaceholder("0 9 * * *").first();
      await cron.fill("0 10 * * *");
      expect(await cron.inputValue(), "the shipping cron field must be editable").toBe("0 10 * * *");
      await page.getByRole("button", { name: /^save$/i }).first().click();
      await page.getByRole("button", { name: /^enable$|^disable$/i }).first().click();
      // Remove LAST of the three, because it is what un-renders them and brings "Schedule" back — which
      // is the ONLY way this leg can reach the create path at all. ⚠️ Without that, seeding a schedule
      // up front means `POST /api/schedules` never renders on the shipping side, and the preview leg's
      // "Schedule is disabled" would have no contrast: an over-gate of the real edition's create button
      // would pass both tests.
      await page.getByRole("button", { name: /^remove$/i }).first().click();
      // The aborted DELETE leaves the row in place, so drive the create path from a fresh page instead
      // of depending on the removal having landed.
      await deleteSchedule(loomDaemon, schedule.id);
      await page.reload();
      if (atlas) await openTab(page, "Cadence");
      const createBtn = page.getByRole("button", { name: /^schedule$/i });
      await expect(createBtn).toBeVisible();
      await expect(createBtn).toBeEnabled();
      await createBtn.click();

      if (atlas) await openTab(page, "History");
      await page.getByRole("button", { name: /^resume$/i }).first().click();
      if (atlas) await openTab(page, "Home");
      await page.getByRole("button", { name: /^stop$/i }).first().click();

      // Each write path test 8 asserts SILENT must appear here — as PATHS, not just a count, so a page
      // that fired one request six times would not satisfy it. This is what keeps test 8 from being
      // satisfied by a gate that disabled the shipping UI too.
      const has = (re: RegExp) => sent.some((r) => re.test(r));
      await expect.poll(() => sent.length, { message: "the shipping controls should have fired" }).toBeGreaterThanOrEqual(8);
      expect(sent.filter((r) => /^POST \/api\/agents\/[^/]+\/sessions$/.test(r)).length,
        `both spawns should have fired — got ${sent}`).toBeGreaterThanOrEqual(2);
      // TWO prompt saves: the button AND the Ctrl/Cmd+Enter shortcut, matching the preview leg's pair.
      expect(sent.filter((r) => /^POST \/api\/agents\/[^/]+$/.test(r)).length,
        `prompt save via BOTH the button and Ctrl+Enter expected — got ${sent}`).toBeGreaterThanOrEqual(2);
      expect(has(/^POST \/api\/schedules$/), `cadence CREATE missing from ${sent}`).toBe(true);
      expect(has(/^POST \/api\/schedules\/[^/]+$/), `cadence save/toggle missing from ${sent}`).toBe(true);
      expect(has(/^DELETE \/api\/schedules\/[^/]+$/), `cadence remove missing from ${sent}`).toBe(true);
      expect(has(/^POST \/api\/sessions\/[^/]+\/resume$/), `run-history Resume missing from ${sent}`).toBe(true);
      expect(has(/^POST \/api\/sessions\/[^/]+\/stop$/), `Stop missing from ${sent}`).toBe(true);
    } finally {
      await deleteSchedule(loomDaemon, schedule.id);
    }
  });
  }
});

// ── Direct REST helpers. The fixture patches Node's global fetch to attach the loopback token to every
// non-GET write (card 783dca99), so a POST/DELETE here needs no header of its own; a GET still does. ──

async function seedSuggestion(d: LoomDaemon, label: string, prompt: string): Promise<{ id: string }> {
  const res = await fetch(`${d.baseURL}/api/preset-prompt-suggestions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, prompt, rationale: "seeded by atlas-platform.spec.ts" }),
  });
  if (!res.ok) throw new Error(`POST /api/preset-prompt-suggestions -> ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { id?: string; deduped?: boolean };
  // The route DEDUPES by label against presets and any-status suggestions, answering 200 {deduped:true}
  // with no row. A unique label makes that impossible — but failing loudly beats handing the test a
  // suggestion id of `undefined` and a mystery red further down.
  if (!body.id) throw new Error(`preset suggestion was deduped rather than created: ${JSON.stringify(body)}`);
  return { id: body.id };
}

/**
 * A real `kind:"workspace-auditor"` schedule on the reserved home's auditor, so the cadence form renders
 * its Save / Enable-Disable / Remove controls (they exist only once a schedule does — which is why a
 * button-by-button gate would have missed them on a home with none).
 *
 * `enabled: false` deliberately: the fixture boots LOOM_SCHEDULER_ENABLED=0 so nothing can fire anyway,
 * and a disabled row keeps that true independently of that env default.
 */
async function seedWorkspaceAuditorSchedule(d: LoomDaemon, agentId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${d.baseURL}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, agentId, cron: "0 9 * * *", enabled: false, kind: "workspace-auditor" }),
  });
  if (!res.ok) throw new Error(`POST /api/schedules -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** Cleanup for the above. 404 is the state this wants (the test's own Remove click may have landed). */
async function deleteSchedule(d: LoomDaemon, id: string) {
  await fetch(`${d.baseURL}/api/schedules/${id}`, { method: "DELETE" }).catch(() => {});
}

async function dismissSuggestion(d: LoomDaemon, id: string) {
  // 404 (never created) and 409 (already adopted/dismissed by the test itself) are both the state this
  // cleanup wants, so neither is an error here.
  await fetch(`${d.baseURL}/api/preset-prompt-suggestions/${id}/dismiss`, { method: "POST" }).catch(() => {});
}

async function presetLabels(d: LoomDaemon): Promise<string[]> {
  const res = await fetch(`${d.baseURL}/api/preset-prompts`, { headers: { authorization: `Bearer ${d.loopbackSecret}` } });
  if (!res.ok) throw new Error(`GET /api/preset-prompts -> ${res.status}`);
  return ((await res.json()) as { label: string }[]).map((p) => p.label);
}

async function deletePresetsLabelled(d: LoomDaemon, labels: string[]) {
  const res = await fetch(`${d.baseURL}/api/preset-prompts`, { headers: { authorization: `Bearer ${d.loopbackSecret}` } });
  if (!res.ok) return;
  const presets = (await res.json()) as { id: string; label: string }[];
  for (const p of presets.filter((x) => labels.includes(x.label))) {
    await fetch(`${d.baseURL}/api/preset-prompts/${p.id}`, { method: "DELETE" }).catch(() => {});
  }
}
