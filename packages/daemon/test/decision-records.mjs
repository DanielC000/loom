// decision-records.mjs PostToolUse hook test (card 661b7d46). Fully deterministic — no daemon, no
// claude. Invokes the shipped decision-records.mjs asset directly with synthetic PostToolUse `Read`
// payloads on stdin against a fixture "repo" (a temp dir with its own `.git` marker + docs/adr,
// docs/decisions, docs/investigations), and asserts:
//   DoD-1: a read whose range (or enclosing block) intersects a `// @decision <id>` anchor returns that
//          record's title + 'Do not' section(s) (or, for a record with none, its title/body plus an
//          explicit no-Do-not fallback note — card abd049da), resolved live from the fixture repo at call
//          time, NEVER the narrative around them.
//   DoD-2: a read with no anchored id in range is byte-identical to no hook at all (empty stdout).
//   DoD-3: per-session dedupe — a repeat read of the same anchored region injects nothing the second
//          time in the SAME session, but still injects in a DIFFERENT session.
//   DoD-4: a byte cap is enforced two ways — a single oversized record is truncated WITH an explicit
//          signal (never silently), and when several records compete for one call's shared budget,
//          excess ones are dropped WHOLE and named, never partially included a second time.
//   DoD-5: negative control — an anchor whose id resolves to NO record in any store stays silent, but
//          the SAME store/mechanism is proven capable of firing first (a known-present id, above).
// Plus code-review regressions (2026-09-09):
//   B1: block expansion is upward-only — a read strictly BEFORE an anchor (dense file, no blank lines)
//       must never reach it via downward expansion, and must never falsely mark it delivered.
//   B2: truncation is byte-accurate on MULTI-BYTE content (this repo's own em-dash-heavy prose) — never
//       a UTF-16-code-unit slice that silently triples the real byte count.
//   S4: never resolve records against a repo OTHER than the session's own cwd.
//   N2: truncation keeps HEAD and TAIL, not just the head (a trailing caveat must survive).
//   N3: id resolution requires a real boundary after the id (no bare-prefix false match) and is
//       deterministic.
//   N4: a single line carrying two anchors yields both ids.
// Plus card da723d41 (2026-09-09): the payload carries the record via `hookSpecificOutput.
// additionalContext` ONLY — no `systemMessage` copy (that field is never fed to the model; see the
// asset's own header for the empirical determination) — and the per-record byte cap was raised.
// Plus card 5244adc2 (the remaining half of 661b7d46 DoD-2's "no overhead"): writeSessionSettings wires
// the Read PostToolUse hook group ONLY when its `repoPath` arg resolves to a project carrying at least
// one of the three record stores; `repoPath` omitted stays byte-identical to the old always-wired default.
// Plus card 969b0e1c (2026-09-10) — the `@decision sha:<id>` namespace sigil: a `sha:`-sigil'd anchor
// citing a REAL, verified commit (the fixture repo is a genuine `git init`'d repo with one seed commit,
// not just a bare `.git` marker) resolves and its injected heading carries the sigil; the SAME 8 hex
// characters under the ORIGINAL bare form still resolve as a card id, unverified (the backward-
// compatibility control); and the sigil'd form REFUSES when the id does not verify as a real commit, even
// when the identical record file exists (resolveRecord's refuse-rather-than-fall-through gate).
// Plus card 8449a258 (2026-09-12, owner request a0155873 option (b)): protected-content extraction (title +
// every 'Do not'-style heading, at ANY level, not just `##`) is the SAME "what survives" logic this test
// exercises below, now used to decide what's injected in the first place, not merely what a truncation
// keeps.
// Plus card abd049da (2026-09-12, owner request e17fd9bf): only a record's title + 'Do not' section(s) are
// injected — NEVER the narrative around them, whether or not the record needed truncating. A record with
// no Do-not section injects an explicit, labelled fallback note instead of the old whole-record narrative.
// The per-record byte cap now bounds this much smaller reduced body (ordinarily never triggered).
//
// RUN with an isolated LOOM_HOME (writeSessionSettings just needs the settings dir; no daemon needed):
//   pnpm build (repo root) then `node test/decision-records.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { DECISION_RECORDS_SCRIPT, SETTINGS_DIR, ensureDirs } from "../dist/paths.js";
import { writeSessionSettings, DECISION_RECORD_STORE_KINDS } from "../dist/pty/claude-settings.js";
import { listRecordIds, findRecordsMissingDoNot } from "../assets/comment-anchor-lint.mjs";

// The REAL repo root (three levels up from this test file) — used only to source ONE real, currently
// no-Do-not record's content for the DoD-2 "proven over a real case" test below (card abd049da), never to
// resolve anchors against it (every hook invocation in this file still targets the isolated fixture REPO).
const REAL_REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- fixture repo: a temp dir with its own `.git` marker + the three record stores ---
const REPO = path.join(os.tmpdir(), `loom-decrec-repo-${Date.now()}-${process.pid}`);
const DEDUPE_DIR = path.join(os.tmpdir(), `loom-decrec-dedupe-${Date.now()}-${process.pid}`);
const FOREIGN_REPO = path.join(os.tmpdir(), `loom-decrec-foreign-${Date.now()}-${process.pid}`); // S4: a DIFFERENT repo on the same host
const NO_STORE_REPO = path.join(os.tmpdir(), `loom-decrec-nostore-${Date.now()}-${process.pid}`); // S1: a repo with no record store at all
// Card 969b0e1c: a REAL git repo (not just a bare `.git` marker — every OTHER fixture here only needs
// `.git` to exist for `findRepoRoot`) so `resolveRecord`'s SHA-verification branch has a genuine commit
// to verify against. One seed commit is enough; nothing else in this fixture needs to be tracked.
fs.mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: REPO });
fs.writeFileSync(path.join(REPO, "SEED.md"), "seed\n");
commitAll(REPO, "seed", "-c user.email=decrec-fixture@loom -c user.name=decrec-fixture");
const REAL_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim().slice(0, 8);
fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "decisions"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-a-real-investigation"), { recursive: true });

fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-adr-store.md"), "# ADR aaaaaaaa\n\nAn immutable decision record, resolved from docs/adr.\n");
fs.writeFileSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-a-real-investigation", "findings.md"), "# bbbbbbbb — findings\n\nAn investigation report, resolved from the nested docs/investigations convention.\n");
fs.writeFileSync(path.join(REPO, "docs", "decisions", "dddddddd-decisions-store.md"), "# Decision dddddddd\n\nA mutable decision record, resolved from docs/decisions.\n");
// deadbeef: deliberately oversized (> the script's 6000-byte per-record cap).
fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadbeef-oversized.md"), "# deadbeef\n\n" + "x".repeat(9000) + "\n");
// four ~3500-byte records that individually fit the per-record cap but together exceed the shared
// per-call budget (3 * ~3550 fits under 12000; a 4th does not) — for the drop-whole-record case.
for (const id of ["e0000001", "e0000002", "e0000003", "e0000004"]) {
  fs.writeFileSync(path.join(REPO, "docs", "decisions", `${id}-budget.md`), `# ${id}\n\n` + "y".repeat(3480) + "\n");
}
// Card 969b0e1c: REAL_SHA's own record — resolves via the sha: sigil (a genuine, verified commit).
fs.writeFileSync(path.join(REPO, "docs", "decisions", `${REAL_SHA}-sha-record.md`), `# ${REAL_SHA}\n\nGenuine commit-keyed record, resolved via the sha: sigil.\n`);
// deadc0de's record backs BOTH the bare-form (resolves, never verified) and sigil'd (refused — not a
// real commit in this repo, even though this very record file exists) cases from the SAME fixture id.
fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadc0de-namespace-test.md"), "# deadc0de\n\nNamespace test record.\n");

// --- fixture source file: several blank-line-delimited blocks. Built with a line-tracking helper (never
// hand-counted line numbers) so every anchor's real 1-indexed line is known exactly, however the blocks
// around it are shaped. ---
const srcLines = [];
const lineOf = {}; // id -> 1-indexed line number of its anchor comment
const push = (text) => { srcLines.push(text); return srcLines.length; }; // returns the new line's 1-indexed number
const blank = () => srcLines.push("");
const filler = (n, label) => { for (let i = 0; i < n; i++) push(`// filler ${label}${i}`); };

// Block A: anchor aaaaaaaa NOT on the first line of the block — a read of a LATER line in the same
// block must still expand upward and find it (DoD-1's "enclosing block" scope control).
filler(3, "A-pre");
lineOf.aaaaaaaa = push("// @decision aaaaaaaa — always X, never Y");
filler(8, "A-post");
blank();

// Block B: anchor bbbbbbbb alone (resolves via the nested docs/investigations convention).
filler(2, "B");
lineOf.bbbbbbbb = push("// @decision bbbbbbbb — see the investigation");
filler(2, "B-post");
blank();

// Block C: anchor cccccccc alone, in ITS OWN block — isolated by blank lines on both sides so a read of
// just this line (or this block) can never also pick up bbbbbbbb from block B. Deliberately has NO
// record in any store (DoD-5).
lineOf.cccccccc = push("// @decision cccccccc — this id resolves to no record anywhere");
blank();

// Block D: no anchor at all (DoD-2), and separated by blank lines from block C's anchor on one side and
// block E's anchors on the other — proves the "enclosing block" expansion doesn't bleed across either.
filler(10, "D-no-anchor");
blank();

// Block E: four anchors sharing ONE block — the shared-byte-budget case (DoD-4b).
for (const id of ["e0000001", "e0000002", "e0000003", "e0000004"]) {
  lineOf[id] = push(`// @decision ${id} — budget-competing record`);
}
blank();

// Block F: card 969b0e1c's sigil namespace — three isolated one-line blocks, each its own anchor.
lineOf.shaReal = push(`// @decision sha:${REAL_SHA} — a genuine verified-commit record`);
blank();
lineOf.deadc0deBare = push("// @decision deadc0de — bare form is a CARD id, never SHA-verified");
blank();
lineOf.deadc0deSha = push("// @decision sha:deadc0de — sigil'd form IS SHA-verified; deadc0de is not a real commit here");
blank();

const SRC = path.join(REPO, "src.ts");
fs.writeFileSync(SRC, srcLines.join("\n") + "\n");
// A single range that spans BOTH block B (bbbbbbbb) and block C (cccccccc) in one read — proves the
// resolver fires correctly on one id while correctly staying silent on the other in the SAME call.
const bAndCRange = [lineOf.bbbbbbbb, lineOf.cccccccc - lineOf.bbbbbbbb + 1];
// A range entirely inside block D (no anchor, and bounded by blank lines from block C on one side).
const blockDLine = lineOf.cccccccc + 3; // a couple of lines into block D's filler
// A range spanning all four block-E anchors in one call.
const blockEStart = lineOf.e0000001;
const blockESpan = lineOf.e0000004 - lineOf.e0000001 + 1;

function runHookRaw(filePath, cwd, sessionId, offset, limit, tool = "Read") {
  const toolInput = { file_path: filePath };
  if (offset !== undefined) toolInput.offset = offset;
  if (limit !== undefined) toolInput.limit = limit;
  const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, session_id: sessionId, cwd };
  const r = spawnSync(process.execPath, [DECISION_RECORDS_SCRIPT, DEDUPE_DIR], { input: JSON.stringify(payload), encoding: "utf8" });
  const out = (r.stdout || "").trim();
  return out ? JSON.parse(out) : null;
}
function runHookOnFile(filePath, sessionId, offset, limit, tool = "Read") {
  return runHookRaw(filePath, REPO, sessionId, offset, limit, tool);
}
function runHook(sessionId, offset, limit, tool = "Read") {
  return runHookOnFile(SRC, sessionId, offset, limit, tool);
}

