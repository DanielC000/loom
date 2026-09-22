import { commitAll } from "./_git-commit.mjs";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 67c54f48 (item 5) — gate_history's DEFAULT page size (when `limit` is omitted) is lowered from
// 100 to DEFAULT_GATE_HISTORY_PAGE (db.ts), sized to fit an UNPROJECTED page inline. The original
// evidence (23fde5f8) measured gate_history({limit:60}) already exceeding the caller's tool-result
// cap at 54,350 chars (~905 chars/row) — the OLD default of 100 rows was never fixed by 40f4cae9's later
// `fields:[...]` projection, since `pickFields` returns rows UNCHANGED when `fields` is omitted (a pure
// opt-in, not a default-behavior change). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// gate-history.mjs: a REAL Db + SessionService, the REAL OrchestrationMcpRouter driven over an
// in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves:
//   (1) DEFAULT_GATE_HISTORY_PAGE is a real, sane, exported number (not the old 100).
//   (2) An OMITTED `limit` on the real gate_history MCP tool returns exactly DEFAULT_GATE_HISTORY_PAGE
//       rows (not the old 100), and paginates on from there via nextOffset.
//   (3) THE ACTUAL DEFECT THIS FIXES, PROVEN AS A NEGATIVE CONTROL: the SAME fixture, read with the OLD
//       default (`limit:100`, still a valid explicit value below MAX_GATE_HISTORY_PAGE) produces a
//       response that genuinely EXCEEDS the shared ~48,000-char "safely inline" budget every sibling
//       DEFAULT_*_CAP in this codebase targets (SPILL_INLINE_BUDGET_CHARS) — this is the check shown
//       capable of failing on a known-bad case, not merely asserted never to.
//   (4) The NEW default's response stays comfortably UNDER that same budget, on the identical fixture.
//   (5) A caller who wants MORE rows per page than the new default fits can still reach for `fields:[...]`
//       (already shipped, card 40f4cae9/9772def) to shrink each row instead of raising `limit` —
//       proving the discoverability path this card's DoD asked for actually works end to end.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-history-default-limit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ghdl-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db, MAX_GATE_HISTORY_PAGE, DEFAULT_GATE_HISTORY_PAGE } = await import("../dist/db.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const GIT_ID = "-c user.email=ghdl@loom -c user.name=ghdl";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ghdl\n");
  execSync(`git init -q && git config user.email ghdl@loom && git config user.name ghdl`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

try {
  check("(1) DEFAULT_GATE_HISTORY_PAGE is a real number, well below the old 100 and the MAX clamp",
    typeof DEFAULT_GATE_HISTORY_PAGE === "number" && DEFAULT_GATE_HISTORY_PAGE > 0 &&
    DEFAULT_GATE_HISTORY_PAGE < 100 && DEFAULT_GATE_HISTORY_PAGE <= MAX_GATE_HISTORY_PAGE);

  const dbs = [];
  const repo = path.join(os.tmpdir(), `ghdl-repo-${Date.now()}-${randomUUID().slice(0, 8)}`);
  makeRepo(repo);
  try {
    const db = new Db();
    dbs.push(db);
    const P = `ghdl-${Date.now()}-${randomUUID().slice(0, 8)}`;
    db.insertProject({ id: P, name: "GateHistoryDefaultLimit", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    const a = `${P}-a`;
    db.insertAgent({ id: a, projectId: P, name: "dev-longer-agent-name", startupPrompt: "", position: 0 });
    const t = `${P}-task`;
    db.insertTask({ id: t, projectId: P, title: "A reasonably long real-world card title for realistic row sizing", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const mgr = `${P}-mgr`, w = `${P}-wkr`;
    db.insertSession({ id: mgr, projectId: P, agentId: a, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: w, projectId: P, agentId: a, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t, worktreePath: `${repo}-wt`, branch: "loom/a-realistic-branch-name-1234abcd" });

    // Seed 110 realistic-shaped, DECIDED (passed) merge-gate rows — comfortably more than both the old
    // default (100) and the new one (DEFAULT_GATE_HISTORY_PAGE), so paging/negative-control math is real.
    const ROW_COUNT = 110;
    for (let i = 0; i < ROW_COUNT; i++) {
      db.appendEvent({
        id: randomUUID(), ts: new Date(Date.now() - (ROW_COUNT - i) * 1000).toISOString(),
        managerSessionId: mgr, workerSessionId: w, taskId: t, kind: "build_gate",
        detail: { opId: randomUUID(), passed: true, durationMs: 45000 + i, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 2 },
      });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const router = new OrchestrationMcpRouter(db, sessions);
    const server = router.buildServer(mgr, "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "ghdl", version: "0" });
    await client.connect(clientT);
    const call = async (args) => JSON.parse((await client.callTool({ name: "gate_history", arguments: args ?? {} })).content[0].text);

    // ── (2) omitted limit uses the NEW, smaller default ────────────────────────────────────────────
    const defaultResult = await call();
    check(`(2) omitted limit returns exactly DEFAULT_GATE_HISTORY_PAGE (${DEFAULT_GATE_HISTORY_PAGE}) rows, not the old 100`,
      defaultResult.items.length === DEFAULT_GATE_HISTORY_PAGE && defaultResult.limit === DEFAULT_GATE_HISTORY_PAGE);
    check("(2) total still reflects the full 110-row population (only the PAGE shrank, not the count)", defaultResult.total === ROW_COUNT);
    check("(2) nextOffset is non-null — more rows remain to page through", defaultResult.nextOffset === DEFAULT_GATE_HISTORY_PAGE);

    // ── (3) NEGATIVE CONTROL — the OLD default's shape, reproduced via an explicit limit:100, genuinely
    // overflows the shared inline budget. This is the check PROVEN CAPABLE OF FAILING on a known-bad case. ──
    const oldDefaultResult = await call({ limit: 100 });
    const oldDefaultChars = JSON.stringify(oldDefaultResult).length;
    check("(3) setup: the old-default emulation (limit:100) actually returned 100 rows", oldDefaultResult.items.length === 100);
    check(`(3) NEGATIVE CONTROL: the OLD default's response (${oldDefaultChars} chars) genuinely EXCEEDS the ${SPILL_INLINE_BUDGET_CHARS}-char shared inline budget — THE DEFECT THIS CARD FIXES, reproduced`,
      oldDefaultChars > SPILL_INLINE_BUDGET_CHARS);

    // ── (4) the NEW default's response, same fixture, stays comfortably under that same budget ────────
    const defaultChars = JSON.stringify(defaultResult).length;
    check(`(4) THE FIX: the NEW default's response (${defaultChars} chars) stays under the ${SPILL_INLINE_BUDGET_CHARS}-char shared inline budget`,
      defaultChars < SPILL_INLINE_BUDGET_CHARS);
    check("(4) the new default's response is meaningfully smaller than the old one's on the SAME data (not a coincidence of different content)",
      defaultChars < oldDefaultChars);

    // ── (5) discoverability: fields:[...] shrinks a page further than row-count alone can, so a caller
    // wanting MORE rows per page has a real path that doesn't just re-multiply the ~900-char shape. ──────
    const projectedBig = await call({ limit: 100, fields: ["outcome", "durationMs"] });
    const projectedChars = JSON.stringify(projectedBig).length;
    check("(5) fields:[...] still returns all 100 requested rows", projectedBig.items.length === 100);
    check(`(5) DISCOVERABILITY WORKS: a fields-projected 100-row page (${projectedChars} chars) is dramatically smaller than the unprojected 100-row page (${oldDefaultChars} chars) — a real path to MORE rows than the default without raising limit past what an unprojected row can carry`,
      projectedChars < oldDefaultChars / 2);

    await client.close();
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_history's default page size now fits inline, proven against the same overflow shape the original evidence measured, with fields:[...] still available for a caller who wants more rows."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
