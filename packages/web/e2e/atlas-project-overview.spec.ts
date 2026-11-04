// The Atlas project node's reworked Overview — card 269f46ef, the owner's "C · Roster" pick.
//
// His instruction on this tab, verbatim: "Remove Board." and "Dashboard cards too cluttered on
// narrower page width. Remove 'AGENTS' card. Rework and Expand the rest of the cards now that the
// board is gone. Improve them." He picked direction C from three rendered mockups on request
// 891ed41f, with one amendment, also verbatim: "Overview C: 'Needs you' should be on top in its own
// row so it has enough space." Record: docs/decisions/269f46ef-atlas-project-overview-roster.md.
//
// The REMOVALS (no deck, no band, no disclosure, no board embed, no Agents panel) are asserted by
// the specs those surfaces belonged to — atlas-dashboard-disclosure, atlas-home, atlas-kpi-deck and
// atlas-agents each state the absence beside the claim it replaced, which is where a reader looking
// for "where did it go" will actually be. This file is the POSITIVE coverage for what was built.
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
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const WIDE = { width: 1440, height: 1000 };
const NARROW = { width: 900, height: 1000 };

// `claude-sonnet-4-5`'s own window, which `contextWindowForModel` resolves — so every expected %
// below is derivable from the seeded token count rather than a magic number.
const CTX_WINDOW = 1_000_000;
const WARM_PCT = 42;
const RED_PCT = 96;
const TONE_RED = "rgb(255, 92, 92)"; // --loom-red #ff5c5c

// The four readings that carry a breakdown. `merged` is deliberately NOT here — leg 5 is the
// assertion that it is a plain readout, and listing it would make that leg contradict this list.
const BRIEF_POPOVERS = ["cards", "fleet", "context", "gates"];

async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

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

/**
 * A project whose fleet is ONE manager on a manager rig and ONE worker on a worker rig.
 *
 * That asymmetry is the whole fixture: `splitRoster` calls the manager's agent spawnable and the
 * worker's agent dispatched, so the two scopes have genuinely different populations — 2 rows and 1 —
 * and a filter that kept or dropped everything could satisfy neither.
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
  });
  const worker = await loomDaemon.seedLiveSession({
    project, id: `e2e-ovsc-wkr-${short}`, agentId: wkrAgent.id, agentName: wkrName, role: "worker",
    parentSessionId: mgr.sessionId, branch: `loom/ovscope${short}`,
  });
  return { project, mgr, worker, mgrName, wkrName };
}

/** The scope toggle's two segments, scoped through the control's own testid. */
const scopeSegment = (page: Page, which: "all" | "spawnable") =>
  page.getByTestId("atlas-roster-scope")
    .getByRole("radio", { name: which === "all" ? /^All/ : /^You spawn/ });

/** One roster row, by the session it draws — never by text, which a sibling spec's row can match. */
const row = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="atlas-roster-row"][data-session-id="${sessionId}"]`);

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
  test("switch ON at 1440: the roster reads every seeded cell, with the worker nested under its manager", async ({ page, loomDaemon }) => {
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
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
    expect(mgr!.state.toLowerCase()).toBe("busy");
    expect(mgr!.branch, "a manager holds no branch").toContain("—");
    expect(mgr!.context, `manager context: ${mgr!.context}`).toContain(`${WARM_PCT}%`);
    // 🔴 The manager's event is one it FILED, not one filed about a worker — a map keyed only on
    // `workerSessionId` leaves this cell empty, which is the defect the derivation exists to avoid.
    expect(mgr!.last, `manager last event: ${mgr!.last}`).toContain("idle_report");
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
    expect(wkr!.last, `worker last event: ${wkr!.last}`).toContain("merge_request");
    expect(wkr!.last).not.toContain("idle_report");
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

  test("switch ON at 900: a roster row stacks into a labelled block, losing no cell", async ({ page, loomDaemon }) => {
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
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
    expect(narrow!.last).toContain("merge_request");
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

  test("switch ON: every briefing pop-over opens and closes, and the landed readout is not a button", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const seeded = await seedFleet(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
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

  test("switch ON: a context above the red threshold reads red, on the briefing figure and in the roster", async ({ page, loomDaemon }) => {
    // Ordered amber-first (`>= 80 ? amber : >= 95 ? red`) the red branch is unreachable, because
    // every value at 95 is also at 80 — so neither the figure nor the roster's own meter could ever
    // show the one state these readings exist to surface. The claim moved here, with the readings,
    // from atlas-kpi-deck.spec.ts's `context` tile (card 269f46ef).
    const seeded = await seedFleet(loomDaemon, RED_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // The WORST of the fleet is the 96% worker, not the 42% manager seeded beside it — so the
    // reading is a real `worstContext` derivation and not "whichever session came back first".
    const figure = page.getByTestId("atlas-brief-context").locator(".loom-ovbrief-n");
    await expect(figure).toHaveText(`${RED_PCT}%`);
    await expect(figure).toHaveCSS("color", TONE_RED);

    // …and the SAME expression, rendered a second way: the roster row's own track fill.
    const track = row(page, seeded.worker.sessionId).locator(".loom-ovroster-track > span");
    await expect(track).toHaveCSS("background-color", TONE_RED);
    // THE CONTRAST CASE, on the same page at the same moment: the 42% manager is NOT red. Without
    // it, "red" is equally satisfied by a page that painted every meter red.
    await expect(row(page, seeded.mgr.sessionId).locator(".loom-ovroster-track > span"))
      .not.toHaveCSS("background-color", TONE_RED);
  });

  // ── THE SCOPE FILTER (card effd47d5) ────────────────────────────────────────────────────────
  // The owner's own item on this tab, verbatim: "Optionaly show either only tarminals of spawnable
  // agents or teminals of all running agents. Adjustable by user preference."
  //
  // ⚠️ The roster is a TABLE of sessions, not a strip of terminals — this page has mounted no
  // terminal since the rework (card 269f46ef), and re-adding one is explicitly out of scope. These
  // legs are about which agents' sessions the table LISTS.

  test("switch ON: the scope toggle really changes the listed population, both ways", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    await seedAtlasOn(page);
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

  test("switch ON: the chosen scope survives a reload, stored per project", async ({ page, loomDaemon }) => {
    const seeded = await seedRiggedFleet(loomDaemon);
    await seedAtlasOn(page);
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
  });
});
