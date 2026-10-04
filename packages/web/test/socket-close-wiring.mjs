// Card 04314fbc — pins that all three of the app's WebSocket clients actually DELEGATE their close
// decision to the shared unit, and that the fleet provider's two seed retry loops are stoppable.
//
// WHY A SOURCE SCAN, and what it does and does not prove. The BEHAVIOUR of the decision — that exactly
// one of retry/tokenDead/refused runs per close shape, and that a stopped retry loop arms nothing ever
// again — is proven behaviourally in `socket-reconnect.mjs` against the real module. What no unit test
// can see is whether a call site still bypasses that unit: `packages/web` has no React test harness
// (no jsdom, no testing-library), so `Terminal.tsx` / `CompanionChat.tsx` / `FleetSocketProvider.tsx`
// cannot be rendered and their `onclose` handlers cannot be invoked here. This file covers that half,
// and ONLY that half: the wiring, read off the real source text.
//
// RED on the pre-fix code for real reasons, not merely because the symbols are new:
//  - CompanionChat.tsx:263 was `if (!onSocketClose(e).retry) { setConn("revoked"); return; }` — one
//    terminal branch for BOTH 1008 kinds, so an unrecognised/policy refusal claimed the token was
//    revoked (check 3 below).
//  - FleetSocketProvider.tsx's 1008 branch returned without touching seedRetryTimer /
//    statusSeedRetryTimer, and both were armed by a bare `setTimeout(seed, SOCKET_RECONNECT_MIN_MS)`
//    (checks 5-7 below).
// Run: node packages/web/test/socket-close-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel) => {
  const text = readFileSync(join(root, rel), "utf8");
  // Comments mention the old shapes by name (this file's own header does too), so a raw scan would
  // match prose as happily as code. Strip comments first — the checks below are about CODE.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:])\/\/[^\n]*$/gm, "$1");
  assert.ok(stripped.length > 0, `${rel}: nothing left after comment-stripping — the stripper is broken`);
  return stripped;
};

const CLIENTS = {
  "components/Terminal.tsx": read("components/Terminal.tsx"),
  "components/CompanionChat.tsx": read("components/CompanionChat.tsx"),
  "components/FleetSocketProvider.tsx": read("components/FleetSocketProvider.tsx"),
};
const fleet = CLIENTS["components/FleetSocketProvider.tsx"];
const companion = CLIENTS["components/CompanionChat.tsx"];

// Every check runs even after an earlier one fails, and the failures are reported together. That is not
// cosmetic: this file's value as a CONTROL depends on being able to see WHICH defect each check catches
// when it is run against pre-fix source. Aborting on the first assertion would reduce the whole file to
// "the new symbol is missing", which proves far less than it looks like it does.
let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (err) { failures.push(name); console.log(`FAIL ${name}\n     ${err.message}`); }
};

// POSITIVE CONTROL FOR THE INSTRUMENT ITSELF. Every check below is an assertion about the presence or
// absence of a substring in these three files; an absence check passes identically if the file was read
// empty, or the path was wrong, or the stripper ate everything. So first prove the scan can see code
// that is definitely there.
check("(0) the scan really reads all three clients' source", () => {
  for (const [name, src] of Object.entries(CLIENTS)) {
    assert.ok(src.includes("socketReconnect"), `${name}: expected the shared module import to be visible`);
    assert.ok(src.includes("onclose") || src.includes("handleClose"), `${name}: expected a close handler`);
    assert.ok(src.length > 2000, `${name}: suspiciously short (${src.length} chars) — wrong path?`);
  }
});

