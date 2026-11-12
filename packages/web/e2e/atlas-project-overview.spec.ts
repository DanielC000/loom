// The Atlas project node's reworked Overview — card 269f46ef, the owner's "C · Roster" pick.
//
// @decision 269f46ef — this file is the POSITIVE coverage for what was built; do not add the
// removals (no deck, band, disclosure, board embed or Agents panel) here. Each is asserted by the
// spec its surface belonged to, beside the claim it replaced, where a reader will look for it.
//
// What each leg measures, and why it can fail:
//   1. THE ROSTER READS REAL SEEDED STATE. Every one of the seven cells, against a value this spec
//      chose — the manager/worker nesting, the card a worker holds (by TITLE, which only a lookup
//      through the board roll-up can produce), its branch, its context percentage derived from the
//      seeded token count against that model's own window, and its last orchestration event. Two of
//      those seven were nowhere on this page before this card.
//   2. IT STACKS AT 900 WITHOUT LOSING A CELL. The header row goes, every cell gains its own
//      label, and all seven are still present with the same content — the failure the fixed-height
//      band had, and the reason a table was picked over another card grid. Asserted as a
//      before/after over the SAME row, so a layout that simply never had the cells cannot pass.
//   3. EVERY BRIEFING POP-OVER OPENS AND CLOSES, on both sides of each action, plus single-open and
//      the Escape path. This is the claim that moved here from atlas-home.spec.ts's deck loop.
//   4. THE TONE ORDER. A seeded 96% context reads RED — on the briefing figure AND on the roster
//      row's own track fill, which are two renderings of one expression. Ordered amber-first the
//      red branch is unreachable (every value at 95 is also at 80), so this is the regression that
//      made the one state these readings exist to surface undrawable. Moved here, with its subject,
//      from atlas-kpi-deck.spec.ts.
//   5. THE LANDED CELL IS A READOUT, NOT A BUTTON — its sparkline IS the breakdown, so a fifth
//      pop-over would open the same 14 bars already drawn beside the figure.
//   6. THE SESSIONS CARD (card 0bcfa530) lists THIS project's running sessions and nothing else —
//      measured against another project's live, pty-bearing, spawnable-rig session that is listable
//      in every way but its project, and against an exited session that the ROSTER does list. ONE
//      preference moves both lists in one step, and the card grows no toggle of its own.
//   7. EXPANDING ATTACHES, COLLAPSING DOES NOT STOP. Measured on the mounted pane's REPLAYED BYTES
//      (each session carries its own sentinel), and on the daemon's own `processState` across a
//      collapse — sessions outlive viewers, so releasing the view must not touch the pty.
//   8. THE ROSTER LISTS EVERY RUNNING SESSION, not only managers and workers (card 6a9cb96a, an
//      owner bug report). A live `assistant` — the role an ideation/thought-partner rig and the
//      Companion share — and a role-less plain terminal each get a row with their own role label,
//      an EXITED one does not, and the card's HEAD count is asserted in the same breath as the row
//      count: the defect was the head counting a population its own list could not draw.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

// lib/activeProject.tsx owns the project key. Hardcoded rather than imported: the e2e tsconfig
// covers `e2e/` only (tsconfig.e2e.json).
const PROJECT_KEY = "loom.projectId";

const WIDE = { width: 1440, height: 1000 };
const NARROW = { width: 900, height: 1000 };

// `claude-sonnet-4-5`'s own window, which `contextWindowForModel` resolves — so every expected %
// below is derivable from the seeded token count rather than a magic number.
const CTX_WINDOW = 1_000_000;
const WARM_PCT = 42;
const RED_PCT = 96;
// The red tones are read from the live --loom-danger(-text) tokens at run time (`cssColor`), never typed as literals.

// The four readings that carry a breakdown. `merged` is deliberately NOT here — leg 5 is the
// assertion that it is a plain readout, and listing it would make that leg contradict this list.
const BRIEF_POPOVERS = ["cards", "fleet", "context", "gates"];

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * A project whose fleet is a MANAGER plus two of its workers, each seeded with a different value in
 * every cell the roster draws — so no cell can be satisfied by another row's content, and the
 * manager/worker nesting has something to be wrong about.
 *
 * ⚠️ `open` counts THREE cards, not the two seeded by name below: `seedLiveSession({ task })` puts
 * its own card on the board too, in `in_progress`. It is still a real derivation rather than a row
 * count — the board holds FOUR cards and one of them is terminal, so a readout that merely counted
 * rows would read 4.
 */
async function seedFleet(loomDaemon: LoomDaemon, workerCtxPct: number) {
  const project = await loomDaemon.createProject(uniq("atlasov"));
  const inboxCard = uniq("ov-sentinel-INBOX");
  await loomDaemon.createTask(project.id, { title: inboxCard, columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: uniq("ov-sentinel-REVIEW"), columnKey: "review" });
  await loomDaemon.createTask(project.id, { title: uniq("ov-sentinel-DONE"), columnKey: "done" });

  const short = `${Math.floor(Math.random() * 1e6)}`;
  const mgr = await loomDaemon.seedLiveSession({
    project, id: `e2e-ovmgr-${short}`, agentName: `OvConductor-${short}`, role: "manager", busy: true,
    model: "claude-sonnet-4-5", ctxInputTokens: (WARM_PCT / 100) * CTX_WINDOW,
  });
  const worker = await loomDaemon.seedLiveSession({
    project, id: `e2e-ovwkr-${short}`, agentName: `OvHauler-${short}`, role: "worker",
    parentSessionId: mgr.sessionId, branch: `loom/ovbranch${short}`,
    task: { title: uniq("ov-held-card"), columnKey: "in_progress" },
    model: "claude-sonnet-4-5", ctxInputTokens: (workerCtxPct / 100) * CTX_WINDOW,
  });
  // The worker's own last event, and a LATER one the manager filed about nothing — so the two rows
  // must resolve different events and a map keyed on one id alone cannot satisfy both.
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "merge_request", workerSessionId: worker.sessionId,
  });
  await loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind: "idle_report" });
  return {
    project, inboxCard, open: 3, inReview: 1,
    mgr, worker, workerCard: worker.taskTitle!, workerBranch: `loom/ovbranch${short}`,
  };
}

