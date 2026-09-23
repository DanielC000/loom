import "./_guard.mjs"; // prod-guard: sets LOOM_TEST=1 (see _guard.mjs)
// Decision-record injection counter + per-repo record count (card b625a6ed). Deterministic, no daemon, no
// claude: runs the shipped decision-records.mjs asset with synthetic PostToolUse `Read` payloads against a
// hermetic fixture repo, then reads the counter back through the real `decisions_for` aggregation
// (dist/mcp/decisions.js). Asserts:
//   (1) COUNTER: one JSONL line per injected record, with EXACTLY the bounded field set
//       {ts, session, repo, anchorId, store, truncated, bytes} — and NO record content (title/body/path).
//   (2) TRUNCATED: an over-cap record logs truncated:true; a normal one truncated:false; `bytes` is the
//       rendered section size.
//   (3) NO-INJECTION ⇒ NO LINE: a per-session-deduped repeat read and a no-anchor read log nothing.
//   (4) FAIL-OPEN: with the sink unwritable (the log path is a DIRECTORY ⇒ EISDIR) the Read's stdout is
//       BYTE-IDENTICAL to a healthy-sink run and the exit code is 0 (positive control: the same fixture with a
//       healthy sink DID write a line).
//   (5) WORKTREE: a linked worktree (`.git` FILE → <main>/.git/worktrees/x) is keyed to its MAIN checkout.
//   (6) PER-REPO COUNT: readInjectionStats/decisionsFor count only the asked repo; recordsByStore counts
//       records per store; a repo with no log/records reads {total:0}, never an error.
//   (7) NAME PIN: paths.ts's DECISION_RECORD_INJECTION_LOG basename equals the hook's INJECTION_LOG_NAME.
// Run: build first (turbo builds shared first), then `node test/decision-record-injection-stats.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-drstats-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { DECISION_RECORDS_SCRIPT, DECISION_RECORD_INJECTION_LOG } = await import("../dist/paths.js");
const { decisionsFor, readInjectionStats } = await import("../dist/mcp/decisions.js");

