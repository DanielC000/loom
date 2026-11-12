// The session's Loom MCP activity strip under the composer (card a9a7140c, owner pick B · Ledger).
//
// The transcript route is stubbed with turns written in the exact text shape the daemon serves
// (packages/daemon/src/pty/claude-transcript.ts `extractText`), so the strip's parser runs against the
// real wire format with no real claude, and the seeded calls are this spec's own sentinel data.
//
// Record: docs/decisions/a9a7140c-session-mcp-activity.md
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try { localStorage.setItem(projectKey, id); } catch { /* assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
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
  // The daemon's own worker-report frame, delivered inside a pasted_content wrapper (card 7627a850).
  { role: "user", text: "<pasted_content id=\"e2e1\">\n[loom:worker-report] worker 1c07b3e5-0000-4000-8000-000000000000 (task a9a7140c) — progress: retained view wired\n</pasted_content id=\"e2e1\">" },
  { role: "assistant", text: call("tag00004", "mcp__loom-orchestration__worker_redirect",
    { sessionId: "1c07b3e5-0000-4000-8000-000000000000", text: "Stop: <b>rebase</b> first." }) },
  { role: "tool_result", text: "-> tool result {tag00004} (error): MCP error -32602: session 1c07b3e5 is not live (processState=exited)" },
  { role: "user", text: "Owner: go ahead. <img src=x onerror=\"window.__mcpXss=1\"><b>ship</b> it" },
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

/** Card 0bcdd158: turns carry the engine `ts` the daemon's REST route now serves. Call 1's line has no
 *  ts (no time, no bar); call 2 has a time but its result line has none (no bar); call 3 is fully timed,
 *  1.45s apart (a time, "≈1.4s", a bar). */
const TS0 = "2026-11-06T10:14:05.000Z";
const TS1 = "2026-11-06T10:14:31.000Z";
const TS1_RESULT = "2026-11-06T10:14:32.450Z";
const TIMED_TRANSCRIPT = [
  { role: "user", text: "Kick off: card 0bcdd158.", ts: TS0 },
  { role: "assistant", text: call("tim00001", "mcp__loom-tasks__tasks_get", { id: "0bcdd158" }) },
  { role: "tool_result", text: "-> tool result {tim00001}: {\"id\":\"0bcdd158\"}", ts: TS0 },
  { role: "assistant", text: call("tim00002", "mcp__loom-orchestration__worker_list", {}), ts: TS0 },
  { role: "tool_result", text: "-> tool result {tim00002}: {\"workers\":[]}" },
  { role: "assistant", text: call("tim00003", "mcp__loom-tasks__tasks_update", { id: "0bcdd158", columnKey: "review" }), ts: TS1 },
  { role: "tool_result", text: "-> tool result {tim00003}: {\"columnKey\":\"review\"}", ts: TS1_RESULT },
];

async function openSession(page: Page, loomDaemon: LoomDaemon, transcript: ReadonlyArray<{ role: string; text: string; ts?: string }> = TRANSCRIPT) {
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
  await pinProject(page, mgr.projectId);
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
    await expect(page.getByTestId("mcp-call-5").getByRole("img", { name: "ok" })).toHaveCSS("color", await cssColor(page, "--loom-live-fg"));
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

  test("each turn says what opened it: your message, a worker report, the opening prompt; message text stays text", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon);

    // Compact: the latest turn was opened by the human's message.
    const compactCause = page.getByTestId("mcp-activity-cause");
    await expect(compactCause).toHaveText("after your message");
    await expect(compactCause).toHaveAttribute("data-cause", "human");

    await page.getByTestId("mcp-activity-bar").click();
    const human = page.getByTestId("mcp-cause-turn-3");
    const report = page.getByTestId("mcp-cause-turn-2");
    await expect(human).toHaveAttribute("data-cause", "human");
    await expect(report).toHaveAttribute("data-cause", "worker-report");
    await expect(page.getByTestId("mcp-cause-turn-1")).toHaveAttribute("data-cause", "opening");
    // The worker report is read through its pasted_content wrapper: id in mono, status beside it.
    await expect(report).toContainText("after worker report 1c07b3e5 (progress)");
    await expect(report.locator("b")).toHaveText("1c07b3e5");
    await expect(page.getByTestId("mcp-cause-turn-1")).toContainText("after the opening prompt");

    // The human's message is quoted as literal text: its markup is characters, not elements.
    await expect(human).toContainText("after your message");
    const quote = human.locator(".loom-mcp-quote");
    await expect(quote).toHaveText('Owner: go ahead. <img src=x onerror="window.__mcpXss=1"><b>ship</b> it');
    await expect(quote.locator("*")).toHaveCount(0);
    await expect(page.locator(".loom-mcp img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __mcpXss?: number }).__mcpXss)).toBeUndefined();
    // The header still counts the whole turn beside the cause.
    await expect(page.getByTestId("mcp-turn-2")).toContainText("1 call · 1 error");
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
    // The bead is a fill (--loom-attn); the "!" mark and the answer are text (--loom-attn-fg, card 9e67a900).
    const amber = await cssColor(page, "--loom-attn");
    const amberText = await cssColor(page, "--loom-attn-fg");
    await expect(bar.locator(".loom-mcp-bead.refused")).toHaveCount(1);
    await expect(bar.locator(".loom-mcp-bead.refused")).toHaveCSS("border-top-color", amber);

    await bar.click();
    const log = page.getByTestId("mcp-activity-log");
    const refusedRow = page.getByTestId("mcp-call-2");
    await expect(refusedRow).toHaveAttribute("data-outcome", "refused");
    await expect(refusedRow).toContainText("Tried to spawn a worker for card 7e2a90b4");
    const mark = refusedRow.getByRole("img", { name: "refused" });
    await expect(mark).toHaveText("!");
    await expect(mark).toHaveCSS("color", amberText);
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
    await expect(page.getByTestId("mcp-call-2-answer")).toHaveCSS("color", amberText);
    await expect(page.getByTestId("mcp-call-2-detail")).toContainText("Read as refused.");
  });

  test("timed rows show the call time and an approximate duration bar; an untimed row shows neither", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon, TIMED_TRANSCRIPT);
    // The browser's own local clock for a ts, the same reading the strip renders.
    const clock = (iso: string) => page.evaluate((s) => {
      const d = new Date(s), p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }, iso);

    // Compact: the latest call is timed, so its duration rides beside the tool name, marked approximate.
    await expect(page.getByTestId("mcp-activity-latest")).toHaveText("Moved card 0bcdd158 to Review");
    await expect(page.getByTestId("mcp-activity-latest-dur")).toHaveText("· ≈1.4s");
    await expect(page.getByTestId("mcp-activity-latest-dur")).toHaveAttribute("title", /Approximate/);

    await page.getByTestId("mcp-activity-bar").click();
    await expect(entries(page)).toHaveCount(3);

    // Call 3: a time, a figure and a visible bar.
    await expect(page.getByTestId("mcp-call-3-at")).toHaveText(await clock(TS1));
    await expect(page.getByTestId("mcp-call-3-dur")).toHaveText("≈1.4s");
    await expect(page.getByTestId("mcp-call-3-dur")).toHaveAttribute("title", /includes hook and harness time/);
    const bar = page.getByTestId("mcp-call-3-bar");
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())!.width).toBeGreaterThan(2);

    // Call 2: its own line has a time, but its result does not, so there is no duration and no bar.
    await expect(page.getByTestId("mcp-call-2-at")).toHaveText(await clock(TS0));
    await expect(page.getByTestId("mcp-call-2-dur")).toHaveCount(0);
    await expect(page.getByTestId("mcp-call-2-bar")).toHaveCount(0);

    // Call 1: no ts on its line, so no time, no duration, no bar, and no "0" anywhere in the row.
    const untimed = page.getByTestId("mcp-call-1");
    await expect(untimed).toContainText("Read card 0bcdd158");
    await expect(page.getByTestId("mcp-call-1-at")).toHaveCount(0);
    await expect(untimed.locator(".loom-mcp-t")).toHaveText("");
    await expect(page.getByTestId("mcp-call-1-dur")).toHaveCount(0);
    await expect(untimed.locator(".loom-mcp-dur i")).toHaveCount(0);
    await expect(untimed).not.toContainText("0ms");

    // The turn header: start time (its title carries the full local date, so a turn past midnight is
    // unambiguous), and the span from the first call to the last answer over the calls with both ts:
    // only call 3 here, so 1.45s.
    const turnAt = page.getByTestId("mcp-turn-1-at");
    await expect(turnAt).toHaveText((await clock(TS0)).slice(0, 5));
    const fullLocal = await page.evaluate((s) => {
      const d = new Date(s), p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }, TS0);
    await expect(turnAt).toHaveAttribute("title", `first Loom call at ${fullLocal}`);
    const total = page.getByTestId("mcp-turn-1-total");
    await expect(total).toHaveText("· ≈1.4s");
    await expect(total).toHaveAttribute("title", "Time from the first Loom call to the last answer in this turn (approximate).");
    await expect(page.getByTestId("mcp-turn-1")).toContainText("3 calls · ≈1.4s");

    // The detail states the time and that the duration is approximate.
    await page.getByTestId("mcp-call-3").click();
    await expect(page.getByTestId("mcp-call-3-detail")).toContainText(`at ${await clock(TS1)}`);
    await expect(page.getByTestId("mcp-call-3-detail")).toContainText("took ≈1.4s, approximate: includes hook and harness time");

    // Narrow column: the time stays, the duration column gives way (the turn total still carries it).
    await page.setViewportSize({ width: 560, height: 900 });
    await expect(page.getByTestId("mcp-call-3-at")).toBeVisible();
    await expect(page.getByTestId("mcp-call-3-dur")).toBeHidden();
    await expect(page.getByTestId("mcp-turn-1-total")).toBeVisible();
  });

  test("a transcript with no times keeps the untimed layout: no time column, no bars, no totals", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await openSession(page, loomDaemon);
    await page.getByTestId("mcp-activity-bar").click();
    const log = page.getByTestId("mcp-activity-log");
    await expect(log.locator(".loom-mcp-ent")).toHaveCount(5);
    await expect(log).not.toHaveClass(/\btimed\b/);
    await expect(log.locator(".loom-mcp-t").first()).toBeHidden();
    await expect(log.locator(".loom-mcp-dur i")).toHaveCount(0);
    await expect(log.locator("[data-testid$='-total']")).toHaveCount(0);
    await expect(page.getByTestId("mcp-activity-latest-dur")).toHaveCount(0);
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
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("mcp-activity")).toHaveAttribute("data-state", "empty");
    await expect(page.getByTestId("mcp-activity")).toContainText("No Loom MCP calls yet this session.");
    await expect(page.getByTestId("mcp-activity-bar")).toHaveCount(0);
  });
});

