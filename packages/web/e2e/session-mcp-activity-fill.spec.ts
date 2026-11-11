// The expanded Loom MCP activity panel's call log fills the panel body (card d3d10823).
//
// The log used to carry its own max-height (520px), while the body's height came from the taller facet
// rail, so a long log stopped short and left a blank band under the list. The bound now sits on the
// body (`.loom-mcp-x`): both columns stretch to the one row and each scrolls on its own. This measures
// the log's and the rail's bottom edges against the body's bottom edge with a long and a short call list,
// at 1440 and 1920, in both themes.
//
// Opt-in visual capture: set LOOM_E2E_SHOTS to a dir to keep the panel shots; unset (CI) it is a no-op.
//
// Record: docs/decisions/a9a7140c-session-mcp-activity.md
import path from "node:path";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const shotDir = process.env.LOOM_E2E_SHOTS;

type Turn = { role: string; text: string };
const call = (tag: string, name: string, args: Record<string, unknown>) => `[tool] {${tag}} ${name}(${JSON.stringify(args)})`;

/** Many distinct tools across both routers, so the facet rail is tall AND the log is far taller. */
const TOOLS = [
  "mcp__loom-tasks__tasks_get", "mcp__loom-tasks__tasks_list", "mcp__loom-tasks__tasks_update",
  "mcp__loom-tasks__memory_read", "mcp__loom-tasks__memory_list", "mcp__loom-tasks__wake_me",
  "mcp__loom-orchestration__worker_list", "mcp__loom-orchestration__worker_message",
  "mcp__loom-orchestration__gate_queue", "mcp__loom-orchestration__gate_status",
];
const LONG_TURNS = 30;
const LONG_PER_TURN = 4;
function longTranscript(): Turn[] {
  const out: Turn[] = [];
  let n = 0;
  for (let t = 0; t < LONG_TURNS; t++) {
    out.push({ role: "user", text: `Kick off step ${t}.` });
    const tags: string[] = [];
    const lines: string[] = [];
    for (let i = 0; i < LONG_PER_TURN; i++) {
      const tag = `fil${String(n).padStart(5, "0")}`;
      tags.push(tag);
      lines.push(call(tag, TOOLS[n % TOOLS.length]!, { id: `d3d1${String(n).padStart(4, "0")}` }));
      n++;
    }
    out.push({ role: "assistant", text: lines.join("\n") });
    out.push({ role: "tool_result", text: tags.map((tag) => `-> tool result {${tag}}: {"ok":true}`).join("\n") });
  }
  return out;
}
const LONG_COUNT = LONG_TURNS * LONG_PER_TURN;

const SHORT: Turn[] = [
  { role: "user", text: "Kick off: card d3d10823." },
  { role: "assistant", text: [
    call("sho00001", "mcp__loom-tasks__tasks_get", { id: "d3d10823" }),
    call("sho00002", "mcp__loom-orchestration__worker_list", {}),
  ].join("\n") },
  { role: "tool_result", text: "-> tool result {sho00001}: {\"id\":\"d3d10823\"}\n-> tool result {sho00002}: {\"workers\":[]}" },
];

async function openExpanded(page: Page, loomDaemon: LoomDaemon, transcript: Turn[], theme: "light" | "dark") {
  const mgr = await loomDaemon.seedLiveSession({
    role: "manager", agentName: "McpFill", id: `e2e-mcpfill-${Date.now()}`,
    ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
  });
  await page.route(new RegExp(`/api/sessions/${mgr.sessionId}/transcript(\\?.*)?$`), (route) => {
    const offset = new URL(route.request().url()).searchParams.get("offset");
    if (offset === null) return route.fulfill({ json: transcript });
    const start = Math.min(Number(offset), transcript.length);
    return route.fulfill({ json: { turns: transcript.slice(start), totalTurns: transcript.length, offset: start, returned: transcript.length - start, nextOffset: null } });
  });
  await page.addInitScript(([projectId, t]) => {
    try {
      localStorage.setItem("loom.projectId", projectId);
      localStorage.setItem("loom.theme", t);
    } catch { /* the theme/fixture assertions below will say so */ }
  }, [mgr.projectId, theme] as const);
  await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByTestId("mcp-activity-bar").click();
  await expect(page.getByTestId("mcp-activity-log")).toBeVisible();
}

