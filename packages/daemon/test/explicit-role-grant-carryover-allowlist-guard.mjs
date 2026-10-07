import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure source-text scan
// STANDING GUARD (card acd3c688, round 2) — mirrors human-authorized-call-site-allowlist-guard.mjs's
// shape for the explicit-role-grant-carryover check (profiles/validate.ts's `explicitRoleGrantCarryoverError`,
// gated inside `resolveAgentSpawn`, sessions/service.ts). TWO independent total bypasses of that check
// exist, and this guard scans BOTH:
//   (A) `opts.spawnHumanAuthorized: true` — set ONLY by the human-REST session-start route
//       (gateway/server.ts's `POST /api/agents/:id/sessions`, six start* calls).
//   (B) `opts.skipGrantCarryoverCheck: true` — set ONLY by the carry-forward callers that re-derive for
//       an EXISTING session's already-pinned role (resume/forkSession/harnessDrainStatus's dry-run read/
//       composeCompanionReinjectPrompt/upgradeCompanionCapabilities/startRun) and by the three recycle
//       methods (recycleManager/recyclePlatformLead/recycleWorker — recycle carries every forbidden-key
//       field forward from the old row regardless, so the check can never meaningfully guard there; see
//       the decision record). Both opts are an EQUALLY TOTAL bypass of the same check — (B) is not a
//       lesser concern than (A), it is a DIFFERENT reason to skip, and a careless new (B) grant is just
//       as dangerous as a careless new (A) grant.
//
// ⚠ THIS GUARD PROVES A NARROWER CLAIM THAN "the bypass is only ever where it should be" — read exactly
// what it checks: every LITERAL `opts.<flag>: true` token anywhere in `packages/daemon/src` resolves to
// one of the allowlisted sites below. It does NOT, and cannot, see a COMPUTED or VARIABLE-CARRIED grant —
// the Scheduler's own `startFn(s.agentId, s.prompt, { spawnHumanAuthorized: scheduleCreatedByIsHuman(s) })`
// (orchestration/scheduler.ts) is exactly this shape: the grant is a FUNCTION CALL RESULT, never the
// literal `true`, so this scan cannot and does not see it at all — it is a DOCUMENTED, NAMED, un-scanned
// site, trusted by code review (`scheduleCreatedByIsHuman`'s own fail-closed semantics), not by this
// guard. Do not read "all N literal sites accounted for" as "the whole bypass surface is accounted for."
// KNOWN, DELIBERATE BLIND SPOTS, same per-flag (mirrors human-authorized-call-site-allowlist-guard.mjs):
//   - A non-literal truthy value, a variable/expression carrying the grant (incl. the Scheduler site
//     above), ES2015 property shorthand, a quoted key, a grant split across multiple lines, or `opts`
//     built/spread from an untrusted source.
//   - Any occurrence outside `packages/daemon/src/**/*.ts` (compiled `dist/`, `packages/web/`, etc.).
//
// Run: node packages/daemon/test/explicit-role-grant-carryover-allowlist-guard.mjs (no build needed —
// pure source-text scan of packages/daemon/src/**/*.ts)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Line-preserving comment stripper (same per-line discipline as human-authorized-call-site-allowlist-guard.mjs).
function stripTrailingLineComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && raw[i + 1] === "/" && raw[i - 1] !== ":") return raw.slice(0, i);
  }
  return raw;
}
function stripCommentsPreserveLines(source) {
  let inBlock = false;
  const out = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      out.push("");
      continue;
    }
    if (trimmed.startsWith("//")) { out.push(""); continue; }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      out.push("");
      continue;
    }
    if (trimmed.startsWith("*")) { out.push(""); continue; }
    out.push(stripTrailingLineComment(raw));
  }
  return out;
}

function walkTsFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walkTsFiles(full, base)); continue; }
    if (entry.name.endsWith(".ts")) out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

