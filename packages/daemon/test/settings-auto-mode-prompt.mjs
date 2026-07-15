// Hermetic regression guard for card 9c03f5a6 — writeSessionSettings (claude-settings.ts) now writes
// `skipAutoPermissionPrompt: true` at the top level of every per-session --settings JSON file, a
// BEST-EFFORT (reverse-engineered, unverified settings-scope) suppression of Claude Code's auto-mode
// first-run entry-warning dialog — see the AUTO_MODE_ENTRY_WARNING_OVERRIDE doc comment for the full
// rationale + caveats. This only locks the MECHANICAL wiring (the key is present, additive, and doesn't
// disturb any existing field) — it cannot verify the CLI actually honors it (that needs a real spawn; see
// test/_smoke-mode-fix-9c03f5a6.mjs, run manually).
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   pnpm build (repo root) then `node test/settings-auto-mode-prompt.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-settings-auto-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

try {
  const perm = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 2 };

  const plain = JSON.parse(fs.readFileSync(writeSessionSettings("sam-plain", perm), "utf8"));
  check("skipAutoPermissionPrompt:true is present on a plain (no vault) session",
    plain.skipAutoPermissionPrompt === true);
  check("it did NOT displace any existing field — permissions.defaultMode still wired",
    plain.permissions.defaultMode === "acceptEdits");
  check("it did NOT displace the resume-gate env override", plain.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES !== undefined);
  check("includeCoAuthoredBy is unaffected (still false)", plain.includeCoAuthoredBy === false);

  // Additive regardless of the vault-lint option too — same key, same value, every path.
  const withVault = JSON.parse(fs.readFileSync(writeSessionSettings("sam-vault", perm, os.tmpdir()), "utf8"));
  check("skipAutoPermissionPrompt:true is present alongside a vaultPath (docLint) session too",
    withVault.skipAutoPermissionPrompt === true);

  const bypass = JSON.parse(fs.readFileSync(
    writeSessionSettings("sam-plan", { ...perm, mode: "plan" }), "utf8"));
  check("skipAutoPermissionPrompt:true is present regardless of the configured permission mode",
    bypass.skipAutoPermissionPrompt === true);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every written --settings file carries skipAutoPermissionPrompt:true (additive, "
    + "doesn't displace any existing field), regardless of permission mode or the vault-lint "
    + "option."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
