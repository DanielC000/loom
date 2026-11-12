// The Atlas project Overview's audit-B polish — card 006ed11f (epic 898a64ef).
//
// What each leg measures, and why it can fail:
//   1. ONE STATUS VOCABULARY (B-10). For every seeded session, the "Work in flight" pill and the
//      "Sessions" pill read the SAME word. The fleet is chosen so the two old functions disagree on
//      every row: a busy manager holding a pending Request ("waiting on you" vs the old "working"),
//      an idle worker ("idle" vs "live") and a busy worker ("working" in both — the control row).
//   2. NAMES SURVIVE A PHONE (B-11). At 390 every Sessions row shows its agent name unclipped, with
//      the pills on a line BELOW it. Before the fix the name's box measured 1px wide.
//   3. THE LANE LEGEND IS A WAY IN (G-07). A chip lands on the Board tab at THAT lane, marks it, and
//      clears `?lane=` from the address; keyboard activation is exercised, not only a click.
//   4. AN EMPTY PROJECT OFFERS ITS NEXT STEP (G-04). No agents → "＋ New agent" (opening the real
//      editor) and no Spawn; once an agent exists → Spawn as well, opening the real spawn panel.
//   5. THE FOOTNOTES ARE PROSE (B-20). Sans, and held to a reading measure at 1440.
//
// Presence-first throughout: every absence is asserted only after something that must BE there.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";

async function openOverview(page: Page, loomDaemon: LoomDaemon, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try { localStorage.setItem(projectKey, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
  await page.goto(loomDaemon.baseURL + "/project");
  await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedMixedFleet(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("ovstatus"));
  await loomDaemon.createTask(project.id, { title: uniq("ovstatus-review"), columnKey: "review" });
  const short = `${Math.floor(Math.random() * 1e6)}`;
  const mgr = await loomDaemon.seedLiveSession({
    project, id: `e2e-osmgr-${short}`, agentName: `StatusLead-${short}`, role: "manager", busy: true,
  });
  const idle = await loomDaemon.seedLiveSession({
    project, id: `e2e-osidl-${short}`, agentName: `StatusIdle-${short}`, role: "worker",
    parentSessionId: mgr.sessionId, busy: false,
  });
  const busy = await loomDaemon.seedLiveSession({
    project, id: `e2e-osbsy-${short}`, agentName: `StatusBusy-${short}`, role: "worker",
    parentSessionId: mgr.sessionId, busy: true,
  });
  await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: project.id, title: uniq("ovstatus-ask") });
  return { project, rows: [
    { id: mgr.sessionId, name: `StatusLead-${short}`, want: "waiting on you" },
    { id: idle.sessionId, name: `StatusIdle-${short}`, want: "idle" },
    { id: busy.sessionId, name: `StatusBusy-${short}`, want: "working" },
  ] };
}

test.describe("Atlas project Overview — one status vocabulary, guided empty states (card 006ed11f)", () => {
  test("the roster and the Sessions card read each session with the same word", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { project, rows } = await seedMixedFleet(loomDaemon);
    await openOverview(page, loomDaemon, project.id);
    for (const r of rows) {
      const roster = page.locator(`[data-testid="atlas-roster-row"][data-session-id="${r.id}"]`).getByTestId("atlas-roster-state");
      const sessions = page.getByTestId(`atlas-psession-row-${r.id}`).getByTestId("session-row-state");
      await expect(roster, `${r.name} roster pill`).toHaveText(r.want);
      await expect(sessions, `${r.name} Sessions pill`).toHaveText(r.want);
    }
  });

  test("at 390 a Sessions row keeps its name whole and stacks the pills under it", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { project, rows } = await seedMixedFleet(loomDaemon);
    await openOverview(page, loomDaemon, project.id);
    for (const r of rows) {
      const row = page.getByTestId(`atlas-psession-row-${r.id}`);
      await expect(row.locator(".loom-wsession-agent")).toHaveText(r.name);
      const m = await row.evaluate((el) => {
        const id = el.querySelector<HTMLElement>(".loom-wsession-id")!;
        const agent = el.querySelector<HTMLElement>(".loom-wsession-agent")!.getBoundingClientRect();
        const state = el.querySelector<HTMLElement>(".loom-wsession-state")!.getBoundingClientRect();
        const idBox = id.getBoundingClientRect();
        return { agentRight: agent.right, idRight: idBox.right, idBottom: idBox.bottom, stateTop: state.top };
      });
      expect(m.agentRight, `${r.name} is not clipped by its row`).toBeLessThanOrEqual(m.idRight + 0.5);
      expect(m.stateTop, `${r.name}'s pills sit below its name`).toBeGreaterThanOrEqual(m.idBottom - 0.5);
    }
  });

  test("a lane legend chip opens the Board tab at that lane", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { project } = await seedMixedFleet(loomDaemon);
    await openOverview(page, loomDaemon, project.id);
    const chip = page.getByTestId("atlas-overview-lane-review");
    await expect(chip).toHaveAttribute("href", "/board?lane=review");
    await chip.scrollIntoViewIfNeeded();
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-lane-key="review"][data-lane-flash]')).toHaveCount(1);
    await expect(page).toHaveURL(/\/board$/);
    // The mark is momentary: it clears on its own, leaving the board as it was.
    await expect(page.locator('[data-lane-key="review"][data-lane-flash]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-lane-key="review"]')).toBeInViewport();
  });

  test("an empty project names its next step", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const project = await loomDaemon.createProject(uniq("ovempty"));
    await openOverview(page, loomDaemon, project.id);
    const empty = page.getByTestId("atlas-overview-empty");
    await expect(empty).toContainText("no agents yet");
    const newAgent = page.getByTestId("atlas-overview-empty-new-agent");
    await expect(newAgent).toBeVisible();
    await expect(page.getByTestId("atlas-overview-empty-spawn-open")).toHaveCount(0);
    await newAgent.click();
    await expect(page.getByTestId("atlas-agent-editor")).toBeVisible();
    await page.getByTestId("atlas-agent-editor-close").click();
    await expect(page.getByTestId("atlas-agent-editor")).toHaveCount(0);
  });

  test("a project with agents but no sessions offers Spawn", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const project = await loomDaemon.createProject(uniq("ovidle"));
    // Through the same REST route the agent editor saves through.
    const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: uniq("OvEmptyAgent") }),
    });
    expect(res.ok).toBe(true);
    await openOverview(page, loomDaemon, project.id);
    const empty = page.getByTestId("atlas-overview-empty");
    await expect(empty).toContainText("Spawn an agent");
    await expect(page.getByTestId("atlas-overview-empty-new-agent")).toBeVisible();
    const spawn = page.getByTestId("atlas-overview-empty-spawn-open");
    await expect(spawn).toBeVisible();
    await spawn.click();
    await expect(page.getByTestId("atlas-overview-empty-spawn")).toBeVisible();
  });

  test("the card footnotes are sans prose held to a reading measure", async ({ page, loomDaemon }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { project } = await seedMixedFleet(loomDaemon);
    await openOverview(page, loomDaemon, project.id);
    const foot = page.getByTestId("atlas-overview-roster").locator(".loom-ovcard-foot");
    await expect(foot).toContainText("Context is measured");
    const m = await foot.evaluate((el) => {
      const p = el.querySelector("p")!;
      return { font: getComputedStyle(p).fontFamily, text: p.getBoundingClientRect().width, box: el.getBoundingClientRect().width };
    });
    expect(m.font).not.toMatch(/mono/i);
    expect(m.text, "the text stops short of the card's full width").toBeLessThan(m.box * 0.8);
  });
});
