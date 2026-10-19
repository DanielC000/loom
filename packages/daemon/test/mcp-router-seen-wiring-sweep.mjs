import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan, no Db used
// Card d1521fca, round 3 — `mcp-inbound-log.mjs` exercises the real `onSeen` wiring end-to-end but only
// for 2 of the 8 `/mcp*` gateway routers (task + orchestration), via a real spawned fixture per route.
// A real-spawn test per remaining router would be expensive and redundant with what's already proven
// (the SAME shared `logInboundMcpRequest` definition, not a per-route reimplementation — see
// gateway/server.ts's own comment above `recordMcpSeen`). This is the cheap, source-text sweep that
// covers the other 6 (and re-covers the 2 already proven) in one pass: every call to
// `logInboundMcpRequest(` in gateway/server.ts must pass `recordMcpSeen` in its argument list, or that
// router's own MCP traffic would silently never feed the MCP-silence watchdog's cadence baseline
// (orchestration/idle-watcher.ts) — the exact "wired for 2 of 8" gap this test exists to close.
//
// MECHANISM: find every `logInboundMcpRequest(` call site in the real file, extract its full argument
// list via a BALANCED-PAREN scan from the opening paren (handles the task/orchestration calls' own
// inline arrow-function argument, `(sid, tool) => attributions.get(tool)`, which carries nested parens
// of its own), and assert the bare token `recordMcpSeen` appears in it. Proven against a synthetic
// positive control (a call missing the argument) before trusting it against the real corpus.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.resolve(__dirname, "..", "src", "gateway", "server.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/**
 * Finds every `logInboundMcpRequest(` call in `src` and returns `{ index, args }` for each, where
 * `args` is the full balanced-paren argument-list text (the parens' own contents, not including the
 * call's own enclosing parens). Depth-tracked character-by-character — correct for this corpus's one
 * nested-paren shape (an inline arrow-function argument) without needing string/comment awareness,
 * since no call site here embeds a paren inside a string or comment token.
 */
function findCalls(src, calleeName) {
  const needle = `${calleeName}(`;
  const calls = [];
  let searchFrom = 0;
  for (;;) {
    const idx = src.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const openIdx = idx + needle.length - 1; // index of the call's own opening "("
    let depth = 0;
    let i = openIdx;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push({ index: idx, args: src.slice(openIdx + 1, i) });
    searchFrom = i + 1;
  }
  return calls;
}

/** The actual classifier: does this call's argument list pass `recordMcpSeen` (a bare token, not a
 *  substring of some other identifier)? */
function passesRecordMcpSeen(args) {
  return /\brecordMcpSeen\b/.test(args);
}

// --- Sanity / positive control on the CLASSIFIER + extractor ITSELF, before trusting them on the real file ---

{
  const synthetic = `logInboundMcpRequest("task", sessionId, req.body, (sid, tool) => attributions.get(tool), recordRepeatedCall, recordMcpSeen);`;
  const calls = findCalls(synthetic, "logInboundMcpRequest");
  check("sanity: findCalls finds exactly one call in a synthetic single-call snippet", calls.length === 1);
  check(
    "sanity: findCalls' balanced-paren scan correctly handles a nested-paren inline arrow argument (does not stop early at the arrow's own closing paren)",
    calls.length === 1 && calls[0].args.includes("recordRepeatedCall") && calls[0].args.includes("recordMcpSeen"),
  );
  check(
    "sanity: passesRecordMcpSeen is true for a call that genuinely passes recordMcpSeen (positive control)",
    calls.length === 1 && passesRecordMcpSeen(calls[0].args),
  );
}
{
  // RED PROOF (positive control, the real regression shape): a call that is missing recordMcpSeen
  // entirely — e.g. a 9th router added later whose author forgot to thread it — must be classified as
  // NOT passing it, never silently treated as fine.
  const syntheticMissing = `logInboundMcpRequest("newrouter", sessionId, req.body, undefined, recordRepeatedCall);`;
  const calls = findCalls(syntheticMissing, "logInboundMcpRequest");
  check("RED PROOF: a call missing recordMcpSeen entirely is found by findCalls", calls.length === 1);
  check(
    "RED PROOF: passesRecordMcpSeen correctly flags a call missing recordMcpSeen as NOT passing it (negative control failure case)",
    calls.length === 1 && !passesRecordMcpSeen(calls[0].args),
  );
}
{
  // A near-miss name must not false-positive the \b-bounded regex (e.g. a hypothetical
  // `recordMcpSeenForAudit` helper is a DIFFERENT identifier, not a call that passes the real one).
  const syntheticNearMiss = `logInboundMcpRequest("x", sessionId, req.body, undefined, recordMcpSeenForAudit);`;
  const calls = findCalls(syntheticNearMiss, "logInboundMcpRequest");
  check(
    "sanity: a near-miss identifier (recordMcpSeenForAudit) is NOT mistaken for the real recordMcpSeen token (word-boundary check)",
    calls.length === 1 && !passesRecordMcpSeen(calls[0].args),
  );
}

// --- The real assertion, over the real corpus ---

const serverSrc = fs.readFileSync(SERVER_FILE, "utf8");
const realCalls = findCalls(serverSrc, "logInboundMcpRequest");

check(`sanity: at least one real logInboundMcpRequest( call was found in gateway/server.ts (found ${realCalls.length})`, realCalls.length > 0);

const missing = [];
for (const call of realCalls) {
  if (!passesRecordMcpSeen(call.args)) {
    const lineNo = serverSrc.slice(0, call.index).split("\n").length;
    missing.push(`line ${lineNo}: ${call.args.slice(0, 80)}...`);
  }
}
check(
  `every real logInboundMcpRequest( call in gateway/server.ts passes recordMcpSeen (found ${realCalls.length} call(s), ${missing.length} missing it${missing.length > 0 ? ": " + missing.join("; ") : ""})`,
  missing.length === 0,
);

// Named per-router sanity (the 8 routers named in the card's own kickoff) — fails loud and names which
// router's own call is gone, rather than only reporting an aggregate count, if a route is ever renamed
// or removed without updating this list.
const EXPECTED_ROUTER_NAMES = ["task", "orchestration", "platform", "audit", "user-audit", "setup", "operator", "run"];
for (const routerName of EXPECTED_ROUTER_NAMES) {
  const found = realCalls.some((call) => call.args.trimStart().startsWith(`"${routerName}"`));
  check(`a logInboundMcpRequest("${routerName}", ...) call exists and passes recordMcpSeen`,
    found && realCalls.some((call) => call.args.trimStart().startsWith(`"${routerName}"`) && passesRecordMcpSeen(call.args)));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every logInboundMcpRequest( call site in gateway/server.ts (all 8 /mcp* routers) threads recordMcpSeen, proven by a balanced-paren source-text sweep with a positive control for the missing-argument regression shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
