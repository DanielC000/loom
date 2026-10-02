import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5172fe3a — structural (AST-based, never timing-based) proof that `archiveOldCodexRollouts`
// (pty/codex-rollout-archive.ts) cannot race `restoreArchivedCodexRollout` (same file), the inverse
// operation a codex resume now runs before spawning (pty/host.ts#createCodexPty). See
// docs/decisions/5172fe3a-codex-rollout-archiver-cannot-race-a-restore.md for the full argument; this
// file is the mechanical proof it cites.
//
// THE ARGUMENT: a restored rollout keeps its original (stale) mtime, so if the archive sweep could run
// again WHILE a restore is possible, it could sweep a just-restored, still-in-use rollout straight back
// into the archive. The sweep has exactly ONE call site in the whole daemon (index.ts's boot sequence),
// runs synchronously, and must execute strictly BEFORE startGatewayListeners(...) binds the port — every
// path that could ever call restoreArchivedCodexRollout (SessionService.resume(), reached by
// resumeFleetOnBoot, the crash-recovery watcher, webhook ingress, event triggers, companion revive, or a
// human REST resume) requires that listener to be open first. So within one daemon process's lifetime
// the sweep runs exactly once, strictly before the earliest possible restore — no window exists where
// both can be in flight.
//
// Mirrors test/boot-listen-not-blocked.mjs's own AST-ordering technique exactly (same TypeScript parse,
// same call-finding helpers) — read that file's own header for why AST shape (not a character/line
// distance) is the right tool: immune to unrelated growth near either call site.
//
// Run: node test/codex-archive-sweep-precedes-listen.mjs (no build needed — reads src/index.ts directly)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const srcText = fs.readFileSync(srcPath, "utf8");
const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);

/** Every call expression `<identifier>(...)` in the file matching `name`, in source order. */
function findIdentifierCalls(name) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Every call expression `<...>.<methodName>(...)` in the file. `receiverName`, when given, restricts to
 *  a bare-identifier receiver `<receiverName>.<methodName>(...)` — mirrors boot-listen-not-blocked.mjs's
 *  own helper of the same name and shape, so `sessions.resumeFleetOnBoot(` is found precisely and not
 *  confused with some other object's own `.resumeFleetOnBoot(` (none exists today, but the receiver
 *  filter is what makes that a guarantee rather than a coincidence). */
function findMethodCalls(methodName, receiverName) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === methodName) {
      const receiver = node.expression.expression;
      if (!receiverName || (ts.isIdentifier(receiver) && receiver.text === receiverName)) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

const archiveCalls = findIdentifierCalls("archiveOldCodexRollouts");
// Same "listen" convention as boot-listen-not-blocked.mjs: the real bind happens inside
// startGatewayListeners(app, …), not a literal app.listen( — but a literal one (if ever reintroduced)
// still counts, so this can't silently stop proving anything if the code changes shape again.
const listenCalls = [...findMethodCalls("listen", "app"), ...findIdentifierCalls("startGatewayListeners")]
  .sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
const resumeFleetCalls = findMethodCalls("resumeFleetOnBoot");

check("src/index.ts calls archiveOldCodexRollouts( exactly once", archiveCalls.length === 1);
check("src/index.ts binds the port (app.listen( or startGatewayListeners()", listenCalls.length > 0);
check("src/index.ts calls sessions.resumeFleetOnBoot( exactly once", resumeFleetCalls.length === 1);

const archivePos = archiveCalls[0]?.getStart(sourceFile) ?? -1;
const listenPos = listenCalls[0]?.getStart(sourceFile) ?? -1;
const resumeFleetPos = resumeFleetCalls[0]?.getStart(sourceFile) ?? -1;

check("archiveOldCodexRollouts() runs STRICTLY BEFORE the gateway listener opens — nothing can call resume() (the only path to restoreArchivedCodexRollout) until then",
  archivePos >= 0 && listenPos >= 0 && archivePos < listenPos);
check("archiveOldCodexRollouts() ALSO runs strictly before resumeFleetOnBoot() (belt and suspenders: the fleet auto-resume itself runs later still, after the listener is already open)",
  archivePos >= 0 && resumeFleetPos >= 0 && archivePos < resumeFleetPos);
check("[negative control] the call-finder isn't vacuously matching everything — a call to a plainly-nonexistent identifier finds nothing",
  findIdentifierCalls("thisIdentifierDoesNotExistAnywhere_5172fe3a").length === 0);

// ═══ PROVE THIS CHECK CAN GO RED: parse a synthetic snippet with the calls in the WRONG order ═══
// (never mutates the real src/index.ts — a fresh, independent ts.createSourceFile over fabricated text)
{
  const badText = `
    function boot() {
      startGatewayListeners(app, {});
      archiveOldCodexRollouts();
      sessions.resumeFleetOnBoot(restartIntent);
    }
  `;
  const badFile = ts.createSourceFile("bad.ts", badText, ts.ScriptTarget.Latest, true);
  const findBad = (name) => {
    const out = [];
    const visit = (node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) out.push(node); ts.forEachChild(node, visit); };
    visit(badFile);
    return out;
  };
  const badArchivePos = findBad("archiveOldCodexRollouts")[0]?.getStart(badFile) ?? -1;
  const badListenPos = findBad("startGatewayListeners")[0]?.getStart(badFile) ?? -1;
  check("[RED-prove] this check's own ordering assertion correctly reports FALSE against a synthetic snippet with the wrong order (proves it CAN fail, not just that it currently passes)",
    !(badArchivePos >= 0 && badListenPos >= 0 && badArchivePos < badListenPos));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — archiveOldCodexRollouts() is called exactly once in src/index.ts, strictly before both the gateway listener opens and resumeFleetOnBoot() runs, so no caller of SessionService.resume() (the sole path to restoreArchivedCodexRollout) can ever be in flight while the sweep runs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
