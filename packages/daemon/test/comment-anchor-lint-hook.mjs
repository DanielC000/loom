// comment-anchor-lint.mjs PER-FILE hook test (card 67621894 — wires the whole-repo report tool from card
// 5329a9af as a live PostToolUse hook, scoped to just the file a Write/Edit just touched). Two halves:
//   1. The pure per-file functions (`isInScope`/`computeFileReport`/`formatHookMessage`) against a fixture
//      repo, plus a real subprocess spawn of the script's own `--hook` mode (no build needed for either —
//      same "assets are plain ESM" posture as test/comment-anchor-lint.mjs).
//   2. writeSessionSettings' wiring: card d92ec82b reworked this gate — the hook now wires on the EXPLICIT
//      `docLint` param AND requires `repoPath`, independently of `vaultPath` (vault-lint's own, separate
//      gate) — so a project with docLint on but no Obsidian vault still gets it. Imported from
//      `../dist/pty/claude-settings.js`, so THIS half needs a build first (`pnpm --filter @loom/daemon
//      build`), same as test/vault-lint.mjs.
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   LOOM_HOME=<temp> node test/comment-anchor-lint-hook.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isInScope, computeFileReport, formatHookMessage } from "../assets/comment-anchor-lint.mjs";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { SETTINGS_DIR, ensureDirs, COMMENT_ANCHOR_LINT_SCRIPT } = await import("../dist/paths.js");
const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

