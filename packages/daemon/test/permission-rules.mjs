// Card 8d0ba38b — pty/permission-rules.ts is the ONE helper that turns an absolute path into a Claude Code
// permissions.deny glob. A single-leading-slash rule is INERT on POSIX (measured on WSL, claude 2.1.323:
// `Read(/home/..)`/`Edit(/home/..)` from a --settings file elsewhere blocked nothing; `//home/..` blocked both).
// Pure module: no LOOM_HOME-derived state, so no temp LOOM_HOME is needed here.
import { toClaudeAbsoluteGlob, claudeAbsoluteGlobForms, claudeAbsoluteRules } from "../dist/pty/permission-rules.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// toClaudeAbsoluteGlob — both path shapes
check("POSIX path -> //home/...", toClaudeAbsoluteGlob("/home/user/.loom/skills") === "//home/user/.loom/skills");
check("win32 forward-slashed -> //c/...", toClaudeAbsoluteGlob("C:/Users/danie/.loom/skills") === "//c/Users/danie/.loom/skills");
check("win32 backslashed -> //c/...", toClaudeAbsoluteGlob("C:\\Users\\danie\\.loom") === "//c/Users/danie/.loom");
check("win32 drive letter is lowercased", toClaudeAbsoluteGlob("D:/x") === "//d/x");
check("never a single-slash absolute on POSIX", !/^\/[^/]/.test(toClaudeAbsoluteGlob("/home/u/x")));

// claudeAbsoluteGlobForms — POSIX emits ONLY `//`; win32 adds the measured-working plain `C:/` form
check("POSIX forms: only the // form", JSON.stringify(claudeAbsoluteGlobForms("/home/u/x", "linux")) === JSON.stringify(["//home/u/x"]));
check("darwin forms: only the // form", JSON.stringify(claudeAbsoluteGlobForms("/Users/u/x", "darwin")) === JSON.stringify(["//Users/u/x"]));
check("win32 forms: // form then plain C:/ form",
  JSON.stringify(claudeAbsoluteGlobForms("C:\\Users\\u\\x", "win32")) === JSON.stringify(["//c/Users/u/x", "C:/Users/u/x"]));

// claudeAbsoluteRules
check("Read rule, POSIX", JSON.stringify(claudeAbsoluteRules("Read", "/home/u/settings", "/**", "linux")) === JSON.stringify(["Read(//home/u/settings/**)"]));
check("Edit rule, no suffix, POSIX", JSON.stringify(claudeAbsoluteRules("Edit", "/home/u/f.json", "", "linux")) === JSON.stringify(["Edit(//home/u/f.json)"]));
check("Read rule, win32",
  JSON.stringify(claudeAbsoluteRules("Read", "C:\\L\\tmp\\settings", "/**", "win32")) === JSON.stringify(["Read(//c/L/tmp/settings/**)", "Read(C:/L/tmp/settings/**)"]));
check("rules never contain a backslash", claudeAbsoluteRules("Read", "C:\\a\\b", "/**", "win32").every((r) => !r.includes("\\")));
// Negative control: the OLD hand-built single-slash form is exactly what this helper must never emit on POSIX.
check("(negative control) the old single-slash form `Read(/home/u/settings/**)` is NOT produced for POSIX",
  !claudeAbsoluteRules("Read", "/home/u/settings", "/**", "linux").includes("Read(/home/u/settings/**)"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