// Card d4d3481e: a codex transcript has no tool-call lines, so a codex session's strip reads the daemon's
// per-call record (GET /api/sessions/:id/mcp-calls). The fixture has no way to seed mcp_call_log rows, so
// the rows spec fulfils that route with rows in the shape db.ts listMcpCalls serves (newest first); the
// empty spec reads the REAL route, which is genuinely empty for a freshly seeded session.
// Record: docs/decisions/d4d3481e-codex-mcp-strip-reads-the-call-record.md
const REC_T0 = Date.parse("2026-11-06T10:14:05.000Z");
const RECORD_ROWS = [
  { id: 904, router: "loom-tasks", tool: "tasks_update", startedAt: REC_T0 + 9000, durationMs: 3, outcome: "ok", errClass: null, attribution: null, agentId: null, agentType: null },
  { id: 903, router: "loom-tasks", tool: "decisions_for", startedAt: REC_T0 + 6000, durationMs: null, outcome: "ok", errClass: null, attribution: null, agentId: null, agentType: null },
  { id: 902, router: "loom-orchestration", tool: "worker_spawn", startedAt: REC_T0 + 4000, durationMs: 1450, outcome: "refused", errClass: "envelope", attribution: null, agentId: null, agentType: null },
  { id: 901, router: "loom-orchestration", tool: "worker_redirect", startedAt: REC_T0, durationMs: 88, outcome: "error", errClass: "throw", attribution: null, agentId: null, agentType: null },
];