// Nearest preceding 2-space-indented class-method declaration line, by plain text (not a full AST parse
// — this guard is deliberately a pure source-text scan, per its own header). Card acd3c688 round 3,
// MINOR 1: several `resolveAgentSpawn(...)` call sites share the exact same ARGUMENT-SHAPE text (e.g.
// `"manager", false, undefined`) across DIFFERENT methods (recycleManager vs startManager) — a
// `mustContain` substring match alone can't tell a hit inside the right method from one accidentally
// moved into the wrong one that happens to share that text. Anchoring to the enclosing method closes
// that: a flag moved to a same-shaped but wrong method now fails its `method` check even though the
// `mustContain` text still matches.
const METHOD_DECL_RE = /^  (?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(?:private\s+|public\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*\(/;
function enclosingMethodName(lines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const m = METHOD_DECL_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function scanFor(baseDir, re) {
  const hits = [];
  for (const rel of walkTsFiles(baseDir)) {
    const lines = stripCommentsPreserveLines(fs.readFileSync(path.join(baseDir, rel), "utf8"));
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim(), method: enclosingMethodName(lines, i) });
    });
  }
  return hits;
}

// `a.method` is optional: group (A)'s six gateway/server.ts sites each call a DISTINCT function name
// (startManager/startPlatformLead/…) so the `mustContain` text alone is already unambiguous there, and
// they sit inside a route handler, not a class method, so there is no enclosing method name to anchor to.
function allowlistMatches(hit, a) {
  if (hit.file !== a.file || !hit.text.includes(a.mustContain)) return false;
  return a.method === undefined || hit.method === a.method;
}

function runAllowlistedScan({ label, re, allowlist, expectedCount }) {
  const hits = scanFor(SRC_DIR, re);
  check(`${label}: the real corpus scan found at least one grant (found ${hits.length})`, hits.length > 0);
  const offenders = hits.filter((h) => !allowlist.some((a) => allowlistMatches(h, a)));
  check(`${label}: every grant is one of the ${allowlist.length} allowlisted sites (offenders: ${offenders.map((h) => `${h.file}:${h.line} (method=${h.method ?? "none"})`).join(", ") || "none"})`,
    offenders.length === 0);
  for (const { file, mustContain, method } of allowlist) {
    check(`${label}: positive control: the allowlisted ${file} site (containing "${mustContain}"${method ? `, inside ${method}` : ""}) IS found`,
      hits.some((h) => allowlistMatches(h, { file, mustContain, method })));
  }
  check(`${label}: exactly ${expectedCount} real grants exist (no accidental extra duplicate at one of the allowlisted shapes)`, hits.length === expectedCount);
  return hits;
}

// ── (A) opts.spawnHumanAuthorized: true — the human-REST session-start route, six sites ──────────────
// Deliberately a DIFFERENT flag name from the pre-existing `humanAuthorized` (3de74275's createAgentCore/
// cloneAgentCore/applyWorkflowTemplate/checkRepoRebind opt-out) — the two mechanisms are unrelated, and a
// shared name would make this scan's own hits collide with human-authorized-call-site-allowlist-guard.mjs's
// three pre-existing, unrelated allowlisted sites.
const SPAWN_HUMAN_AUTHORIZED_RE = /\bspawnHumanAuthorized\s*:\s*true\b/;
const SPAWN_HUMAN_AUTHORIZED_ALLOWLIST = [
  { file: "gateway/server.ts", mustContain: "startManager(id" },
  { file: "gateway/server.ts", mustContain: "startPlatformLead(id" },
  { file: "gateway/server.ts", mustContain: "startAuditor(id" },
  { file: "gateway/server.ts", mustContain: "startWorkspaceAuditor(id" },
  { file: "gateway/server.ts", mustContain: "startSetup(id" },
  { file: "gateway/server.ts", mustContain: "startOperator(id" },
];
runAllowlistedScan({ label: "(A) spawnHumanAuthorized", re: SPAWN_HUMAN_AUTHORIZED_RE, allowlist: SPAWN_HUMAN_AUTHORIZED_ALLOWLIST, expectedCount: 6 });