// ── The scope filter's fixture (card effd47d5) ────────────────────────────────────────────────
//
// `seedFleet` above mints its agents through `seedLiveSession`, which binds them to NO rig — and an
// agent with no rig has a null role, which `splitRoster` reads as SPAWNABLE. So the scope filter
// needs a fleet whose agents carry real rigs, and that is the only reason this second fixture
// exists: `seedFleet` stays byte-identical, and the four legs above keep the fixture they were
// written against.
//
// REST seeding through the same human/loopback endpoints the UI drives, inline rather than added to
// fixtures/daemon.ts — the pattern atlas-agents.spec.ts and profiles-agents.spec.ts already set.
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The pinned grid for the rigged fleet's ptys — small, so a replayed sentinel lands on row 0. */
const GEOMETRY = { cols: 60, rows: 8 };

/**
 * A project whose fleet is ONE manager on a manager rig and ONE worker on a worker rig.
 *
 * That asymmetry is the whole fixture: `splitRoster` calls the manager's agent spawnable and the
 * worker's agent dispatched, so the two scopes have genuinely different populations — 2 rows and 1 —
 * and a filter that kept or dropped everything could satisfy neither.
 *
 * Card 0bcfa530 added three things to it, every one of them ADDITIVE — the two pre-existing scope
 * legs read none of them and their assertions are untouched:
 *   · a distinct `ptyBytes` SENTINEL per session, so "expanding attached THAT session's terminal" is
 *     a measurable byte change rather than a region appearing;
 *   · a SECOND project with its own live, rigged, pty-bearing session — the cross-project negative:
 *     a card that ignored the project scope would list it, and it is otherwise listable in every way;
 *   · the two rig agent ids, so a leg can seed one more session onto this fleet's own rigs.
 *
 * ⛔ An EXITED row is deliberately NOT seeded here, even though the Sessions card needs one as a
 * negative: it would add a ROSTER row, and the two legs above pin the roster's own population and
 * its segment counts exactly. The leg that needs it seeds it itself, onto `mgrAgentId`.
 */
async function seedRiggedFleet(loomDaemon: LoomDaemon) {
  const base = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("atlasovscope"));
  const mgrRig = await apiJson<{ id: string }>(`${base}/api/profiles`,
    { method: "POST", body: JSON.stringify({ name: uniq("Scope Mgr Rig"), role: "manager" }) });
  const wkrRig = await apiJson<{ id: string }>(`${base}/api/profiles`,
    { method: "POST", body: JSON.stringify({ name: uniq("Scope Wkr Rig"), role: "worker" }) });
  // Names share no stem with each other: the assertions below read row text as well as ids.
  const mgrName = uniq("ScopeConductor");
  const wkrName = uniq("ScopeHauler");
  const mgrAgent = await apiJson<{ id: string }>(`${base}/api/projects/${project.id}/agents`,
    { method: "POST", body: JSON.stringify({ name: mgrName, startupPrompt: "" }) });
  const wkrAgent = await apiJson<{ id: string }>(`${base}/api/projects/${project.id}/agents`,
    { method: "POST", body: JSON.stringify({ name: wkrName, startupPrompt: "" }) });
  await apiJson(`${base}/api/agents/${mgrAgent.id}`, { method: "POST", body: JSON.stringify({ profileId: mgrRig.id }) });
  await apiJson(`${base}/api/agents/${wkrAgent.id}`, { method: "POST", body: JSON.stringify({ profileId: wkrRig.id }) });

  const short = `${Math.floor(Math.random() * 1e6)}`;
  // `agentName` is passed to MATCH the agent actually created above: the fixture echoes back whatever
  // it was handed, while the row on screen renders the DB's own join — so a mismatch here would make
  // every text assertion below read a name the page never draws.
  const mgr = await loomDaemon.seedLiveSession({
    project, id: `e2e-ovsc-mgr-${short}`, agentId: mgrAgent.id, agentName: mgrName, role: "manager",
    ptyGeometry: GEOMETRY, ptyBytes: `OVSCOPE-MANAGER-PTY-${short}\r\n`,
  });
  const worker = await loomDaemon.seedLiveSession({
    project, id: `e2e-ovsc-wkr-${short}`, agentId: wkrAgent.id, agentName: wkrName, role: "worker",
    parentSessionId: mgr.sessionId, branch: `loom/ovscope${short}`,
    ptyGeometry: GEOMETRY, ptyBytes: `OVSCOPE-WORKER-PTY-${short}\r\n`,
  });
  // ANOTHER project's live session, on its OWN spawnable rig so it survives either scope — the only
  // thing keeping it off this project's card is the project scope itself.
  const otherProject = await loomDaemon.createProject(uniq("atlasovother"));
  const otherAgent = await apiJson<{ id: string }>(`${base}/api/projects/${otherProject.id}/agents`,
    { method: "POST", body: JSON.stringify({ name: uniq("OtherConductor"), startupPrompt: "" }) });
  await apiJson(`${base}/api/agents/${otherAgent.id}`, { method: "POST", body: JSON.stringify({ profileId: mgrRig.id }) });
  const other = await loomDaemon.seedLiveSession({
    project: otherProject, id: `e2e-ovsc-other-${short}`, agentId: otherAgent.id, role: "manager",
    ptyGeometry: GEOMETRY, ptyBytes: `OVSCOPE-OTHERPROJECT-PTY-${short}\r\n`,
  });
  return {
    project, mgr, worker, mgrName, wkrName, otherProject, other, short,
    mgrAgentId: mgrAgent.id, wkrAgentId: wkrAgent.id,
    mgrSentinel: `OVSCOPE-MANAGER-PTY-${short}`,
    wkrSentinel: `OVSCOPE-WORKER-PTY-${short}`,
    otherSentinel: `OVSCOPE-OTHERPROJECT-PTY-${short}`,
  };
}

