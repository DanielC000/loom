import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// kanbanColumns config-schema well-formedness — the SAME floor planColumnLayout enforces on the column-editor
// PUT path, now applied to the config-PATCH validators (project_create/configure/update + REST PATCH) so a
// config surface can't store a board the editor would reject. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
//
// Proves the shared kanbanColumns schema (via BOTH validateProjectConfigOverride [REST/human, full] and
// validateAgentProjectConfigOverride [agent path]) rejects:
//   - an EMPTY board ([]);
//   - DUPLICATE column keys;
//   - a board MISSING the required defaultLanding role, or the required terminal role;
//   - TWO defaultLanding (or two terminal) columns — ambiguous for columnKeyForRole;
//   - a duplicated NON-required role;
// and ACCEPTS a well-formed board (the default board + a minimal 2-column board), and an OMITTED kanbanColumns
// (optional). The role checks apply identically on the agent path (the agent schema inherits the column shape).
//
// Run: 1) build (turbo builds shared first), 2) node test/kanban-columns-schema.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-colschema-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45322";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { validateProjectConfigOverride, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { resolveConfig } = await import("@loom/shared");

const DEFAULT_BOARD = resolveConfig({}).kanbanColumns; // role-annotated: backlog=defaultLanding, done=terminal
const MINIMAL = [{ key: "todo", label: "To Do", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }];

// Apply BOTH validators to one board so every assertion proves the rule holds on the human AND agent paths.
const both = (cols) => [validateProjectConfigOverride({ kanbanColumns: cols }), validateAgentProjectConfigOverride({ kanbanColumns: cols })];
const bothOk = (cols) => both(cols).every((r) => r.ok === true);
const bothRejected = (cols) => both(cols).every((r) => r.ok === false && typeof r.error === "string");

try {
  // --- ACCEPTED: well-formed boards + omitted ---
  check("a well-formed DEFAULT board is accepted (both validators)", bothOk(DEFAULT_BOARD));
  check("a minimal 2-column board (one defaultLanding + one terminal) is accepted", bothOk(MINIMAL));
  check("an OMITTED kanbanColumns is accepted (the key stays optional)",
    validateProjectConfigOverride({ docLint: true }).ok === true && validateAgentProjectConfigOverride({ docLint: true }).ok === true);

  // --- REJECTED: shape ---
  check("★ an EMPTY board ([]) is rejected", bothRejected([]));
  check("★ DUPLICATE column keys are rejected",
    bothRejected([{ key: "todo", label: "A", role: "defaultLanding" }, { key: "todo", label: "B", role: "terminal" }]));

  // --- REJECTED: required roles ---
  check("★ a board MISSING the defaultLanding role is rejected",
    bothRejected([{ key: "todo", label: "To Do" }, { key: "done", label: "Done", role: "terminal" }]));
  check("★ a board MISSING the terminal role is rejected",
    bothRejected([{ key: "todo", label: "To Do", role: "defaultLanding" }, { key: "done", label: "Done" }]));
  check("★ a FULLY ROLELESS board is rejected (no required roles)",
    bothRejected([{ key: "todo", label: "To Do" }, { key: "done", label: "Done" }]));

  // --- REJECTED: ambiguous roles ---
  check("★ TWO defaultLanding columns are rejected (ambiguous)",
    bothRejected([{ key: "a", label: "A", role: "defaultLanding" }, { key: "b", label: "B", role: "defaultLanding" }, { key: "c", label: "C", role: "terminal" }]));
  check("★ TWO terminal columns are rejected (ambiguous)",
    bothRejected([{ key: "a", label: "A", role: "defaultLanding" }, { key: "b", label: "B", role: "terminal" }, { key: "c", label: "C", role: "terminal" }]));
  check("★ a duplicated NON-required role (two 'review') is rejected",
    bothRejected([
      { key: "a", label: "A", role: "defaultLanding" }, { key: "b", label: "B", role: "terminal" },
      { key: "r1", label: "R1", role: "review" }, { key: "r2", label: "R2", role: "review" },
    ]));
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the kanbanColumns config schema rejects empty / dup-key / role-missing / ambiguous-role boards (the planColumnLayout floor, now enforced on the config-PATCH validators) and accepts well-formed + omitted boards, on BOTH the human and agent paths — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
