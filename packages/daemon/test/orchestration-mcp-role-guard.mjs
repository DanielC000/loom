// Card 95f40ee0: PtyHost (pty/host.ts, scheduleKickoffGuarantee's `gateOnMcp`) and SessionService
// (sessions/service.ts, enqueueDurableNudge) both need to know which SessionRoles mount the
// loom-orchestration MCP server. Before this card each side hand-typed its OWN copy of the same
// three-role comparison — PtyHost deliberately has no access to SessionService, so the two literal
// copies could silently drift apart (a fail-safe drift, but a real maintenance hazard — see the card
// body). This guard proves both sides now derive the answer from the SAME `usesOrchestrationMcp` export
// in @loom/shared (packages/shared/src/types.ts), not from independently-typed literals:
//  1. a behavioral check that the shared predicate itself is correct for every SessionRole;
//  2. a SOURCE-level check that each call site actually invokes the shared predicate, rather than a
//     re-derived hand-rolled comparison — the structural failure mode this card closes. A behavioral
//     check alone can't catch that: once both call sites route through one shared function, they are
//     BY CONSTRUCTION incapable of disagreeing at runtime, so the only way this guard can still observe
//     the pre-fix drift is by reading the source for a reintroduced local copy.
import fs from "node:fs";
import path from "node:path";
import { usesOrchestrationMcp, SESSION_ROLES } from "@loom/shared";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- 1. Behavioral: the shared predicate itself ----------------------------------------------------
const expectedTrue = new Set(["manager", "worker", "assistant"]);
for (const role of SESSION_ROLES) {
  check(`usesOrchestrationMcp("${role}") === ${expectedTrue.has(role)}`, usesOrchestrationMcp(role) === expectedTrue.has(role));
}
check("usesOrchestrationMcp(null) === false", usesOrchestrationMcp(null) === false);

// --- 2. Source-level: both call sites route through the shared predicate, not a local copy ---------
// Card 36afbbdd: comment-stripped before matching — the two "no longer hand-defines/derives" checks
// below are ABSENCE checks on the exact OLD literal shape, and this file's own header (and a real
// refactor-history comment in either .ts file) plausibly quotes that exact old shape verbatim as
// explanation, which would otherwise flip a comment-only diff to a false failure.
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const serviceSrc = stripComments(fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "sessions", "service.ts"), "utf8"));
const hostSrc = stripComments(fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "pty", "host.ts"), "utf8"));

// The import is matched as ONE `import { ... } from "@loom/shared"` statement (`[^}]*` cannot cross a closing
// brace, so it cannot straddle two statements) rather than a fixed character window after the name: the old
// `[\s\S]{0,400}` window silently went red whenever an unrelated type name was appended to the same import list
// (card 6f13746c's two MergeGate* types pushed it from 384 to 431 chars) although the intent still held.
// `import type {` is deliberately NOT matched — a type-only import is erased at runtime, so it cannot supply the predicate.
const SHARED_IMPORT_OF_PREDICATE = /\bimport\s*\{[^}]*\busesOrchestrationMcp\b[^}]*\}\s*from\s*"@loom\/shared";/;
check("sessions/service.ts imports usesOrchestrationMcp from @loom/shared", SHARED_IMPORT_OF_PREDICATE.test(serviceSrc));
check("sessions/service.ts's dispatch gate calls the shared predicate", /if \(usesOrchestrationMcp\(role\)\)/.test(serviceSrc));
check("sessions/service.ts no longer hand-defines its own usesOrchestrationMcp method", !/\busesOrchestrationMcp\(role: SessionRole \| null\): boolean \{/.test(serviceSrc));

check("pty/host.ts imports usesOrchestrationMcp from @loom/shared", SHARED_IMPORT_OF_PREDICATE.test(hostSrc));
check("pty/host.ts's kickoff gateOnMcp calls the shared predicate", /const gateOnMcp = usesOrchestrationMcp\(l0\?\.role \?\? null\);/.test(hostSrc));
check(
  "pty/host.ts's kickoff gate no longer hand-derives the role list inline",
  !/const gateOnMcp = l0\?\.role === "manager" \|\| l0\?\.role === "worker" \|\| l0\?\.role === "assistant";/.test(hostSrc),
);

// (control, card 36afbbdd) NEGATIVE: a comment-only mention of the old hand-rolled shapes no longer flips
// either check. POSITIVE: the identical text as REAL code still does.
{
  const commentOnly =
    "// service.ts used to hand-define: usesOrchestrationMcp(role: SessionRole | null): boolean {\n" +
    '// host.ts used to hand-derive: const gateOnMcp = l0?.role === "manager" || l0?.role === "worker" || l0?.role === "assistant";\n';
  const s = stripComments(commentOnly);
  check("(control) NEGATIVE: comment-only mentions of the old shapes are gone after stripping",
    !/\busesOrchestrationMcp\(role: SessionRole \| null\): boolean \{/.test(s)
    && !/const gateOnMcp = l0\?\.role === "manager" \|\| l0\?\.role === "worker" \|\| l0\?\.role === "assistant";/.test(s));
  const realViolation =
    'function usesOrchestrationMcp(role: SessionRole | null): boolean { return role === "manager"; }\n' +
    'const gateOnMcp = l0?.role === "manager" || l0?.role === "worker" || l0?.role === "assistant";\n';
  const r = stripComments(realViolation);
  check("(control) POSITIVE: the same text as REAL code still trips both checks after stripping",
    /\busesOrchestrationMcp\(role: SessionRole \| null\): boolean \{/.test(r)
    && /const gateOnMcp = l0\?\.role === "manager" \|\| l0\?\.role === "worker" \|\| l0\?\.role === "assistant";/.test(r));
}

// (control) the import matcher itself: it must survive a long name list, and still REJECT each shape that is not
// a runtime import of the predicate from @loom/shared.
{
  const longList = 'import {\n  usesOrchestrationMcp, ' + Array.from({ length: 40 }, (_, i) => `type SomeLongTypeName${i}`).join(", ") + ',\n} from "@loom/shared";\n';
  check("(control) POSITIVE: a >400-char name list after the predicate still matches", longList.length > 800 && SHARED_IMPORT_OF_PREDICATE.test(longList));
  check("(control) NEGATIVE: the predicate imported from a local module does not match",
    !SHARED_IMPORT_OF_PREDICATE.test('import { usesOrchestrationMcp } from "./local.js";\nimport { other } from "@loom/shared";\n'));
  check("(control) NEGATIVE: a type-only import of the predicate does not match",
    !SHARED_IMPORT_OF_PREDICATE.test('import type { usesOrchestrationMcp } from "@loom/shared";\n'));
  check("(control) NEGATIVE: the predicate absent from the @loom/shared import list does not match",
    !SHARED_IMPORT_OF_PREDICATE.test('import { resolveConfig } from "@loom/shared";\nconst usesOrchestrationMcp = 1;\n'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
