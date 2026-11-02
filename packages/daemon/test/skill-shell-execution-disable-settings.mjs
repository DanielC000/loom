// Card 015fdb23 — writeSessionSettings (claude-settings.ts) now carries `disableSkillShellExecution:
// true` at the top level of the --settings JSON for every LOOM_DRIVEN_ROLES session, neutralizing a
// repo/cwd skill's `!`cmd``/fenced ```! shell injection at render time (CLI-verified separately via a
// real spawn — see this card's own worker_report; not re-proven here, since a real `claude` spawn is
// outside this test's scope by the project's own standing verification posture).
//
// Table-driven over the REAL `SESSION_ROLES`/`LOOM_DRIVEN_ROLES` arrays (never a hand-copied role list)
// so this test can't silently drift from the source — see docs/decisions/
// 015fdb23-skill-shell-execution-disable-and-cwd-skill-scan.md.
//
// RUN: pnpm build (repo root) then `node test/skill-shell-execution-disable-settings.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-skill-exec-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");
const { SESSION_ROLES, LOOM_DRIVEN_ROLES, isLoomDrivenRole } = await import("@loom/shared");

try {
  const perm = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [] };

  // (setup) isLoomDrivenRole must agree with LOOM_DRIVEN_ROLES.includes(role) for every real role AND
  // for null/undefined (plain/role-less) — if a future edit lets the helper's own body drift from the
  // array, this trips before any settings-level check below ever gets a chance to mask it.
  for (const role of [...SESSION_ROLES, null, undefined]) {
    check(`(setup) isLoomDrivenRole(${String(role)}) agrees with LOOM_DRIVEN_ROLES.includes`,
      isLoomDrivenRole(role) === (!!role && LOOM_DRIVEN_ROLES.includes(role)));
  }

  // Every real SessionRole, plus the plain (role-less) case, table-driven over the real array.
  for (const role of [...SESSION_ROLES, null]) {
    const inScope = !!role && LOOM_DRIVEN_ROLES.includes(role);
    const sessionId = `skx-${role ?? "plain"}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const written = JSON.parse(fs.readFileSync(
      writeSessionSettings(sessionId, perm, "test-hook-token", undefined, undefined, undefined, inScope),
      "utf8"));
    if (inScope) {
      check(`role "${role}" (LOOM_DRIVEN_ROLES member): disableSkillShellExecution:true is present`,
        written.disableSkillShellExecution === true);
    } else {
      check(`role "${role ?? "plain"}" (NOT a LOOM_DRIVEN_ROLES member): disableSkillShellExecution is ABSENT entirely (not just false)`,
        !("disableSkillShellExecution" in written));
    }
    // Every other field stays exactly as writeSessionSettings always wrote it — proves this is additive,
    // never a displacement of an existing key (same discipline as settings-auto-mode-prompt.mjs).
    check(`role "${role ?? "plain"}": permissions.defaultMode faithfully reflects what was passed in`,
      written.permissions.defaultMode === "acceptEdits");
    check(`role "${role ?? "plain"}": includeCoAuthoredBy is unaffected (still false)`,
      written.includeCoAuthoredBy === false);
  }

  // Omitting the param entirely (every caller that existed before this card) stays byte-identical:
  // no `disableSkillShellExecution` key at all, regardless of role.
  const omitted = JSON.parse(fs.readFileSync(
    writeSessionSettings("skx-omitted", perm, "test-hook-token"), "utf8"));
  check("omitting the param entirely leaves disableSkillShellExecution ABSENT (pre-card callers byte-identical)",
    !("disableSkillShellExecution" in omitted));

  // Explicit `false` behaves exactly like omission — never writes a `disableSkillShellExecution:false`
  // key (that would still be a behavior change vs. every pre-card settings file on disk).
  const explicitFalse = JSON.parse(fs.readFileSync(
    writeSessionSettings("skx-false", perm, "test-hook-token", undefined, undefined, undefined, false),
    "utf8"));
  check("explicit false also leaves the key ABSENT, never writes disableSkillShellExecution:false",
    !("disableSkillShellExecution" in explicitFalse));
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — disableSkillShellExecution is present (true) for every LOOM_DRIVEN_ROLES role and "
    + "absent (never a bare false key) for every other role / plain session / omitted param."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
