#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// rotation-gate.mjs — durable exit-condition gate for the resume-doc ("Orchestrator Log.md")
// rotation procedure (card 8e2a4252).
//
// WHY THIS EXISTS: the gate this script runs was previously only PROSE — documented in
// `Operations/Orchestrator Rules.md`'s own §ROTATION-GATE section — and proven live only by having
// caught two real mistakes when a human/agent happened to remember to apply it by hand. A passive
// notice, however prominent, is not someone running it (see project memory
// shipping-a-detector-is-not-someone-reading-it). This script is the same check as a MECHANISM: a
// rotation either passes it structurally or is refused, with no step where a successor has to choose
// to re-read the procedure and reimplement it from memory.
//
// WHAT IT GATES: the ACTIVE doc a rotation is about to PROMOTE (i.e. the new/trimmed doc that will
// become the live resume doc after rotation) — not the resume doc's general content. The resume doc
// stays free to rewrite/trim anything else about itself; this only refuses if rotation would silently
// drop one of the durable markers below, or shrink the LIVE COMMITMENTS list below its required count.
//
// SOURCE OF THE MARKER LIST AND COUNT: `Projects/Loom/Operations/Orchestrator Rules.md` §ROTATION-GATE
// — a VAULT file, unreachable from this repo/worktree at the time this script was authored. The list
// below was copied verbatim from that section (relayed through card 8e2a4252's kickoff, itself already
// a copy) and MUST be re-checked against the live vault section by whoever next edits this file —
// this local copy can drift silently, same as any other copied-not-pointed-at value.
//
// USAGE:
//   node rotation-gate.mjs --active <path-to-post-rotation-active-doc> --archive <path-to-this-rotation's-archive-file>
// Both paths are REQUIRED and are read as given — this script never hardcodes a vault path. The doc
// lives outside this repo, at a location that differs per machine.
//
// EXIT CODES (never a print-and-continue): 0 = rotation may proceed. 1 = REFUSED — every failure is
// named on stderr. 2 = usage error (missing/unreadable args), not a gate verdict.
//
// WHAT "--archive" IS CHECKED FOR: that it exists and is non-empty. A rotation that names an archive
// path which was never actually written is not a rotation that happened — this is a minimal, structural
// sanity check that the archive side of the operation is real, not a review of its content.
//
// ⚠️ HONEST LIMIT — READ BEFORE TRUSTING A GREEN: every marker check here is an EXACT-SUBSTRING grep.
// It can prove a token's literal text is still present; it CANNOT see a rule that survived rotation only
// in reworded, summarized, or reorganized form. A green from this script means "nothing was blatantly
// deleted" — a CANDIDATE SET that nothing obviously vanished — never a verdict that no meaning was lost.
// A human still has to read the actual diff for a rewrite that changed words but kept (or lost) the idea.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";

// Concept tokens match case-INSENSITIVELY (the concept must survive rotation, not its exact casing).
// `capQueued` matches case-SENSITIVELY: it is a literal response FIELD NAME a successor greps for, not
// a concept — the split is deliberate and load-bearing (the gate false-positived once when this was
// uniform); do not unify these into one rule.
const MARKERS = [
  { token: "Orchestrator Rules", caseSensitive: false, note: "THE POINTER — losing it orphans the whole rules file" },
  { token: "THE FOUR-LEG VERIFY", caseSensitive: false },
  { token: "LIVE COMMITMENTS", caseSensitive: false },
  { token: "MY-PEER-SEND-LEDGER", caseSensitive: false },
  { token: "OWNER-GATED", caseSensitive: false },
  { token: "ROTATE AT 40 KB", caseSensitive: false },
  { token: "THE SAFE-WRITE", caseSensitive: false },
  { token: "MULTI-HARNESS EPIC", caseSensitive: false },
  { token: "ANNOUNCE-CANNOT-CARRY-A-SHA", caseSensitive: false },
  { token: "NO-CLEARANCE-FROM-SILENCE", caseSensitive: false },
  { token: "MGR122-FLOOR", caseSensitive: false },
  { token: "capQueued", caseSensitive: true, note: "a literal response FIELD NAME — must match casing exactly" },
  { token: "in-memory", caseSensitive: false },
  { token: "QUIET-LANE", caseSensitive: false },
];

const REQUIRED_LIVE_COMMITMENTS_COUNT = 14;

