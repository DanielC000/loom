// Hermetic regression guard for card 462c4ae8 —writeSessionSettings (claude-settings.ts) writes the
// DOCUMENTED key `skillOverrides: {"auto-mode-setup": "off"}` into every per-session --settings JSON, which
// turns off /auto-mode-setup and its "Teach auto mode about your environment?" consent offer (Enter on it
// = a scan of the project/sessions + a write to ~/.claude/settings.json). Source:
// https://code.claude.com/docs/en/auto-mode-config.md ("Turn off /auto-mode-setup"); corroborated by
// https://github.com/anthropics/claude-code/issues/100974.
// This locks the MECHANICAL wiring only (key present for every role/mode/option, additive, no existing key
// disturbed, nothing written outside the per-session file). It CANNOT verify the CLI honors the key via
// `--settings` (the offer needs numStartups>=5 plus 5 auto-mode denials to trigger, no bounded probe exists).
// RUN: pnpm build, then `node test/settings-auto-mode-setup-off.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-settings-asoff-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// A sandboxed HOME so a stray write to the user's real settings would be visible here, never on the real one.
const fakeHome = path.join(tmpHome, "home");
fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

try {
  const perm = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: ["Read(./secret)"] };
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const OFF = { "auto-mode-setup": "off" };

  const plain = read(writeSessionSettings("aso-plain", perm, "test-hook-token"));
  check("skillOverrides {auto-mode-setup: off} is present on a plain session", JSON.stringify(plain.skillOverrides) === JSON.stringify(OFF));
  check("it is the ONLY skillOverrides entry (nothing else is switched off)", Object.keys(plain.skillOverrides).length === 1);
  check("existing keys are untouched: permissions allow/deny/defaultMode", plain.permissions.defaultMode === "acceptEdits" && plain.permissions.allow[0] === "mcp__loom-tasks" && plain.permissions.deny[0] === "Read(./secret)");
  check("existing keys are untouched: resume-gate env, includeCoAuthoredBy, skipAutoPermissionPrompt, hooks",
    plain.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES !== undefined && plain.includeCoAuthoredBy === false && plain.skipAutoPermissionPrompt === true && typeof plain.hooks === "object");

  // every mode, including the ones that boot DIRECTLY into auto (computeBootMode) — the mode the offer needs
  for (const mode of ["auto", "plan", "acceptEdits", "default"]) {
    const s = read(writeSessionSettings(`aso-${mode}`, { ...perm, mode }, "test-hook-token"));
    check(`present for permission mode '${mode}'`, JSON.stringify(s.skillOverrides) === JSON.stringify(OFF) && s.permissions.defaultMode === mode);
  }
  const withVault = read(writeSessionSettings("aso-vault", perm, "test-hook-token", os.tmpdir()));
  check("present alongside the vault-lint (vaultPath) option too", JSON.stringify(withVault.skillOverrides) === JSON.stringify(OFF));

  check("the user's real settings location was never written: the sandboxed ~/.claude holds no settings.json and no ~/.claude.json exists",
    !fs.existsSync(path.join(fakeHome, ".claude", "settings.json")) && !fs.existsSync(path.join(fakeHome, ".claude.json")));
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every written --settings file carries skillOverrides {auto-mode-setup: off} (additive, per-session only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