/** Bottom edges (viewport px) of the body, the log and the rail, plus each scroller's heights. */
async function measure(page: Page) {
  return page.getByTestId("mcp-activity").evaluate((root) => {
    const body = root.querySelector<HTMLElement>(".loom-mcp-x")!;
    const log = root.querySelector<HTMLElement>("[data-testid='mcp-activity-log']")!;
    const rail = root.querySelector<HTMLElement>(".loom-mcp-facets")!;
    const b = body.getBoundingClientRect();
    // The body's bottom border-box edge minus its own bottom border: where its content box ends.
    const bodyBottom = b.bottom - parseFloat(getComputedStyle(body).borderBottomWidth || "0");
    return {
      bodyBottom, bodyHeight: b.height,
      logBottom: log.getBoundingClientRect().bottom, logClient: log.clientHeight, logScroll: log.scrollHeight,
      railBottom: rail.getBoundingClientRect().bottom, railScroll: rail.scrollHeight,
    };
  });
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }] as const;

test.describe("session Loom MCP activity · the log fills its panel (card d3d10823)", () => {
  for (const vp of VIEWPORTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`long log at ${vp.width}: fills the body and scrolls inside it (${theme})`, async ({ page, loomDaemon }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(vp);
        await openExpanded(page, loomDaemon, longTranscript(), theme);
        // Fixture identity: exactly this spec's seeded calls, not some other session's data.
        await expect(page.getByTestId("mcp-activity-count")).toHaveText(String(LONG_COUNT));
        await expect(page.getByTestId("mcp-activity-log").locator(".loom-mcp-ent")).toHaveCount(LONG_COUNT);

        const m = await measure(page);
        // The log runs to the body's bottom edge: no blank band under the list.
        expect(Math.abs(m.logBottom - m.bodyBottom), JSON.stringify(m)).toBeLessThanOrEqual(2);
        expect(Math.abs(m.railBottom - m.bodyBottom), JSON.stringify(m)).toBeLessThanOrEqual(2);
        // The body stays bounded (clamp max 760px) and the log scrolls inside it.
        expect(m.bodyHeight, JSON.stringify(m)).toBeLessThanOrEqual(762);
        expect(m.logScroll, JSON.stringify(m)).toBeGreaterThan(m.logClient + 50);
        // Discriminating condition: the log's box is taller than the old 520px cap, so a log capped on
        // its own would have stopped short of the body.
        expect(m.logClient, JSON.stringify(m)).toBeGreaterThan(530);

        // It really scrolls: the last call is reachable inside the log, and the page did not grow to fit it.
        const log = page.getByTestId("mcp-activity-log");
        await log.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        const lastBox = await log.locator(".loom-mcp-ent").last().boundingBox();
        expect(lastBox && lastBox.y + lastBox.height <= m.logBottom + 1, JSON.stringify({ lastBox, m })).toBe(true);
        await log.evaluate((el) => { el.scrollTop = 0; });

        if (shotDir) await page.getByTestId("mcp-activity").screenshot({ path: path.join(shotDir, `mcp-fill-long-${vp.width}-${theme}.png`) });
      });
    }

    test(`short log at ${vp.width}: the log column still meets the body's bottom edge`, async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(vp);
      await openExpanded(page, loomDaemon, SHORT, "dark");
      await expect(page.getByTestId("mcp-activity-count")).toHaveText("2");
      await expect(page.getByTestId("mcp-activity-log").locator(".loom-mcp-ent")).toHaveCount(2);

      const m = await measure(page);
      expect(Math.abs(m.logBottom - m.bodyBottom), JSON.stringify(m)).toBeLessThanOrEqual(2);
      expect(Math.abs(m.railBottom - m.bodyBottom), JSON.stringify(m)).toBeLessThanOrEqual(2);
      // Two calls do not scroll, and the body sizes to its content rather than to the bound.
      expect(m.logScroll, JSON.stringify(m)).toBeLessThanOrEqual(m.logClient + 1);
      expect(m.railScroll, JSON.stringify(m)).toBeLessThanOrEqual(m.bodyHeight + 1);

      if (shotDir) await page.getByTestId("mcp-activity").screenshot({ path: path.join(shotDir, `mcp-fill-short-${vp.width}-dark.png`) });
    });
  }
});
