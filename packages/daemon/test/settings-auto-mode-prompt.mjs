// Hermetic regression guard for card 9c03f5a6 — writeSessionSettings (claude-settings.ts) now writes
// `skipAutoPermissionPrompt: true` at the top level of every per-session --settings JSON file, a
// BEST-EFFORT (reverse-engineered, unverified settings-scope) suppression of Claude Code's auto-mode
// first-run entry-warning dialog — see the AUTO_MODE_ENTRY_WARNING_OVERRIDE doc comment for the full
// rationale + caveats. This only locks the MECHANICAL wiring (the key is present, additive, and doesn't
// disturb any existing field) — it cannot verify the CLI actually honors it (that needs a real spawn; see
// test/_smoke-mode-fix-9c03f5a6.mjs, run manually).
//
// ISOLATION NOTE (card 51926260, Code Review catch): this calls `writeSessionSettings` DIRECTLY with a
// literal `mode`, verifying that function's own faithful passthrough — it says NOTHING about which
// `mode` PRODUCTION actually passes it. Since 795910c7, `createPty` (host.ts) resolves the REAL boot
// mode via `computeBootMode` BEFORE calling `writeSessionSettings`, so a `startupModeCycles`-bearing
// permission object is no longer production's actual input shape here (production now passes the
// ALREADY-RESOLVED target, e.g. `auto`, not the raw `acceptEdits` + cycles it used to). The coupling
// between the WRITTEN `defaultMode` and the REAL `--permission-mode` argv value is covered by
// `boot-mode-settings-argv-coupling.mjs`, not this file.
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
  // No `startupModeCycles` — irrelevant to writeSessionSettings (it never reads that field; see the
  // ISOLATION NOTE above) and its presence previously implied this was production's real input shape,
  // which it no longer is.
  const perm = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [] };

  const plain = JSON.parse(fs.readFileSync(writeSessionSettings("sam-plain", perm, "test-hook-token"), "utf8"));
  check("skipAutoPermissionPrompt:true is present on a plain (no vault) session",
    plain.skipAutoPermissionPrompt === true);
  check("it did NOT displace any existing field — permissions.defaultMode faithfully reflects whatever mode was passed in",
    plain.permissions.defaultMode === "acceptEdits");
  check("it did NOT displace the resume-gate env override", plain.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES !== undefined);
  check("includeCoAuthoredBy is unaffected (still false)", plain.includeCoAuthoredBy === false);

  // Additive regardless of the vault-lint option too — same key, same value, every path.
  const withVault = JSON.parse(fs.readFileSync(writeSessionSettings("sam-vault", perm, "test-hook-token", os.tmpdir()), "utf8"));
  check("skipAutoPermissionPrompt:true is present alongside a vaultPath (docLint) session too",
    withVault.skipAutoPermissionPrompt === true);

  const bypass = JSON.parse(fs.readFileSync(
    writeSessionSettings("sam-plan", { ...perm, mode: "plan" }, "test-hook-token"), "utf8"));
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
