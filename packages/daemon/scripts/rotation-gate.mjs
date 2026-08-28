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
// Re-verified against the live vault section 2026-08-28 (card d78a6d5d): the 14-item marker list and
// REQUIRED_LIVE_COMMITMENTS_COUNT=14 below still match §ROTATION-GATE verbatim — no drift found.
//
// USAGE:
//   node rotation-gate.mjs --active <path-to-post-rotation-active-doc> --archive <path-to-this-rotation's-archive-file>
//   node rotation-gate.mjs --active <path> --archive <path> --rules <path-to-non-rotating-rules-file>
//   node rotation-gate.mjs --active <path> --lint
// --active is always REQUIRED and is read as given — this script never hardcodes a vault path. The doc
// lives outside this repo, at a location that differs per machine. --archive is REQUIRED unless --lint
// is passed (see LINT MODE below).
//
// --rules <path> (OPTIONAL, card 9a5837b2): a UNION, not a replacement. A marker is satisfied if it is
// present in --active, OR — when --rules is supplied — in the --rules file. Omitting --rules leaves
// behavior byte-identical to before this flag existed: every marker must still be found in --active
// alone. The union exists because some of the durable-marker content is meant to move OUT of the
// rotating doc into the non-rotating `Operations/Orchestrator Rules.md`, and the gate must not go blind
// to a marker the moment it's relocated there — this makes the two landings (script change, vault move)
// order-independent: the gate passes via --active alone before the move and via --rules after, with no
// window where a marker that still genuinely exists somewhere durable is treated as missing. A marker
// absent from BOTH files still fails — this never weakens what "present" means, it only adds a second
// durable place to look. On success, the script names WHICH file satisfied each marker (see below) so a
// green never obscures where a rule now actually lives.
//
// LINT MODE (--lint, card 9a5837b2): runs the SAME marker + LIVE COMMITMENTS checks against --active
// (plus --rules if given) WITHOUT requiring or checking --archive at all. Rotation only happens at a
// rotation; a marker can silently break mid-seat (e.g. a card-line rewrite that carries a marker token
// away with it) and nothing would catch it until the next rotation, under exactly the time pressure the
// doc warns against. --lint lets anyone run the marker check against the LIVE doc, any time, for free.
// The archive check verifies "a rotation actually produced an archive file" — a question that has no
// meaning outside an actual rotation, so lint mode SKIPS it entirely rather than requiring a throwaway
// archive path: inventing a dummy file on every lint run is friction that would just discourage the
// thing this mode exists to encourage (running it often), and a REUSED throwaway risks misleading a
// future reader into thinking it's a real rotation artifact. This is deliberately a SEPARATE, explicit
// flag — the ROTATION path (no --lint) is completely unchanged and still hard-requires a real, non-empty
// --archive; lint mode can never be reached by accident.
//
// EXIT CODES (never a print-and-continue): 0 = rotation/lint may proceed / passes. 1 = REFUSED — every
// failure is named on stderr. 2 = usage error (missing/unreadable args), not a gate verdict.
//
// WHAT "--archive" IS CHECKED FOR (rotation path only — skipped entirely under --lint): that it exists
// and is non-empty. A rotation that names an archive path which was never actually written is not a
// rotation that happened — this is a minimal, structural sanity check that the archive side of the
// operation is real, not a review of its content.
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
  node rotation-gate.mjs --active <path> --archive <path> --rules <path-to-non-rotating-rules-file>
  node rotation-gate.mjs --active <path> --lint [--rules <path>]
  node rotation-gate.mjs --help

Exit 0 = rotation/lint may proceed. Exit 1 = refused (see stderr for every failure). Exit 2 = usage error.

--rules <path> (OPTIONAL): a marker is satisfied if present in --active OR in --rules (a union, never a
  replacement — a marker in neither still fails). On success, the script names which file satisfied each
  marker. Omit it and behavior is byte-identical to a script with no --rules flag at all.

--lint: skip the --archive requirement/check entirely and run only the marker + LIVE COMMITMENTS checks
  against --active (and --rules, if given). For running the gate against the LIVE doc any time, not only
  at a rotation. --archive is never read or required in this mode. The rotation path (no --lint) is
  unchanged and still hard-requires a real, non-empty --archive.

