// Card f761fdf3 item 1 — scripts/prune-claude-config-worktree-entries.mjs's --apply gate used to accept
// `CLAUDE_CONFIG_DIR=""` as proof of a deliberate rehearsal, but claudeJsonPath() treats an EMPTY string
// the same as UNSET (falls back to the real ~/.claude.json). So
// `CLAUDE_CONFIG_DIR= node … --apply --worktrees-root <typo>` used to pass the gate and run the real
// bulk-delete write against the owner's real config with a mistyped (or malicious) worktrees root.
//
// Runs the REAL script as a child process (it executes top-level, not via an exported function).
//
// ⛔ HARD RULE: this test NEVER resolves to the real ~/.claude.json, even while exercising the
// `CLAUDE_CONFIG_DIR=""` shape the bug is about. HOME/USERPROFILE are redirected to a throwaway temp dir
// for the whole child process, so os.homedir() — and therefore "the real ~/.claude.json" as the script's
// own gate computes it — resolves to a path INSIDE that temp dir, never the owner's actual home.
//
// Run after build: node test/prune-script-apply-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "scripts", "prune-claude-config-worktree-entries.mjs");
check("(setup) the real prune script exists at the resolved path", fs.existsSync(scriptPath));

const root = path.join(os.tmpdir(), `loom-prune-script-apply-gate-test-${Date.now()}-${process.pid}`);
const fakeHome = path.join(root, "home"); // "the real ~/.claude.json", as the script's own gate computes it, lives here
fs.mkdirSync(fakeHome, { recursive: true });

const runScript = (args, extraEnv) => spawnSync(process.execPath, [scriptPath, ...args], {
  env: {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...extraEnv,
  },
  encoding: "utf8",
});

try {
  // === 1. THE BUG SHAPE: CLAUDE_CONFIG_DIR="" (empty string — present in env, but claudeJsonPath()
  //        treats it as unset) must NOT be accepted as proof of a deliberate rehearsal. A typo'd/bogus
  //        --worktrees-root with --apply must be REFUSED, because the resolved config path is still the
  //        (fake, never-real) "real" ~/.claude.json. ===
  {
    const bogusRoot = path.join(root, "typo-worktrees-root");
    fs.mkdirSync(bogusRoot, { recursive: true });
    const res = runScript(["--apply", "--worktrees-root", bogusRoot], { CLAUDE_CONFIG_DIR: "" });

    check("empty-string CLAUDE_CONFIG_DIR + --apply + non-default --worktrees-root: REFUSED (exit 1)",
      res.status === 1);
    check("empty-string CLAUDE_CONFIG_DIR: refusal names the real-config-with-overridden-root reasoning",
      /REFUSED/.test(res.stderr) && /not a rehearsal/.test(res.stderr));
    // Confirm it never even got far enough to report a mode/apply result — the gate fired before any read.
    check("empty-string CLAUDE_CONFIG_DIR: no 'mode' line printed (refused before doing any work)",
      !/^mode\s*:/m.test(res.stdout));
  }

  // === 2. UNSET CLAUDE_CONFIG_DIR (never set at all) must behave identically to the empty-string case —
  //        both resolve to the same "real" config path, so both must be refused the same way. ===
  {
    const bogusRoot2 = path.join(root, "typo-worktrees-root-2");
    fs.mkdirSync(bogusRoot2, { recursive: true });
    const res = runScript(["--apply", "--worktrees-root", bogusRoot2], { CLAUDE_CONFIG_DIR: undefined });
    check("unset CLAUDE_CONFIG_DIR + --apply + non-default --worktrees-root: REFUSED (exit 1), same as empty-string",
      res.status === 1 && /REFUSED/.test(res.stderr));
  }

  // === 2b. CASE-VARIANT of the real home (manager follow-up, card f761fdf3): on win32, a CLAUDE_CONFIG_DIR
  //         that differs from the real home ONLY in case still resolves to the SAME real ~/.claude.json —
  //         a case-sensitive string compare would wrongly treat it as "not the real config" and wave
  //         --apply + a bogus --worktrees-root through. Must be refused exactly like the exact-case real
  //         file. ===
  if (process.platform === "win32") {
    const caseVariantHome = fakeHome.toUpperCase();
    const bogusRoot2b = path.join(root, "typo-worktrees-root-case-variant");
    fs.mkdirSync(bogusRoot2b, { recursive: true });
    const res = runScript(["--apply", "--worktrees-root", bogusRoot2b], { CLAUDE_CONFIG_DIR: caseVariantHome });
    check("case-variant CLAUDE_CONFIG_DIR (same real file, different case) + --apply + non-default --worktrees-root: REFUSED",
      res.status === 1 && /REFUSED/.test(res.stderr));
  } else {
    console.log("SKIP  case-variant CLAUDE_CONFIG_DIR refusal — win32-only (no case-fold elsewhere)");
  }

  // === 3. NEGATIVE CONTROL — a genuinely NON-default CLAUDE_CONFIG_DIR (a real, distinct directory) is a
  //        legitimate rehearsal signal and must still be ALLOWED through the gate with --apply +
  //        --worktrees-root. Proves the fix didn't just turn the gate into an unconditional refusal. ===
  {
    const rehearsalConfigDir = path.join(root, "rehearsal-config");
    fs.mkdirSync(rehearsalConfigDir, { recursive: true });
    const rehearsalRoot = path.join(root, "rehearsal-worktrees-root");
    fs.mkdirSync(rehearsalRoot, { recursive: true });
    const res = runScript(["--apply", "--worktrees-root", rehearsalRoot], { CLAUDE_CONFIG_DIR: rehearsalConfigDir });

    check("genuine non-default CLAUDE_CONFIG_DIR: NOT refused (the gate still allows real rehearsals)",
      res.status === 0);
    check("genuine non-default CLAUDE_CONFIG_DIR: actually ran (prints a 'mode' line)",
      /^mode\s*:/m.test(res.stdout));
    check("genuine non-default CLAUDE_CONFIG_DIR: resolved config file sits under the rehearsal dir, never fakeHome",
      res.stdout.includes(path.join(rehearsalConfigDir, ".claude.json")));
  }

  // === 4. The real (fake) home's .claude.json was NEVER created or touched by any of the above — the
  //        refused runs did no work at all, and the allowed rehearsal run targeted its own separate dir. ===
  check("(invariant) the fake-but-'real' ~/.claude.json was never created by any refused run",
    !fs.existsSync(path.join(fakeHome, ".claude.json")));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\nALL PASS — the --apply gate refuses CLAUDE_CONFIG_DIR=\"\"/unset exactly like the real file, and still allows a genuine rehearsal; the real ~/.claude.json was never touched."
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