// --- fixture repo: one file WITH violations, one CLEAN file, a docs store, a test/-excluded file --------
const REPO = path.join(os.tmpdir(), `loom-comment-anchor-lint-hook-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(REPO, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(REPO, "packages", "daemon", "test"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });

// aaaaaaaa: anchored + recorded → clean. dddddddd: anchored, NOTHING resolves it → orphan anchor.
const longUnanchored = Array.from({ length: 20 }, (_, i) => `// regrowing narrative line ${i}`).join("\n");
const violatingSrc = [
  "const before = 1;",
  "",
  "// @decision dddddddd — resolves to nothing, must be flagged as an orphan anchor",
  "",
  longUnanchored,
  "",
  "const after = 1;",
].join("\n");
const cleanSrc = [
  "const before = 1;",
  "",
  "// @decision aaaaaaaa — resolved via docs/adr, never flagged",
  "",
  "const after = 1;",
].join("\n");
const violatingPath = path.join(REPO, "packages", "daemon", "src", "violating.ts");
const cleanPath = path.join(REPO, "packages", "daemon", "src", "clean.ts");
const excludedPath = path.join(REPO, "packages", "daemon", "test", "fixture-test.mjs");
const wrongExtPath = path.join(REPO, "packages", "daemon", "src", "notes.md");
fs.writeFileSync(violatingPath, violatingSrc);
fs.writeFileSync(cleanPath, cleanSrc);
fs.writeFileSync(excludedPath, "// @decision ffffffff — synthetic test-fixture anchor, must never be scanned\n");
fs.writeFileSync(wrongExtPath, "# not a source file\n");
fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-example.md"), "# aaaaaaaa\n\nAn ADR.\n");

try {
  // --- isInScope -----------------------------------------------------------------------------------
  check("isInScope: an in-scope source file resolves to its repo-relative path",
    isInScope(REPO, violatingPath) === "packages/daemon/src/violating.ts");
  check("isInScope: a file under an excluded segment (test/) is rejected", isInScope(REPO, excludedPath) === null);
  check("isInScope: a non-source extension (.md) is rejected", isInScope(REPO, wrongExtPath) === null);
  check("isInScope: a path outside repoRoot entirely is rejected",
    isInScope(REPO, path.join(os.tmpdir(), "elsewhere.ts")) === null);
  check("isInScope: a path under a directory NOT in SOURCE_ROOTS is rejected",
    isInScope(REPO, path.join(REPO, "packages", "daemon", "notsrc", "x.ts")) === null);

  // --- computeFileReport: positive control (must be able to SEE a violation) -----------------------
  const violatingReport = computeFileReport(REPO, violatingPath, violatingSrc, { minLines: 15 });
  check("computeFileReport: in-scope violating file is not null", violatingReport !== null);
  check("computeFileReport: the 20-line unanchored block is flagged",
    violatingReport.unanchoredLongBlocks.length === 1 && violatingReport.unanchoredLongBlocks[0].length === 20);
  check("computeFileReport: dddddddd is flagged as an orphan anchor",
    violatingReport.orphanAnchors.length === 1 && violatingReport.orphanAnchors[0].id === "dddddddd");

  // --- computeFileReport: negative control (a genuinely clean in-scope file reports nothing) --------
  const cleanReport = computeFileReport(REPO, cleanPath, cleanSrc, { minLines: 15 });
  check("computeFileReport: in-scope clean file is not null (was actually scanned, not skipped)", cleanReport !== null);
  check("computeFileReport: clean file has zero unanchoredLongBlocks", cleanReport.unanchoredLongBlocks.length === 0);
  check("computeFileReport: clean file has zero orphanAnchors (aaaaaaaa resolves via docs/adr)",
    cleanReport.orphanAnchors.length === 0);

  // --- computeFileReport: out-of-scope file returns null, not an empty report (distinguishable) -----
  check("computeFileReport: out-of-scope file (test/) returns null, not a zeroed report",
    computeFileReport(REPO, excludedPath, "// @decision ffffffff — x\n") === null);

  // --- formatHookMessage ------------------------------------------------------------------------------
  const msg = formatHookMessage(violatingReport);
  check("formatHookMessage: names the file", msg.includes("packages/daemon/src/violating.ts"));
  check("formatHookMessage: names the orphan anchor id", msg.includes("dddddddd"));
  check("formatHookMessage: names the unanchored block's line length", msg.includes("20 lines"));

  // --- runHook via a real subprocess spawn (`node comment-anchor-lint.mjs --hook <repoRoot>`) -------
  const runHookProc = (filePath, tool = "Write") => {
    const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath }, cwd: REPO };
    const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", REPO], { input: JSON.stringify(payload), encoding: "utf8" });
    check(`runHook(${tool} ${path.basename(filePath)}): exits 0 (warn-only, never blocks)`, r.status === 0);
    const out = (r.stdout || "").trim();
    return out ? JSON.parse(out) : null;
  };

  // POSITIVE CONTROL FIRST (DoD-4): prove the hook can actually see a violation before trusting silence.
  const hit = runHookProc(violatingPath, "Write");
  check("runHook (positive control): a Write on the violating file DOES fire", hit !== null);
  check("runHook (positive control): systemMessage carries the orphan anchor id",
    !!hit && /dddddddd/.test(hit.systemMessage));
  check("runHook (positive control): hookSpecificOutput.hookEventName === PostToolUse",
    !!hit && hit.hookSpecificOutput?.hookEventName === "PostToolUse");

  // NEGATIVE CONTROLS — each isolates ONE reason the hook should stay silent.
  check("runHook (negative control): a Write on a CLEAN in-scope file stays silent", runHookProc(cleanPath, "Write") === null);
  check("runHook (negative control): a Read (wrong tool) on the SAME violating file stays silent", runHookProc(violatingPath, "Read") === null);
  check("runHook (negative control): a Write on an out-of-scope file (test/) stays silent", runHookProc(excludedPath, "Write") === null);
  check("runHook (negative control): a Write on a non-source extension stays silent", runHookProc(wrongExtPath, "Write") === null);
  {
    const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook"], { input: "{}", encoding: "utf8" });
    check("runHook (negative control): missing repoRoot arg exits 0 and stays silent", r.status === 0 && !(r.stdout || "").trim());
  }

  // --- writeSessionSettings wiring: gated on the explicit `docLint` param (card d92ec82b), independently
  // of vaultPath (which stays vault-lint's own gate) -----------------------------------------------------
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };
  const findGroup = (settings, needle) =>
    (settings.hooks.PostToolUse || []).find((g) => g.matcher === "Write|Edit" && g.hooks[0].command.includes(needle));

  // ON-case FIRST (same DoD-4 ordering): docLint:true + vaultPath given + repoPath given → wired. (The
  // realistic combination sessions/service.ts produces: vaultPath is only ever set when docLint is true.)
  const on = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on", perm, "test-hook-token", "/some/vault", REPO, true), "utf8"));
  const onGroup = findGroup(on, "comment-anchor-lint.mjs");
  check("writeSessionSettings(vaultPath+repoPath): comment-anchor-lint Write|Edit group present", !!onGroup);
  check("writeSessionSettings(vaultPath+repoPath): command uses --hook mode with the repo root",
    !!onGroup && onGroup.hooks[0].command.includes("--hook") && onGroup.hooks[0].command.includes(REPO));
  check("writeSessionSettings(vaultPath+repoPath): vault-lint's own group is STILL present (additive, not replaced)",
    !!findGroup(on, "vault-lint.mjs"));

  // docLint on but repoPath omitted → comment-anchor-lint absent (no repo root to scope it to).
  const onNoRepo = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on-norepo", perm, "test-hook-token", "/some/vault"), "utf8"));
  check("writeSessionSettings(vaultPath, no repoPath): comment-anchor-lint group ABSENT", !findGroup(onNoRepo, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(vaultPath, no repoPath): vault-lint's own group unaffected", !!findGroup(onNoRepo, "vault-lint.mjs"));

  // --- card d92ec82b: docLint:true + repoPath + NO vaultPath (no Obsidian vault configured) ------------
  // THE GAP THIS CARD FIXES: comment-anchor-lint targets SOURCE files, not vault notes, so it should wire
  // regardless of whether a vault is configured. Before d92ec82b this hook was gated on `vaultPath`
  // truthiness alone (a proxy for "docLint is on" that could not distinguish it from "a vault is
  // configured") — this is the exact positive control that pre-change code FAILS: with no 6th `docLint`
  // arg even accepted, the old code reads `vaultPath` (undefined here) and never wires the hook. Run this
  // block against pre-fix code (git-stash the source changes, rebuild, rerun) to see it fail RED; against
  // the fix, it must pass GREEN.
  const onNoVault = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on-novault", perm, "test-hook-token", undefined, REPO, true), "utf8"));
  check("writeSessionSettings(docLint:true, repoPath, NO vaultPath): comment-anchor-lint group PRESENT (the fix)",
    !!findGroup(onNoVault, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(docLint:true, repoPath, NO vaultPath): vault-lint's own group ABSENT (no vault to lint)",
    !findGroup(onNoVault, "vault-lint.mjs"));

  // docLint:false + repoPath given, vaultPath omitted → comment-anchor-lint absent even though repoPath is
  // present (docLint itself must gate it, not just repoPath's presence).
  const offNoVault = JSON.parse(fs.readFileSync(writeSessionSettings("cal-off-novault", perm, "test-hook-token", undefined, REPO, false), "utf8"));
  check("writeSessionSettings(docLint:false, repoPath, no vaultPath): comment-anchor-lint group ABSENT",
    !findGroup(offNoVault, "comment-anchor-lint.mjs"));

  // OFF-case (docLint off — no vaultPath), repoPath STILL given → must be byte-identical to today: absent.
  const off = JSON.parse(fs.readFileSync(writeSessionSettings("cal-off", perm, "test-hook-token", undefined, REPO), "utf8"));
  check("writeSessionSettings(no vaultPath / docLint off, repoPath given): comment-anchor-lint group ABSENT",
    !findGroup(off, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(no vaultPath / docLint off): vault-lint's own group ALSO absent (unchanged behavior)",
    !findGroup(off, "vault-lint.mjs"));
  check("writeSessionSettings(no vaultPath / docLint off): decision-records Read hook still present (unaffected)",
    (off.hooks.PostToolUse || []).some((g) => g.matcher === "Read" && g.hooks[0].command.includes("decision-records.mjs")));
} finally {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const s of ["cal-on", "cal-on-norepo", "cal-on-novault", "cal-off-novault", "cal-off"]) {
    try { fs.rmSync(path.join(SETTINGS_DIR, `${s}.json`), { force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-anchor-lint's per-file hook mode fires (with a genuine positive control) on an "
    + "in-scope violating file, stays silent on a clean file / wrong tool / out-of-scope file, and "
    + "writeSessionSettings wires it only when the explicit docLint param is true AND repoPath is given — "
    + "independently of vaultPath (card d92ec82b), including the docLint:true+repoPath+NO-vaultPath case "
    + "the old vaultPath-proxy gate missed — while docLint off stays byte-identical to today."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