const HELP = `rotation-gate.mjs — refuse to promote a resume-doc rotation that silently drops a durable marker or shrinks the LIVE COMMITMENTS list.

USAGE:
  node rotation-gate.mjs --active <path-to-post-rotation-active-doc> --archive <path-to-this-rotation's-archive-file>
  node rotation-gate.mjs --help

Exit 0 = rotation may proceed. Exit 1 = refused (see stderr for every failure). Exit 2 = usage error.

Checks run against --active:
  1. All ${MARKERS.length} markers below are present as exact substrings (see the case-sensitivity note in each).
  2. The LIVE COMMITMENTS section (between its heading and the next MY-PEER-SEND-LEDGER heading) still
     contains ${REQUIRED_LIVE_COMMITMENTS_COUNT} numbered items, matched by /^\\d+\\. /gm.

Checks run against --archive:
  3. The path exists, is a regular file, and is non-empty.

Markers (case-INsensitive unless noted):
${MARKERS.map((m) => `  - ${m.token}${m.caseSensitive ? " (case-SENSITIVE)" : ""}${m.note ? ` — ${m.note}` : ""}`).join("\n")}

⚠️ HONEST LIMIT: every check here is an exact-substring grep. It proves a token's literal text survived;
it cannot see a rule that was reworded, summarized, or split across lines during rotation. A green is a
candidate set ("nothing was blatantly deleted"), never a verdict that nothing was lost.

Marker list and the required LIVE COMMITMENTS count are sourced from \`Operations/Orchestrator Rules.md\`
§ROTATION-GATE (a vault file outside this repo) — re-verify this script's copy against that section
before trusting it long-term; see the file header for why.
`;

const HONEST_LIMIT_NOTE =
  "[rotation-gate] limit: every check above is an exact-substring grep — it proves literal text survived, " +
  "not that no meaning was lost to rewording. Treat a green as a candidate set, not a verdict.";

function parseArgs(argv) {
  const out = { active: null, archive: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (a === "--active") {
      out.active = argv[++i];
    } else if (a === "--archive") {
      out.archive = argv[++i];
    } else if (a.startsWith("--active=")) {
      out.active = a.slice("--active=".length);
    } else if (a.startsWith("--archive=")) {
      out.archive = a.slice("--archive=".length);
    } else {
      console.error(`[rotation-gate] unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function findMissingMarkers(text) {
  const missing = [];
  for (const marker of MARKERS) {
    const haystack = marker.caseSensitive ? text : text.toLowerCase();
    const needle = marker.caseSensitive ? marker.token : marker.token.toLowerCase();
    if (!haystack.includes(needle)) missing.push(marker);
  }
  return missing;
}

// Returns the count of /^\d+\. /gm matches strictly between the first "LIVE COMMITMENTS" heading and the
// next "MY-PEER-SEND-LEDGER" heading after it, or null if either boundary can't be located (in which
// case the marker check above will already have flagged the missing heading).
function countLiveCommitments(text) {
  const lower = text.toLowerCase();
  const startIdx = lower.indexOf("live commitments");
  if (startIdx === -1) return null;
  const afterStart = text.slice(startIdx + "live commitments".length);
  const endIdxRel = afterStart.toLowerCase().indexOf("my-peer-send-ledger");
  const section = endIdxRel === -1 ? afterStart : afterStart.slice(0, endIdxRel);
  const matches = section.match(/^\d+\. /gm);
  return matches ? matches.length : 0;
}

function readRequiredFile(flagName, filePath) {
  if (!filePath) {
    console.error(`[rotation-gate] missing required --${flagName} <path>`);
    process.exit(2);
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`[rotation-gate] cannot read --${flagName} ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.active || !args.archive) {
    console.error(HELP);
    process.exit(2);
  }

  const activeText = readRequiredFile("active", args.active);

  let archiveStat;
  try {
    archiveStat = fs.statSync(args.archive);
  } catch (err) {
    console.error(`[rotation-gate] REFUSED: --archive ${args.archive} does not exist or is unreadable (${err.message})`);
    console.error(`[rotation-gate] a rotation must actually produce an archive file before its new active doc is promoted`);
    process.exit(1);
  }
  const archiveFailures = [];
  if (!archiveStat.isFile()) {
    archiveFailures.push(`--archive ${args.archive} is not a regular file`);
  } else if (archiveStat.size === 0) {
    archiveFailures.push(`--archive ${args.archive} is empty`);
  }

  const missing = findMissingMarkers(activeText);
  const liveCount = countLiveCommitments(activeText);

  const failures = [...archiveFailures];
  if (missing.length > 0) {
    failures.push(
      `missing ${missing.length}/${MARKERS.length} marker(s) from --active: ${missing.map((m) => m.token).join(", ")}`
    );
  }
  if (liveCount === null) {
    failures.push("could not locate the LIVE COMMITMENTS section (heading missing) — cannot verify its item count");
  } else if (liveCount !== REQUIRED_LIVE_COMMITMENTS_COUNT) {
    failures.push(
      `LIVE COMMITMENTS section in --active holds ${liveCount} numbered item(s), expected ${REQUIRED_LIVE_COMMITMENTS_COUNT}`
    );
  }

  if (failures.length > 0) {
    console.error(`[rotation-gate] REFUSED — rotation must not promote ${args.active}:`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(HONEST_LIMIT_NOTE);
    process.exit(1);
  }

  console.log(
    `[rotation-gate] OK — ${args.active} carries all ${MARKERS.length} markers and a ` +
      `${REQUIRED_LIVE_COMMITMENTS_COUNT}-item LIVE COMMITMENTS section; --archive ${args.archive} exists ` +
      `(${archiveStat.size} bytes). Rotation may proceed.`
  );
  console.log(HONEST_LIMIT_NOTE);
  process.exit(0);
}

main();
