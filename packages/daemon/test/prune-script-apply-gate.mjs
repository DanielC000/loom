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

  // === 5. CR e0d7eeff item 3 — --temp-test-entries + --worktrees-root together: REFUSED (script :81)
  //        regardless of --apply — --worktrees-root is a worktree-mode-only rehearsal override and is
  //        meaningless once --temp-test-entries switches to the OTHER candidate predicate. ===
  {
    const bogusRoot5 = path.join(root, "temp-mode-worktrees-root");
    fs.mkdirSync(bogusRoot5, { recursive: true });
    const res = runScript(["--temp-test-entries", "--worktrees-root", bogusRoot5]);
    check("--temp-test-entries + --worktrees-root: REFUSED (exit 1) even with no --apply at all",
      res.status === 1);
    check("--temp-test-entries + --worktrees-root: refusal names it a worktree-mode-only rehearsal override",
      /--worktrees-root is a worktree-mode-only rehearsal override/.test(res.stderr));
    check("--temp-test-entries + --worktrees-root: no 'mode' line printed (refused before doing any work)",
      !/^mode\s*:/m.test(res.stdout));
  }

  // === 6. --temp-test-entries dispatch: a dry run actually runs pruneDeadTempTestClaudeConfigEntries,
  //        scoped to THIS CHILD's own redirected tmp root — never the real os.tmpdir(). os.tmpdir() reads
  //        TEMP/TMP (win32) or TMPDIR (posix), so redirecting those for the child is the same convention
  //        HOME/USERPROFILE already use above for "the real ~/.claude.json". Also exercises item 1's fix
  //        (the --json key is `tmpRoot`, not the old lower-cased `tmproot`). ===
  {
    const fakeTmp6 = path.join(root, "fake-tmpdir");
    fs.mkdirSync(fakeTmp6, { recursive: true });
    const configDir6 = path.join(root, "temp-mode-config");
    fs.mkdirSync(configDir6, { recursive: true });
    const claudeJson6 = path.join(configDir6, ".claude.json");
    const keyFor6 = (dir) => path.resolve(dir).replace(/\\/g, "/");

    const deadKeyDir = path.join(fakeTmp6, "loom-dead-abc123"); // never created on disk — dead candidate
    fs.writeFileSync(claudeJson6, JSON.stringify({ projects: { [keyFor6(deadKeyDir)]: { hasTrustDialogAccepted: true } } }, null, 2));

    const res = runScript(["--temp-test-entries", "--json"], {
      CLAUDE_CONFIG_DIR: configDir6,
      TEMP: fakeTmp6, TMP: fakeTmp6, TMPDIR: fakeTmp6,
    });
    check("--temp-test-entries dispatch: dry run exits 0", res.status === 0);
    let parsed6 = null;
    try { parsed6 = JSON.parse(res.stdout); } catch { /* left null — the check below fails loudly */ }
    check("--temp-test-entries dispatch: --json output parses", parsed6 !== null);
    check("--temp-test-entries dispatch: scoped to this child's OWN redirected tmp root, never the real os.tmpdir()",
      parsed6?.tmpRoot === fakeTmp6);
    check("--temp-test-entries dispatch: resolved config file sits under the redirected CLAUDE_CONFIG_DIR",
      parsed6?.claudeJson === claudeJson6);
    check("--temp-test-entries dispatch: the planted dead loom- key was classified dead",
      parsed6?.deadCount === 1 && parsed6?.deadKeysSample?.includes(keyFor6(deadKeyDir)));
    check("--temp-test-entries dispatch: dry run never writes — the planted entry is still on disk",
      keyFor6(deadKeyDir) in JSON.parse(fs.readFileSync(claudeJson6, "utf8")).projects);
  }

  // === 7. CR e0d7eeff item 3 — "unknown liveness is never deleted" for temp mode. Not fault-injectable
  //        through a real spawned child process portably — there is no cross-platform way to force a
  //        non-ENOENT/ENOTDIR stat() error without touching real host ACLs (and doing so risks leaving a
  //        locked fixture dir behind). Exercises the EXACT function the script's --temp-test-entries
  //        dispatch calls, directly, with the SAME `__setStatSyncForTest` seam
  //        claude-config-worktree-prune.mjs's own "unknown liveness" section (11) already uses for the
  //        worktree-mode predicate — same guarantee (card 498452c0 review item 2), other predicate. ===
  {
    const { pruneDeadTempTestClaudeConfigEntries, __setStatSyncForTest } = await import("../dist/pty/claude-config.js");
    const fakeTmp7 = path.join(root, "fake-tmpdir-unknown");
    fs.mkdirSync(fakeTmp7, { recursive: true });
    const configDir7 = path.join(root, "temp-mode-config-unknown");
    fs.mkdirSync(configDir7, { recursive: true });
    const claudeJson7 = path.join(configDir7, ".claude.json");
    const keyFor7 = (dir) => path.resolve(dir).replace(/\\/g, "/");

    const unknownDir = path.join(fakeTmp7, "loom-unknown-stat");
    const normalDeadDir = path.join(fakeTmp7, "loom-normal-dead"); // never created — plain dead control
    fs.writeFileSync(claudeJson7, JSON.stringify({
      projects: {
        [keyFor7(unknownDir)]: { hasTrustDialogAccepted: true },
        [keyFor7(normalDeadDir)]: { hasTrustDialogAccepted: true },
      },
    }, null, 2));

    const savedCfg7 = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir7;
    const realStatSync7 = fs.statSync;
    __setStatSyncForTest((p, opts) => {
      if (path.resolve(p) === path.resolve(unknownDir)) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realStatSync7(p, opts);
    });
    let dry7, applied7;
    try {
      dry7 = pruneDeadTempTestClaudeConfigEntries({ dryRun: true, tmpdir: fakeTmp7 });
      applied7 = pruneDeadTempTestClaudeConfigEntries({ dryRun: false, tmpdir: fakeTmp7 });
    } finally {
      __setStatSyncForTest();
      if (savedCfg7 === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg7;
    }

    check("temp mode, unknown liveness (dry run): the EACCES key is in unknownKeys, not deadKeysSample",
      dry7.unknownKeys.includes(keyFor7(unknownDir)) && !dry7.deadKeysSample.includes(keyFor7(unknownDir)));
    check("temp mode, unknown liveness (dry run): the normal dead key is still classified dead",
      dry7.deadKeysSample.includes(keyFor7(normalDeadDir)));
    check("temp mode, unknown liveness (apply): the EACCES key was NOT removed",
      !applied7.removedKeys.includes(keyFor7(unknownDir)));
    check("temp mode, unknown liveness (apply): the EACCES key is reported in unknownKeys",
      applied7.unknownKeys.includes(keyFor7(unknownDir)));
    check("temp mode, unknown liveness (apply): the normal dead key WAS removed",
      applied7.removedKeys.includes(keyFor7(normalDeadDir)));
    const after7 = JSON.parse(fs.readFileSync(claudeJson7, "utf8")).projects;
    check("temp mode, unknown liveness (apply): the EACCES key still present in the file",
      keyFor7(unknownDir) in after7);
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\nALL PASS — the --apply gate refuses CLAUDE_CONFIG_DIR=\"\"/unset exactly like the real file, and still allows a genuine rehearsal; the real ~/.claude.json was never touched."
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
