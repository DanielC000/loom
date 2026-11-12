// The Workspace home's labels, card 73b41b5d (Atlas audit child of epic 898a64ef, findings A-10, A-15,
// A-19, A-35). A-13 (Clear usage hold's weight) is in atlas-fleet-controls.spec.ts beside the rest of
// that cluster.
//
//   A-10  The gate pair is spaced (`0 · 0`, never `0·0`), and the Gate lanes row spells its two figures
//         out without truncating either.
//   A-15  The `needs you` tile names its parts, and the parts add up to the tile's own figure.
//   A-19  A session row gives way PROJECT first: with a long project and a long agent, the agent keeps
//         more room than the project and the short id is never cut. A tree row's badges reach its
//         accessible name with words and a separator, not as digits glued to the name.
//   A-35  A project card's live count is worded and each lane segment names its lane.
//
// Every claim is scoped to rows this spec seeded: the e2e daemon is shared across spec files.
import { expect, test, type Page } from "./fixtures/daemon";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("Atlas home labels (card 73b41b5d)", () => {
  test("gate pair, needs-you split, session-row truncation order, tree badge names, project card labels", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    // A long project and a long agent, the audit's own stress shape.
    const longName = uniq("AUDIT-Delta Extremely Long Customer Onboarding And Billing Reconciliation Platform");
    const project = await loomDaemon.createProject(longName);
    const longAgent = "Senior Full-Stack Billing Reconciliation And Customer Onboarding Engineer Lead";
    const mgr = await loomDaemon.seedLiveSession({ project, id: uniq("lblmgr"), role: "manager", agentName: longAgent });
    await loomDaemon.createTask(project.id, { title: uniq("lane-card"), columnKey: "todo" });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: project.id, title: uniq("labels request") });

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(loomDaemon.baseURL + "/home");

    // FIXTURE IDENTITY first: this spec's own project card and session row are on the page.
    const card = page.getByTestId(`atlas-project-card-${project.id}`);
    const row = page.getByTestId(`atlas-session-row-${mgr.sessionId}`);
    await expect(card).toBeVisible();
    await expect(row).toBeVisible();

    // ── A-10 ── the spaced pair, on the tile and the tab, and the lanes row spelled out.
    await expect(page.getByTestId("atlas-kpi-gates").locator(".loom-kpi-value")).toHaveText(/^\d+ · \d+$/);
    await expect(page.getByTestId("atlas-tab-gates").locator(".loom-atlas-tabcount")).toHaveText(/^\d+ · \d+$/);
    const meter = page.getByTestId("atlas-band-gates").locator(".loom-meterrow").first();
    await expect(meter.locator(".loom-meterrow-l")).toHaveText(/^\d+ running$/);
    await expect(meter.locator(".loom-meterrow-v")).toHaveText(/^\d+ queued$/);
    const meterFits = await meter.evaluate((el) => {
      const l = el.querySelector(".loom-meterrow-l") as HTMLElement;
      return { label: l.scrollWidth <= l.clientWidth, row: el.scrollWidth <= el.clientWidth };
    });
    expect(meterFits, "the Gate lanes figures are truncated or overflow their panel").toEqual({ label: true, row: true });

    // ── A-15 ── the needs-you parts are named and sum to the tile's figure.
    const needs = page.getByTestId("atlas-kpi-needs");
    await expect(needs.locator(".loom-kpi-sub")).toContainText(/\d+ requests?/);
    const total = Number(await needs.locator(".loom-kpi-value").innerText());
    const sub = await needs.locator(".loom-kpi-sub").innerText();
    const parts = [...sub.matchAll(/(\d+) (?:request|merge|notice|alert)s?/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(parts, `the split "${sub}" does not add up to the tile's ${total}`).toBe(total);
    // The pop-over says why the Inbox tab's number differs.
    await needs.click();
    await expect(page.getByTestId("atlas-kpi-pop-needs")).toContainText("The Inbox tab counts requests only");
    await page.keyboard.press("Escape");

    // ── A-19 ── project gives way first; the agent keeps more room; the id is never cut. At two widths:
    // at 1024 the project is down to its stub and the agent too has to give; at 1440 the project alone
    // absorbs the shortfall, so the agent must be WHOLE (a sub-pixel leak used to ellipsise it there).
    const measure = () => row.evaluate((el) => {
      const part = (sel: string) => {
        const node = el.querySelector(sel) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(node);
        return { box: node.getBoundingClientRect(), text: range.getBoundingClientRect().width, min: parseFloat(getComputedStyle(node).minWidth) };
      };
      const proj = part(".loom-wsession-proj"), agent = part(".loom-wsession-agent"), short = part(".loom-wsession-short");
      return {
        proj: proj.box.width, projAtStub: proj.box.width <= proj.min + 0.5,
        agent: agent.box.width, agentCut: agent.text > agent.box.width + 0.5,
        shortCut: short.text > short.box.width + 0.5 || short.box.right > (el.querySelector(".loom-wsession-id") as HTMLElement).getBoundingClientRect().right + 0.5,
      };
    });
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await measure()).shortCut, { message: `the short session id was cut off at ${width}` }).toBe(false);
      const m = await measure();
      expect(m.proj, `the project kept more of the row than the agent at ${width}`).toBeLessThan(m.agent);
      if (m.agentCut) expect(m.projAtStub, `the agent was cut at ${width} while the project still had room to give`).toBe(true);
    }
    await page.setViewportSize({ width: 1024, height: 900 });

    // Tree row: words and a separator, never digits glued onto the project's name.
    const branch = page.locator("nav button.loom-atlas-node.is-branch").filter({ hasText: new RegExp(escapeRe(longName)) });
    await expect(branch).toHaveAccessibleName(new RegExp(`^${escapeRe(longName)}\\s*, \\d+ needs? you\\s*, 1 live$`));

    // ── A-35 ── worded live count, and every lane segment names its lane.
    await expect(card.locator(".loom-projcard-head")).toContainText("1 live");
    // On ONE line beside a long name: a wrapped "1 / live" badge made that card taller than its row.
    // One line of ~12px text plus 4px padding is under 2em tall; two lines are well over it.
    const badgeLines = await card.locator(".loom-projcard-head").getByText("1 live", { exact: true }).evaluate((el) =>
      el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).fontSize) * 2);
    expect(badgeLines, "the worded live badge wrapped beside a long project name").toBe(true);
    const segTitles = await card.locator(".loom-laneseg").evaluateAll((els) => els.map((e) => e.getAttribute("title")));
    expect(segTitles.length, "the card's lane bar drew no segments").toBeGreaterThan(0);
    for (const t of segTitles) expect(t, "a lane segment has no lane name").toMatch(/^.+ · \d+$/);
  });
});
