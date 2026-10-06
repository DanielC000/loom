// Pins that packages/daemon/src/index.ts calls declareDaemonProcess() EXACTLY ONCE, and BEFORE the
// daemon's own `new Db(` — card 0a03059e (docs/decisions/0a03059e-prod-db-default-refuse.md). This is
// the ONE legitimate call site the whole prod-db-default-refuse guard trusts; if it's ever removed,
// duplicated, or reordered to after `new Db(`, the real daemon boot would start refusing to open its own
// database (a P0: the daemon would never boot) with no other test catching it — db.ts's own guard logic
// has no way to see what index.ts does or doesn't call.
//
// Checks BOTH the real src/index.ts AND the real built dist/index.js (a build step, or a hand-edit of
// only one of the two, could desync them), and proves the detector itself is falsifiable by running it
// against synthetic mutations of the SAME real text (removed / duplicated / moved-after) rather than
// trusting its own logic blindly.
//
// Run: 1) build daemon, 2) node test/daemon-declare-ordering.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1) — pure source-text scan below, no Db used
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DECLARE_RE = /\bdeclareDaemonProcess\s*\(\s*\)/g;
const NEW_DB_RE = /\bnew\s+Db\s*\(/;

/** @returns {{declareCount:number, declarePos:number|undefined, dbPos:number|undefined}} */
function analyze(rawText) {
  const text = stripComments(rawText);
  const declareMatches = [...text.matchAll(DECLARE_RE)];
  const dbMatch = NEW_DB_RE.exec(text);
  return { declareCount: declareMatches.length, declarePos: declareMatches[0]?.index, dbPos: dbMatch?.index };
}

/** @returns {{ok:boolean, reason?:string}} */
function verdict(a) {
  if (a.declareCount !== 1) return { ok: false, reason: `declareDaemonProcess() called ${a.declareCount} time(s), expected exactly 1` };
  if (a.dbPos === undefined) return { ok: false, reason: "no `new Db(` call found at all" };
  if (a.declarePos === undefined) return { ok: false, reason: "declareDaemonProcess() call not found" };
  if (!(a.declarePos < a.dbPos)) return { ok: false, reason: "declareDaemonProcess() does not come BEFORE new Db(" };
  return { ok: true };
}

const srcPath = path.join(__dirname, "..", "src", "index.ts");
const distPath = path.join(__dirname, "..", "dist", "index.js");
const srcText = fs.readFileSync(srcPath, "utf8");
const distText = fs.readFileSync(distPath, "utf8");

// This is an EXPLICIT comment-stripped whole-file scan (CLAUDE.md / git/worktrees.ts's
// CHANGED_TS_TEXT_SCANNER_REPO_PATHS doc, shape (3)): immune to a comment-only diff by construction, so
// it deliberately does NOT belong on that list. Sanity-check the stripper itself actually strips, rather
// than trusting it blindly — the raw src text carries the inline `@decision 0a03059e` comment at the real
// declareDaemonProcess() call site; the stripped text must not.
check("(sanity) stripComments() actually removes a known real comment from src/index.ts",
  srcText.includes("@decision 0a03059e") && !stripComments(srcText).includes("@decision 0a03059e"));

// --- (A)/(B) PIN the real files ---
const srcVerdict = verdict(analyze(srcText));
check("(A) src/index.ts: declareDaemonProcess() called exactly once, before new Db(", srcVerdict.ok);
if (!srcVerdict.ok) console.log(`    reason: ${srcVerdict.reason}`);

const distVerdict = verdict(analyze(distText));
check("(B) dist/index.js: declareDaemonProcess() called exactly once, before new Db(", distVerdict.ok);
if (!distVerdict.ok) console.log(`    reason: ${distVerdict.reason}`);

// --- (C)/(D)/(E) prove the detector is falsifiable — synthetic mutations of the REAL src text ---
const removed = srcText.replace(/declareDaemonProcess\(\);?/, "");
check("(C) setup: removal actually changed the text (sanity)", removed !== srcText);
check("(C) detector fires RED if the call is removed entirely", !verdict(analyze(removed)).ok);

const duplicated = srcText.replace(/(declareDaemonProcess\(\);)/, "$1\n  $1");
check("(D) setup: duplication actually changed the text (sanity)", duplicated !== srcText);
check("(D) detector fires RED if the call is duplicated (count != 1)", !verdict(analyze(duplicated)).ok);

// Build the moved-after text directly (swap the two statements) rather than via a tricky single regex.
const moved = (() => {
  const declareStmt = "declareDaemonProcess();";
  const dbStmt = "const db = new Db();";
  const idx = srcText.indexOf(declareStmt);
  const dbIdx = srcText.indexOf(dbStmt);
  if (idx < 0 || dbIdx < 0 || dbIdx < idx) return srcText; // shouldn't happen against the real file
  const before = srcText.slice(0, idx);
  const between = srcText.slice(idx + declareStmt.length, dbIdx);
  const after = srcText.slice(dbIdx + dbStmt.length);
  return before + dbStmt + between + declareStmt + after;
})();
check("(E) setup: moved-after text actually changed (sanity)", moved !== srcText);
check("(E) detector fires RED if the call is moved to AFTER new Db(", !verdict(analyze(moved)).ok);

console.log(failures === 0
  ? "\n✅ ALL PASS — declareDaemonProcess() is called exactly once, before new Db(, in both src and dist; the detector itself is falsifiable."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