try {
  // --- DoD-1: a range that does NOT include the anchor line itself, but shares its blank-line-delimited
  // block, still gets the complete record (the "enclosing block" scope control, card 661b7d46). ---
  const a1 = runHook("s1", lineOf.aaaaaaaa + 2, 3); // a few lines AFTER the anchor, still in block A
  check("DoD-1: read inside block A (not the anchor line itself) injects the aaaaaaaa record's content",
    !!a1 && /An immutable decision record, resolved from docs\/adr\./.test(a1.hookSpecificOutput.additionalContext));
  check("DoD-1: the injected content carries the record's title",
    !!a1 && a1.hookSpecificOutput.additionalContext.includes("# ADR aaaaaaaa"));
  // Card abd049da: aaaaaaaa's fixture has no 'Do not' section at all — the explicit, labelled fallback
  // note must fire (DoD-2 of that card: never silence, never the old whole-record narrative dressed up as
  // if it were the guard).
  check("card abd049da DoD-2: a record with NO 'Do not' section injects the explicit no-Do-not fallback note",
    !!a1 && a1.hookSpecificOutput.additionalContext.includes("No 'Do not' section in this record"));
  check("card abd049da: the injected content also carries a pointer to the full record path",
    !!a1 && /Full record: docs\/adr\/aaaaaaaa-adr-store\.md/.test(a1.hookSpecificOutput.additionalContext));

  // --- card da723d41 regression: a record is emitted EXACTLY ONCE, via `hookSpecificOutput.
  // additionalContext` only — never a duplicate `systemMessage` copy of the same body (the defect this
  // card fixed: the payload used to carry the identical record text in BOTH fields, "whichever the
  // running Claude honors", doubling every injection's byte cost for a field never actually read by the
  // model — see the asset's own header for the empirical determination). ---
  check("card da723d41: the payload carries NO systemMessage field at all",
    !!a1 && !("systemMessage" in a1));
  check("card da723d41: hookSpecificOutput.additionalContext is the ONLY place the record body appears "
    + "(top-level JSON keys are exactly hookSpecificOutput)",
    !!a1 && Object.keys(a1).length === 1 && Object.keys(a1)[0] === "hookSpecificOutput");

  // --- DoD-1 (investigations convention) + DoD-5 positive control: bbbbbbbb resolves (nested dir), and
  // this SAME call also carries an anchor (cccccccc) that has NO record anywhere — proving the
  // resolution mechanism fires correctly for one id while correctly staying silent for the other in the
  // very same hook invocation (not just an isolated always-empty result). ---
  const a2 = runHook("s2", bAndCRange[0], bAndCRange[1]); // spans both bbbbbbbb (block B) and cccccccc (block C)
  check("DoD-1: nested docs/investigations/<id>-*/findings.md convention resolves",
    !!a2 && /An investigation report, resolved from the nested docs\/investigations convention\./.test(a2.hookSpecificOutput.additionalContext));
  check("card abd049da: an investigations record with no 'Do not' section ALSO gets the explicit fallback note",
    !!a2 && a2.hookSpecificOutput.additionalContext.includes("No 'Do not' section in this record"));
  check("DoD-5: an anchored id with no record anywhere is silently skipped (never a broken partial), "
    + "in the SAME call that correctly resolved a sibling id — proves the miss is a real absence, not a broken check",
    !!a2 && !a2.hookSpecificOutput.additionalContext.includes("cccccccc"));

  // --- DoD-2: a read entirely inside block C (no anchor in range or its own block) is a byte-identical
  // no-op — AND, since the read is separated by a blank line from block B's own anchors, this also
  // proves the "enclosing block" expansion does not bleed across a blank-line boundary. ---
  const a3 = runHook("s3", blockDLine, 3);
  check("DoD-2: a read with no anchored record in range (or its own block) is silent (no stdout at all)", a3 === null);

  // --- DoD-5, restated per the polarity discipline: re-run the EXACT same negative id in isolation —
  // block C is bounded by blank lines on both sides, so this reads NOTHING but the cccccccc anchor and
  // its own block — this is the "control run where the target is known present first" pairing (a2 above
  // already showed the mechanism firing on a real id, bbbbbbbb, in the same call). ---
  const a3b = runHook("s3b", lineOf.cccccccc, 1); // exactly (and only) the cccccccc anchor's own isolated block
  check("DoD-5: an anchor whose id has no record anywhere, read alone, produces zero output", a3b === null);

  // --- non-Read tool is ignored outright. ---
  const a4 = runHook("s4", lineOf.aaaaaaaa + 2, 3, "Write");
  check("a non-Read tool_name is ignored (no injection even over an anchored range)", a4 === null);

  // --- a Read call with NO offset/limit must default to the REAL Read tool's own default (line 1, up
  // to 2000 lines) — never "the whole file". Otherwise a large file's anchor past line 2000 would get
  // injected as if the agent's actual (truncated) Read call had returned it, which it never did. ---
  const bigLines = [];
  bigLines[9] = "// @decision facade00 — within the default 2000-line window";
  // Placed well past even the block-expansion heuristic's own bound (2000 + BLOCK_EXPAND_MAX=40) — this
  // file has no blank lines at all, so a weaker placement would be caught by block expansion instead of
  // genuinely testing the default-limit boundary.
  bigLines[2100] = "// @decision 0fff2000 — past the default 2000-line window";
  for (let i = 0; i < 2200; i++) if (bigLines[i] === undefined) bigLines[i] = `// filler BIG${i}`;
  const BIG_SRC = path.join(REPO, "big.ts");
  fs.writeFileSync(BIG_SRC, bigLines.join("\n") + "\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "facade00-in-window.md"), "# facade00\n\nWithin the default window.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "0fff2000-out-of-window.md"), "# 0fff2000\n\nPast the default window.\n");
  const bigPayload = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: BIG_SRC }, session_id: "s-default-window", cwd: REPO };
  const bigResult = spawnSync(process.execPath, [DECISION_RECORDS_SCRIPT, DEDUPE_DIR], { input: JSON.stringify(bigPayload), encoding: "utf8" });
  const a4b = (bigResult.stdout || "").trim() ? JSON.parse(bigResult.stdout) : null;
  check("default (no offset/limit) read: an anchor WITHIN the default 2000-line window is injected",
    !!a4b && a4b.hookSpecificOutput.additionalContext.includes("Within the default window."));
  check("default (no offset/limit) read: an anchor PAST the default 2000-line window is NOT injected "
    + "(the real Read tool never returned it, so injecting it would misattribute context the agent never saw)",
    !!a4b && !a4b.hookSpecificOutput.additionalContext.includes("0fff2000"));

  // --- DoD-3: per-session dedupe. ---
  const dedupeSession = "s-dedupe";
  const first = runHook(dedupeSession, lineOf.aaaaaaaa + 2, 3);
  check("DoD-3 setup: first read in a fresh session injects the record", !!first);
  const second = runHook(dedupeSession, lineOf.aaaaaaaa + 2, 3);
  check("DoD-3: an IDENTICAL repeat read in the SAME session injects nothing the second time", second === null);
  const otherSession = runHook("s-dedupe-different", lineOf.aaaaaaaa + 2, 3);
  check("DoD-3: the SAME region in a DIFFERENT session still injects (dedupe is per-session, not global)", !!otherSession);

  // --- DoD-4a: a single oversized record is truncated WITH an explicit signal, never silently. ---
  fs.appendFileSync(SRC, "\n// @decision deadbeef — oversized record\n");
  const deadbeefLine = fs.readFileSync(SRC, "utf8").split(/\r?\n/).findIndex((l) => l.includes("deadbeef")) + 1;
  const a5 = runHook("s-trunc", deadbeefLine, 1);
  check("DoD-4a: an oversized record is injected truncated, with an explicit TRUNCATED marker naming the byte cap",
    !!a5 && a5.hookSpecificOutput.additionalContext.includes("[TRUNCATED at 6000 bytes"));
  check("DoD-4a: the truncated body itself is capped near the stated limit, not the full 9000+ bytes",
    !!a5 && a5.hookSpecificOutput.additionalContext.length < 6800);

  // --- DoD-4b: several records competing for one call's shared budget — the ones that fit are injected
  // COMPLETE (never partially truncated to fit more in), and the rest are dropped WHOLE and named. ---
  const a6 = runHook("s-budget", blockEStart, blockESpan); // all four e000000N anchors in one range
  check("DoD-4b: at least one budget-competing record is injected in full (not truncated)",
    !!a6 && /# e0000001/.test(a6.hookSpecificOutput.additionalContext) && !a6.hookSpecificOutput.additionalContext.includes("[TRUNCATED"));
  check("DoD-4b: at least one record is explicitly named as omitted for shared budget, not silently dropped",
    !!a6 && /omitted for byte budget/.test(a6.hookSpecificOutput.additionalContext) && /e000000\d-budget\.md/.test(a6.hookSpecificOutput.additionalContext));

  // --- lever #3 (card 65dddbe9): a per-call record COUNT cap (MAX_RECORDS_PER_CALL), independent of the
  // byte budget — a byte budget alone doesn't bound record COUNT when many small records compete. ---
  {
    const idFor = (n) => `c0${n.toString(16).padStart(6, "0")}`; // 8-hex ids, e.g. n=1 -> "c0000001"

    // (a) 15 anchors, each backed by a TINY record — combined well under TOTAL_MAX_BYTES, so the COUNT
    // cap is the ONLY binding constraint here, isolated from the byte-budget case (DoD-4b, above).
    const N_SMALL = 15;
    const smallLines = [];
    for (let n = 1; n <= N_SMALL; n++) {
      const id = idFor(n);
      smallLines.push(`// @decision ${id} — count-cap fixture record ${n}`);
      fs.writeFileSync(path.join(REPO, "docs", "decisions", `${id}-count-small.md`), `# ${id}\n\nTiny record ${n}.\n`);
    }
    const SMALL_SRC = path.join(REPO, "count-small.ts");
    fs.writeFileSync(SMALL_SRC, smallLines.join("\n") + "\n");
    const smallResult = runHookOnFile(SMALL_SRC, "s-count-small", 1, N_SMALL);
    const smallCtx = smallResult ? smallResult.hookSpecificOutput.additionalContext : "";
    const injectedSmallCount = (smallCtx.match(/^### decision /gm) || []).length;
    check("lever #3 (a): exactly 10 records injected when 15 are in range and all individually tiny "
      + "(the count cap binds, not the byte budget)", injectedSmallCount === 10);
    check("lever #3 (a): none of the 10 injected were truncated (proves the byte budget was NOT the "
      + "binding constraint here)", !!smallResult && !smallCtx.includes("[TRUNCATED"));
    check("lever #3 (a): the omission note explicitly names the omitted COUNT (5 = 15 - 10)",
      /5 further record\(s\) omitted for record count \(max 10 per call\)/.test(smallCtx));
    check("lever #3 (a): the omission note lists the omitted ids/paths, not just a bare count",
      /count-small\.md/.test(smallCtx));

    // (b) 60 anchors — 50 omitted for count. The omission note must stay BOUNDED (lists only the first
    // OMISSION_NOTE_MAX_LISTED ids, then "+K more"), never one line per omitted record — a whole-file
    // read of a real hot file (sessions/service.ts, 32-44 omitted today) would otherwise turn the note
    // itself into a multi-kilobyte injection, defeating the point of any cap.
    const N_MANY = 60;
    const manyLines = [];
    for (let n = 1; n <= N_MANY; n++) {
      const id = idFor(1000 + n); // distinct id range from fixture (a) above — no collision
      manyLines.push(`// @decision ${id} — many-anchor fixture record ${n}`);
      fs.writeFileSync(path.join(REPO, "docs", "decisions", `${id}-count-many.md`), `# ${id}\n\nTiny record ${n}.\n`);
    }
    const MANY_SRC = path.join(REPO, "count-many.ts");
    fs.writeFileSync(MANY_SRC, manyLines.join("\n") + "\n");
    const manyResult = runHookOnFile(MANY_SRC, "s-count-many", 1, N_MANY);
    const manyCtx = manyResult ? manyResult.hookSpecificOutput.additionalContext : "";
    const injectedManyCount = (manyCtx.match(/^### decision /gm) || []).length;
    check("lever #3 (b): exactly 10 records injected out of 60 in range", injectedManyCount === 10);
    const omittedLine = (manyCtx.match(/^\(50 further record\(s\) omitted for record count.*\)$/m) || [])[0];
    check("lever #3 (b): the omission note names the full omitted count (50), even though its listed ids are bounded",
      !!omittedLine);
    check("lever #3 (b): the note lists only the first OMISSION_NOTE_MAX_LISTED (10) ids, then a '+K more' tally (40 = 50 - 10)",
      !!omittedLine && omittedLine.includes("+40 more"));
    check("lever #3 (b): the omission note itself stays well under a byte ceiling — not one line per omitted "
      + "record (an unbounded note over 50 omissions would run well past this)",
      !!omittedLine && Buffer.byteLength(omittedLine, "utf8") < 1200);
  }

  // --- card abd049da: only a record's title + 'Do not' section(s) are injected — the NARRATIVE around
  // them is excluded ENTIRELY now, never merely truncated-with-signal (the old card 8449a258 behavior this
  // supersedes for the injection path — 8449a258's own protected-content definition, title + every 'Do
  // not' heading, is exactly what `extractDoNotOnly` reuses). Both fixtures below carry enough narrative
  // to exceed the per-record cap under the OLD whole-record truncation, but their DO-NOT-ONLY reduced
  // content is small — proving the narrative is dropped structurally, not merely elided. ---
  {
    const filler = (n) => "lorem ".repeat(Math.ceil(n / 6)).slice(0, n);

    // c0ff33ee: modeled on the real docs/decisions/088afc94-*.md specimen (card 8449a258's own DoD-3
    // fixture) — several Narrative/Do-not pairs, with the SECOND 'Do not' section landing in what would
    // be the OLD truncation algorithm's elided middle.
    const do1 = "## Do not\n\n- keep-me-1: must always survive.\n\n";
    const do2 = "## Do not (2)\n\n- KEEP-ME-MIDDLE: this is the section that must survive in full even "
      + "though it falls near the middle of the record.\n\n";
    const structuredBody = "## Narrative\n\n" + filler(2600) + "\n\n" + do1
      + "## Narrative (2)\n\n" + filler(2600) + "\n\n" + do2
      + "## Narrative (3)\n\n" + filler(2600) + "\n\n" + "## Source\n\nfile.ts\n";
    const structuredText = "# c0ff33ee — synthetic do-not protection record\n\n" + structuredBody;
    check("sanity: c0ff33ee fixture exceeds the per-record cap (else this proves nothing about narrative exclusion)",
      Buffer.byteLength(structuredText, "utf8") > 6000);
    fs.writeFileSync(path.join(REPO, "docs", "decisions", "c0ff33ee-structural-truncation.md"), structuredText);
    const STRUCT_SRC = path.join(REPO, "struct.ts");
    fs.writeFileSync(STRUCT_SRC, "// @decision c0ff33ee — structural truncation check\n");
    const structResult = runHookOnFile(STRUCT_SRC, "s-c0ff33ee", 1, 1);
    check("card abd049da: title survives in full", !!structResult && structResult.hookSpecificOutput.additionalContext.includes("# c0ff33ee"));
    check("card abd049da: the FIRST 'Do not' section survives in full",
      !!structResult && structResult.hookSpecificOutput.additionalContext.includes("keep-me-1: must always survive."));
    check("card abd049da: the SECOND 'Do not' section (mid-record) survives in full",
      !!structResult && structResult.hookSpecificOutput.additionalContext.includes("## Do not (2)")
        && structResult.hookSpecificOutput.additionalContext.includes("KEEP-ME-MIDDLE"));
    check("card abd049da: the NARRATIVE is excluded entirely — not a single filler word survives",
      !!structResult && !structResult.hookSpecificOutput.additionalContext.includes("lorem"));
    check("card abd049da: no [TRUNCATED] marker fires — the reduced (Do-not-only) body is well under the per-record cap",
      !!structResult && !structResult.hookSpecificOutput.additionalContext.includes("[TRUNCATED"));
    check("card abd049da: the injected content is a small fraction of the ~8KB source record (proving real "
      + "byte reduction, not just narrative reordering)",
      !!structResult && structResult.hookSpecificOutput.additionalContext.length < 1200);

    // c0ffee01: the 'Do not' heading nested at H3 under a `##` parent — measured (card 8449a258): 18 real
    // records in this repo carry their 'Do not' section ONLY this way, never at `##`.
    const nested = "### Do not\n\n- NESTED-KEEP-ME: only appears at H3, nested under a H2 parent.\n\n";
    const nestedBody = "## Decision A\n\n" + filler(3950) + "\n\n" + nested
      + "## Decision B\n\n" + filler(3200) + "\n\n" + "## Source\n\nfile.ts\n";
    const nestedText = "# c0ffee01 — nested do-not record\n\n" + nestedBody;
    check("sanity: c0ffee01 fixture exceeds the per-record cap (else this proves nothing about narrative exclusion)",
      Buffer.byteLength(nestedText, "utf8") > 6000);
    fs.writeFileSync(path.join(REPO, "docs", "decisions", "c0ffee01-nested-do-not.md"), nestedText);
    const NESTED_SRC = path.join(REPO, "nested.ts");
    fs.writeFileSync(NESTED_SRC, "// @decision c0ffee01 — nested do-not detection check\n");
    const nestedResult = runHookOnFile(NESTED_SRC, "s-c0ffee01", 1, 1);
    check("card abd049da: a 'Do not' heading nested at H3 (never `##`) is still detected and kept in full",
      !!nestedResult && nestedResult.hookSpecificOutput.additionalContext.includes("NESTED-KEEP-ME"));
    check("card abd049da: the H3-nested case ALSO excludes its surrounding narrative entirely",
      !!nestedResult && !nestedResult.hookSpecificOutput.additionalContext.includes("lorem"));

    // Negative control: deadbeef (DoD-4a fixture, no 'Do not' heading at all — its single-heading fixture
    // IS its own "protected" content, so it's oversized on its own) still reports the LEGACY head+tail
    // wording, distinguishing "oversized with no Do-not section" from the two Do-not cases above.
    check("negative control: a record with NO 'Do not' heading at all (deadbeef) reports the legacy "
      + "head+tail-elided wording when it's individually oversized, not the Do-not-only shape above",
      !!a5 && a5.hookSpecificOutput.additionalContext.includes("head+tail kept, middle elided"));
  }

  // --- sigil namespace (card 969b0e1c): a `sha:`-sigil'd anchor citing a REAL, verified commit resolves
  // exactly like a card anchor, and the injected heading carries the sigil (never confusable with a card
  // id — the "never confusable by a reader" property must survive into the injected text). ---
  const shaHit = runHook("s-sha-real", lineOf.shaReal, 1);
  check("sigil DoD-2/3: a sha:-sigil'd anchor citing a REAL, verified commit injects its record",
    !!shaHit && shaHit.hookSpecificOutput.additionalContext.includes("Genuine commit-keyed record, resolved via the sha: sigil."));
  check("sigil: the injected heading carries the sha: sigil (never bare, never confusable with a card id)",
    !!shaHit && shaHit.hookSpecificOutput.additionalContext.includes(`### decision sha:${REAL_SHA} (`));

  // --- sigil namespace, the SAME 8 hex characters (deadc0de), once bare and once sigil'd, backed by the
  // SAME record file. The bare form resolves (never SHA-verified — proves a card-id anchor still resolves
  // exactly as it did before this card, the fence's own requirement). ---
  const deadc0deBareHit = runHook("s-deadc0de-bare", lineOf.deadc0deBare, 1);
  check("sigil control (positive): the bare deadc0de anchor resolves as a CARD id, unverified",
    !!deadc0deBareHit && deadc0deBareHit.hookSpecificOutput.additionalContext.includes("Namespace test record."));
  check("sigil control (positive): its heading is the BARE id, no sigil (ns=card)",
    !!deadc0deBareHit && deadc0deBareHit.hookSpecificOutput.additionalContext.includes("### decision deadc0de ("));
  // ⚠️ METHOD-LIMITATION NOTE (honest, not swept under the RED/GREEN proof above): the sigil'd form
  // (deadc0de is not a real commit) also injects nothing — but a null result here is NOT, by itself,
  // evidence of "recognized then refused" rather than "never recognized as an anchor at all". Checked
  // against the reverted pre-sigil source (git checkout HEAD -- decision-records.mjs, then re-run): this
  // exact assertion PASSES on the OLD code too, for a DIFFERENT reason — the old ANCHOR_RE never matches
  // "sha:deadc0de" as an anchor in the first place, so `foundAnchors` is simply empty for this line, same
  // observable null as a genuine post-verification refusal. decision-records.mjs's own design makes every
  // resolution failure uniformly silent (mirrors the pre-existing DoD-5 behavior for an id with no record
  // anywhere) — there is no distinct signal in ITS output for "refused" vs "never an anchor". The
  // discriminating RED/GREEN proof for the refusal mechanism itself lives in
  // test/comment-anchor-lint.mjs's `computeReport (sigil)` checks instead: `orphanAnchors.items` there
  // explicitly carries `ns: "sha"` for a recognized-but-unverifiable sha anchor, which DOES fail under the
  // reverted source and pass under the fix (verified below) — that is the check that actually isolates
  // resolveRecord's refuse-rather-than-fall-through gate from mere non-recognition.
  const deadc0deShaHit = runHook("s-deadc0de-sha", lineOf.deadc0deSha, 1);
  check("sigil: the sha:deadc0de anchor injects nothing (consistent with refusal — see the method-"
    + "limitation note above for why this assertion alone can't isolate refusal from non-recognition)",
    deadc0deShaHit === null);

  // --- B1 regression: block expansion is upward-only. A DENSE file (no blank lines anywhere) with an
  // anchor at line 30 — a read strictly BEFORE it must NOT reach it via downward expansion, and must NOT
  // falsely mark it delivered, so a LATER read that actually contains the anchor still gets it. Before
  // the fix: the early read's 40-line downward expansion reached the anchor, injected it under a header
  // claiming it governed a range it didn't, and marked it delivered — so the later, genuinely-governed
  // read got wrongly silenced. ---
  const denseLines = [];
  for (let i = 0; i < 25; i++) denseLines.push(`// dense filler ${i}`);
  denseLines[29] = "// @decision cafebabe — governs the block starting near line 30";
  for (let i = 25; i < 70; i++) if (denseLines[i] === undefined) denseLines[i] = `// dense filler ${i}`;
  const DENSE_SRC = path.join(REPO, "dense.ts");
  fs.writeFileSync(DENSE_SRC, denseLines.join("\n") + "\n"); // NO blank lines anywhere in this file
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "cafebabe-dense.md"), "# cafebabe\n\nGoverns the block starting near line 30.\n");
  const b1Session = "s-b1";
  const b1Early = runHookOnFile(DENSE_SRC, b1Session, 1, 10); // lines 1-10, well before line 30, no blank lines to stop expansion
  check("B1: a read strictly BEFORE an anchor (dense file, no blank lines) does NOT reach it via downward expansion", b1Early === null);
  const b1Later = runHookOnFile(DENSE_SRC, b1Session, 25, 15); // lines 25-39, actually contains line 30
  check("B1: the SAME session's later read that actually contains the anchor still gets it "
    + "(not falsely marked delivered by the earlier, too-early read)",
    !!b1Later && b1Later.hookSpecificOutput.additionalContext.includes("Governs the block starting near line 30."));

  // --- B2 regression: byte-accurate truncation on MULTI-BYTE content. The prior slice(0, 4000) cut
  // UTF-16 CODE UNITS, so 4000 chars of 3-byte em dashes produced 12000 BYTES — 3x the stated per-record
  // cap — which then blew the shared TOTAL_MAX_BYTES budget and caused the whole record to be DROPPED
  // instead of truncated. This repo's own house typography (em dashes, arrows) is exactly this shape. ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "b2b2b2b2-multibyte.md"), "# b2b2b2b2\n\n" + "—".repeat(4500) + "\n");
  const B2_SRC = path.join(REPO, "b2.ts");
  fs.writeFileSync(B2_SRC, "// @decision b2b2b2b2 — multi-byte record\n");
  const b2Result = runHookOnFile(B2_SRC, "s-b2", 1, 1);
  check("B2: a multi-byte-heavy oversized record is INJECTED, truncated (not dropped whole for exceeding the shared budget)",
    !!b2Result && /# b2b2b2b2/.test(b2Result.hookSpecificOutput.additionalContext) && !/too large to inject/.test(b2Result.hookSpecificOutput.additionalContext));
  check("B2: it carries the explicit TRUNCATED marker (never a silent cut)",
    !!b2Result && b2Result.hookSpecificOutput.additionalContext.includes("[TRUNCATED at 6000 bytes"));
  check("B2: the WHOLE emitted message (not just this one record) stays within the shared 12000-byte budget "
    + "— proof the per-record truncation is measured in real bytes, not UTF-16 code units",
    !!b2Result && Buffer.byteLength(b2Result.hookSpecificOutput.additionalContext, "utf8") <= 12000);

  // --- N2 regression: truncation must keep HEAD AND TAIL. This repo's own convention puts a caveat/bound
  // at the END of a comment — a head-only cut keeps the claim and silently drops its qualifier. ---
  const n2Body = "HEAD-CLAIM-MARKER\n" + "z".repeat(9000) + "\nTAIL-CAVEAT-MARKER";
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "22222220-headtail.md"), `# 22222220\n\n${n2Body}\n`);
  const N2_SRC = path.join(REPO, "n2.ts");
  fs.writeFileSync(N2_SRC, "// @decision 22222220 — head+tail check\n");
  const n2Result = runHookOnFile(N2_SRC, "s-n2", 1, 1);
  check("N2: a truncated record keeps its HEAD", !!n2Result && n2Result.hookSpecificOutput.additionalContext.includes("HEAD-CLAIM-MARKER"));
  check("N2: a truncated record ALSO keeps its TAIL (a trailing caveat must survive truncation, not just the opening claim)",
    !!n2Result && n2Result.hookSpecificOutput.additionalContext.includes("TAIL-CAVEAT-MARKER"));

  // --- N3 regression: a bare prefix match would let id `deadbeef` match an unrelated
  // `deadbeefcafe-other.md`. Require a real boundary (`-`/`.`) after the id. deadbeef's OWN record
  // (docs/decisions/deadbeef-oversized.md) already exists from the DoD-4a fixture above. ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadbeefcafe-other.md"), "# unrelated\n\nA DIFFERENT record that merely SHARES a prefix with deadbeef.\n");
  const N3_SRC = path.join(REPO, "n3.ts");
  fs.writeFileSync(N3_SRC, "// @decision deadbeef — boundary check\n");
  const n3Result = runHookOnFile(N3_SRC, "s-n3", 1, 1);
  check("N3: a prefix-sharing but unrelated store file is NEVER matched",
    !!n3Result && !n3Result.hookSpecificOutput.additionalContext.includes("A DIFFERENT record that merely SHARES a prefix"));
  check("N3: the id's OWN correctly-bounded record still resolves",
    !!n3Result && n3Result.hookSpecificOutput.additionalContext.includes("[TRUNCATED at 6000 bytes")); // deadbeef's own record is the oversized one

  // --- N4 regression: a single line carrying TWO anchors must yield BOTH ids, not just the first (the
  // prior regex had no `g` flag). ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "11111111-multi.md"), "# 11111111\n\nFirst of two anchors on one line.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "22222222-multi.md"), "# 22222222\n\nSecond of two anchors on one line.\n");
  const MULTI_SRC = path.join(REPO, "multi.ts");
  fs.writeFileSync(MULTI_SRC, "// @decision 11111111 — first  // @decision 22222222 — second\n");
  const multiResult = runHookOnFile(MULTI_SRC, "s-n4", 1, 1);
  check("N4: a single line carrying TWO anchors injects BOTH records (not just the first)",
    !!multiResult && multiResult.hookSpecificOutput.additionalContext.includes("First of two anchors on one line.")
      && multiResult.hookSpecificOutput.additionalContext.includes("Second of two anchors on one line."));

  // --- S4 regression: never resolve records against a repo OTHER than the session's own cwd — a Read of
  // a file that happens to live in a DIFFERENT repo on the same host must not inject THAT tree's records. ---
  fs.mkdirSync(path.join(FOREIGN_REPO, ".git"), { recursive: true });
  fs.mkdirSync(path.join(FOREIGN_REPO, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(FOREIGN_REPO, "docs", "decisions", "f0f0f0f0-foreign.md"), "# f0f0f0f0\n\nForeign repo record.\n");
  const FOREIGN_SRC = path.join(FOREIGN_REPO, "foreign.ts");
  fs.writeFileSync(FOREIGN_SRC, "// @decision f0f0f0f0 — foreign repo anchor\n");
  const s4Foreign = runHookRaw(FOREIGN_SRC, REPO, "s-foreign", 1, 1); // cwd = THIS session's own repo; file lives in a DIFFERENT one
  check("S4: a Read of a file in a DIFFERENT repo than the session's own cwd is never resolved (no injection)", s4Foreign === null);
  const s4ForeignOwnCwd = runHookRaw(FOREIGN_SRC, FOREIGN_REPO, "s-foreign-2", 1, 1); // cwd = that SAME foreign repo
  check("S4 sanity: the same file DOES resolve when the session's own cwd is that repo "
    + "(proves the silence above is the cross-repo guard firing, not a broken resolver)",
    !!s4ForeignOwnCwd && s4ForeignOwnCwd.hookSpecificOutput.additionalContext.includes("Foreign repo record."));

  // --- S1: the early-bail when a repo has adopted NONE of the three record stores at all — a repo with
  // no docs/adr, docs/decisions, or docs/investigations must stay silent even over a syntactically
  // well-formed anchor (proves the store-existence check, not just "no anchor found"). ---
  fs.mkdirSync(NO_STORE_REPO, { recursive: true });
  fs.mkdirSync(path.join(NO_STORE_REPO, ".git"), { recursive: true });
  const NO_STORE_SRC = path.join(NO_STORE_REPO, "src.ts");
  fs.writeFileSync(NO_STORE_SRC, "// @decision aaaaaaaa — this repo has no record store at all\n");
  const s1NoStore = runHookRaw(NO_STORE_SRC, NO_STORE_REPO, "s-nostore", 1, 1);
  check("S1: a repo with NONE of the three record stores stays silent even over a well-formed anchor",
    s1NoStore === null);

  // --- writeSessionSettings wiring (card 5244adc2 — the remaining half of 661b7d46 DoD-2's "no
  // overhead"): the Read PostToolUse hook is emitted ONLY when `repoPath` resolves to a project with at
  // least one of the three record stores; `repoPath` omitted keeps the pre-5244adc2 always-wired default. ---
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };

  // Arm 2 FIRST, per the polarity discipline (card DoD-3): prove the selector can SEE the Read group at
  // all before trusting arm 1's silence below — REPO already has all three record stores from the
  // decision-records.mjs fixtures above.
  const withStore = JSON.parse(fs.readFileSync(writeSessionSettings("decrec-wiring-store", perm, "test-hook-token", undefined, REPO), "utf8"));
  const readGroupWithStore = (withStore.hooks.PostToolUse || []).find((g) => g.matcher === "Read");
  check("writeSessionSettings(repoPath WITH a record store): PostToolUse carries a Read group", !!readGroupWithStore);
  check("writeSessionSettings(repoPath WITH a record store): the Read group's command points at decision-records.mjs",
    !!readGroupWithStore && readGroupWithStore.hooks[0].command.includes("decision-records.mjs"));

  // Arm 1: NO_STORE_REPO has none of the three record stores — no Read group at all, not merely a fast
  // in-process bail inside the hook itself (that bail still exists as the mid-session-deletion backstop —
  // DoD-5 — and is unchanged; this is a SEPARATE, earlier gate that skips wiring the hook in the first place).
  const noStore = JSON.parse(fs.readFileSync(writeSessionSettings("decrec-wiring-nostore", perm, "test-hook-token", undefined, NO_STORE_REPO), "utf8"));
  const readGroupNoStore = (noStore.hooks.PostToolUse || []).find((g) => g.matcher === "Read");
  check("writeSessionSettings(repoPath with NO record store): PostToolUse carries NO Read group at all "
    + "(literal zero overhead — the hook's own process is never spawned on this project's Reads)",
    !readGroupNoStore);

  // repoPath omitted entirely (the shape every OTHER test in this file, and every pre-5244adc2 caller,
  // still uses) stays byte-identical to the old always-wired behavior.
  const omitted = JSON.parse(fs.readFileSync(writeSessionSettings("decrec-wiring-omitted", perm, "test-hook-token"), "utf8"));
  const readGroupOmitted = (omitted.hooks.PostToolUse || []).find((g) => g.matcher === "Read");
  check("writeSessionSettings(repoPath omitted): PostToolUse still carries a Read group (backward-compatible default)",
    !!readGroupOmitted);

  // --- card 0635f545: pin DECISION_RECORD_STORE_KINDS (claude-settings.ts) against decision-records.mjs's
  // OWN `anyStoreExists` store-kind literals — 5244adc2 had to duplicate that list because the compiled
  // daemon cannot import the standalone asset. Asserting the two FUNCTIONS return the same ANSWER on the
  // fixtures above would be the wrong test here: it can never detect a store kind neither fixture has,
  // which is exactly the shape of the dangerous drift direction (see below) — so this compares the LISTS
  // themselves. The asset can't be imported (out of scope to change, and the whole point of it staying a
  // standalone/live-read asset — see the card), so its list is recovered by parsing the literal
  // `"docs", "<kind>"` pairs out of `anyStoreExists`'s own source text; the settings side is read as a
  // real compiled constant (DECISION_RECORD_STORE_KINDS), not re-parsed, so only ONE side of this
  // comparison is ever textual.
  //
  // Drift directions this catches: BOTH, because it's true set equality, not a one-way subset/superset
  // check. If the settings list falls behind the asset (gains fewer kinds) — the dangerous direction: a
  // project whose only store is a kind the asset knows but the settings list doesn't would be judged
  // store-less, the hook never gets wired, and decision records silently stop injecting for it, with no
  // downstream backstop (the backstop lives INSIDE the un-wired hook) — this test fails. If the settings
  // list runs ahead of the asset (gains an extra kind the asset doesn't check) — the benign, self-
  // announcing direction (the hook wires when it need not) — this test fails too.
  const assetSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "assets", "decision-records.mjs"), "utf8");
  const assetFnMarker = "function anyStoreExists(";
  const assetFnStart = assetSrc.indexOf(assetFnMarker);
  check("sanity: decision-records.mjs still defines anyStoreExists (source shape assumed by this test)", assetFnStart !== -1);
  const assetBraceStart = assetSrc.indexOf("{", assetFnStart);
  let depth = 0, i = assetBraceStart;
  for (; i < assetSrc.length; i++) {
    if (assetSrc[i] === "{") depth++;
    else if (assetSrc[i] === "}") { depth--; if (depth === 0) break; }
  }
  const assetFnBody = assetSrc.slice(assetBraceStart, i + 1);
  const assetKinds = new Set();
  for (const m of assetFnBody.matchAll(/"docs"\s*,\s*"([a-zA-Z0-9_-]+)"/g)) assetKinds.add(m[1]);
  // Positive control: prove the extraction pattern can actually find something, against the SAME asset
  // text, before trusting its silence anywhere else — an empty result here would make the two-sides-agree
  // check below pass vacuously if DECISION_RECORD_STORE_KINDS were also (wrongly) empty.
  check("sanity: literal-parsing anyStoreExists's body finds all 3 currently-known store kinds "
    + "(proves the extraction pattern works, not just that both sides happen to be empty)",
    assetKinds.size === 3 && assetKinds.has("adr") && assetKinds.has("decisions") && assetKinds.has("investigations"));
  const settingsKinds = new Set(DECISION_RECORD_STORE_KINDS);
  const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  check("DECISION_RECORD_STORE_KINDS (claude-settings.ts, compiled) matches decision-records.mjs's own "
    + "anyStoreExists store-kind literals exactly (set equality — catches EITHER divergence direction)",
    setsEqual(assetKinds, settingsKinds));

  // --- card abd049da DoD-2, "proven by a test over at least one of the 35 real cases": dynamically pick
  // ONE real docs/adr|docs/decisions record from the ACTUAL repo that currently has no 'Do not' section
  // (never a hardcoded id — a record could gain a Do-not section later, per this card's own "Do not" list,
  // and a hardcoded id would then silently stop testing what it claims to), copy its REAL content into the
  // fixture repo, anchor it, and confirm the fallback fires on genuine record text, not just a synthetic
  // fixture. Skips gracefully (rather than failing) if the real corpus currently has zero such records —
  // that would mean the coverage gap this card exists to close has already been fully closed. ---
  {
    const realRecords = listRecordIds(REAL_REPO_ROOT);
    const realMissing = findRecordsMissingDoNot(REAL_REPO_ROOT, realRecords);
    if (realMissing.length === 0) {
      check("card abd049da DoD-2 (real-case proof): SKIPPED — the real corpus currently has zero flat-store "
        + "records missing a 'Do not' section (the coverage gap is fully closed; nothing to prove against)", true);
    } else {
      const real = realMissing[0];
      const realText = fs.readFileSync(real.path, "utf8");
      const realStore = path.basename(path.dirname(real.path)); // "adr" or "decisions"
      const realFixturePath = path.join(REPO, "docs", realStore, path.basename(real.path));
      fs.writeFileSync(realFixturePath, realText);
      const REAL_CASE_SRC = path.join(REPO, "real-case.ts");
      fs.writeFileSync(REAL_CASE_SRC, `// @decision ${real.id} — real no-Do-not case, card abd049da DoD-2\n`);
      const realResult = runHookOnFile(REAL_CASE_SRC, "s-real-no-do-not", 1, 1);
      check(`card abd049da DoD-2 (real-case proof): real record ${real.id} (currently no Do-not section) `
        + "injects the explicit fallback note, not silence and not the old whole-record narrative",
        !!realResult && realResult.hookSpecificOutput.additionalContext.includes("No 'Do not' section in this record"));
      check(`card abd049da DoD-2 (real-case proof): the real record's own title survives`,
        !!realResult && realResult.hookSpecificOutput.additionalContext.includes(`${real.id}`));
    }
  }
} finally {
  for (const d of [REPO, DEDUPE_DIR, FOREIGN_REPO, NO_STORE_REPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  for (const id of ["decrec-wiring-store", "decrec-wiring-nostore", "decrec-wiring-omitted"]) {
    try { fs.rmSync(path.join(SETTINGS_DIR, `${id}.json`), { force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decision-records.mjs injects a record's title + 'Do not' section(s) plus a pointer "
    + "(or an explicit no-Do-not fallback note, never silence, never the old whole-record narrative), "
    + "resolved live from docs/adr, docs/decisions, and the nested docs/investigations convention, "
    + "whenever an anchor's line falls within a Read's actual range or its enclosing blank-line block; "
    + "stays byte-identical to no hook at all when nothing is anchored in range; dedupes per session; and "
    + "enforces its byte cap via explicit truncation (a single oversized reduced body) or explicit "
    + "whole-record omission (shared-budget contention) — never a silent partial."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
