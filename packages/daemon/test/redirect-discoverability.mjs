import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING CONTENT GUARD (card 7acee6d4) — WHY THIS EXISTS: the origin incident was a manager reaching
// for `worker_message` to "hold" a worker, because nothing at the moment of the tool call told it that
// `worker_redirect` is the hold/pause/stop tool, and nothing told it `worker_stop` is terminal, not a
// pause. The fix is TEXT — the `worker_redirect`/`worker_stop` tool descriptions in mcp/orchestration.ts
// (read at MCP call time) and the `/orchestrate` doctrine (assets/skills/orchestrate/SKILL.md, shipped to
// every end user's own project). A behavioral test can't catch a regression here — the tools already
// worked correctly; only the WORDING was misleading. So this is a pure text-content scan, run BEFORE this
// card's fix: every check below FAILED against the pre-fix text (see the card's own root-cause table).
//
// Two invariants this guards against separately regressing:
//   (A) `worker_redirect`'s description must lead with the hold/pause/stop/wait/don't-do-X/abandon
//       vocabulary a manager actually thinks in — not only "change course" (too narrow, per the card).
//   (B) `worker_stop`'s description must say plainly that it ENDS the session, so it can't be mistaken
//       for a pause.
//   (C) `/orchestrate`'s bright-line trigger and its verify-the-working-tree-first pairing must SHIP
//       TOGETHER — the card is explicit that shipping the trigger without the pairing is strictly worse
//       than the status quo (a discoverable stop button without a check that risks destroying correct
//       in-progress work). Assert one implies the other, not just that both happen to be present today.
//
// Run (no build needed — pure text scan of the .ts source + the shipped .md doctrine):
//   node packages/daemon/test/redirect-discoverability.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.join(__dirname, "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// -----------------------------------------------------------------------------------------------------
// (A) + (B) — the tool descriptions, straight from the MCP registration source (what the model reads
// at call time — not a paraphrase in some other doc that could drift from it).
// -----------------------------------------------------------------------------------------------------
const orchSrc = fs.readFileSync(path.join(DAEMON_ROOT, "src", "mcp", "orchestration.ts"), "utf8");

/** Extract the `description:` string literal/concatenation for a `server.registerTool("<name>", { ... })` block. */
function extractToolDescription(src, toolName) {
  const anchor = `"${toolName}",`;
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  const descIdx = src.indexOf("description", start);
  const schemaIdx = src.indexOf("inputSchema", descIdx);
  if (descIdx === -1 || schemaIdx === -1) return null;
  return src.slice(descIdx, schemaIdx);
}

const redirectDesc = extractToolDescription(orchSrc, "worker_redirect");
const stopDesc = extractToolDescription(orchSrc, "worker_stop");

check("worker_redirect description found in mcp/orchestration.ts", !!redirectDesc);
check("worker_stop description found in mcp/orchestration.ts", !!stopDesc);

if (redirectDesc) {
  // The intents a manager actually thinks, per the card's own list — not just "change course".
  const wantedIntents = ["hold", "pause", "wait for me", "don't do", "abandon"];
  for (const intent of wantedIntents) {
    check(`(A) worker_redirect description mentions the "${intent}" intent`, redirectDesc.toLowerCase().includes(intent));
  }
  // It must appear EARLY (in the opening clause), not buried after the mechanical explanation — the
  // origin defect was that a manager never got far enough to find a correct-but-late mention.
  const firstIntentIdx = Math.min(...wantedIntents.map((w) => {
    const i = redirectDesc.toLowerCase().indexOf(w);
    return i === -1 ? Infinity : i;
  }));
  const forcefullyIdx = redirectDesc.toLowerCase().indexOf("forcefully redirect");
  check(
    "(A) the hold/pause vocabulary leads the description (appears before the old narrow framing, or the narrow framing is gone)",
    firstIntentIdx < 200 && (forcefullyIdx === -1 || firstIntentIdx < forcefullyIdx),
  );
  // Verify-the-tree-first pairing must reach the TOOL DESCRIPTION too, not just doctrine — the manager
  // calling this tool without ever having loaded /orchestrate must still see the caution.
  check(
    "(A) worker_redirect description carries the verify-the-working-tree-first caution",
    /git status|working tree/i.test(redirectDesc) && /verify|check/i.test(redirectDesc),
  );
}

if (stopDesc) {
  check("(B) worker_stop description states plainly that it ENDS the session (terminal, not a pause)", /ENDS[^.]*session/.test(stopDesc));
  check("(B) worker_stop description points a manager wanting a HOLD/pause at worker_redirect instead", /worker_redirect/.test(stopDesc));
}

// -----------------------------------------------------------------------------------------------------
// (C) — the /orchestrate doctrine: bright-line trigger + verify-tree pairing must ship TOGETHER. Scan the
// SHIPPED bundle (assets/skills) — the copy every end user's project actually receives.
// -----------------------------------------------------------------------------------------------------
const skillPath = path.join(DAEMON_ROOT, "assets", "skills", "orchestrate", "SKILL.md");
const skillSrc = fs.readFileSync(skillPath, "utf8");

const hasBrightLine = /bright line/i.test(skillSrc) && /worker_redirect/.test(skillSrc) && /never `?worker_message`?/i.test(skillSrc);
const hasVerifyTreePairing = /working tree\s+is authoritative/i.test(skillSrc) && /event log is not/i.test(skillSrc);

check("(C) /orchestrate carries the bright-line hold/pause/stop trigger", hasBrightLine);
check("(C) /orchestrate carries the verify-the-tree-before-you-stop pairing", hasVerifyTreePairing);
check("(C) the trigger and its pairing ship TOGETHER (neither present without the other)", hasBrightLine === hasVerifyTreePairing);

// The shipped skill is generic (no Loom-specific paths/commands) — the card's own hard constraint.
const FORBIDDEN_TOKENS = ["packages/", "pnpm --filter", "@loom/", "Projects/Loom/"];
for (const token of FORBIDDEN_TOKENS) {
  check(`(C) shipped /orchestrate stays generic — no "${token}" token`, !skillSrc.includes(token));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_redirect/worker_stop lead with discoverable hold/pause/stop/terminal vocabulary, and /orchestrate ships the bright-line trigger only together with its verify-the-tree pairing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