/** The scope toggle's two segments, scoped through the control's own testid. */
const scopeSegment = (page: Page, which: "all" | "spawnable") =>
  page.getByTestId("atlas-roster-scope")
    .getByRole("radio", { name: which === "all" ? /^All/ : /^You spawn/ });

/** One roster row, by the session it draws — never by text, which a sibling spec's row can match. */
const row = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="atlas-roster-row"][data-session-id="${sessionId}"]`);

// ── The Sessions card's locators (card 0bcfa530) ──────────────────────────────────────────────
// All scoped THROUGH the card's own testid: the e2e daemon is shared, and the Workspace node renders
// the same component with its own `atlas-session*` testids — a bare row locator would reach neither
// safely. `atlas-psession*` is this node's set (pages/ProjectHome.tsx `PROJECT_SESSION_IDS`).
const sessCard = (page: Page) => page.getByTestId("atlas-overview-sessions");
const sessRows = (page: Page) => sessCard(page).locator("[data-atlas-wsession]");
const sessTerm = (page: Page) => sessCard(page).getByTestId("atlas-psessions-terminal");
/** The mounted pane's real rendered buffer, via xterm's own always-in-sync accessibility tree —
 *  the same legitimate xterm feature atlas-workspace-sessions.spec.ts reads from. Nothing is
 *  monkeypatched, and a <canvas> is not readable any other way. */
const sessPaneText = (page: Page) => sessTerm(page).locator(".xterm-accessibility-tree > div");
const sessRow = (page: Page, id: string) => page.getByTestId(`atlas-psession-row-${id}`);
const sessExpand = (page: Page, id: string) => page.getByTestId(`atlas-psession-expand-${id}`);

/** One session's live `processState`, read straight off the API the page itself reads. */
async function processStateOf(baseURL: string, sessionId: string): Promise<string | null> {
  const rows = await apiJson<{ id: string; processState: string }[]>(`${baseURL}/api/sessions`);
  return rows.find((s) => s.id === sessionId)?.processState ?? null;
}

/** Every cell of one row, read as {label → text} off the labels the row itself carries. */
async function rowCells(page: Page, sessionId: string) {
  return await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="atlas-roster-row"][data-session-id="${id}"]`);
    if (!el) return null;
    const txt = (sel: string) => (el.querySelector(sel)?.textContent ?? "").trim();
    const labels = Array.from(el.querySelectorAll(".loom-ovroster-lbl")).map((l) => (l.textContent ?? "").trim());
    return {
      agent: txt(".loom-ovroster-agent"),
      state: txt(".loom-ovroster-state"),
      card: txt(".loom-ovroster-cell.is-card"),
      branch: txt(".loom-ovroster-cell.is-branch"),
      context: txt(".loom-ovroster-ctx"),
      last: txt(".loom-ovroster-cell.is-last"),
      // The raw kind behind the plain label (card c77713ae): the cell's `data-event-kind` and `title`.
      lastKind: el.querySelector(".loom-ovroster-cell.is-last")?.getAttribute("data-event-kind") ?? null,
      lastTitle: el.querySelector(".loom-ovroster-cell.is-last")?.getAttribute("title") ?? null,
      open: txt(".loom-ovroster-open"),
      labels,
      indented: el.classList.contains("is-child"),
      // ⚠️ The ROW'S OWN HEIGHT, not a count of distinct cell `top`s. The wide form is a grid with
      // `align-items: center`, so cells of different heights (a pill, a bare text run, a meter) are
      // each centred and legitimately report different tops on a single-line row — measured 2 and 3
      // distinct tops on rows that are visibly one line. Height is what actually discriminates one
      // line from a stacked block, and it is compared against the SAME row at the other width.
      height: Math.round(el.getBoundingClientRect().height),
    };
  }, sessionId);
}