// ── (B) opts.skipGrantCarryoverCheck: true — every carry-forward caller, nine sites ──────────────────
const SKIP_CHECK_RE = /\bskipGrantCarryoverCheck\s*:\s*true\b/;
const SKIP_CHECK_ALLOWLIST = [
  // harnessDrainStatus's dry-run read (no spawn effect at all).
  { file: "sessions/service.ts", mustContain: "effectiveForcePlain(s, agent)", method: "harnessDrainStatus" },
  // composeCompanionReinjectPrompt (compose-only, no spawn).
  { file: "sessions/service.ts", mustContain: '"assistant", false, companionName', method: "composeCompanionReinjectPrompt" },
  // resume() — re-derives for the row's own already-pinned role.
  { file: "sessions/service.ts", mustContain: "effectiveForcePlain(session, agent)", method: "resume" },
  // upgradeCompanionCapabilities — re-pins an EXISTING assistant-role session.
  { file: "sessions/service.ts", mustContain: '"assistant", false, undefined', method: "upgradeCompanionCapabilities" },
  // forkSession — carries the SOURCE row's already-pinned role forward.
  { file: "sessions/service.ts", mustContain: "forkAgent, config, src.role", method: "forkSession" },
  // startRun — every forbidden-key field is hardcoded false/absent on the spawned run session regardless.
  { file: "sessions/service.ts", mustContain: '"run", false, undefined', method: "startRun" },
  // recycleWorker/recycleManager/recyclePlatformLead — recycle carries every field from the OLD row.
  // `method` is load-bearing here (not decorative): the ARGUMENT-SHAPE text alone (`"worker"/"manager"/
  // "platform", false, undefined`) is shared with startManager/startPlatformLead's own resolveAgentSpawn
  // calls elsewhere in this file — only the enclosing-method anchor tells a recycle site apart from one
  // of those if a flag were ever moved onto the wrong one.
  { file: "sessions/service.ts", mustContain: '"worker", false, undefined', method: "recycleWorker" },
  { file: "sessions/service.ts", mustContain: '"manager", false, undefined', method: "recycleManager" },
  { file: "sessions/service.ts", mustContain: '"platform", false, undefined', method: "recyclePlatformLead" },
];
const skipHits = runAllowlistedScan({ label: "(B) skipGrantCarryoverCheck", re: SKIP_CHECK_RE, allowlist: SKIP_CHECK_ALLOWLIST, expectedCount: 9 });

// ── MINOR 1 regression proof (card acd3c688 round 3): the method anchor on the three recycle entries is
// LOAD-BEARING, not decorative. Simulate the exact swap the review flagged — a skipGrantCarryoverCheck
// hit landing inside startManager's OWN resolveAgentSpawn call, which shares recycleManager's identical
// `"manager", false, undefined` argument-shape text — and show it goes RED under the real matcher, after
// first showing TEXT ALONE (no method anchor) would have stayed GREEN, which is the defect being closed. ──
{
  const movedHit = { file: "sessions/service.ts", text: 'this.resolveAgentSpawn(agent, config, "manager", false, undefined, { skipGrantCarryoverCheck: true });', method: "startManager" };
  const recycleManagerEntry = SKIP_CHECK_ALLOWLIST.find((a) => a.method === "recycleManager");
  const textOnlyWouldMatch = movedHit.file === recycleManagerEntry.file && movedHit.text.includes(recycleManagerEntry.mustContain);
  check("MINOR-1 regression: TEXT ALONE (no method anchor) matches the moved hit — proving the two call sites really do share one argument shape",
    textOnlyWouldMatch === true);
  check("MINOR-1 regression: the METHOD-ANCHORED matcher correctly REJECTS the moved hit (method \"startManager\" != \"recycleManager\") despite the shared text",
    allowlistMatches(movedHit, recycleManagerEntry) === false);
}

// ── forwarding sites are NOT flagged (opts?.spawnHumanAuthorized / opts.spawnHumanAuthorized propagate an
// ALREADY-granted value, never mint a new one — the index.ts Scheduler wiring, and every start* method's
// own `{ spawnHumanAuthorized: opts?.spawnHumanAuthorized }` passthrough) ──────────────────────────────
const forwardingRe = /\bspawnHumanAuthorized\s*:\s*opts\??\.spawnHumanAuthorized\b/;
const serviceText = fs.readFileSync(path.join(SRC_DIR, "sessions", "service.ts"), "utf8");
check("positive control: sessions/service.ts DOES forward spawnHumanAuthorized (proves the forwarding shape is real, not a typo)",
  forwardingRe.test(serviceText));
