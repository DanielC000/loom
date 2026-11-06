// The session's Loom MCP activity strip under the composer (card a9a7140c, owner pick B · Ledger).
//
// The transcript route is stubbed with turns written in the exact text shape the daemon serves
// (packages/daemon/src/pty/claude-transcript.ts `extractText`), so the strip's parser runs against the
// real wire format with no real claude, and the seeded calls are this spec's own sentinel data.
//
// Record: docs/decisions/a9a7140c-session-mcp-activity.md
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

async function seedAtlasOn(page: Page, projectId: string) {
  await page.addInitScript(([atlasKey, projectKey, id]) => {
    try { localStorage.setItem(atlasKey, "1"); localStorage.setItem(projectKey, id); } catch { /* assertions will say so */ }
  }, [ATLAS_KEY, PROJECT_KEY, projectId] as const);
}

const call = (tag: string, name: string, args: Record<string, unknown>) => `[tool] {${tag}} ${name}(${JSON.stringify(args)})`;

/** Three agent turns, five Loom calls, one transport error, plus a native Read call that must not count. */
const TRANSCRIPT = [
  { role: "user", text: "Kick off: pick up card a9a7140c." },
  { role: "assistant", text: [
    "Looking at the board.",
    call("tag00001", "mcp__loom-tasks__tasks_list", { columnKey: "in_progress" }),
    call("tag00002", "Read", { file_path: "C:/repo/x.ts" }),
    call("tag00003", "mcp__loom-orchestration__worker_list", {}),
  ].join("\n") },
  { role: "tool_result", text: "-> tool result {tag00001}: [{\"id\":\"a9a7140c\"}]\n-> tool result {tag00002}: 1 x\n-> tool result {tag00003}: {\"workers\":[]}" },
  { role: "user", text: "[loom:from-worker] 1c07b3e5 progress" },
  { role: "assistant", text: call("tag00004", "mcp__loom-orchestration__worker_redirect",
    { sessionId: "1c07b3e5-0000-4000-8000-000000000000", text: "Stop: <b>rebase</b> first." }) },
  { role: "tool_result", text: "-> tool result {tag00004} (error): MCP error -32602: session 1c07b3e5 is not live (processState=exited)" },
  { role: "user", text: "Owner: go ahead." },
  { role: "assistant", text: [
    call("tag00005", "mcp__loom-tasks__memory_read", { key: "atlas-session-node-build-p2-7" }),
    call("tag00006", "mcp__loom-tasks__tasks_update", { id: "a9a7140c-3591-403c-9c2b-6f2311de7f37", columnKey: "review" }),
  ].join("\n") },
  { role: "tool_result", text: "-> tool result {tag00005}: {\"version\":2}\n-> tool result {tag00006}: {\"columnKey\":\"review\",\"version\":5}" },
];

/** Card 825e38da: one refused call (a successful result with an {error} body), one ok call, and one ok
 *  call whose answer was cut at the daemon's 2 KB cap (unclassified: never read as refused). */
const CUT = `{"error":"x","pad":"${"y".repeat(2100)}`.slice(0, 2048) + "... [+77 chars truncated]";
const REFUSAL_TRANSCRIPT = [
  { role: "user", text: "Kick off: dispatch card 7e2a90b4." },
  { role: "assistant", text: [
    call("ref00001", "mcp__loom-tasks__tasks_get", { id: "7e2a90b4" }),
    call("ref00002", "mcp__loom-orchestration__worker_spawn", { taskId: "7e2a90b4", agentId: "web-designer" }),
    call("ref00003", "mcp__loom-tasks__memory_list", {}),
  ].join("\n") },
  { role: "tool_result", text: [
    "-> tool result {ref00001}: {\"id\":\"7e2a90b4\",\"columnKey\":\"todo\"}",
    "-> tool result {ref00002}: {\"error\":\"concurrency cap reached: 3 of 3 live workers.\",\"capacity\":{\"live\":3,\"max\":3}}",
    `-> tool result {ref00003}: ${CUT}`,
  ].join("\n") },
];

