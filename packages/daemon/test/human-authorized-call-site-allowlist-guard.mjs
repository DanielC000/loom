import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure source-text scan
// STANDING GUARD — card a06650d2's delta-review ruling on the 3de74275 decision record (fix round 2): the
// createAgentCore/cloneAgentCore/applyWorkflowTemplate FIELD check (connections/capabilities/vaultWrite) is
// fail-closed by default on every caller; `opts.humanAuthorized: true` is the ONLY opt-out, and it must be
// set by EXACTLY TWO call sites — both human-only (bearer/gateway-token) REST routes in gateway/server.ts
// (the companion-provision auto-clone, and the /api/setup/templates/apply route) — never by an agent-facing
// MCP tool or any other caller. A THIRD site (a refactor, a new REST route, a careless copy-paste) granting
// this flag would silently widen the field-check bypass with no agent-facing symptom to notice it by (the
// human-only-surface-leak-guard's own check only proves `humanAuthorized` never appears under
// src/mcp/*.ts — it does NOT bound how many OTHER places outside mcp/ may grant it). This guard closes
// that gap: a corpus-wide, comment-stripped scan of every LITERAL `humanAuthorized: true` grant (never a
// type declaration `humanAuthorized?: boolean`, and never an internal forwarding call like
// `humanAuthorized: opts?.humanAuthorized`, which only propagates an ALREADY-granted value rather than
// minting a new one) against a fixed two-site allowlist.
//
// ⚠ THIS GUARD IS A TRIPWIRE AGAINST THE OBVIOUS MISTAKE, NOT A PROOF OF THE INVARIANT — it is a per-line
// LITERAL-text regex scan, not a type-checker or a dataflow analysis. Real agent-unreachability of
// `humanAuthorized` rests on `strictShape`'s `.strict()` rejecting any unknown MCP inputSchema key, NOT on
// this guard. KNOWN, DELIBERATE BLIND SPOTS (this guard will NOT catch a 3rd grant shaped like any of
// these — read it as a list of things a future refactor could still get wrong undetected):
//   - A non-literal truthy value: `humanAuthorized: !0`, `humanAuthorized: 1 === 1`, `humanAuthorized:
//     Boolean(1)`, `humanAuthorized: condition ? true : true`.
//   - A variable or expression carrying the grant: `const grant = true; …{ humanAuthorized: grant }`.
//   - ES2015 property shorthand: `const humanAuthorized = true; …{ humanAuthorized }`.
//   - A quoted key: `{ "humanAuthorized": true }`.
//   - A grant value split across multiple lines by an unusual formatter.
//   - `opts` (or any object literal) built from, or spread from, an untrusted request body/parameter
//     rather than a literal `{ humanAuthorized: true }` — e.g. `createAgentCore(db, args, req.body)`.
//   - Any occurrence outside `packages/daemon/src/**/*.ts` (compiled `dist/`, `packages/web/`, etc. are
//     not scanned).
//
// Run: node packages/daemon/test/human-authorized-call-site-allowlist-guard.mjs (no build needed — pure
// source-text scan of packages/daemon/src/**/*.ts)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Line-preserving comment stripper (same per-line discipline as the shared ./_strip-comments.mjs, but
// pushes an EMPTY string for a dropped comment-only line instead of omitting it entirely, so the output
// array's index+1 always equals the ORIGINAL file's line number — this guard reports real line numbers).
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
    if (trimmed.startsWith("*")) { out.push(""); continue; } // JSDoc/block-comment continuation
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

// A LITERAL grant — `humanAuthorized` followed by `:` then `true` as a standalone token (not `trueXyz`,
// not a type annotation `?: boolean`, and never matching the forwarding shape `humanAuthorized: opts?.…`).
const GRANT_RE = /\bhumanAuthorized\s*:\s*true\b/;

function scanGrants(baseDir) {
  const hits = [];
  for (const rel of walkTsFiles(baseDir)) {
    const lines = stripCommentsPreserveLines(fs.readFileSync(path.join(baseDir, rel), "utf8"));
    lines.forEach((line, i) => { if (GRANT_RE.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim() }); });
  }
  return hits;
}

