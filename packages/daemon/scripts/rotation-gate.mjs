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
// drop one of the durable markers below, or shrink the LIVE COMMITMENTS list below its required floor.
//
// SOURCE OF THE MARKER LIST AND COUNT: `Projects/Loom/Operations/Orchestrator Rules.md` §ROTATION-GATE
// — a VAULT file, unreachable from this repo/worktree at the time this script was authored. The list
// below was copied verbatim from that section (relayed through card 8e2a4252's kickoff, itself already
// a copy) and MUST be re-checked against the live vault section by whoever next edits this file —
// this local copy can drift silently, same as any other copied-not-pointed-at value.
// Re-verified against the live vault section 2026-08-28 (card d78a6d5d): the 14-item marker list still
// matches §ROTATION-GATE verbatim — no drift found.
//
// ⭐ LIVE_COMMITMENTS_FLOOR IS A FLOOR, NOT AN EXACT COUNT (card 34a6f07e, 2026-08-28). It used to be
// `REQUIRED_LIVE_COMMITMENTS_COUNT`, checked with EQUALITY (`!==`). That was a bug, not a feature: a
// fixed arity doesn't merely fail to catch overflow — it CREATES it. The cheapest way to add a 15th
// legitimate commitment and keep an equality check green is to leave it OUT of the counted section
// (unprotected prose instead) — measured live on this seat's own rotation: 6 new binding terms were
// pushed into prose above the list specifically to dodge this check, and a doc that dropped that prose
// block entirely still passed, because the equality check never looked at it either way. This script's
// own name and `--help` already promised the right semantics ("refuse to promote a rotation that …
// SHRINKS the LIVE COMMITMENTS list") — equality was never that. The fix: assert a FLOOR (`>=`) instead.
// Growing the list can never fail this check again; only shrinking below the floor can.
//
// A floor only protects what it counts. `LIVE_COMMITMENTS_FLOOR` is bumped here from 14 to 20 — the 14
// re-verified 2026-08-28 (card d78a6d5d) plus 6 new terms card 34a6f07e names as newly agreed and
// currently sitting, unprotected, in prose in the live vault doc (the card's own prose FIRST miscounted
// this as 5, omitting "DISCLOSE A LIVE-WORKER-COUNT CHANGE ON THE CHANGE, not at the next natural letter"
// — corrected 2026-08-28 after the filer recounted the real doc; named here so the arithmetic is
// auditable, not just trusted). This is DELIBERATE and lands ahead of the matching vault edit: it makes
// `--lint`/rotation REFUSE the live doc (14 numbered items) until those 6 terms are moved from prose into
// the numbered LIVE COMMITMENTS list as items 15–20 — the "fail loudly and get updated" behavior the
// fixed-arity bug was denying. See card 34a6f07e's worker report for the exact hand-off. Whoever performs
// that vault edit must bump this constant to match the new true count IN
// THE SAME EDIT — never lower it, and never let it silently drift behind the vault content the way the
// prior count itself drifted (see the header note above): this remains the ONE place the number lives,
// mirroring the vault the same way the marker list already does.
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
// --was <bytes> (OPTIONAL, card c7c0a493): an independent byte-shrinkage check for "any rewrite you are
// calling a CUT" — NOT rotation-scoped (a rotation is a REPLACEMENT; old-vs-new size is the wrong
// comparison there and would false-positive on a legitimate early rotation). It is accepted, and checked
// identically, in BOTH --lint and rotation mode: the check itself is orthogonal to which mode is running
// — a rotation invocation can equally be marketed as "also a cut," and there is no reason to special-case
// it out of the one mode where a real rewrite happens. It is pure opt-in: omitting it changes no check,
// no verdict, and no exit code in either mode — the only difference is one added status line saying the
// byte check did not run (DoD-2's visibility requirement below), so output is NOT byte-identical, only
// behaviour/exit-code is.
// Semantics: fails (adds to the refusal list) when byteLength(--active) >= --was; passes when strictly
// smaller. `--was` is the CALLER's own pre-edit measurement — this script has no access to the previous
// version and never tries to infer it. Bytes are read via fs.statSync(...).size (the file's real on-disk
// byte count), not a decoded-string length, so multi-byte characters are counted correctly.
// Omitting --was is itself visible, not silent: every successful run says explicitly whether the byte
// check ran or was skipped, so a caller can never mistake "no --was given" for "shrinkage was verified."
// A malformed --was (non-numeric, negative, ZERO, or missing its value) is a usage error (exit 2), never
// a silent pass — zero is rejected deliberately, not merely non-numeric: a real --active document is
// never genuinely 0 bytes pre-edit, so --was 0 could only ever be a bug in the caller, and accepting it
// would silently refuse every doc forever (see parseWasBytes's own comment for the full reasoning).
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

const LIVE_COMMITMENTS_FLOOR = 20;

