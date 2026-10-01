// Card 3b4e2bbe: `reserveHermeticPort()`/`listenHermetic()` (_hermetic-port.mjs) exist specifically
// because the plain `hermeticPort()` export returns a pid-derived guess that can land inside a Windows
// WinNAT/Hyper-V reserved port range — a real `.listen()` there fails `EACCES`, which is what redded
// b801bad0's 52-minute full merge gate. This is a TRIPWIRE against a future file reintroducing that same
// bug shape: binding directly off `hermeticPort()` instead of going through the two sanctioned helpers.
//
// Deliberately CHEAP/STATIC (text scan, not real data-flow analysis) — same posture as this suite's other
// whole-directory guards (see CLAUDE.md's own note on STATIC_GUARD_REPO_PATHS): it is not in that list
// (this is a test-only change; adding to STATIC_GUARD_REPO_PATHS means editing worktrees.ts, a src file,
// which is outside this card's scope — a reviewer/manager call, not this worker's), so run it directly:
// `node packages/daemon/test/hermetic-port-listen-guard.mjs`.
//
// TWO CHECKS:
//  (a) LITERAL — `hermeticPort()`'s call expression appears textually inside a `.listen(...)` call's own
//      argument list: the most direct form of the mistake this card's own DoD names ("a new
//      `.listen(hermeticPort())` fails loudly"). Bounded to the enclosing `.listen(...)` call's own
//      parens (depth-tracked), so it won't false-positive across two unrelated nearby calls.
//  (b) STRUCTURAL — a file imports the raw `hermeticPort` export AND calls `.listen(` anywhere, but does
//      NOT also import `reserveHermeticPort`/`listenHermetic` (the two sanctioned ways to actually bind a
//      hermetic port) — catches the one-step-removed version, where `hermeticPort()`'s return is stashed
//      in a variable/env var first and THAT is what reaches `.listen()`. Measured zero false positives
//      against the real corpus as of this card (every current `hermeticPort`+`.listen()` file already
//      imports one of the two safe helpers after this card's own fix).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));
const HELPER = "_hermetic-port.mjs";

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".mjs") && f !== SELF && f !== HELPER);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function listenCallArgsContain(text, needle) {
  const re = /\.listen\(/g;
  let m;
  while ((m = re.exec(text))) {
    const openAt = m.index + m[0].length - 1; // index of the "(" itself
    let depth = 0;
    let end = -1;
    for (let i = openAt; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue; // unbalanced — skip rather than false-positive
    const call = text.slice(openAt, end + 1);
    if (call.includes(needle)) return true;
  }
  return false;
}

let anyChecked = false;
for (const file of files) {
  const text = fs.readFileSync(path.join(__dirname, file), "utf8");

  if (listenCallArgsContain(text, "hermeticPort()")) {
    anyChecked = true;
    check(`${file}: a .listen(...) call does NOT pass hermeticPort()'s return value directly (use reserveHermeticPort()/listenHermetic() instead)`, false);
  }

  const importsHermeticPort = /\bimport\s*\{[^}]*\bhermeticPort\b[^}]*\}\s*from\s*["']\.\/_hermetic-port\.mjs["']/.test(text);
  const importsSafeHelper = /\bimport\s*\{[^}]*\b(?:reserveHermeticPort|listenHermetic)\b[^}]*\}\s*from\s*["']\.\/_hermetic-port\.mjs["']/.test(text);
  const callsListen = /\.listen\(/.test(text);
  if (importsHermeticPort && callsListen) {
    anyChecked = true;
    check(`${file}: imports hermeticPort() and calls .listen() — must also import reserveHermeticPort()/listenHermetic() (the sanctioned ways to bind a hermetic port)`, importsSafeHelper);
  }
}

// Positive control: confirm the scan mechanism itself actually fires on a known-bad shape, so a passing
// run above isn't just "the regex never matches anything" (the broken-pattern-looks-like-true-absence
// trap). Synthetic, in-memory only — never written to disk.
const knownBad = `
import { hermeticPort } from "./_hermetic-port.mjs";
await app.listen({ port: hermeticPort(), host: "127.0.0.1" });
`;
check("(control) the literal-pattern scan DOES fire on a known-bad synthetic snippet (proves the scan isn't vacuously passing)", listenCallArgsContain(knownBad, "hermeticPort()"));

check(`scanned ${files.length} test file(s); ${anyChecked ? "found" : "found no"} file(s) importing hermeticPort() alongside .listen()`, true);

console.log(failures === 0
  ? "\n✅ ALL PASS — no test file binds a hermetic port by passing hermeticPort()'s raw value into .listen()"
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