// ── real corpus scan ────────────────────────────────────────────────────────────────────────────────────
const ALLOWLIST = [
  { file: "gateway/server.ts", mustContain: "cloneAgentCore(" },
  { file: "gateway/server.ts", mustContain: "applyWorkflowTemplate(" },
];
const realHits = scanGrants(SRC_DIR);
check(`the real corpus scan found at least one humanAuthorized:true grant (found ${realHits.length})`, realHits.length > 0);

const offenders = realHits.filter((h) => !ALLOWLIST.some((a) => a.file === h.file && h.text.includes(a.mustContain)));
check(`every humanAuthorized:true grant is one of the two allowlisted sites (offenders: ${offenders.map((h) => `${h.file}:${h.line}`).join(", ") || "none"})`,
  offenders.length === 0);

for (const { file, mustContain } of ALLOWLIST) {
  const found = realHits.some((h) => h.file === file && h.text.includes(mustContain));
  check(`positive control: the allowlisted ${file} site (containing "${mustContain}") IS found by the scan`, found);
}
check("exactly two real grants exist (no accidental 3rd+ duplicate at one of the two allowlisted shapes)", realHits.length === 2);

// ── forwarding sites are NOT flagged (clone-core.ts / setup/templates.ts propagate an ALREADY-granted
// value, never mint a new one — distinguishing these from a real grant is this guard's whole point) ──────
const forwardingRe = /\bhumanAuthorized\s*:\s*opts\??\.humanAuthorized\b/;
const cloneCoreText = fs.readFileSync(path.join(SRC_DIR, "agents", "clone-core.ts"), "utf8");
const templatesText = fs.readFileSync(path.join(SRC_DIR, "setup", "templates.ts"), "utf8");
check("positive control: clone-core.ts DOES forward humanAuthorized (proves the forwarding shape is real, not a typo)",
  forwardingRe.test(cloneCoreText));
check("positive control: setup/templates.ts DOES forward humanAuthorized (same reasoning)",
  forwardingRe.test(templatesText));
check("the forwarding sites in clone-core.ts/templates.ts are NOT counted as grants (GRANT_RE doesn't match `: opts?.humanAuthorized`)",
  !GRANT_RE.test(cloneCoreText.split("\n").find((l) => forwardingRe.test(l)) ?? "")
  && !GRANT_RE.test(templatesText.split("\n").find((l) => forwardingRe.test(l)) ?? ""));

// ── negative control: a synthetic THIRD grant site, OUTSIDE the allowlist, IS caught ──────────────────────
{
  const fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "loom-ha-guard-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "mcp"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "mcp", "sneaky.ts"), 'const x = createAgentCore(db, {}, { humanAuthorized: true });\n');
    const fixtureHits = scanGrants(fixtureRoot);
    check("negative control: an illegal 3rd-site grant (outside gateway/server.ts) IS caught by the scan",
      fixtureHits.length === 1 && fixtureHits[0].file === "mcp/sneaky.ts");
    // A COMMENT-only mention of the same literal text must NOT be flagged (comment-stripped scan).
    fs.writeFileSync(path.join(fixtureRoot, "mcp", "commented.ts"), "// const x = fn(db, {}, { humanAuthorized: true });\n");
    const fixtureHits2 = scanGrants(path.join(fixtureRoot, "mcp"));
    check("negative control: a COMMENT-only mention of the same literal is NOT flagged (comment-stripped)",
      fixtureHits2.filter((h) => h.file === "commented.ts").length === 0);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the ONLY two humanAuthorized:true grants in the whole src/ tree are gateway/server.ts's companion-provision auto-clone and its REST template-apply route; clone-core.ts's/setup/templates.ts's own internal forwarding is correctly NOT counted as a grant; and a synthetic 3rd-site grant (or a comment-only mention) is correctly caught / correctly ignored."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