const HELP = `rotation-gate.mjs — refuse to promote a resume-doc rotation that silently drops a durable marker or shrinks the LIVE COMMITMENTS list.

USAGE:
  node rotation-gate.mjs --active <path-to-post-rotation-active-doc> --archive <path-to-this-rotation's-archive-file>
  node rotation-gate.mjs --active <path> --archive <path> --rules <path-to-non-rotating-rules-file>
  node rotation-gate.mjs --active <path> --lint [--rules <path>]
  node rotation-gate.mjs --active <path> [--archive <path> | --lint] --was <bytes>
  node rotation-gate.mjs --help

Exit 0 = rotation/lint may proceed. Exit 1 = refused (see stderr for every failure). Exit 2 = usage error.

--rules <path> (OPTIONAL): a marker is satisfied if present in --active OR in --rules (a union, never a
  replacement — a marker in neither still fails). On success, the script names which file satisfied each
  marker. Omit it and behavior is byte-identical to a script with no --rules flag at all.

--lint: skip the --archive requirement/check entirely and run only the marker + LIVE COMMITMENTS checks
  against --active (and --rules, if given). For running the gate against the LIVE doc any time, not only
  at a rotation. --archive is never read or required in this mode. The rotation path (no --lint) is
  unchanged and still hard-requires a real, non-empty --archive.

--was <bytes> (OPTIONAL, CUT-scoped, NOT rotation-scoped): checks that --active actually SHRANK relative
  to a byte count the caller measured before editing. Fails when byteLength(--active) >= --was; passes
  when strictly smaller. Accepted identically in both --lint and rotation mode — the check is orthogonal
  to which mode is running. Omitting it changes no check, no verdict, and no exit code in either mode — a
  run with no --was still exits 0 on an otherwise-clean doc — but it is NOT output-identical: it prints one
  added status line saying the byte check did not run, so "no --was given" is never mistaken for
  "shrinkage was verified." A malformed value (non-numeric, negative, ZERO, or missing) is a usage error
  (exit 2), not a silent pass — zero is rejected deliberately: a real --active document is never genuinely
  0 bytes pre-edit, so --was 0 could only ever be a caller bug, and accepting it would silently refuse
  every doc forever. This is NOT a check that a ROTATION is smaller than what it replaces — a rotation is
  a replacement, not a cut, and this flag is for a caller who is explicitly claiming an edit is a CUT (of
  --active itself, whether or not this run also happens to be a rotation).

Checks run against --active (unioned with --rules when supplied):
  1. All ${MARKERS.length} markers below are present as exact substrings (see the case-sensitivity note in each).
  2. The LIVE COMMITMENTS section (between its markdown HEADING LINE and the next MY-PEER-SEND-LEDGER
     heading LINE — a prose mention of either token that is not itself a heading line is ignored) still
     contains AT LEAST ${LIVE_COMMITMENTS_FLOOR} numbered items, matched by /^\\d+\\. /gm — a FLOOR, never an
     exact count: the list may grow without limit, it may never shrink below this floor. (This section is
     only ever measured in --active — it is not a candidate for the --rules union.)

Checks run against --archive (skipped entirely under --lint):
  3. The path exists, is a regular file, and is non-empty.

Byte check (only when --was is given — OPTIONAL, independent of everything above):
  4. --active's real on-disk byte count is strictly smaller than --was.

Markers (case-INsensitive unless noted):
${MARKERS.map((m) => `  - ${m.token}${m.caseSensitive ? " (case-SENSITIVE)" : ""}${m.note ? ` — ${m.note}` : ""}`).join("\n")}

⚠️ HONEST LIMIT: every check here is an exact-substring grep. It proves a token's literal text survived;
it cannot see a rule that was reworded, summarized, or split across lines during rotation. A green is a
candidate set ("nothing was blatantly deleted"), never a verdict that nothing was lost.

Marker list and the LIVE COMMITMENTS floor are sourced from \`Operations/Orchestrator Rules.md\`
§ROTATION-GATE (a vault file outside this repo) — re-verify this script's copy against that section
before trusting it long-term; see the file header for why.
`;

const HONEST_LIMIT_NOTE =
  "[rotation-gate] limit: every check above is an exact-substring grep — it proves literal text survived, " +
  "not that no meaning was lost to rewording. Treat a green as a candidate set, not a verdict.";