check("(1) every client routes its close through the shared handleSocketClose", () => {
  for (const [name, src] of Object.entries(CLIENTS)) {
    assert.ok(/\bhandleSocketClose\s*\(/.test(src), `${name}: must call handleSocketClose`);
    assert.ok(/from "\.\.\/lib\/socketReconnect"/.test(src), `${name}: must import it from the shared module`);
  }
});

check("(2) no client calls onSocketClose directly any more — that is the collapse-prone form", () => {
  // onSocketClose returns a verdict and leaves the schedule-or-stop decision with the caller. It stays
  // exported (the unit test and a classify-without-side-effects caller want it), but a SOCKET CLIENT
  // using it is exactly how the two terminal kinds got conflated.
  for (const [name, src] of Object.entries(CLIENTS)) {
    assert.ok(!/\bonSocketClose\s*\(/.test(src), `${name}: still calls onSocketClose directly`);
  }
});

check("(3) every handleSocketClose call site supplies all THREE branches by name", () => {
  for (const [name, src] of Object.entries(CLIENTS)) {
    const calls = src.split(/\bhandleSocketClose\s*\(/).slice(1);
    assert.equal(calls.length, 1, `${name}: expected exactly one close-decision call site, saw ${calls.length}`);
    for (const branch of ["retry", "tokenDead", "refused"]) {
      assert.ok(new RegExp(`\\b${branch}\\s*:`).test(calls[0]), `${name}: missing the ${branch} branch`);
    }
  }
});

check("(4) the companion's two terminal branches land in DIFFERENT conn states", () => {
  // The defect this card fixes: ANY 1008 — policy or unrecognised — set conn to "revoked" and rendered
  // the "token revoked" pill, sending the user to re-paste a credential that was never the problem.
  const site = companion.split(/\bhandleSocketClose\s*\(/)[1];
  const tokenDead = /tokenDead\s*:\s*\(\s*\)\s*=>\s*setConn\("([a-z-]+)"\)/.exec(site);
  const refused = /refused\s*:\s*\(\s*\)\s*=>\s*setConn\("([a-z-]+)"\)/.exec(site);
  assert.ok(tokenDead, "tokenDead must set a conn state");
  assert.ok(refused, "refused must set a conn state");
  assert.equal(tokenDead[1], "revoked");
  assert.notEqual(refused[1], tokenDead[1], "a policy refusal must not reuse the revoked-credential state");
  // ...and that state must actually be rendered with its own copy, not fall through to a default.
  assert.ok(new RegExp(`conn === "${refused[1]}" \\?`).test(companion),
    `ChatHeader must give "${refused[1]}" its own pill rather than defaulting it to "reconnecting"`);
  assert.ok(!new RegExp(`conn === "${refused[1]}" \\?[^:]*token revoked`).test(companion),
    "the refused pill must not say the token was revoked");
});

check("(5) the fleet provider's seed retries are STOPPABLE loops, not bare setTimeouts", () => {
  const loops = fleet.match(/createRetryLoop\(\)/g) ?? [];
  assert.equal(loops.length, 2, `expected one retry loop per seed (2), saw ${loops.length}`);
  // The pre-fix arming form, in both of its spellings.
  assert.ok(!/setTimeout\(\s*seed\b/.test(fleet), "seed must not be re-armed by a bare setTimeout");
  assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*seedStatus/.test(fleet), "seedStatus must not be re-armed by a bare setTimeout");
  assert.ok(!/seedRetryTimer|statusSeedRetryTimer/.test(fleet), "the uncleared raw timer handles must be gone");
  // Each seed's failure path arms its OWN loop and gives up once that loop is stopped.
  assert.ok(/seedRetry\.schedule\(/.test(fleet) && /statusSeedRetry\.schedule\(/.test(fleet),
    "both seeds must re-arm through their own loop");
  assert.ok(/seedRetry\.stopped\(\)/.test(fleet) && /statusSeedRetry\.stopped\(\)/.test(fleet),
    "a fetch that rejects AFTER the terminal close must check its loop before re-arming");
});

check("(6) a TERMINAL close stops both seed loops", () => {
  // The whole point of the card: the 1008 branch used to stop only the reconnect, leaving a seed that
  // 401s because the credential just died to retry that same 401 at ~1 Hz forever.
  assert.ok(/stopSeedRetries\(\)/.test(fleet), "there must be one helper that stops both loops");
  assert.ok(/const stopSeedRetries = [\s\S]{0,200}?seedRetry\.stop\(\)[\s\S]{0,200}?statusSeedRetry\.stop\(\)/.test(fleet),
    "stopSeedRetries must stop BOTH loops, not just one");
  const site = fleet.split(/\bhandleSocketClose\s*\(/)[1];
  assert.ok(/const terminal = [\s\S]{0,300}?stopSeedRetries\(\)/.test(fleet),
    "the shared terminal path must stop the loops");
  // Both terminal branches must reach that path, and the retryable one must NOT.
  for (const branch of ["tokenDead", "refused"]) {
    const body = new RegExp(`${branch}\\s*:\\s*(.*)`).exec(site)?.[1] ?? "";
    assert.ok(/terminal\(|stopSeedRetries\(\)/.test(body), `${branch} must stop the seed loops (saw: ${body.trim()})`);
  }
  const retryBody = site.split(/retry\s*:\s*\(\)\s*=>\s*\{/)[1]?.split("},")[0] ?? "";
  assert.ok(retryBody.includes("startFallbackPoll"), "the retry branch body must be readable");
  assert.ok(!/stopSeedRetries\(\)/.test(retryBody),
    "an ordinary disconnect must NOT stop the seeds — the reconnect re-seeds through them");
});

check("(7) unmount stops the loops too, and the disconnected fallback poll deliberately survives", () => {
  // The effect cleanup used to clearTimeout both raw handles; it must now stop both loops instead.
  const cleanup = fleet.slice(fleet.lastIndexOf("return () => {"));
  assert.ok(/stopSeedRetries\(\)/.test(cleanup), "cleanup must stop both seed loops");
  assert.ok(/stopFallbackPoll\(\)/.test(cleanup), "cleanup must still stop the fallback poll");
  // ...but a TERMINAL close keeps the fallback poll running on purpose: its own 401 is what holds the
  // gateway banner up, and at 10s it is ~6 requests/min per feed rather than the seeds' ~120/min.
  assert.ok(/const terminal = [\s\S]{0,400}?startFallbackPoll\(\)/.test(fleet),
    "a terminal close must still start the fallback poll");
});

if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n${pass} check(s) passed`);
