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

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- 1. Behavioral: the shared predicate itself ----------------------------------------------------
const expectedTrue = new Set(["manager", "worker", "assistant"]);
for (const role of SESSION_ROLES) {
  check(`usesOrchestrationMcp("${role}") === ${expectedTrue.has(role)}`, usesOrchestrationMcp(role) === expectedTrue.has(role));
}
check("usesOrchestrationMcp(null) === false", usesOrchestrationMcp(null) === false);

// --- 2. Source-level: both call sites route through the shared predicate, not a local copy ---------
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const serviceSrc = fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "sessions", "service.ts"), "utf8");
const hostSrc = fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "pty", "host.ts"), "utf8");

check("sessions/service.ts imports usesOrchestrationMcp from @loom/shared", /\busesOrchestrationMcp\b[\s\S]{0,400}\} from "@loom\/shared";/.test(serviceSrc));
check("sessions/service.ts's dispatch gate calls the shared predicate", /if \(usesOrchestrationMcp\(role\)\)/.test(serviceSrc));
check("sessions/service.ts no longer hand-defines its own usesOrchestrationMcp method", !/\busesOrchestrationMcp\(role: SessionRole \| null\): boolean \{/.test(serviceSrc));

check("pty/host.ts imports usesOrchestrationMcp from @loom/shared", /import \{ resolveProfileCapabilities, usesOrchestrationMcp \} from "@loom\/shared";/.test(hostSrc));
check("pty/host.ts's kickoff gateOnMcp calls the shared predicate", /const gateOnMcp = usesOrchestrationMcp\(l0\?\.role \?\? null\);/.test(hostSrc));
check(
  "pty/host.ts's kickoff gate no longer hand-derives the role list inline",
  !/const gateOnMcp = l0\?\.role === "manager" \|\| l0\?\.role === "worker" \|\| l0\?\.role === "assistant";/.test(hostSrc),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