async function openSession(page: Page, loomDaemon: LoomDaemon, transcript: ReadonlyArray<{ role: string; text: string }> = TRANSCRIPT) {
  const mgr = await loomDaemon.seedLiveSession({
    role: "manager", agentName: "McpLead", id: `e2e-mcp-${Date.now()}`,
    ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
  });
  // The strip fetches the whole transcript first, then `?offset=N` tails: serve both shapes.
  await page.route(new RegExp(`/api/sessions/${mgr.sessionId}/transcript(\\?.*)?$`), (route) => {
    const offset = new URL(route.request().url()).searchParams.get("offset");
    if (offset === null) return route.fulfill({ json: transcript });
    const start = Math.min(Number(offset), transcript.length);
    return route.fulfill({ json: { turns: transcript.slice(start), totalTurns: transcript.length, offset: start, returned: transcript.length - start, nextOffset: null } });
  });
  await seedAtlasOn(page, mgr.projectId);
  await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
  return mgr;
}

const entries = (page: Page) => page.getByTestId("mcp-activity-log").locator(".loom-mcp-ent");

test.describe("session Loom MCP activity strip", () => {
  test("compact: the latest Loom call as a sentence, under the composer", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon);

    const latest = page.getByTestId("mcp-activity-latest");
    await expect(latest).toHaveText("Moved card a9a7140c to Review");
    // Five Loom calls: the native Read call is not one of them.
    await expect(page.getByTestId("mcp-activity-count")).toHaveText("5");
    await expect(page.getByTestId("mcp-activity-bar")).toContainText("1 error");
    await expect(page.getByTestId("mcp-activity-bar")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("mcp-activity-log")).toHaveCount(0);

    // It sits under the composer.
    const composerBox = await page.getByTestId("session-node-composer").boundingBox();
    const stripBox = await page.getByTestId("session-node-mcp").boundingBox();
    expect(composerBox && stripBox && stripBox.y >= composerBox.y + composerBox.height).toBe(true);
  });

  test("expanded: grouped by agent turn, the facet filter narrows, an error reads as an error", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon);

    await page.getByTestId("mcp-activity-bar").click();
    await expect(page.getByTestId("mcp-activity-bar")).toHaveAttribute("aria-expanded", "true");
    const log = page.getByTestId("mcp-activity-log");
    await expect(log).toBeVisible();

    // Turns newest first; each turn holds exactly its own calls, newest first.
    await expect(log.locator("[data-testid^='mcp-turn-']")).toHaveCount(3);
    const turnIds = await log.locator("[data-testid^='mcp-turn-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(turnIds).toEqual(["mcp-turn-3", "mcp-turn-2", "mcp-turn-1"]);
    const callsIn = (turn: number) => page.getByTestId(`mcp-turn-${turn}`).locator(".loom-mcp-ent")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(await callsIn(3)).toEqual(["mcp-call-5", "mcp-call-4"]);
    expect(await callsIn(2)).toEqual(["mcp-call-3"]);
    expect(await callsIn(1)).toEqual(["mcp-call-2", "mcp-call-1"]);
    await expect(page.getByTestId("mcp-turn-2")).toContainText("1 call · 1 error");

    // The error row: marked, coloured, and its answer is the error text, red.
    const errRow = page.getByTestId("mcp-call-3");
    await expect(errRow).toHaveAttribute("data-outcome", "error");
    await expect(errRow).toContainText("Tried to redirect worker 1c07b3e5");
    // Colours resolved from the live tokens (helpers/themeToken.ts), never typed as literals.
    const red = await cssColor(page, "--loom-danger");
    await expect(errRow.getByRole("img", { name: "error" })).toHaveCSS("color", red);
    await expect(page.getByTestId("mcp-call-5").getByRole("img", { name: "ok" })).toHaveCSS("color", await cssColor(page, "--loom-live"));
    await errRow.click();
    await expect(errRow).toHaveAttribute("aria-expanded", "true");
    const detail = page.getByTestId("mcp-call-3-detail");
    await expect(detail).toContainText("Asked Loom");
    await expect(page.getByTestId("mcp-call-3-answer")).toHaveText("MCP error -32602: session 1c07b3e5 is not live (processState=exited)");
    await expect(page.getByTestId("mcp-call-3-answer")).toHaveCSS("color", red);
    // Agent-authored argument text is shown as text, never parsed as HTML.
    await expect(detail).toContainText("Stop: <b>rebase</b> first.");
    await expect(detail.locator("pre b")).toHaveCount(0);

    // Facets narrow: error only, then Board only, then clear.
    await expect(entries(page)).toHaveCount(5);
    await page.getByTestId("mcp-facet-outcome-error").click();
    await expect(page.getByTestId("mcp-facet-outcome-error")).toHaveAttribute("aria-pressed", "true");
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(1);
    await expect(log.locator(".loom-mcp-ent")).toHaveAttribute("data-testid", "mcp-call-3");
    await page.getByTestId("mcp-facet-outcome-error").click();
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(5);
    await page.getByTestId("mcp-facet-sub-board").click();
    const boardRows = await log.locator(".loom-mcp-ent").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(boardRows).toEqual(["mcp-call-5", "mcp-call-1"]);
    await page.getByTestId("mcp-filter-clear").click();
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(5);
    await page.getByTestId("mcp-facet-router-loom-orchestration").click();
    const orchRows = await log.locator(".loom-mcp-ent").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(orchRows).toEqual(["mcp-call-3", "mcp-call-2"]);

    // Collapse.
    await page.getByTestId("mcp-activity-bar").click();
    await expect(page.getByTestId("mcp-activity-log")).toHaveCount(0);
  });

  test("a refused call (error field in a successful answer) is amber, counted, and filterable apart from ok and error", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon, REFUSAL_TRANSCRIPT);

    // Compact: the count names the refusal; the turn's bead for it is amber; there is no error.
    const bar = page.getByTestId("mcp-activity-bar");
    await expect(page.getByTestId("mcp-activity-count")).toHaveText("3");
    await expect(page.getByTestId("mcp-activity-refused-count")).toHaveText("· 1 refused");
    await expect(page.getByTestId("mcp-activity-refused-count")).toHaveAttribute("title", /error field/);
    await expect(bar).not.toContainText("error");
    const amber = await cssColor(page, "--loom-attn");
    await expect(bar.locator(".loom-mcp-bead.refused")).toHaveCount(1);
    await expect(bar.locator(".loom-mcp-bead.refused")).toHaveCSS("border-top-color", amber);

    await bar.click();
    const log = page.getByTestId("mcp-activity-log");
    const refusedRow = page.getByTestId("mcp-call-2");
    await expect(refusedRow).toHaveAttribute("data-outcome", "refused");
    await expect(refusedRow).toContainText("Tried to spawn a worker for card 7e2a90b4");
    const mark = refusedRow.getByRole("img", { name: "refused" });
    await expect(mark).toHaveText("!");
    await expect(mark).toHaveCSS("color", amber);
    // The plain ok call and the call whose answer was cut at 2 KB both stay ok.
    await expect(page.getByTestId("mcp-call-1")).toHaveAttribute("data-outcome", "ok");
    await expect(page.getByTestId("mcp-call-3")).toHaveAttribute("data-outcome", "ok");
    await expect(page.getByTestId("mcp-turn-1")).toContainText("3 calls · 1 refused");

    // The rail labels the heuristic, and counts the answer it could not read.
    await expect(page.getByTestId("mcp-refused-legend")).toContainText("refused is a guess: the answer carried an error field.");
    await expect(page.getByTestId("mcp-unclassified-count")).toContainText("1 answer too long to check.");
    await expect(page.getByTestId("mcp-facet-outcome-refused")).toContainText("1");
    await expect(page.getByTestId("mcp-facet-outcome-error")).toContainText("0");

    // Exercise the refused facet: the list narrows to the refusal, then widens back.
    const rows = () => log.locator(".loom-mcp-ent").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(await rows()).toEqual(["mcp-call-3", "mcp-call-2", "mcp-call-1"]);
    const facet = page.getByTestId("mcp-facet-outcome-refused");
    await expect(facet).toHaveAttribute("aria-pressed", "false");
    await facet.click();
    await expect(facet).toHaveAttribute("aria-pressed", "true");
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(1);
    expect(await rows()).toEqual(["mcp-call-2"]);
    // ok and refused are separate facets: ok alone excludes the refusal.
    await facet.click();
    await page.getByTestId("mcp-facet-outcome-ok").click();
    expect(await rows()).toEqual(["mcp-call-3", "mcp-call-1"]);
    await page.getByTestId("mcp-filter-clear").click();
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(3);

    // The answer is the refusal body, in amber, with the heuristic stated beside it.
    await refusedRow.click();
    await expect(page.getByTestId("mcp-call-2-answer")).toContainText("concurrency cap reached");
    await expect(page.getByTestId("mcp-call-2-answer")).toHaveCSS("color", amber);
    await expect(page.getByTestId("mcp-call-2-detail")).toContainText("Read as refused.");
  });

  // The transcript route has no tail, so every poll is the whole transcript. Counts real requests.
  test("polls the whole transcript sparingly: idle backoff, and no second timer beside the Transcript tab", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const mgr = await openSession(page, loomDaemon);
    const url = `/api/sessions/${mgr.sessionId}/transcript`;
    let polls = 0;
    page.on("request", (req) => { if (new URL(req.url()).pathname === url) polls++; });
    await expect(page.getByTestId("mcp-activity-latest")).toBeVisible();

    // Idle + compact: 15s backoff, so a 10s window right after load sees no poll (5s would see 2).
    polls = 0;
    await page.waitForTimeout(10_000);
    expect(polls, "idle compact strip polled inside its 15s backoff").toBe(0);

    // Expanded + Transcript tab open: both views observe ONE query key, so react-query re-arms their
    // timers together and the URL is fetched on one 5s cadence (~2 in 11s). If the strip ever moved
    // to its own key, the same URL would get two independent timers (~4). The lower bound is the
    // positive control that this counter sees polls at all.
    await page.getByTestId("mcp-activity-bar").click();
    await page.getByTestId("atlas-node-tabs").getByRole("tab", { name: "Transcript" }).click();
    await expect(page.getByTestId("session-node-pane-transcript")).toBeVisible();
    await expect(page.getByTestId("mcp-activity-log")).toBeVisible();
    await page.waitForTimeout(1_000);
    polls = 0;
    await page.waitForTimeout(11_000);
    expect(polls, "transcript polls in 11s with the Transcript tab open").toBeGreaterThanOrEqual(1);
    expect(polls, "transcript polls in 11s with the Transcript tab open").toBeLessThanOrEqual(3);
  });

  test("a session with no Loom calls says so instead of an empty box", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "McpQuiet", id: `e2e-mcpq-${Date.now()}`,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await page.route(`**/api/sessions/${mgr.sessionId}/transcript`, (route) =>
      route.fulfill({ json: [{ role: "user", text: "hi" }, { role: "assistant", text: call("t1", "Read", { file_path: "x" }) }] }));
    await seedAtlasOn(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("mcp-activity")).toHaveAttribute("data-state", "empty");
    await expect(page.getByTestId("mcp-activity")).toContainText("No Loom MCP calls yet this session.");
    await expect(page.getByTestId("mcp-activity-bar")).toHaveCount(0);
  });
});