async function openCodexSession(page: Page, loomDaemon: LoomDaemon, rows: typeof RECORD_ROWS | null) {
  const s = await loomDaemon.seedLiveSession({
    role: "manager", agentName: "McpCodex", id: `e2e-mcpx-${Date.now()}`, harness: "codex",
    ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
  });
  const hits = { record: [] as string[], transcript: 0 };
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === `/api/sessions/${s.sessionId}/mcp-calls`) hits.record.push(u.search);
    if (u.pathname === `/api/sessions/${s.sessionId}/transcript`) hits.transcript++;
  });
  if (rows) {
    await page.route(new RegExp(`/api/sessions/${s.sessionId}/mcp-calls(\\?.*)?$`), (route) =>
      route.fulfill({ json: { calls: rows, dropped: 0, writeFailures: 0 } }));
  }
  await pinProject(page, s.projectId);
  await page.goto(`${loomDaemon.baseURL}/session/${s.sessionId}`);
  return { s, hits };
}

test.describe("session Loom MCP activity strip · codex (per-call record)", () => {
  test("renders recorded calls compact and expanded, with the record's own semantics", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const { hits } = await openCodexSession(page, loomDaemon, RECORD_ROWS);

    // Compact: the latest recorded call, no object (none is recorded), a measured duration with no "≈".
    const strip = page.getByTestId("mcp-activity");
    await expect(strip).toHaveAttribute("data-source", "record");
    await expect(page.getByTestId("mcp-activity-latest")).toHaveText("Updated card");
    await expect(page.getByTestId("mcp-activity-latest-dur")).toHaveText(" · 3ms");
    await expect(page.getByTestId("mcp-activity-latest-dur")).toHaveAttribute("title", /router/);
    await expect(page.getByTestId("mcp-activity-scope")).toHaveText("· latest calls");
    await expect(page.getByTestId("mcp-activity-count")).toHaveText("4");
    await expect(page.getByTestId("mcp-activity-refused-count")).toHaveAttribute("title", /error envelope/);
    await expect(page.getByTestId("mcp-activity-bar")).toContainText("1 refused");
    await expect(page.getByTestId("mcp-activity-bar")).toContainText("1 error");
    await expect(page.getByTestId("mcp-activity-cause")).toHaveCount(0);
    await expect(strip).not.toContainText("Codex sessions don't show");

    // Expand: one honestly labelled group, newest first.
    await expect(page.getByTestId("mcp-activity-log")).toHaveCount(0);
    await page.getByTestId("mcp-activity-bar").click();
    await expect(page.getByTestId("mcp-activity-bar")).toHaveAttribute("aria-expanded", "true");
    const log = page.getByTestId("mcp-activity-log");
    await expect(log.locator(".loom-mcp-turn")).toHaveCount(1);
    await expect(page.getByTestId("mcp-turn-0")).toContainText("All calls · codex records no turns");
    await expect(page.getByTestId("mcp-turn-0")).toContainText("4 calls");
    await expect(page.getByTestId("mcp-turn-0-total")).toHaveText(" · 9.0s");
    expect(await entries(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid"))))
      .toEqual(["mcp-call-4", "mcp-call-3", "mcp-call-2", "mcp-call-1"]);
    await expect(page.getByTestId("mcp-call-1")).toHaveAttribute("data-outcome", "error");
    await expect(page.getByTestId("mcp-call-1")).toContainText("Tried to redirect worker");
    await expect(page.getByTestId("mcp-call-2")).toHaveAttribute("data-outcome", "refused");
    await expect(page.getByTestId("mcp-call-2-dur")).toHaveText("1.4s");
    // A lead that would hang on "for" reads as the bare tool name; a missing duration shows none.
    await expect(page.getByTestId("mcp-call-3")).toContainText("Ran decisions_for");
    await expect(page.getByTestId("mcp-call-3-dur")).toHaveCount(0);
    await expect(page.getByTestId("mcp-refused-legend")).toHaveText("! refused: the tool returned an error envelope.");

    // Detail: what the record does not keep is said, not left blank.
    await page.getByTestId("mcp-call-2").click();
    const detail = page.getByTestId("mcp-call-2-detail");
    await expect(detail).toContainText("router loom-orchestration");
    await expect(detail).toContainText("took 1.4s, measured by Loom's router");
    await expect(page.getByTestId("mcp-call-2-not-kept")).toHaveText("Arguments and answer aren't recorded for codex calls.");
    await expect(detail).toContainText("returned an error envelope");
    await expect(detail).not.toContainText("Asked Loom");
    await expect(detail).not.toContainText("Touched");
    await expect(detail).not.toContainText("≈");

    // Collapse.
    await page.getByTestId("mcp-activity-bar").click();
    await expect(page.getByTestId("mcp-activity-bar")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("mcp-activity-log")).toHaveCount(0);

    // The strip asked the record route (with the store's per-session cap), and never the transcript.
    expect(hits.record.length).toBeGreaterThanOrEqual(1);
    expect(hits.record[0]).toBe("?limit=500");
    expect(hits.transcript, "a codex strip must not fetch the transcript").toBe(0);
  });

  test("an empty record says so for codex, read from the real route", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const { hits } = await openCodexSession(page, loomDaemon, null);
    await expect(page.getByTestId("mcp-activity")).toHaveAttribute("data-state", "empty");
    await expect(page.getByTestId("mcp-activity")).toContainText("No Loom MCP calls recorded for this codex session yet.");
    await expect(page.getByTestId("mcp-activity-bar")).toHaveCount(0);
    expect(hits.record.length).toBeGreaterThanOrEqual(1);
  });

  test("a claude session never asks the record route", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    // Counted from before the first navigation, so the mount-time fetch an enabled query would make is seen.
    let recordHits = 0;
    page.on("request", (req) => { if (new URL(req.url()).pathname.endsWith("/mcp-calls")) recordHits++; });
    await openSession(page, loomDaemon);
    await expect(page.getByTestId("mcp-activity")).toHaveAttribute("data-source", "transcript");
    await expect(page.getByTestId("mcp-activity-latest")).toHaveText("Moved card a9a7140c to Review");
    await page.getByTestId("mcp-activity-bar").click();
    await expect(page.getByTestId("mcp-activity-log")).toBeVisible();
    await page.waitForTimeout(6_000); // one active poll window
    expect(recordHits).toBe(0);
  });
});
