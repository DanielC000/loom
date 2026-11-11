// The project node's Usage tab — card 30266229 (the owner's Atlas feedback item, verbatim: `Add new per
// project "Usage" tab. - Breakdown usage by tasks and related tasks too.`). Record:
// docs/decisions/30266229-per-project-usage-by-task.md.
//
// SIX SEEDED FIGURES, EVERY ONE A DISTINCT POWER OF TWO IN DOLLARS: $1 (an epic's own usage), $2 (its
// child), $4 (a standalone card), $8 (a card related to that standalone one), $16 (a manager session ⇒
// orchestration overhead) and $32 (a sample with no task and no session row ⇒ unattributed). That is
// the discriminator this whole spec rests on: every SUBSET of those six sums to a different number, so
// a roll-up that double-counts a child, merges a relation, or reads the wrong bucket lands on a figure
// no correct derivation can produce. With equal amounts, all three defects would pass.
//
// What each leg asserts:
//   1. THE TAB IS A REAL ADDRESS. It is in the declared tab set (parsed out of src/nav.tsx, never typed
//      here), navigates to /project?tab=usage, and a full RELOAD comes back on it.
//   2. THE PER-TASK NUMBERS ARE REAL, AND THE CHILD IS ROLLED UP ONCE. The epic states $3.00 — its own
//      $1 plus its child's $2 — while the child has NO row of its own until the epic is expanded.
//      Expanding is EXERCISED (a click, with the before/after row count), not merely rendered.
//   3. A RELATION IS NOT MERGED. Expanding the $4 card draws the $8 related card as its own labelled
//      row, and the $4 card's own figure is unchanged by it.
//   4. THE THREE BUCKETS ADD UP. The overhead and unattributed rows carry $16 and $32, the total stat
//      reads $63.00, and the visible dollar figures are SUMMED FROM THE DOM and required to equal it —
//      which is the page's own stated claim, not a restatement of the seed.
//   5. THE DISCLOSURE SAYS THE FOUR HONEST THINGS, and the window control is wired — EXERCISED, with
//      the rows present at one window and the empty state at another.
//   6. SWITCH OFF: the tab exists only under Atlas — no project-usage surface in the classic shell.
//
// 🔴 EVERY SAMPLE IS BACK-DATED BY `SAMPLE_AGE_DAYS`, and the tab is driven to "All time" to see them.
// That is isolation, not scenery: the `loomDaemon` fixture is WORKER-SCOPED and shared across every
// spec file in the worker, usage samples have no cleanup lever (only sessions are archived in
// afterEach), and `usage.spec.ts` — which sorts after this file — asserts a GLOBAL empty interactive
// plane at the 7-day and 24-hour windows. Seeding at "now" made that spec fail, measured. Back-dated
// rows sit in a window no other spec reads, so they cannot leak into one. ⛔ A spec that starts
// reading /usage at "All time" must either seed its own project scope or expect to see these.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { nodeTabKeys, openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// Wide enough that the ten-tab row lays out without the narrow-breakpoint rules taking over, and that
// every row's right-hand figure cluster has room beside its title.
const VIEWPORT = { width: 1600, height: 1000 };

// ── The six seeded figures (see the header: distinct powers of two, deliberately) ───────────────
const EPIC_USD = 1;
const CHILD_USD = 2;
const SOLO_USD = 4;
const RELATED_USD = 8;
const OVERHEAD_USD = 16;
const UNATTRIBUTED_USD = 32;
/** What the epic's row must state: its own usage PLUS its child's, each counted once. */
const EPIC_ROLLED_USD = EPIC_USD + CHILD_USD;
const GRAND_USD = EPIC_USD + CHILD_USD + SOLO_USD + RELATED_USD + OVERHEAD_USD + UNATTRIBUTED_USD;

/** How far back every sample is seeded — see this file's header for why it is not "now". Inside the
 *  server's own one-year floor on `since`, so the "All time" window still returns them. */