const mkRepo = (name) => {
  const dir = path.join(tmpHome, name);
  fs.mkdirSync(path.join(dir, "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "decisions"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};
const REPO = mkRepo("repo-a");
const OTHER = mkRepo("repo-b");
const SECRET_TITLE = "ZQXSECRETTITLE";
const SECRET_BODY = "ZQXSECRETBODY";
fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-one.md"), `# aaaaaaaa — ${SECRET_TITLE}\n\n${SECRET_BODY} narrative.\n\n## Do not\n\n- Do not do the thing.\n`);
fs.writeFileSync(path.join(REPO, "docs", "decisions", "bbbbbbbb-two.md"), `# bbbbbbbb — two\n\n## Do not\n\n- Do not ${"x".repeat(7000)}.\n`); // reduced body > 6000 ⇒ truncated
fs.writeFileSync(path.join(REPO, "docs", "decisions", "cccccccc-three.md"), `# cccccccc — three\n\n## Do not\n\n- Do not y.\n`);
fs.writeFileSync(path.join(OTHER, "docs", "decisions", "dddddddd-other.md"), `# dddddddd — other\n\n## Do not\n\n- Do not z.\n`);
const src = (repo, name, id) => { const p = path.join(repo, name); fs.writeFileSync(p, `// @decision ${id} — guard\nconst x = 1;\n`); return p; };

function run(dedupeDir, filePath, cwd, session) {
  const r = spawnSync(process.execPath, [DECISION_RECORDS_SCRIPT, dedupeDir], {
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: filePath, offset: 1, limit: 5 }, session_id: session, cwd }),
    encoding: "utf8",
  });
  return { out: r.stdout, code: r.status };
}
const readLog = (dedupeDir) => {
  try { return fs.readFileSync(path.join(dedupeDir, "injections.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// (1)(2)(3) counter
{
  const dd = path.join(tmpHome, "dd1");
  const fa = src(REPO, "a.ts", "aaaaaaaa");
  const fb = src(REPO, "b.ts", "bbbbbbbb");
  const r1 = run(dd, fa, REPO, "sess-1");
  check("(1a) the injection itself still fires (positive control for the counter)", r1.code === 0 && r1.out.includes("decision aaaaaaaa"));
  run(dd, fb, REPO, "sess-1");
  const lines = readLog(dd);
  check("(1b) one line per injected record", lines.length === 2);
  const KEYS = ["anchorId", "bytes", "repo", "session", "store", "truncated", "ts"];
  check("(1c) every line has EXACTLY the bounded field set", lines.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(KEYS)));
  const la = lines.find((l) => l.anchorId === "aaaaaaaa");
  const ctx = JSON.parse(r1.out).hookSpecificOutput.additionalContext;
  const section = ctx.slice(ctx.indexOf("### decision aaaaaaaa")); // single record, no omission note ⇒ the rest of the context IS the section
  check("(1d) fields: session, store, truncated:false, bytes == rendered section size", la && la.session === "sess-1" && la.store === "adr" && la.truncated === false && la.bytes === Buffer.byteLength(section, "utf8"));
  const lb = lines.find((l) => l.anchorId === "bbbbbbbb");
  check("(2) an over-cap record logs truncated:true and store:decisions", lb && lb.truncated === true && lb.store === "decisions");
  let raw = ""; try { raw = fs.readFileSync(path.join(dd, "injections.jsonl"), "utf8"); } catch { /* absent ⇒ (1b) already failed */ }
  check("(1e) NO record content in the log (title/body/record path absent)", !raw.includes(SECRET_TITLE) && !raw.includes(SECRET_BODY) && !raw.includes("aaaaaaaa-one") && !raw.includes("Do not"));
  run(dd, fa, REPO, "sess-1"); // per-session dedupe: nothing injected
  const fnone = path.join(REPO, "none.ts"); fs.writeFileSync(fnone, "const y = 2;\n");
  run(dd, fnone, REPO, "sess-1"); // no anchor
  check("(3) a deduped repeat read and a no-anchor read log nothing", readLog(dd).length === 2);
}

// (4) fail-open
{
  const healthy = path.join(tmpHome, "dd-ok");
  const broken = path.join(tmpHome, "dd-broken");
  fs.mkdirSync(path.join(broken, "injections.jsonl"), { recursive: true }); // sink path is a directory ⇒ append throws EISDIR
  const f = src(REPO, "c.ts", "cccccccc");
  const ok = run(healthy, f, REPO, "sess-f");
  const bad = run(broken, f, REPO, "sess-f");
  check("(4a) positive control: the healthy sink wrote a line", readLog(healthy).length === 1);
  check("(4b) sink failure: exit 0 and stdout BYTE-IDENTICAL to the healthy run", bad.code === 0 && bad.out === ok.out && bad.out.length > 0);
  check("(4c) sink failure: the sink really was unwritable (still a directory, no line written)", fs.statSync(path.join(broken, "injections.jsonl")).isDirectory());
}

// (5) worktree keyed to main checkout
{
  const dd = path.join(tmpHome, "dd-wt");
  const wt = path.join(tmpHome, "wt-of-a");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "seed"], { cwd: REPO });
  execFileSync("git", ["worktree", "add", "-q", "-b", "wt-branch", wt], { cwd: REPO });
  fs.mkdirSync(path.join(wt, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "decisions", "cccccccc-three.md"), fs.readFileSync(path.join(REPO, "docs", "decisions", "cccccccc-three.md")));
  const f = src(wt, "w.ts", "cccccccc");
  run(dd, f, wt, "sess-wt");
  const l = readLog(dd);
  check("(5) a linked worktree's injection is keyed to the MAIN checkout root", l.length === 1 && fs.realpathSync(l[0].repo) === fs.realpathSync(REPO));
}

// (6) per-repo count via the real aggregation
{
  const log = path.join(tmpHome, "agg", "injections.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const row = (repo, extra = {}) => JSON.stringify({ ts: "2026-09-23T10:00:00.000Z", session: "s1", repo, anchorId: "aaaaaaaa", store: "adr", truncated: false, bytes: 100, ...extra }) + "\n";
  fs.writeFileSync(log, row(REPO) + row(REPO, { session: "s2", truncated: true, store: "decisions", bytes: 50, ts: "2026-09-24T10:00:00.000Z" }) + row(OTHER) + "not json\n");
  const a = readInjectionStats(REPO, log);
  check("(6a) counts only the asked repo's lines (total/truncated/bytes/sessions/byStore/first/last)",
    a.total === 2 && a.truncated === 1 && a.bytes === 150 && a.sessions === 2 && a.byStore.adr === 1 && a.byStore.decisions === 1
    && a.first === "2026-09-23T10:00:00.000Z" && a.last === "2026-09-24T10:00:00.000Z");
  check("(6b) the OTHER repo is counted separately", readInjectionStats(OTHER, log).total === 1);
  const none = readInjectionStats(REPO, path.join(tmpHome, "agg", "does-not-exist.jsonl"));
  check("(6c) an absent log reads {total:0}, never an error", none.total === 0 && none.sessions === 0);
  // decisions_for no-query: recordsByStore + injections from the DEFAULT log path (the hook's real sink)
  fs.mkdirSync(path.dirname(DECISION_RECORD_INJECTION_LOG), { recursive: true });
  fs.writeFileSync(DECISION_RECORD_INJECTION_LOG, row(REPO) + row(REPO) + row(REPO));
  const all = decisionsFor(REPO);
  check("(6d) decisions_for index: recordCount + recordsByStore per store", all.recordCount === 3 && all.recordsByStore.adr === 1 && all.recordsByStore.decisions === 2 && all.recordsByStore.investigations === 0);
  check("(6e) decisions_for index: injections read from the hook's real log path", all.injections.total === 3);
  check("(6f) a repo with records but no injections reads injections.total 0", decisionsFor(OTHER).injections.total === 0 && decisionsFor(OTHER).recordCount === 1);
}

// (7) name pin
{
  const asset = fs.readFileSync(DECISION_RECORDS_SCRIPT, "utf8");
  const m = /const INJECTION_LOG_NAME = "([^"]+)"/.exec(asset);
  check("(7) paths.ts DECISION_RECORD_INJECTION_LOG basename == the hook's INJECTION_LOG_NAME", !!m && path.basename(DECISION_RECORD_INJECTION_LOG) === m[1]);
}

fs.rmSync(tmpHome, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nALL PASS");
