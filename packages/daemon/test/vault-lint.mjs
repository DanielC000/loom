// Vault-lint PostToolUse hook test (PR #21a, Pillar D). Fully deterministic — no daemon, no claude.
// Invokes the shipped vault-lint.mjs asset directly with synthetic PostToolUse payloads on stdin and
// asserts the mechanical doc-hygiene checks fire (advisory, via stdout JSON) on the anti-patterns and
// stay silent on clean / out-of-scope writes. Also asserts writeSessionSettings wires the PostToolUse
// Write|Edit entry pointing at the script.
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   LOOM_HOME=<temp> node test/vault-lint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VAULT_LINT_SCRIPT, SETTINGS_DIR, ensureDirs } from "../dist/paths.js";
import { writeSessionSettings } from "../dist/pty/claude-settings.js";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- a temp vault with one resolvable note + a dir OUTSIDE the vault ---
const VAULT = path.join(os.tmpdir(), `loom-vault-${Date.now()}`);
const OUTSIDE = path.join(os.tmpdir(), `loom-outside-${Date.now()}`);
fs.mkdirSync(VAULT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(VAULT, "Existing.md"), "# Existing\n\nA real note.\n");

// Invoke the hook script as Claude would: payload JSON on stdin, vault path as argv. Returns the
// parsed advisory object (with systemMessage) on a flag, or null when the hook stays silent.
function runHook(filePath, tool = "Write") {
  const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath }, cwd: VAULT };
  const r = spawnSync(process.execPath, [VAULT_LINT_SCRIPT, VAULT], { input: JSON.stringify(payload), encoding: "utf8" });
  const out = (r.stdout || "").trim();
  return out ? JSON.parse(out) : null;
}
const writeNote = (rel, content) => { const p = path.join(VAULT, rel); fs.writeFileSync(p, content); return p; };

try {
  // 1) append marker (UPDATE:) → flagged.
  const f1 = runHook(writeNote("update.md", "# Note\n\nThe value is 42.\n\nUPDATE: actually it is 43.\n"));
  check("append marker (UPDATE:) → flagged", !!f1 && /append marker/i.test(f1.systemMessage));

  // 2) broken wikilink → flagged.
  const f2 = runHook(writeNote("links.md", "# Links\n\nSee [[Nonexistent]] for details.\n"));
  check("broken [[wikilink]] → flagged", !!f2 && /broken wikilink/i.test(f2.systemMessage));

  // 3) oversized note → flagged.
  const f3 = runHook(writeNote("big.md", Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n"));
  check("oversized note (>400 lines) → flagged", !!f3 && /oversized note/i.test(f3.systemMessage));

  // 4) clean bounded note with a RESOLVABLE wikilink → no flag.
  const f4 = runHook(writeNote("clean.md", "# Clean\n\nSee [[Existing]] — and [[Existing#section|an alias]] too.\n"));
  check("clean note with a resolvable [[Existing]] → no flag", f4 === null);

  // 5) a non-.md write → ignored.
  const f5 = runHook(path.join(VAULT, "code.ts"), "Write");
  check("non-.md write → ignored", f5 === null);

  // 6) a .md OUTSIDE the vault → ignored.
  const outside = path.join(OUTSIDE, "stray.md");
  fs.writeFileSync(outside, "UPDATE: this would be flagged if it were in the vault\n");
  const f6 = runHook(outside);
  check("a .md outside the vault → ignored (even with an append marker)", f6 === null);

  // 6b) Edit tool (not just Write) is handled the same way.
  const f6b = runHook(writeNote("edited.md", "EDIT: bolted-on correction\n"), "Edit");
  check("Edit tool on a vault .md with an append marker → flagged", !!f6b && /append marker/i.test(f6b.systemMessage));

  // 7) writeSessionSettings wires the PostToolUse Write|Edit entry pointing at the shipped script.
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };
  const withVault = JSON.parse(fs.readFileSync(writeSessionSettings("vl-on", perm, VAULT), "utf8"));
  const ptu = withVault.hooks.PostToolUse;
  check("writeSessionSettings(vaultPath): PostToolUse matcher = Write|Edit", Array.isArray(ptu) && ptu[0].matcher === "Write|Edit");
  check("writeSessionSettings(vaultPath): command points at vault-lint.mjs + the vault path",
    ptu[0].hooks[0].command.includes("vault-lint.mjs") && ptu[0].hooks[0].command.includes(VAULT));
  const noVault = JSON.parse(fs.readFileSync(writeSessionSettings("vl-off", perm), "utf8"));
  check("writeSessionSettings(no vaultPath / docLint off): NO PostToolUse entry", noVault.hooks.PostToolUse === undefined);
} finally {
  for (const d of [VAULT, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  for (const s of ["vl-on", "vl-off"]) { try { fs.rmSync(path.join(SETTINGS_DIR, `${s}.json`), { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — vault-lint flags append markers / broken wikilinks / oversized notes on vault .md writes (advisory), ignores non-.md + out-of-vault writes, and is wired as a PostToolUse Write|Edit hook."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
