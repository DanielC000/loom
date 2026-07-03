// Default-ignore for daemon secret material (board card 77ccbd66, defense-in-depth p3). Asserts
// ensureDirs() writes/enforces a `.gitignore` in LOOM_HOME covering secret.key, *.key, *.pem — on a
// fresh install, on re-init (idempotent, no duplication), and without clobbering a user's own entries.
// Fully hermetic — no daemon, no claude, just ensureDirs() + fs assertions against LOOM_HOME.
//
// RUN with an isolated LOOM_HOME (test-daemon.mjs sets this up per-test automatically):
//   LOOM_HOME=<temp> node test/secret-gitignore.mjs
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, LOOM_HOME } from "../dist/paths.js";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const gitignorePath = path.join(LOOM_HOME, ".gitignore");

// 1) fresh install: ensureDirs() creates the .gitignore with all three default entries.
ensureDirs();
check(".gitignore created on fresh init", fs.existsSync(gitignorePath));
let content = fs.readFileSync(gitignorePath, "utf8");
check("covers secret.key", content.split(/\r?\n/).includes("secret.key"));
check("covers *.key", content.split(/\r?\n/).includes("*.key"));
check("covers *.pem", content.split(/\r?\n/).includes("*.pem"));

// 2) idempotent: re-running ensureDirs() does not duplicate entries.
ensureDirs();
ensureDirs();
content = fs.readFileSync(gitignorePath, "utf8");
const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
check("no duplicate entries after repeated ensureDirs()", lines.filter((l) => l === "secret.key").length === 1);

// 3) a pre-existing .gitignore with the user's own entries is preserved, and only the missing
//    default entries are appended (no clobbering, no reordering of the user's lines).
fs.rmSync(gitignorePath, { force: true });
fs.writeFileSync(gitignorePath, "my-notes.txt\ncustom.log");
ensureDirs();
content = fs.readFileSync(gitignorePath, "utf8");
check("preserves pre-existing user entry my-notes.txt", content.includes("my-notes.txt"));
check("preserves pre-existing user entry custom.log", content.includes("custom.log"));
check("appends missing secret.key to existing file", content.split(/\r?\n/).includes("secret.key"));
check("appends missing *.key to existing file", content.split(/\r?\n/).includes("*.key"));
check("appends missing *.pem to existing file", content.split(/\r?\n/).includes("*.pem"));

// 4) a .gitignore that already has one of the default entries (e.g. hand-added by a prior fix)
//    is not duplicated, but still gets the remaining missing entries appended.
fs.rmSync(gitignorePath, { force: true });
fs.writeFileSync(gitignorePath, "secret.key\n");
ensureDirs();
content = fs.readFileSync(gitignorePath, "utf8");
const lines2 = content.split(/\r?\n/).filter((l) => l.length > 0);
check("does not duplicate an already-present entry", lines2.filter((l) => l === "secret.key").length === 1);
check("still appends *.key when secret.key already present", lines2.includes("*.key"));
check("still appends *.pem when secret.key already present", lines2.includes("*.pem"));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  secret-gitignore (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