const SAMPLE_AGE_DAYS = 300;
const SAMPLE_TS = new Date(Date.now() - SAMPLE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, reload
// included, so an unconditional write would re-pin on a later leg and that leg would be measuring this
// helper instead of the app (measured on P1-4, card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * PROJECT_NODE_TABS, parsed out of the real source — the idiom atlas-project-tabs.spec.ts establishes
 * (the e2e tsconfig cannot import a `src/` module, and a tab list typed here would drift alongside the
 * code it polices). The filtered row count is checked against the block's own raw marker count, so a
 * regex that quietly stopped matching a row cannot hand back a plausible SUBSET.
 */
function parseProjectNodeTabs(): { rows: { key: string; label: string; to: string }[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const nodePath = /export const PROJECT_NODE_PATH = "([^"]+)"/.exec(src)?.[1];
  if (!nodePath) throw new Error(`no PROJECT_NODE_PATH declaration found in ${NAV_SOURCE}`);
  const start = src.indexOf("export const PROJECT_NODE_TABS");
  if (start < 0) throw new Error(`no PROJECT_NODE_TABS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`PROJECT_NODE_TABS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bkey:\s*"/g) ?? []).length;
  const rows: { key: string; label: string; to: string }[] = [];
  const row = /\bkey:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*to:\s*(?:"([^"]+)"|`([^`]*)`|(PROJECT_NODE_PATH))/g;
  for (const m of block.matchAll(row)) {
    const raw = m[5] ? "${PROJECT_NODE_PATH}" : (m[3] ?? m[4] ?? "");
    rows.push({ key: m[1]!, label: m[2]!, to: raw.replace("${PROJECT_NODE_PATH}", nodePath) });
  }
  return { rows, rawMarkers, block };
}

const short = (id: string) => id.slice(0, 8);
const taskRow = (page: Page, id: string) => page.getByTestId(`project-usage-row-${short(id)}`);
const taskCost = (page: Page, id: string) => page.getByTestId(`project-usage-cost-${short(id)}`);
const expander = (page: Page, id: string) => page.getByTestId(`project-usage-expand-${short(id)}`);

/** Every dollar figure currently rendered inside the tab, as numbers — the DOM's own arithmetic. */
async function visibleUsd(page: Page, testIds: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const id of testIds) {
    const text = await page.getByTestId(id).innerText();
    const m = /\$([\d,]+(?:\.\d+)?)/.exec(text);
    if (!m) throw new Error(`no dollar figure in ${id}: ${JSON.stringify(text)}`);
    out.push(Number.parseFloat(m[1]!.replace(/,/g, "")));
  }
  return out;
}

/**
 * One project carrying all six figures above.
 *
 * ⚠️ The manager session is seeded through `seedLiveSession` (and so auto-archived by the fixture's own
 * isolation after the test) because `orchestrationOverhead` is claimed BY the live `sessions.role`
 * join — there is no way to build that bucket from a sample's own fields, and a sample on the default
 * minted `e2e-session-<uuid>` has no session row at all, which is exactly what makes the
 * UNATTRIBUTED sample unattributed.
 */
async function seedUsageProject(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("pusage"));
  const epic = await loomDaemon.createTask(project.id, { title: uniq("USAGE-EPIC-SENTINEL"), columnKey: "todo" });
  const child = await loomDaemon.createTask(project.id, { title: uniq("USAGE-CHILD-SENTINEL"), columnKey: "todo" });
  const solo = await loomDaemon.createTask(project.id, { title: uniq("USAGE-SOLO-SENTINEL"), columnKey: "in_progress" });
  const related = await loomDaemon.createTask(project.id, { title: uniq("USAGE-RELATED-SENTINEL"), columnKey: "done" });

  // The two structural edges this card is about, written through the SAME human REST route the board
  // card dialog's relation editor uses (POST /api/tasks/:id runs them through `planTaskStructure`).
  await apiJson(`${loomDaemon.baseURL}/api/tasks/${child.id}`, {
    method: "POST", body: JSON.stringify({ parentId: epic.id }),
  });
  await apiJson(`${loomDaemon.baseURL}/api/tasks/${solo.id}`, {
    method: "POST", body: JSON.stringify({ related: [related.id] }),
  });

  // Tokens scale with the dollars so a row's meter and its cost never disagree about which row is
  // biggest; the four token classes carry different multiples so a derivation summing the wrong column
  // cannot land on the right answer by coincidence.
  const sample = (usd: number, taskId?: string, sessionId?: string) => loomDaemon.seedUsageSample({
    projectId: project.id,
    ...(taskId ? { taskId } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: "claude-sonnet-5",
    ts: SAMPLE_TS,
    inputTokens: usd * 100,
    outputTokens: usd * 200,
    cacheCreationTokens: usd * 300,
    cacheReadTokens: usd * 400,
    costUsd: usd,
  });

  await sample(EPIC_USD, epic.id);
  await sample(CHILD_USD, child.id);
  await sample(SOLO_USD, solo.id);
  await sample(RELATED_USD, related.id);
  // Claimed as overhead BY ROLE, even though the sample carries a task id — the read side excludes a
  // manager/platform session from `byTask` regardless. Seeding it WITH a task id is the stronger
  // fixture: it proves the exclusion rather than relying on the writer never setting one.
  const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: uniq("pusage-mgr") });
  await sample(OVERHEAD_USD, epic.id, mgr.sessionId);
  // No task id and no session row ⇒ neither a task nor overhead.
  await sample(UNATTRIBUTED_USD);

  return { project, epic, child, solo, related };
}