test.describe("the Atlas project Overview's roster composition (card 269f46ef)", () => {
  test("at 1440: the roster reads every seeded cell, with the worker nested under its manager", async ({ page, loomDaemon }) => {
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY. A silent fallback to a sibling worker's daemon renders a plausible,
    // screenshot-able, entirely wrong page, and every value below would be read off it.
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(page.getByTestId("atlas-roster-table")).toBeVisible();

    // The head count is the live fleet, and the card's own label says what the table is.
    await expect(page.getByTestId("atlas-overview-roster")).toContainText("Work in flight");

    const mgr = await rowCells(page, seeded.mgr.sessionId);
    const wkr = await rowCells(page, seeded.worker.sessionId);
    expect(mgr, "the manager's roster row is missing").not.toBeNull();
    expect(wkr, "the worker's roster row is missing").not.toBeNull();

    // ── THE MANAGER ROW. Busy, no card of its own, no branch, its own context, its own last event.
    expect(mgr!.agent).toContain(seeded.mgr.agentName);
    expect(mgr!.agent.toLowerCase()).toContain("manager");
    expect(mgr!.state.toLowerCase()).toBe("working");
    expect(mgr!.branch, "a manager holds no branch").toContain("—");
    expect(mgr!.context, `manager context: ${mgr!.context}`).toContain(`${WARM_PCT}%`);
    // 🔴 The manager's event is one it FILED, not one filed about a worker — a map keyed only on
    // `workerSessionId` leaves this cell empty, which is the defect the derivation exists to avoid.
    // The cell reads in words (`eventKindLabel`), and the raw kind stays on it for debugging.
    expect(mgr!.last, `manager last event: ${mgr!.last}`).toContain("Idle report");
    expect(mgr!.last, "the raw kind is not the visible text").not.toContain("idle_report");
    expect(mgr!.lastKind).toBe("idle_report");
    expect(mgr!.lastTitle).toBe("idle_report");
    expect(mgr!.indented, "a manager is never indented").toBe(false);
    expect(mgr!.height, `at 1440 a row is ONE line (measured ${mgr!.height}px)`).toBeLessThan(60);

    // ── THE WORKER ROW. Idle, holding a card by TITLE, on its branch, at its own occupancy.
    expect(wkr!.agent).toContain(seeded.worker.agentName);
    expect(wkr!.agent.toLowerCase()).toContain("worker");
    expect(wkr!.state.toLowerCase()).toBe("idle");
    // The CARD is the fact that was nowhere on this page before this card, and the title can only
    // come from a lookup through the board roll-up — a cell wired to `taskId` alone shows 8 hex.
    expect(wkr!.card, `worker card cell: ${wkr!.card}`).toContain(seeded.workerCard);
    expect(wkr!.branch).toContain(seeded.workerBranch);
    expect(wkr!.context).toContain(`${WARM_PCT}%`);
    // …and the LAST EVENT is the other new fact, and a DIFFERENT event from the manager's.
    expect(wkr!.last, `worker last event: ${wkr!.last}`).toContain("Merge requested");
    expect(wkr!.lastKind).toBe("merge_request");
    expect(wkr!.last).not.toContain("Idle report");
    expect(wkr!.indented, "a worker is drawn under the manager that owns it").toBe(true);

    // The row's exit opens THAT session, never the first one the page could find.
    await expect(row(page, seeded.worker.sessionId).getByRole("link", { name: /Open/ }))
      .toHaveAttribute("href", `/session/${seeded.worker.sessionId}`);

    // The meter is the SEEDED ratio, not merely a bar: a 0-width or full-width fill renders
    // identically to a reader and would mean nothing.
    const fillPct = await row(page, seeded.worker.sessionId).locator(".loom-ovroster-track > span")
      .evaluate((el) => {
        const own = el.getBoundingClientRect().width;
        const parent = (el.parentElement as HTMLElement).getBoundingClientRect().width;
        return Math.round((own / parent) * 100);
      });
    expect(fillPct, "the roster track's fill is the seeded occupancy").toBe(WARM_PCT);
  });

  test("at 900: a roster row stacks into a labelled block, losing no cell", async ({ page, loomDaemon }) => {
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await pinProject(page, seeded.project.id);

    // BEFORE, at the wide width: one line, and the table's own header row is what names the cells.
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    const wide = await rowCells(page, seeded.worker.sessionId);
    expect(wide!.height, `at 1440 the row is one line (measured ${wide!.height}px)`).toBeLessThan(60);
    await expect(page.locator(".loom-ovroster-head"), "the wide table has a header row").toBeVisible();

    // AFTER, at 900: the header row is gone, the row is several lines, and EVERY cell is still
    // there with the same content — the claim a card grid could not make at this width.
    await page.setViewportSize(NARROW);
    await expect(page.locator(".loom-ovroster-head")).toBeHidden();
    const narrow = await rowCells(page, seeded.worker.sessionId);
    expect(narrow!.height, `at 900 the row is a stacked block (wide ${wide!.height}px → narrow ${narrow!.height}px)`)
      .toBeGreaterThan(wide!.height * 2);
    expect(narrow!.card, "the card cell survived the fold").toContain(seeded.workerCard);
    expect(narrow!.branch).toContain(seeded.workerBranch);
    expect(narrow!.context).toContain(`${WARM_PCT}%`);
    expect(narrow!.last).toContain("Merge requested");
    expect(narrow!.agent).toContain(seeded.worker.agentName);
    expect(narrow!.state.toLowerCase()).toBe("idle");
    expect(narrow!.open.toLowerCase()).toContain("open");

    // …and each of the four cells that lost the header now names itself. Read off the row's own
    // labels, so a fold that hid the header without revealing them fails here.
    const labels = narrow!.labels.map((l) => l.toLowerCase()).sort();
    expect(labels, `stacked row labels: ${narrow!.labels.join(" / ")}`)
      .toEqual(["branch", "card", "context", "last"]);

    // The page itself must not grow a horizontal scrollbar at this width.
    const scroll = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    }));
    expect(scroll.scrollW, `900: scrollWidth ${scroll.scrollW} vs clientWidth ${scroll.clientW}`)
      .toBeLessThanOrEqual(scroll.clientW);
  });

  test("every briefing pop-over opens and closes, and the landed readout is not a button", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // The board reading is the seeded derivation — 3 open against 4 cards on the board, so a
    // readout that counted rows would say 4. This also settles the board query.
    await expect(page.getByTestId("atlas-brief-cards").locator(".loom-ovbrief-n"))
      .toHaveText(String(seeded.open));

    for (const key of BRIEF_POPOVERS) {
      const cell = page.getByTestId(`atlas-brief-${key}`);
      const pop = page.getByTestId(`atlas-brief-pop-${key}`);

      // BEFORE: the reading is there and its breakdown is not. Presence first — a bare "no
      // pop-over" on a page that had not finished loading would pass with nothing on screen.
      await expect(cell).toBeVisible();
      await expect(cell).toHaveAttribute("aria-expanded", "false");
      await expect(pop).toHaveCount(0);

      await cell.click();

      // AFTER: it opened, and the trigger says so to a screen reader as well as to the eye.
      await expect(pop).toBeVisible();
      await expect(cell).toHaveAttribute("aria-expanded", "true");
      // Exactly one at a time — the line is single-open, so clicking a second reading must not
      // leave two breakdowns stacked over the cards below.
      await expect(page.locator(".loom-kpi-pop")).toHaveCount(1);

      await page.getByTestId(`atlas-brief-close-${key}`).click();
      await expect(pop).toHaveCount(0);
      await expect(cell).toHaveAttribute("aria-expanded", "false");
    }

    // Escape closes too — the keyboard path, not just the mouse one.
    const first = page.getByTestId(`atlas-brief-${BRIEF_POPOVERS[0]}`);
    await first.click();
    await expect(page.getByTestId(`atlas-brief-pop-${BRIEF_POPOVERS[0]}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`atlas-brief-pop-${BRIEF_POPOVERS[0]}`)).toHaveCount(0);

    // ── THE LANDED CELL IS A READOUT. Its 14-bar series IS the breakdown, so it is deliberately
    //    not a fifth button. Both halves: the chart is really drawn, and the cell is not a trigger.
    const landed = page.getByTestId("atlas-brief-merged");
    await expect(landed).toBeVisible();
    await expect(landed.locator(".loom-daybars")).toBeVisible();
    expect(await landed.evaluate((el) => el.tagName.toLowerCase()),
      "the landed cell became a button, which would open the chart beside it").not.toBe("button");
    await expect(landed.locator("button")).toHaveCount(0);
  });

  test("a context above the red threshold reads red, on the briefing figure and in the roster", async ({ page, loomDaemon }) => {
    // Ordered amber-first (`>= 80 ? amber : >= 95 ? red`) the red branch is unreachable, because
    // every value at 95 is also at 80 — so neither the figure nor the roster's own meter could ever
    // show the one state these readings exist to surface. The claim moved here, with the readings,
    // from atlas-kpi-deck.spec.ts's `context` tile (card 269f46ef).
    const seeded = await seedFleet(loomDaemon, RED_PCT);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // The WORST of the fleet is the 96% worker, not the 42% manager seeded beside it — so the
    // reading is a real `worstContext` derivation and not "whichever session came back first".
    const figure = page.getByTestId("atlas-brief-context").locator(".loom-ovbrief-n");
    await expect(figure).toHaveText(`${RED_PCT}%`);
    // Red as TEXT is the danger text shade; the meter below is the danger fill. Both are red.
    const TONE_RED = await cssColor(page, "--loom-danger");
    await expect(figure).toHaveCSS("color", await cssColor(page, "--loom-danger-text"));

    // …and the SAME expression, rendered a second way: the roster row's own track fill.
    const track = row(page, seeded.worker.sessionId).locator(".loom-ovroster-track > span");
    await expect(track).toHaveCSS("background-color", TONE_RED);
    // THE CONTRAST CASE, on the same page at the same moment: the 42% manager is NOT red. Without
    // it, "red" is equally satisfied by a page that painted every meter red.
    await expect(row(page, seeded.mgr.sessionId).locator(".loom-ovroster-track > span"))
      .not.toHaveCSS("background-color", TONE_RED);
  });

  // ── EVERY RUNNING SESSION, NOT ONLY MANAGERS AND WORKERS (card 6a9cb96a) ────────────────────
  //
  // The owner's own bug report, verbatim: "'work in flight' card in the UI atlas ui overview page
  // does not show the currently running 'Thought Partner' 'ba96294d' session."
  //
  // The page split its sessions by exact role match into `manager` and `worker` and handed only
  // those two to `rosterRows`, so an ideation/thought-partner rig (which runs as `assistant`), the
  // Companion, an operator, an Agent run and a plain role-less terminal each appeared in NO row —
  // while the card's own head counted every one of them. Record:
  // docs/decisions/6a9cb96a-atlas-overview-roster-lists-every-running-session.md.

  test("the roster lists running non-worker sessions, and its head count matches its own list", async ({ page, loomDaemon }) => {
    // Its OWN fleet, never `seedRiggedFleet`'s: the two scope legs below pin that fixture's row
    // count and segment counts exactly, so adding a session to it would redden them.
    const project = await loomDaemon.createProject(uniq("atlasovroles"));
    const short = `${Math.floor(Math.random() * 1e6)}`;
    const mgr = await loomDaemon.seedLiveSession({
      project, id: `e2e-ovrole-mgr-${short}`, agentName: `RoleConductor-${short}`, role: "manager",
    });
    // 🔴 THE SUBJECT. `assistant` is the role an ideation/thought-partner rig and the Companion both
    // run under, so this row IS the owner's reported session's shape.
    const tp = await loomDaemon.seedLiveSession({
      project, id: `e2e-ovrole-tp-${short}`, agentName: `RoleThoughtPartner-${short}`, role: "assistant",
    });
    // …and a role-less plain terminal beside it, so a fix that special-cased the one role the bug
    // report named would still leave this leg red. It is the broader class, not one role.
    const plain = await loomDaemon.seedLiveSession({
      project, id: `e2e-ovrole-plain-${short}`, agentName: `RolePlain-${short}`, role: "plain",
    });
    // THE NEGATIVE, differing from `tp` in exactly ONE field: an EXITED assistant. These rows are
    // deliberately LIVE-only (unlike the manager/worker rows, which keep every non-archived row) —
    // `role:"run"` is never archived on exit at all, so listing exited rows here would accrue a
    // dead Agent Run row per invocation under a card called "Work in flight".
    const deadTp = await loomDaemon.seedLiveSession({
      project, id: `e2e-ovrole-deadtp-${short}`, agentName: `RoleDeadPartner-${short}`,
      role: "assistant", processState: "exited",
    });
    await pinProject(page, project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY first — a silent fallback to a sibling worker's daemon renders a plausible,
    // entirely wrong page, and every count below would be read off it. Plus the shell's own
    // identity, so the leg cannot pass against a different frame.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);
    await expect(page.getByTestId("atlas-roster-table")).toBeVisible();

    // ── THE ROWS. Presence before absence (card 625d791c): a leading `toHaveCount(0)` is satisfied
    //    by a page that is merely still loading.
    await expect(row(page, mgr.sessionId)).toBeVisible();
    await expect(row(page, tp.sessionId)).toBeVisible();
    await expect(row(page, plain.sessionId)).toBeVisible();
    await expect(row(page, deadTp.sessionId)).toHaveCount(0);
    await expect(page.locator('[data-testid="atlas-roster-row"]')).toHaveCount(3);

    // THE LABEL the DoD asked for, read off each row's own role slot — the thought partner reads
    // `assistant` and a role-less terminal reads `session`, never a blank or a borrowed "worker".
    await expect(row(page, tp.sessionId).locator(".loom-ovroster-agent i")).toHaveText("assistant");
    await expect(row(page, plain.sessionId).locator(".loom-ovroster-agent i")).toHaveText("session");
    await expect(row(page, tp.sessionId).locator(".loom-ovroster-agent b")).toHaveText(tp.agentName);

    // 🔴 THE DEFECT'S OWN SIGNATURE: the head counted the thought partner while the list could not
    // draw it — the head-disagrees-with-its-own-list shape card 9b6be377 was filed against. Both
    // readings are asserted together, so a fix that narrowed the HEAD instead would fail here.
    await expect(page.getByTestId("atlas-overview-roster").locator(".loom-bandcount").first())
      .toHaveText("3 live · 0 working");
    // …and the scope toggle's own derived count, which reads off the same row set.
    await expect(scopeSegment(page, "all")).toHaveText(/^All \(3\)$/);

    // THE ROW IS NOT INDENTED. `child` means "a worker drawn under the manager that owns it";
    // nothing outside that relationship may claim it.
    await expect(row(page, tp.sessionId)).not.toHaveClass(/is-child/);

    // …and the footer states the live-only asymmetry rather than leaving the exited row's absence
    // to be discovered.
    await expect(page.getByTestId("atlas-overview-roster"))
      .toContainText("is listed only while it is running");
  });

  // ── THE SCOPE FILTER (card effd47d5) ────────────────────────────────────────────────────────
  // The owner's own item on this tab, verbatim: "Optionaly show either only tarminals of spawnable
  // agents or teminals of all running agents. Adjustable by user preference."
  //
  // ⚠️ The roster is a TABLE of sessions, not a strip of terminals: these legs are about which
  // agents' sessions the TABLE lists. The terminal list the owner's wording also asked for is a
  // SEPARATE card below it (card 0bcfa530, its own legs at the bottom of this file) answering to
  // this same one preference — so a change to the toggle has to be checked against both.

  test("the scope toggle really changes the listed population, both ways", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY first: a silent fallback to a sibling worker's daemon renders a plausible,
    // entirely wrong page, and every row count below would be read off it.
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(page.getByTestId("atlas-roster-table")).toBeVisible();

    // ── DEFAULT = ALL. Pinned deliberately: the card GUESSED that "spawnable only" was already
    //    this page's behaviour, and it was not. Defaulting the other way would hide rows from every
    //    existing reader on upgrade.
    await expect(scopeSegment(page, "all")).toHaveAttribute("aria-checked", "true");
    await expect(scopeSegment(page, "spawnable")).toHaveAttribute("aria-checked", "false");
    await expect(row(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(row(page, seeded.worker.sessionId)).toBeVisible();

    // 🔴 THE COUNTS ON THE SEGMENTS ARE THE FILTER, COMPUTED, BEFORE ANYTHING IS CLICKED. The rigs
    // are what make them differ: 2 sessions, 1 of them on an agent a human may start. A filter that
    // was a no-op would read "You spawn (2)" here and pass every visibility assertion below.
    await expect(scopeSegment(page, "all")).toHaveText(/^All \(2\)$/);
    await expect(scopeSegment(page, "spawnable")).toHaveText(/^You spawn \(1\)$/);

    // ── CLICK → SPAWNABLE ONLY. The dispatched worker goes, the manager stays. Presence first
    //    (card 625d791c): assert the row that must REMAIN before the one that must disappear, or a
    //    page that simply stopped rendering the table satisfies the absence.
    await scopeSegment(page, "spawnable").click();
    await expect(scopeSegment(page, "spawnable")).toHaveAttribute("aria-checked", "true");
    await expect(row(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(row(page, seeded.worker.sessionId)).toHaveCount(0);
    await expect(page.locator('[data-testid="atlas-roster-row"]')).toHaveCount(1);

    // …and the card SAYS it is filtered, in the footer whose job is keeping the label honest. A
    // table silently showing a subset under the heading "Work in flight" is the defect here.
    await expect(page.getByTestId("atlas-overview-roster"))
      .toContainText("Listing only the agents you start by hand; 1 session dispatched by a manager is hidden.");

    // ── AND BACK. Both directions, so "the worker vanished" cannot be satisfied by a row that
    //    merely failed to render once and never came back.
    await scopeSegment(page, "all").click();
    await expect(scopeSegment(page, "all")).toHaveAttribute("aria-checked", "true");
    await expect(row(page, seeded.worker.sessionId)).toBeVisible();
    await expect(page.locator('[data-testid="atlas-roster-row"]')).toHaveCount(2);
    await expect(page.getByTestId("atlas-overview-roster")).not.toContainText("Listing only the agents");
  });

  test("the chosen scope survives a reload, stored per project", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    await expect(row(page, seeded.worker.sessionId)).toBeVisible();
    await scopeSegment(page, "spawnable").click();
    await expect(row(page, seeded.worker.sessionId)).toHaveCount(0);

    // It is a PREFERENCE, not component state: it must be in the per-project localStorage key the
    // Sessions tab's own layout already uses the shape of, not a React state that dies on reload.
    expect(await page.evaluate((k) => localStorage.getItem(k), `loom.overviewRoster.${seeded.project.id}`))
      .toBe("spawnable");

    await page.reload();
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // AFTER THE RELOAD: the control is still on the chosen reading, and the list still reflects it.
    // Presence first again — the manager row proves the table rendered at all, so the worker's
    // absence is a filter result rather than a page that never finished loading.
    await expect(scopeSegment(page, "spawnable")).toHaveAttribute("aria-checked", "true");
    await expect(row(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(row(page, seeded.worker.sessionId)).toHaveCount(0);
    await expect(page.locator('[data-testid="atlas-roster-row"]')).toHaveCount(1);

    // …and the ONE preference also restored the Sessions card below (card 0bcfa530). Presence
    // first: the manager's terminal row proves the card rendered, so the worker's absence is the
    // restored filter rather than a card that never drew.
    await expect(sessRow(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(sessRow(page, seeded.worker.sessionId)).toHaveCount(0);
    await expect(sessRows(page)).toHaveCount(1);
  });

  // ── THE SESSIONS CARD (card 0bcfa530) ───────────────────────────────────────────────────────
  // The owner's decision 925ea659: "Also add a filtered terminal list to the project Overview (new
  // card)". It is the project-scoped twin of the Workspace node's own Sessions card (9b6be377),
  // reusing that component, and filtered by the SAME preference as the roster above it.

  test("the Sessions card lists this project's running sessions only, and follows the one scope toggle in step with the roster", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    // The EXITED negative, seeded HERE rather than into the shared fixture (which the roster legs
    // above pin exactly). On the MANAGER's spawnable rig deliberately: it is then in this project,
    // listed by the roster, and spawnable under BOTH scopes — so the only thing that can keep it off
    // the terminal list is "not running", which is precisely the claim under test.
    const exited = await loomDaemon.seedLiveSession({
      project: seeded.project, id: `e2e-ovsc-dead-${seeded.short}`, agentId: seeded.mgrAgentId,
      agentName: seeded.mgrName, role: "worker", processState: "exited",
    });
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY first: a silent fallback to a sibling worker's daemon renders a plausible,
    // entirely wrong page, and every count below would be read off it.
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(sessCard(page)).toBeVisible();

    // ── THE POPULATION. Presence before every absence: the two running rows, then the three
    //    things that must not be here, each of which differs from a listed row in ONE field.
    await expect(sessRows(page)).toHaveCount(2);
    await expect(sessRow(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(sessRow(page, seeded.worker.sessionId)).toBeVisible();
    // 🔴 THE CROSS-PROJECT NEGATIVE. `seeded.other` is live, pty-bearing and on a spawnable rig —
    // it survives either scope. Only the project scope keeps it off this card.
    await expect(sessRow(page, seeded.other.sessionId)).toHaveCount(0);
    // …and the EXITED row, which is the one place the two cards' populations deliberately diverge:
    // the roster lists it (it has a row with an `exited` pill), the terminal list cannot.
    await expect(row(page, exited.sessionId)).toBeVisible();
    await expect(sessRow(page, exited.sessionId)).toHaveCount(0);

    // The head count is what the card LISTS, never a separately-derived figure that could drift —
    // the "a card reading 3 beside a list showing 2" shape card 9b6be377 recorded.
    await expect(sessCard(page).locator(".loom-bandcount").first()).toHaveText("2");
    // Nothing is mounted at rest. This is what makes the card safe to add to a tab the owner had
    // furniture REMOVED from: at rest it costs its head plus one line per session.
    await expect(sessTerm(page)).toHaveCount(0);

    // ── ONE TOGGLE, TWO LISTS. The control lives in the roster's head; flipping it must move BOTH
    //    populations in the same step, or "one preference" is a claim the page does not keep.
    await scopeSegment(page, "spawnable").click();
    await expect(scopeSegment(page, "spawnable")).toHaveAttribute("aria-checked", "true");
    await expect(row(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(row(page, seeded.worker.sessionId)).toHaveCount(0);
    await expect(sessRow(page, seeded.mgr.sessionId)).toBeVisible();
    await expect(sessRow(page, seeded.worker.sessionId)).toHaveCount(0);
    await expect(sessRows(page)).toHaveCount(1);
    await expect(sessCard(page).locator(".loom-bandcount").first()).toHaveText("1");

    // …and the card SAYS it is filtered, naming the control rather than growing a second one. A
    // list silently showing a subset under the heading "Sessions" is the defect here.
    await expect(sessCard(page)).toContainText(
      "Listing only the agents you start by hand; 1 running session dispatched by a manager is hidden by the filter on the card above.",
    );
    // ⛔ AND THERE IS NO SECOND TOGGLE. The card's own head carries no scope control — one
    // preference, one place to change it.
    await expect(sessCard(page).getByTestId("atlas-roster-scope")).toHaveCount(0);
    await expect(sessCard(page).getByRole("radio")).toHaveCount(0);

    // ── AND BACK. Both directions, so "the worker vanished" cannot be satisfied by a row that
    //    merely failed to render once and never came back.
    await scopeSegment(page, "all").click();
    await expect(sessRow(page, seeded.worker.sessionId)).toBeVisible();
    await expect(sessRows(page)).toHaveCount(2);
    await expect(sessCard(page)).not.toContainText("Listing only the agents");
  });

  test("expanding a Sessions row attaches THAT session's terminal, and collapsing releases the view without stopping the session", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    // An exited session on the same fleet — not to be listed, but as the CONTRAST CASE for the
    // `processState` reading below: "still live after a collapse" means nothing unless the same
    // helper, on the same daemon, at the same moment, can return something that is not "live".
    const exited = await loomDaemon.seedLiveSession({
      project: seeded.project, id: `e2e-ovsc-ctl-${seeded.short}`, agentId: seeded.mgrAgentId,
      role: "worker", processState: "exited",
    });
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // AT REST: the rows are there and NOTHING is mounted — presence before the absence claim.
    await expect(sessRows(page)).toHaveCount(2);
    await expect(sessTerm(page)).toHaveCount(0);
    const mgrToggle = sessExpand(page, seeded.mgr.sessionId);
    const wkrToggle = sessExpand(page, seeded.worker.sessionId);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");

    // ── EXPAND. The observable is the pane's REPLAYED BYTES, not a region appearing: this
    //    session's own sentinel is what proves the mount really ATTACHED to the row that was
    //    clicked, and no amount of chrome can satisfy it.
    await mgrToggle.click();
    await expect(sessTerm(page)).toHaveCount(1);
    await expect(sessPaneText(page).filter({ hasText: seeded.mgrSentinel })).toBeVisible();
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "true");
    await expect(sessRow(page, seeded.mgr.sessionId)).toHaveClass(/is-expanded/);

    // ── MOVE IT, never add a second. Still exactly ONE region, now replaying the OTHER session's
    //    bytes — the byte CHANGE is what tells a moved mount apart from a second one rendering in
    //    the same place, and the single-mount rule is this card's whole cost model.
    await wkrToggle.click();
    await expect(sessTerm(page)).toHaveCount(1);
    await expect(sessPaneText(page).filter({ hasText: seeded.wkrSentinel })).toBeVisible();
    await expect(sessPaneText(page).filter({ hasText: seeded.mgrSentinel })).toHaveCount(0);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");

    // ── COLLAPSE. Sessions outlive viewers: releasing the view must not touch the pty.
    await expect.poll(() => processStateOf(loomDaemon.baseURL, seeded.worker.sessionId),
      { message: "the seeded worker is live before the collapse" }).toBe("live");
    await wkrToggle.click();
    await expect(sessTerm(page)).toHaveCount(0);
    await expect(wkrToggle).toHaveAttribute("aria-expanded", "false");
    // The row is still listed and the DAEMON still reports the session live — read off the same
    // API the page reads, so this is the session's real state and not a rendering of it.
    await expect(sessRow(page, seeded.worker.sessionId)).toBeVisible();
    expect(await processStateOf(loomDaemon.baseURL, seeded.worker.sessionId),
      "collapsing the terminal stopped the session").toBe("live");
    // THE CONTRAST CASE, through the same helper against the same daemon in the same breath: a
    // session that really is not running reads `exited`. Without it, `toBe("live")` above would be
    // equally satisfied by a helper that returned "live" for everything, including a stopped pty.
    expect(await processStateOf(loomDaemon.baseURL, exited.sessionId),
      "the processState read cannot distinguish a stopped session, so the claim above is vacuous")
      .toBe("exited");

    // …and the STRONGEST form of the same claim: re-expanding replays the SAME bytes, so the pty
    // entry itself survived the collapse rather than merely the DB row.
    await wkrToggle.click();
    await expect(sessTerm(page)).toHaveCount(1);
    await expect(sessPaneText(page).filter({ hasText: seeded.wkrSentinel })).toBeVisible();

    // The expanded card is a READOUT, the same posture the Workspace card takes: a Composer to
    // steer with (a terminal you cannot steer is not worth the mount), and no lifecycle buttons —
    // the row's `Open ↗` reaches the session node's full tile, which owns Stop and Fork.
    await expect(sessTerm(page).getByTestId("composer")).toBeVisible();
    await expect(sessTerm(page).getByRole("button", { name: /^stop$/i })).toHaveCount(0);
    await expect(sessTerm(page).getByRole("button", { name: /^fork$/i })).toHaveCount(0);

    // The per-row exit carries THAT row's own id, never the first the page could find.
    await expect(page.getByTestId(`atlas-psession-open-${seeded.worker.sessionId}`))
      .toHaveAttribute("href", `/session/${seeded.worker.sessionId}`);
  });
});