check("the forwarding sites in sessions/service.ts are NOT counted as an (A) grant (doesn't match `: opts?.spawnHumanAuthorized`)",
  !serviceText.split("\n").some((l) => forwardingRe.test(l) && SPAWN_HUMAN_AUTHORIZED_RE.test(l)));

// ── (C) the Scheduler's COMPUTED spawnHumanAuthorized site — named here, never literally scanned (this
// guard's own documented blind spot, per its header) — a presence-only check that the computed call site
// still exists and still routes through scheduleCreatedByIsHuman, so at minimum a wholesale deletion or a
// rename of that helper is caught, even though a careless literal-true swap-in at this exact site would
// not be (that residual is the point of naming it here rather than pretending it's covered). ──────────
{
  const schedulerText = fs.readFileSync(path.join(SRC_DIR, "orchestration", "scheduler.ts"), "utf8");
  check("(C) the Scheduler's computed spawnHumanAuthorized site still calls scheduleCreatedByIsHuman (named, un-scanned-by-regex site)",
    /spawnHumanAuthorized:\s*scheduleCreatedByIsHuman\(/.test(schedulerText));
}

// ── negative control: a synthetic extra grant site, OUTSIDE either allowlist, IS caught — for BOTH flags ──
{
  const fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "loom-erg-guard-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "mcp"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "mcp", "sneaky.ts"),
      'const x = sessions.startManager(agentId, undefined, { spawnHumanAuthorized: true });\n' +
      'const y = sessions.resolveAgentSpawn(agent, config, "manager", false, undefined, { skipGrantCarryoverCheck: true });\n');
    const fixtureHitsA = scanFor(fixtureRoot, SPAWN_HUMAN_AUTHORIZED_RE);
    check("negative control (A): an illegal extra spawnHumanAuthorized site (outside gateway/server.ts) IS caught",
      fixtureHitsA.length === 1 && fixtureHitsA[0].file === "mcp/sneaky.ts");
    const fixtureHitsB = scanFor(fixtureRoot, SKIP_CHECK_RE);
    check("negative control (B): an illegal extra skipGrantCarryoverCheck site (outside the 9 allowlisted) IS caught",
      fixtureHitsB.length === 1 && fixtureHitsB[0].file === "mcp/sneaky.ts");
    fs.writeFileSync(path.join(fixtureRoot, "mcp", "commented.ts"),
      "// const x = fn(db, {}, { spawnHumanAuthorized: true, skipGrantCarryoverCheck: true });\n");
    const fixtureHitsA2 = scanFor(path.join(fixtureRoot, "mcp"), SPAWN_HUMAN_AUTHORIZED_RE).filter((h) => h.file === "commented.ts");
    const fixtureHitsB2 = scanFor(path.join(fixtureRoot, "mcp"), SKIP_CHECK_RE).filter((h) => h.file === "commented.ts");
    check("negative control: a COMMENT-only mention of either literal is NOT flagged (comment-stripped)",
      fixtureHitsA2.length === 0 && fixtureHitsB2.length === 0);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

check("(B) setup: nine distinct skipGrantCarryoverCheck sites were actually found (not fewer, collapsed by a shared mustContain)",
  new Set(skipHits.map((h) => h.line)).size === 9);

console.log(failures === 0
  ? "\n✅ ALL PASS — every LITERAL spawnHumanAuthorized:true grant resolves to the six human-REST start* calls, every LITERAL skipGrantCarryoverCheck:true grant resolves to the nine carry-forward/recycle call sites, the Scheduler's own computed (non-literal) site is named and still wired to scheduleCreatedByIsHuman, forwarding sites are correctly not counted as grants, and a synthetic extra site (or a comment-only mention) of either flag is correctly caught / correctly ignored. This proves the LITERAL-site surface only — see the header for what it cannot see."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