function parseArgs(argv) {
  const out = { active: null, archive: null, rules: null, was: null, lint: false, help: false };
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
    } else if (a === "--was") {
      out.was = argv[++i];
    } else if (a === "--lint") {
      out.lint = true;
    } else if (a.startsWith("--active=")) {
      out.active = a.slice("--active=".length);
    } else if (a.startsWith("--archive=")) {
      out.archive = a.slice("--archive=".length);
    } else if (a.startsWith("--rules=")) {
      out.rules = a.slice("--rules=".length);
    } else if (a.startsWith("--was=")) {
      out.was = a.slice("--was=".length);
    } else {
      console.error(`[rotation-gate] unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// --was is OPTIONAL like --rules, but unlike --rules its value must be a POSITIVE integer byte count,
// not a path — validated separately so a malformed value (non-numeric, negative, zero, or the flag given
// with no following value at all) is a usage error (exit 2), never silently treated as "not given."
//
// ⭐ EXPLICIT CALL (card c7c0a493's third question): --was 0 is rejected, not accepted as a degenerate-but-
// legal "the previous doc was empty." `^\d+$` alone would let 0 through, and 0 passes as a NUMBER but can
// never be a genuine caller measurement here: every gate-passing --active must already carry all
// MARKERS.length markers plus at least a LIVE_COMMITMENTS_FLOOR-item section, so its real pre-edit size
// was never 0 bytes for anything this script would ever be asked to check. Any real --was 0 is therefore
// always a bug in the CALLER (an uncomputed value, an integer default slipping through) dressed up as a
// legal input that would then silently refuse EVERY doc forever (byteLength >= 0 is always true) — the
// exact "silently-always-failing input" shape --was exists to prevent elsewhere, so it is refused here
// too rather than left unconsidered.
function parseWasBytes(raw) {
  if (raw === undefined || raw === null || raw === "") {
    console.error(`[rotation-gate] --was requires a byte-count value (e.g. --was 20128)`);
    process.exit(2);
  }
  if (!/^\d+$/.test(raw)) {
    console.error(`[rotation-gate] invalid --was value ${JSON.stringify(raw)}: must be a positive integer byte count`);
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    console.error(`[rotation-gate] invalid --was value ${JSON.stringify(raw)}: out of safe integer range`);
    process.exit(2);
  }
  if (n === 0) {
    console.error(`[rotation-gate] invalid --was value 0: a real --active document is never genuinely 0 bytes pre-edit (it must already carry ${MARKERS.length} markers plus at least a ${LIVE_COMMITMENTS_FLOOR}-item LIVE COMMITMENTS section) — --was 0 would silently refuse every doc forever, so it is rejected as a usage error rather than accepted as a degenerate check`);
    process.exit(2);
  }
  return n;
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
  const wasBytes = args.was !== null ? parseWasBytes(args.was) : null;

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

  // The byte check reads --active's REAL on-disk byte count (fs.statSync, not a decoded-string length)
  // so multi-byte characters are counted correctly — this is exactly the case the check exists to catch:
  // fewer LINES can still be MORE bytes. Kept OUT of `failures` below (a separate flag instead) so its
  // status line is never duplicated between the itemized failure list and its own dedicated line — it is
  // printed on EVERY exit path (skip/pass/fail), not only on success, per DoD-2's visibility requirement.
  let byteCheckLine;
  let byteCheckFailed = false;
  if (wasBytes === null) {
    byteCheckLine = `[rotation-gate] byte check: SKIPPED — no --was given, so this run does NOT verify --active actually shrank`;
  } else {
    const activeBytes = fs.statSync(args.active).size;
    const delta = activeBytes - wasBytes;
    if (activeBytes >= wasBytes) {
      byteCheckFailed = true;
      byteCheckLine = `[rotation-gate] byte check: FAILED — --active is ${activeBytes} byte(s), not smaller than --was ${wasBytes} byte(s) (delta ${delta >= 0 ? "+" : ""}${delta}) — a rewrite claiming to be a cut must shrink`;
    } else {
      byteCheckLine = `[rotation-gate] byte check: passed — --active is ${activeBytes} byte(s) < --was ${wasBytes} byte(s) (shrank by ${-delta} byte(s))`;
    }
  }

  const failures = [...archiveFailures];
  if (missing.length > 0) {
    const source = rulesText !== null ? "--active or --rules" : "--active";
    failures.push(
      `missing ${missing.length}/${MARKERS.length} marker(s) from ${source}: ${missing.map((m) => m.token).join(", ")}`
    );
  }
  if (live.count === null) {
    failures.push(`could not locate the LIVE COMMITMENTS section (heading missing) — cannot verify its item count (${live.diagnostic})`);
  } else if (live.count < LIVE_COMMITMENTS_FLOOR) {
    failures.push(
      `LIVE COMMITMENTS section in --active holds ${live.count} numbered item(s), fewer than the required floor of ${LIVE_COMMITMENTS_FLOOR} (${live.diagnostic})`
    );
  }

  if (failures.length > 0 || byteCheckFailed) {
    console.error(`[rotation-gate] REFUSED — ${args.lint ? "lint failed for" : "rotation must not promote"} ${args.active}:`);
    for (const f of failures) console.error(`  - ${f}`);
    if (byteCheckFailed) console.error(`  - ${byteCheckLine.replace(/^\[rotation-gate\] byte check: /, "byte check: ")}`);
    console.error(HONEST_LIMIT_NOTE);
    process.exit(1);
  }

  if (args.lint) {
    console.log(
      `[rotation-gate] LINT OK — ${args.active} carries all ${MARKERS.length} markers and ${live.count} ` +
        `LIVE COMMITMENTS item(s) (>= floor of ${LIVE_COMMITMENTS_FLOOR}). (lint mode: --archive not checked — this is not a rotation.)`
    );
  } else {
    console.log(
      `[rotation-gate] OK — ${args.active} carries all ${MARKERS.length} markers and ${live.count} ` +
        `LIVE COMMITMENTS item(s) (>= floor of ${LIVE_COMMITMENTS_FLOOR}); --archive ${args.archive} exists ` +
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
  console.log(byteCheckLine);
  console.log(HONEST_LIMIT_NOTE);
  process.exit(0);
}

main();
