// Boot-order test for card f1366911: signal handlers (SIGINT/SIGTERM/SIGHUP) and the FIRST
// `gracefulShutdown` assignment (the boot-safe stub from boot-shutdown-stub.ts) must be registered
// BEFORE the HTTP server starts listening (`startGatewayListeners(`) — not after it, and not after any
// boot `await` in between. Before this fix, `gracefulShutdown` was first assigned (and the ONLY
// `process.on(` registration loop ran) at the very end of `main()`, well after listen — a stop (HTTP or
// a raw signal) arriving in that window got a false 202 / Node's default signal behavior and no
// shutdown marker, later misclassified as a crash. See @decision f1366911 in src/index.ts /
// docs/decisions/f1366911-*.md for the full incident.
//
// STRUCTURAL ONLY — parses src/index.ts's real AST (same approach as boot-listen-not-blocked.mjs, card
// fdf93d3a), so this is immune to unrelated text growth near the call sites and never boots a real
// daemon (manager directive on this card: no real-daemon-boot test).
// Run: node test/boot-shutdown-registered-before-listen.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const srcText = fs.readFileSync(srcPath, "utf8");
const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);

function findIdentifierCalls(name) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

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

// Every `for (... of HANDLED_SIGNALS) { ... }` loop in the file.
function findHandledSignalsForLoops() {
  const out = [];
  const visit = (node) => {
    if (ts.isForOfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === "HANDLED_SIGNALS") out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

// Every bare assignment expression `gracefulShutdown = <expr>` (NOT the `let gracefulShutdown = ...`
// declaration itself, which is a VariableDeclaration, not a BinaryExpression).
function findGracefulShutdownReassignments() {
  const out = [];
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === "gracefulShutdown") out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

const listenCalls = [...findMethodCalls("listen", "app"), ...findIdentifierCalls("startGatewayListeners")]
  .sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
const stubCalls = findIdentifierCalls("makeBootShutdownStub");
const signalLoops = findHandledSignalsForLoops();
// `gracefulShutdown` is declared ONCE (`let gracefulShutdown: ... | null = null`) and then ASSIGNED via
// two separate bare `gracefulShutdown = <expr>` statements: the early boot-safe stub, and (later) the
// full teardown upgrade. Both are BinaryExpression assignments, not VariableDeclaration initializers.
const reassignments = findGracefulShutdownReassignments().sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));

check("src/index.ts binds the port (app.listen( or startGatewayListeners()", listenCalls.length > 0);
check("src/index.ts calls makeBootShutdownStub( exactly once", stubCalls.length === 1);
check("src/index.ts has exactly ONE `for (... of HANDLED_SIGNALS)` registration loop (no duplicate)", signalLoops.length === 1);
check("src/index.ts assigns gracefulShutdown exactly TWICE — the early stub, then the full-teardown upgrade", reassignments.length === 2);

const listenPos = listenCalls[0]?.getStart(sourceFile) ?? -1;
const stubPos = stubCalls[0]?.getStart(sourceFile) ?? -1;
const signalLoopPos = signalLoops[0]?.getStart(sourceFile) ?? -1;
const earlyAssignPos = reassignments[0]?.getStart(sourceFile) ?? -1;
const lateAssignPos = reassignments[1]?.getStart(sourceFile) ?? -1;

check("makeBootShutdownStub(...) runs BEFORE the HTTP server starts listening (the fix — was after)",
  listenPos >= 0 && stubPos >= 0 && stubPos < listenPos);
check("the SIGINT/SIGTERM/SIGHUP registration loop runs BEFORE the HTTP server starts listening (the fix — was after)",
  listenPos >= 0 && signalLoopPos >= 0 && signalLoopPos < listenPos);
check("gracefulShutdown's FIRST assignment (the early stub) happens BEFORE listen (the fix — was after)",
  listenPos >= 0 && earlyAssignPos >= 0 && earlyAssignPos < listenPos);
check("gracefulShutdown's SECOND assignment (the full-teardown upgrade) happens AFTER listen (unchanged — subsystems it closes over aren't constructed any earlier)",
  listenPos >= 0 && lateAssignPos >= 0 && lateAssignPos > listenPos);
check("the full-teardown upgrade happens strictly after the early stub assignment",
  earlyAssignPos >= 0 && lateAssignPos >= 0 && lateAssignPos > earlyAssignPos);

console.log(failures === 0
  ? "\n✅ ALL PASS — gracefulShutdown's boot-safe stub + the signal-handler registration loop both run BEFORE the HTTP server starts listening; the full teardown correctly upgrades the SAME binding afterward, exactly once, with no duplicate registration loop."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