test.describe("project node Usage tab (card 30266229)", () => {
  test("switch ON: the tab is a real address, and its per-task rows roll children up exactly once",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);

      // ── 1. THE TAB IS DECLARED. Read off nav.tsx, with the parse's own positive controls. ──
      const { rows, rawMarkers, block } = parseProjectNodeTabs();
      expect(rows.length, `the PROJECT_NODE_TABS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
      expect(rows.length,
        `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} key: marker(s)`
        + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
      expect(rows, "the Usage tab is not declared, or not at the address this spec drives")
        .toContainEqual({ key: "usage", label: "Usage", to: "/project?tab=usage" });

      const seeded = await seedUsageProject(loomDaemon);
      await seedAtlasOn(page);
      await pinProject(page, seeded.project.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(loomDaemon.baseURL + "/project");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      // FIXTURE IDENTITY: this really is the project this test seeded, not whichever one the shared
      // worker daemon happened to resolve first.
      await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
      // And the tab is REACHABLE — in the row or the More menu, never neither.
      expect(await nodeTabKeys(page), "the Usage tab is in neither half of the node's tab row")
        .toContain("usage");

      await openNodeTab(page, "usage");
      await expect(page, "the Usage tab did not land on its declared address")
        .toHaveURL(loomDaemon.baseURL + "/project?tab=usage");
      await expect(page.getByTestId("project-usage")).toBeVisible();

      // A RELOAD comes back on the tab from the address alone — the claim that makes it an address
      // rather than component state.
      await page.reload();
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-tab-usage")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("project-usage")).toBeVisible();

      // ── 5a. THE WINDOW CONTROL, EXERCISED FIRST. Every sample is back-dated (see the header), so
      //    the tab's own 7-day default must show the EMPTY state and "All time" must show the rows.
      //    That is a content before/after, not a label change — and it has to happen here, because
      //    every figure below is only reachable at the wider window. ──
      await expect(page.getByTestId("project-usage-empty"),
        "a 7-day default showed rows for samples seeded 300 days ago").toBeVisible();
      await expect(page.getByText("est. consumption · past 7 days")).toBeVisible();
      await page.getByTestId("project-usage-window").selectOption({ label: "All time" });
      await expect(page.getByTestId("project-usage-empty"),
        "selecting All time did not widen the query — the rows never appeared").toHaveCount(0);
      await expect(page.getByText("est. consumption · all time")).toBeVisible();

      // ── 2. THE PER-TASK NUMBERS, AND THE ROLL-UP. ──
      await expect(taskCost(page, seeded.solo.id)).toHaveText(`$${SOLO_USD.toFixed(2)}`);
      await expect(taskCost(page, seeded.related.id)).toHaveText(`$${RELATED_USD.toFixed(2)}`);
      // THE CENTRAL CLAIM: the epic states its own $1 PLUS its child's $2 — not $1 (no roll-up), not
      // $4 (the child counted twice), not $18 (the manager's own sample folded in).
      await expect(taskCost(page, seeded.epic.id),
        `the epic must state its own $${EPIC_USD} + its child's $${CHILD_USD}, each counted once`)
        .toHaveText(`$${EPIC_ROLLED_USD.toFixed(2)}`);
      // The epic's row NAMES how many cards it rolled up, so the figure above is self-describing.
      await expect(taskRow(page, seeded.epic.id)).toContainText("+1 rolled up");
      // The card titles are the seeded ones (the rows are this fixture's, not a sibling's).
      await expect(taskRow(page, seeded.epic.id)).toContainText(seeded.epic.title);
      // ⭐ AND THE CHILD HAS NO ROW OF ITS OWN WHILE COLLAPSED — otherwise a reader would see the
      // child's $2 twice on one screen and the rows would not add up to the total.
      await expect(taskRow(page, seeded.child.id),
        "the child is drawn as a top-level row as well as inside its parent's figure").toHaveCount(0);

      // EXERCISED, not rendered: expanding is a real before/after state change.
      const rowsBefore = await page.locator("[data-pu-task]").count();
      await expander(page, seeded.epic.id).click();
      await expect(expander(page, seeded.epic.id)).toHaveAttribute("aria-expanded", "true");
      await expect(taskRow(page, seeded.child.id), "the child row did not appear on expand").toBeVisible();
      await expect(taskCost(page, seeded.child.id)).toHaveText(`$${CHILD_USD.toFixed(2)}`);
      expect(await page.locator("[data-pu-task]").count(),
        "expanding the epic did not add its child's row").toBeGreaterThan(rowsBefore);
      // Collapsing puts it back — the control is a toggle, not a one-way reveal.
      await expander(page, seeded.epic.id).click();
      await expect(taskRow(page, seeded.child.id)).toHaveCount(0);
      expect(await page.locator("[data-pu-task]").count()).toBe(rowsBefore);

      // ── 3. A RELATION IS SHOWN SEPARATELY AND MERGED INTO NOTHING. ──
      await expander(page, seeded.solo.id).click();
      const relRow = page.getByTestId(`project-usage-relation-related-${short(seeded.related.id)}`);
      await expect(relRow, "the related card is not drawn under the card that points at it").toBeVisible();
      await expect(relRow).toContainText("related");
      await expect(relRow, "the relation row must carry the related card's OWN figure")
        .toContainText(`$${RELATED_USD.toFixed(2)}`);
      // THE CLAIM: the viewed card's own number is unchanged by the edge existing.
      await expect(taskCost(page, seeded.solo.id),
        `the related card's $${RELATED_USD} was merged into the viewed card's total`)
        .toHaveText(`$${SOLO_USD.toFixed(2)}`);
      // And the related card is STILL its own top-level row, not consumed by the card pointing at it.
      await expect(taskRow(page, seeded.related.id)).toBeVisible();
      await expect(page.getByTestId(`project-usage-relations-${short(seeded.solo.id)}`))
        .toContainText("never added to the figure above");

      // ── 4. THE THREE BUCKETS ADD UP TO THE STATED TOTAL. ──
      await expect(page.getByTestId("project-usage-overhead")).toContainText(`$${OVERHEAD_USD.toFixed(2)}`);
      await expect(page.getByTestId("project-usage-overhead")).toContainText("Orchestration overhead");
      await expect(page.getByTestId("project-usage-unattributed")).toContainText(`$${UNATTRIBUTED_USD.toFixed(2)}`);
      await expect(page.getByTestId("project-usage-unattributed")).toContainText("Unattributed");
      await expect(page.getByTestId("project-usage-total-cost")).toContainText(`$${GRAND_USD.toFixed(2)}`);
      // The page never says its rows are incomplete, because they are not.
      await expect(page.getByTestId("project-usage-residual")).toHaveCount(0);

      // SUMMED FROM THE DOM, not from the seed: the four task rows visible while collapsed (the epic
      // carrying its child) plus the two buckets must equal the total the page states above them.
      await expander(page, seeded.solo.id).click();
      const figures = await visibleUsd(page, [
        `project-usage-cost-${short(seeded.epic.id)}`,
        `project-usage-cost-${short(seeded.solo.id)}`,
        `project-usage-cost-${short(seeded.related.id)}`,
        "project-usage-overhead",
        "project-usage-unattributed",
      ]);
      const summed = figures.reduce((a, b) => a + b, 0);
      const [stated] = await visibleUsd(page, ["project-usage-total-cost"]);
      expect(summed, `the visible rows (${figures.join(" + ")}) do not add up to the stated total ${stated}`)
        .toBeCloseTo(stated!, 2);
      expect(stated, "the stated total is not the seeded grand total").toBeCloseTo(GRAND_USD, 2);

      // ── 5b. THE DISCLOSURE SAYS THE FOUR HONEST THINGS. ──
      const disclosure = page.getByTestId("project-usage-disclosure");
      await expect(disclosure).toContainText("ESTIMATE");
      await expect(disclosure).toContainText("Unattributed");
      await expect(disclosure).toContainText("Orchestration overhead");
      await expect(disclosure).toContainText("account-wide");

      // And the window narrows back, so 5a's widening was the control doing it rather than a one-way
      // settle: a 24-hour window returns the tab to its empty state.
      await page.getByTestId("project-usage-window").selectOption({ label: "Last 24 hours" });
      await expect(page.getByTestId("project-usage-empty")).toBeVisible();
      await expect(taskRow(page, seeded.solo.id)).toHaveCount(0);
    });
});
