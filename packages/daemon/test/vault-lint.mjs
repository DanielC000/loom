// Vault-lint PostToolUse hook test (PR #21a, Pillar D). Fully deterministic — no daemon, no claude.
// Invokes the shipped vault-lint.mjs asset directly with synthetic PostToolUse payloads on stdin and
// asserts the mechanical loom-doc-hygiene checks fire (advisory, via stdout JSON) on the anti-patterns and
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

  // 2) broken wikilink WITH the opt-in flag → flagged (the check is opt-in / default-off now).
  const f2 = runHook(writeNote("links.md", "---\ndoc-lint-links: true\n---\n# Links\n\nSee [[Nonexistent]] for details.\n"));
  check("broken [[wikilink]] + doc-lint-links: true → flagged", !!f2 && /broken wikilink/i.test(f2.systemMessage));

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

  // --- false-positive guards ---

  // a) `doc-lint: false` frontmatter → ALL checks skipped (append marker + broken link + oversized) → no flag.
  const aBody = "# Note\n\nUPDATE: corrected.\n\nSee [[Nonexistent]].\n" + Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const fa = runHook(writeNote("optout.md", "---\ndoc-lint: false\ndoc-lint-links: true\n---\n" + aBody));
  check("doc-lint: false → all checks skipped → no flag", fa === null);

  // b) scar markers INSIDE a fenced code block → exempt; the SAME marker OUTSIDE the fence → flagged.
  const fbIn = runHook(writeNote("fenced.md", "# Meta\n\nA doc about scars:\n\n```\nUPDATE: this is quoted\nEDIT: also quoted\n```\n\nClean prose.\n"));
  check("append markers inside a ```fence``` → no flag", fbIn === null);
  const fbOut = runHook(writeNote("unfenced.md", "# Meta\n\n```\nUPDATE: quoted\n```\n\nUPDATE: but this one is real.\n"));
  check("append marker outside the fence (with one also inside) → flagged", !!fbOut && /append marker/i.test(fbOut.systemMessage));

  // c) broken wikilink with NO opt-in → no flag (default off); same note with doc-lint-links: true → flagged.
  const fcOff = runHook(writeNote("redlink.md", "# Red\n\nSee [[Nonexistent]] and [[Fire Studio]].\n"));
  check("broken wikilink, no opt-in → no flag (default off)", fcOff === null);
  const fcOn = runHook(writeNote("redlink-on.md", "---\ndoc-lint-links: true\n---\n# Red\n\nSee [[Nonexistent]].\n"));
  check("broken wikilink + doc-lint-links: true → flagged", !!fcOn && /broken wikilink/i.test(fcOn.systemMessage));

  // d) wikilink RESOLUTION matches Obsidian (regression guard for the false-positive flood, task 469ba89a):
  //    with doc-lint-links: true a VALID aliased / cross-folder / special-char (& / em-dash / spaces) link
  //    must produce ZERO warnings, while a genuinely dangling target still flags. The resolver strips
  //    |alias and #heading/#^block, resolves a bare basename against the WHOLE vault, and handles Folder/Name.
  fs.mkdirSync(path.join(VAULT, "Projects", "Loom"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Projects", "Loom", "Architecture.md"), "# Architecture\n");
  fs.writeFileSync(path.join(VAULT, "Projects", "Loom", "Vision & Architecture.md"), "# Vision\n");
  fs.writeFileSync(path.join(VAULT, "Projects", "Loom", "Operational Notes — Gotchas.md"), "# Ops\n"); // em-dash filename
  const validLinks = [
    "[[Architecture|the arch doc]]",                 // aliased, cross-folder, bare basename
    "[[Projects/Loom/Architecture]]",                // full Folder/Name path
    "[[Vision & Architecture]]",                      // ampersand + spaces
    "[[Vision & Architecture|vision]]",              // ampersand + alias
    "[[Operational Notes — Gotchas#Section]]",  // em-dash filename + #heading
  ].join(" and ");
  const fdOk = runHook(writeNote("resolves.md", `---\ndoc-lint-links: true\n---\n# Links\n\nSee ${validLinks}.\n`));
  check("valid aliased / cross-folder / special-char wikilinks + opt-in → ZERO warnings", fdOk === null);
  const fdBad = runHook(writeNote("resolves-bad.md",
    "---\ndoc-lint-links: true\n---\n# Links\n\nSee [[Vision & Architecture]] (valid) and [[Totally Nonexistent Note]] (dangling).\n"));
  check("a genuinely dangling target STILL flags (among valid special-char links)",
    !!fdBad && /broken wikilink/i.test(fdBad.systemMessage) && /Totally Nonexistent Note/.test(fdBad.systemMessage)
      && !/Vision & Architecture/.test(fdBad.systemMessage));

  // 7) writeSessionSettings wires the PostToolUse Write|Edit entry pointing at the shipped script.
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };
  const withVault = JSON.parse(fs.readFileSync(writeSessionSettings("vl-on", perm, VAULT), "utf8"));
  const ptu = withVault.hooks.PostToolUse;
  check("writeSessionSettings(vaultPath): PostToolUse matcher = Write|Edit", Array.isArray(ptu) && ptu[0].matcher === "Write|Edit");
  check("writeSessionSettings(vaultPath): command points at vault-lint.mjs + the vault path",
    ptu[0].hooks[0].command.includes("vault-lint.mjs") && ptu[0].hooks[0].command.includes(VAULT));
  check("writeSessionSettings(vaultPath): includeCoAuthoredBy === false (suppress Claude commit trailer)",
    withVault.includeCoAuthoredBy === false);
  const noVault = JSON.parse(fs.readFileSync(writeSessionSettings("vl-off", perm), "utf8"));
  check("writeSessionSettings(no vaultPath / docLint off): NO PostToolUse entry", noVault.hooks.PostToolUse === undefined);
  check("writeSessionSettings(no vaultPath): includeCoAuthoredBy === false (suppress Claude commit trailer)",
    noVault.includeCoAuthoredBy === false);
} finally {
  for (const d of [VAULT, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  for (const s of ["vl-on", "vl-off"]) { try { fs.rmSync(path.join(SETTINGS_DIR, `${s}.json`), { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — vault-lint flags append markers (fence-exempt) + oversized notes on vault .md writes (advisory), honors the doc-lint:false opt-out and the doc-lint-links:true broken-wikilink opt-in, ignores non-.md + out-of-vault writes, and is wired as a PostToolUse Write|Edit hook."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