Checks run against --active (unioned with --rules when supplied):
  1. All ${MARKERS.length} markers below are present as exact substrings (see the case-sensitivity note in each).
  2. The LIVE COMMITMENTS section (between its markdown HEADING LINE and the next MY-PEER-SEND-LEDGER
     heading LINE — a prose mention of either token that is not itself a heading line is ignored) still
     contains ${REQUIRED_LIVE_COMMITMENTS_COUNT} numbered items, matched by /^\\d+\\. /gm. (This section is
     only ever measured in --active — it is not a candidate for the --rules union.)

Checks run against --archive (skipped entirely under --lint):
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
  const out = { active: null, archive: null, rules: null, lint: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (a === "--active") {
      out.active = argv[++i];
    } else if (a === "--archive") {
      out.archive = argv[++i];
    } else if (a === "--rules") {
      out.rules = argv[++i];
    } else if (a === "--lint") {
      out.lint = true;
    } else if (a.startsWith("--active=")) {
      out.active = a.slice("--active=".length);
    } else if (a.startsWith("--archive=")) {
      out.archive = a.slice("--archive=".length);
    } else if (a.startsWith("--rules=")) {
      out.rules = a.slice("--rules=".length);
    } else {
      console.error(`[rotation-gate] unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function textIncludes(text, marker) {
  const haystack = marker.caseSensitive ? text : text.toLowerCase();
  const needle = marker.caseSensitive ? marker.token : marker.token.toLowerCase();
  return haystack.includes(needle);
}

// Returns { missing: Marker[], satisfiedBy: Map<token, "active"|"rules"> }. A marker is satisfied by
// --active first (checked first so an --active hit is never reported as coming from --rules even if the
// token also happens to appear there); only if absent from --active AND rulesText is non-null is --rules
// consulted. A marker absent from BOTH is missing — the union only ever ADDS a place to look, it never
// removes --active as a valid source.
function checkMarkers(activeText, rulesText) {
  const missing = [];
  const satisfiedBy = new Map();
  for (const marker of MARKERS) {
    if (textIncludes(activeText, marker)) {
      satisfiedBy.set(marker.token, "active");
    } else if (rulesText !== null && textIncludes(rulesText, marker)) {
      satisfiedBy.set(marker.token, "rules");
    } else {
      missing.push(marker);
    }
  }
  return { missing, satisfiedBy };
}

// Finds the first line at or after `fromIndex` that is a real markdown heading (1-6 leading `#` followed
// by whitespace — so "## ⛔⛔ §LIVE COMMITMENTS — ..." matches, an arbitrary run of emoji/`§` between the
// hashes and the token is fine) AND contains `token` (case-insensitive). Returns the line index, or -1.
function findHeadingLine(lines, token, fromIndex) {
  const needle = token.toLowerCase();
  const headingRe = /^#{1,6}\s/;
  for (let i = fromIndex; i < lines.length; i++) {
    if (headingRe.test(lines[i]) && lines[i].toLowerCase().includes(needle)) return i;
  }
  return -1;
}

// Returns { count, diagnostic }. `count` is the number of /^\d+\. /gm matches strictly between the LIVE
// COMMITMENTS heading LINE and the next MY-PEER-SEND-LEDGER heading LINE after it (or end of file if
// there is none) — null if the LIVE COMMITMENTS heading itself can't be located at all. `diagnostic`
// always names WHERE the section was measured (matched line number + text, or "end of file"), so a count
// mismatch is self-diagnosable without reading this script's source (card d78a6d5d DoD-3).
//
// BOTH boundaries are anchored to a markdown HEADING LINE, never a bare substring search — card
// d78a6d5d: the prior version used plain case-insensitive `indexOf` on the raw text, so a PROSE mention
// of either boundary token anywhere above its real heading (e.g. a doc's own header block documenting
// this gate's contract in these exact words) silently redefined the measured span, producing a
// maximally-alarming false "0 numbered item(s), expected 14" on a perfectly correct document. Anchoring
// to a heading line makes a prose mention inert: it is never itself a heading line, so it can never open
// or close the section.
function countLiveCommitments(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const startLine = findHeadingLine(lines, "live commitments", 0);
  if (startLine === -1) {
    return { count: null, diagnostic: "no heading line matching /^#{1,6}\\s.*live commitments/i found anywhere in --active" };
  }
  const endLine = findHeadingLine(lines, "my-peer-send-ledger", startLine + 1);
  const sectionLines = lines.slice(startLine + 1, endLine === -1 ? lines.length : endLine);
  const matches = sectionLines.join("\n").match(/^\d+\. /gm);
  const startDesc = `heading line ${startLine + 1} ("${lines[startLine].trim()}")`;
  const endDesc =
    endLine === -1
      ? "end of file (no MY-PEER-SEND-LEDGER heading found after it)"
      : `heading line ${endLine + 1} ("${lines[endLine].trim()}")`;
  return { count: matches ? matches.length : 0, diagnostic: `measured from ${startDesc} to ${endDesc}` };
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

// --rules is OPTIONAL: null (not provided) is a valid, distinct state from "provided but unreadable"
// (a real error, exit 1) — unlike readRequiredFile, an absent path here is never a usage error.
function readOptionalFile(flagName, filePath) {
  if (!filePath) return null;
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
  if (!args.active) {
    console.error(HELP);
    process.exit(2);
  }
  if (!args.lint && !args.archive) {
    console.error(HELP);
    process.exit(2);
  }

  const activeText = readRequiredFile("active", args.active);
  const rulesText = readOptionalFile("rules", args.rules);

  let archiveStat = null;
  const archiveFailures = [];
  if (!args.lint) {
    try {
      archiveStat = fs.statSync(args.archive);
    } catch (err) {
      console.error(`[rotation-gate] REFUSED: --archive ${args.archive} does not exist or is unreadable (${err.message})`);
      console.error(`[rotation-gate] a rotation must actually produce an archive file before its new active doc is promoted`);
      process.exit(1);
    }
    if (!archiveStat.isFile()) {
      archiveFailures.push(`--archive ${args.archive} is not a regular file`);
    } else if (archiveStat.size === 0) {
      archiveFailures.push(`--archive ${args.archive} is empty`);
    }
  }

  const { missing, satisfiedBy } = checkMarkers(activeText, rulesText);
  const live = countLiveCommitments(activeText);

  const failures = [...archiveFailures];
  if (missing.length > 0) {
    const source = rulesText !== null ? "--active or --rules" : "--active";
    failures.push(
      `missing ${missing.length}/${MARKERS.length} marker(s) from ${source}: ${missing.map((m) => m.token).join(", ")}`
    );
  }
  if (live.count === null) {
    failures.push(`could not locate the LIVE COMMITMENTS section (heading missing) — cannot verify its item count (${live.diagnostic})`);
  } else if (live.count !== REQUIRED_LIVE_COMMITMENTS_COUNT) {
    failures.push(
      `LIVE COMMITMENTS section in --active holds ${live.count} numbered item(s), expected ${REQUIRED_LIVE_COMMITMENTS_COUNT} (${live.diagnostic})`
    );
  }

  if (failures.length > 0) {
    console.error(`[rotation-gate] REFUSED — ${args.lint ? "lint failed for" : "rotation must not promote"} ${args.active}:`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(HONEST_LIMIT_NOTE);
    process.exit(1);
  }

  if (args.lint) {
    console.log(
      `[rotation-gate] LINT OK — ${args.active} carries all ${MARKERS.length} markers and a ` +
        `${REQUIRED_LIVE_COMMITMENTS_COUNT}-item LIVE COMMITMENTS section. (lint mode: --archive not checked — this is not a rotation.)`
    );
  } else {
    console.log(
      `[rotation-gate] OK — ${args.active} carries all ${MARKERS.length} markers and a ` +
        `${REQUIRED_LIVE_COMMITMENTS_COUNT}-item LIVE COMMITMENTS section; --archive ${args.archive} exists ` +
        `(${archiveStat.size} bytes). Rotation may proceed.`
    );
  }
  if (rulesText !== null) {
    const fromRules = MARKERS.filter((m) => satisfiedBy.get(m.token) === "rules");
    if (fromRules.length > 0) {
      console.log(`[rotation-gate] ${fromRules.length}/${MARKERS.length} marker(s) satisfied via --rules (absent from --active): ${fromRules.map((m) => m.token).join(", ")}`);
    } else {
      console.log(`[rotation-gate] all ${MARKERS.length} markers satisfied via --active alone (--rules supplied but not needed)`);
    }
    console.log(`[rotation-gate] marker sources:`);
    for (const m of MARKERS) {
      console.log(`  - ${m.token}: ${satisfiedBy.get(m.token)}`);
    }
  }
  console.log(HONEST_LIMIT_NOTE);
  process.exit(0);
}

main();
