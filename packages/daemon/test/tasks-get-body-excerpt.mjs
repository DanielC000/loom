import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 67c54f48 (item 3) — tasks_get gains `bodyGrep`/`bodySlice` params (mcp/server.ts, backed by the
// new `applyBodyExcerpt` helper in mcp/tasks.ts) so a caller who only needs one line/section of a card's
// body doesn't have to pull the whole thing, as `spillableTaskGet`'s own spill `note` used to be the only
// answer ("grep it for a substring; slice by character range via Bash" — a client-side workaround, not a
// server-side fix). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// tasks-list-fields-projection.mjs: a REAL Db + SessionService against a FAKE pty (PtyHost createPty()
// seam), the REAL TaskMcpRouter driven over an in-process MCP InMemoryTransport (no HTTP, no external
// daemon).
//
// Proves:
//   (A) bodyGrep: only the matching lines come back — every OTHER line of the body is genuinely ABSENT
//       from the response (not merely a smaller preview). Polarity trap: the UNPROJECTED default read is
//       used as a positive control proving the non-matching lines DO round-trip when not excerpted.
//       bodyGrepMatches/bodyCharsFull are asserted too. Case-insensitivity and a 0-match case are covered.
//   (B) bodySlice: only the requested [start,end) character range comes back — content before/after the
//       range is genuinely absent. An out-of-range end is silently clamped (String.slice semantics), not
//       an error.
//   (C) passing both bodyGrep and bodySlice is a rejected error, not a silent pick-one.
//   (D) omitting both is BYTE-IDENTICAL to before this existed — no bodyExcerpt/bodyCharsFull key at all,
//       full body returned (the "pure opt-in" contract every sibling projection in this file uses).
//   (E) a bodyGrep excerpt that would otherwise trip the spill boundary stays INLINE because excerpting
//       happens BEFORE the spill decision — proving the ordering, not just the string math.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-get-body-excerpt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tgbe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-tgbe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# tasks-get-body-excerpt test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=tgbe@loom -c user.name=tgbe");

const now = new Date().toISOString();
const db = new Db();

const P = "fee1a234-0000-4000-8000-000000000002";
db.insertProject({ id: P, name: "BodyExcerpt", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentM", projectId: P, name: "Manager", startupPrompt: "M", position: 0, profileId: null });
db.insertSession({ id: "M", projectId: P, agentId: "agentM", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only reads tasks here

const asJson = (res) => JSON.parse(res.content[0].text);

try {
  const bodyLines = [
    "## Release condition",
    "STATUS: BLOCKED on card abc12345",
    "some unrelated line one",
    "some unrelated line two",
    "STATUS: another mention, different case: Status update pending",
    "trailing line",
  ];
  const body = bodyLines.join("\n");
  db.insertTask({ id: "t-excerpt", projectId: P, title: "fix(x): release condition card", body, columnKey: "backlog", position: 0, priority: "p1", createdAt: now, updatedAt: now, held: false, deferred: false });

  const server = new TaskMcpRouter(db, wakes).buildServer(P, "M");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tgbe", version: "0" });
  await client.connect(clientT);

  // Positive control: the UNPROJECTED default read carries the FULL body, every line included.
  const defaultRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt" } }));
  check("(setup) positive control: default read's body is the full, unexcerpted body", defaultRow.body === body);
  check("(setup) positive control: default read carries no bodyExcerpt/bodyCharsFull keys at all", !("bodyExcerpt" in defaultRow) && !("bodyCharsFull" in defaultRow) && !("bodyGrepMatches" in defaultRow));

  // ===================== (A) bodyGrep =====================
  const grepRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt", bodyGrep: "status" } }));
  check("(A) bodyGrep: bodyExcerpt:true is stamped", grepRow.bodyExcerpt === true);
  check("(A) bodyGrep: bodyCharsFull equals the ORIGINAL body's length", grepRow.bodyCharsFull === body.length);
  check("(A) bodyGrep: case-insensitive match — both the ALL-CAPS and mixed-case STATUS lines matched", grepRow.bodyGrepMatches === 2);
  check("(A) bodyGrep: body contains ONLY the matching lines, newline-joined, in original order",
    grepRow.body === "STATUS: BLOCKED on card abc12345\nSTATUS: another mention, different case: Status update pending");
  check("(A) bodyGrep: every NON-matching line is genuinely ABSENT from the response body (not just a preview)",
    !grepRow.body.includes("unrelated line") && !grepRow.body.includes("Release condition") && !grepRow.body.includes("trailing line"));

  // (A) 0-match case: distinguishable from "empty body", not from an error.
  const noMatchRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt", bodyGrep: "nothing-matches-this-xyz" } }));
  check("(A) bodyGrep 0-match: not an error", !("error" in noMatchRow));
  check("(A) bodyGrep 0-match: bodyGrepMatches:0 (distinguishable from an empty body — bodyCharsFull is still the real length)",
    noMatchRow.bodyGrepMatches === 0 && noMatchRow.body === "" && noMatchRow.bodyCharsFull === body.length);

  // ===================== (B) bodySlice =====================
  const sliceRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt", bodySlice: [0, 17] } }));
  check("(B) bodySlice: bodyExcerpt:true is stamped", sliceRow.bodyExcerpt === true);
  check("(B) bodySlice: body is EXACTLY the [0,17) character range", sliceRow.body === body.slice(0, 17) && sliceRow.body.length === 17);
  check("(B) bodySlice: content AFTER the range is genuinely absent", !sliceRow.body.includes("STATUS") && !sliceRow.body.includes("trailing"));
  check("(B) bodySlice: bodyCharsFull is still the ORIGINAL full length, not the sliced length", sliceRow.bodyCharsFull === body.length);

  // (B) out-of-range end is silently clamped (String.slice semantics), never an error.
  const clampedRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt", bodySlice: [0, body.length + 5000] } }));
  check("(B) bodySlice out-of-range end: not an error, clamps to the real body (String.slice tolerance)", !("error" in clampedRow) && clampedRow.body === body);

  // ===================== (C) both params: rejected =====================
  const bothRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt", bodyGrep: "status", bodySlice: [0, 5] } }));
  check("(C) passing both bodyGrep and bodySlice is a rejected error, not a silent pick-one", typeof bothRow.error === "string" && bothRow.error.includes("bodyGrep") && bothRow.error.includes("bodySlice"));

  // ===================== (D) omitting both: byte-identical to before this existed =====================
  const plainRow = asJson(await client.callTool({ name: "tasks_get", arguments: { id: "t-excerpt" } }));
  check("(D) omitting both params: full body returned, unchanged", plainRow.body === body);
  check("(D) omitting both params: no bodyExcerpt/bodyCharsFull/bodyGrepMatches keys leak in", !("bodyExcerpt" in plainRow) && !("bodyCharsFull" in plainRow) && !("bodyGrepMatches" in plainRow));

  await client.close();

  // ===================== (E) excerpt-before-spill ordering =====================
  // A body big enough that the FULL body would spill (past SPILL_INLINE_BUDGET_CHARS=48,000), but a
  // bodyGrep match is tiny — proving the excerpt is taken BEFORE the spill decision, not after.
  const bigLine = "x".repeat(100);
  const bigLines = [];
  for (let i = 0; i < 600; i++) bigLines.push(bigLine); // ~60,600 chars, comfortably past the 48,000 inline budget
  bigLines.splice(300, 0, "UNIQUE-MARKER-LINE-FOR-GREP");
  const bigBody = bigLines.join("\n");
  check("(E) setup: the big body alone exceeds the 48,000-char inline budget", bigBody.length > 48000);
  db.insertTask({ id: "t-big", projectId: P, title: "fix(x): big body excerpt test", body: bigBody, columnKey: "backlog", position: 1, priority: "p1", createdAt: now, updatedAt: now, held: false, deferred: false });

  const server2 = new TaskMcpRouter(db, wakes).buildServer(P, "M");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await server2.connect(serverT2);
  const client2 = new Client({ name: "tgbe-big", version: "0" });
  await client2.connect(clientT2);

  // Negative control: the UNEXCERPTED full read of this same big task DOES spill (proves the fixture
  // actually crosses the spill threshold, not that spilling is broken generally).
  const bigDefaultRow = asJson(await client2.callTool({ name: "tasks_get", arguments: { id: "t-big" } }));
  check("(E) negative control: the full (unexcerpted) big body DOES spill (bodyFile present, no inline body)", typeof bigDefaultRow.bodyFile === "string" && !("body" in bigDefaultRow));

  const bigGrepRow = asJson(await client2.callTool({ name: "tasks_get", arguments: { id: "t-big", bodyGrep: "UNIQUE-MARKER-LINE-FOR-GREP" } }));
  check("(E) THE FIX: the SAME big task, excerpted via bodyGrep, stays INLINE (no bodyFile — excerpting ran before the spill decision)",
    typeof bigGrepRow.body === "string" && !("bodyFile" in bigGrepRow));
  check("(E) the inline excerpt is genuinely small (just the matching line), not the full ~60KB body", bigGrepRow.body === "UNIQUE-MARKER-LINE-FOR-GREP" && bigGrepRow.body.length < 100);
  check("(E) bodyCharsFull still reports the REAL full-body length even though body itself is tiny", bigGrepRow.bodyCharsFull === bigBody.length);

  await client2.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_get's bodyGrep/bodySlice excerpt genuinely drops un-requested body content from the response itself, applies before the spill decision, and stays byte-identical when omitted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
