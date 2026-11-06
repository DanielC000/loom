import "./_guard.mjs";
// Card 55de3b68 — SOURCE-TEXT guard (no daemon, no build beyond tsc): every statement in
// `packages/daemon/src/db.ts` that writes the `questions` table (`UPDATE questions`, `INSERT INTO questions`,
// `DELETE FROM questions`, also `INSERT OR … INTO questions` / `REPLACE INTO questions`) must sit inside a
// method that calls `notifyQuestionsChanged(` — the post-commit /ws/fleet `{t:"questions"}` signal the web
// inbox relies on INSTEAD of polling. A mutator added without the call would leave every open tab stale with
// no poll left to heal it, and nothing visible would fail.
//
// ENCLOSING-METHOD RULE: a "method" is a 2-space-indented `name(` declaration at the class body level; a
// statement belongs to the nearest such declaration above it. Comments are blanked (line numbers kept)
// before scanning, so prose that merely MENTIONS `UPDATE questions` is never a site.
//
// ALLOWLIST (each with its reason; a stale entry — one that no longer matches a real site — fails too):
//   markQuestionSurfaced  last_surfaced_* is decisions-relay dedup bookkeeping; no inbox reader displays it.
//   migrateQuestions     the boot migration; runs once inside the constructor's migrate step, before any listener can be wired.
//
// JOINED-FIELD SITES (second rule): the inbox row (`listOpenQuestions`) JOINs fields that live OUTSIDE the
// questions table — the linked card's lane + title, the asking session's process_state/resumability, the
// project and agent names — so a write to THOSE tables must signal too, with no `UPDATE questions` in sight
// for rule 1 to find. JOINED_FIELD_SITES names each such method; its body must call a notifier. The helpers
// are EXISTS-gated and the callers fire only on a real transition (never a busy flip / last_activity touch).
//
// BLIND SPOTS (named, not hidden): only db.ts is scanned (a `questions` write built in another module would
// be invisible — verified none exist: `grep -rnE "(UPDATE|INSERT INTO|DELETE FROM) questions" src` outside
// db.ts is empty at the time of writing, and this guard re-checks that across src/); dynamically built SQL
// (a table name from a variable) is invisible; the guard proves the CALL is present in the method, not that
// it sits after the write on every path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const ALLOWLIST = new Map([
  ["markQuestionSurfaced", "last_surfaced_* decisions-relay dedup bookkeeping — not inbox-visible"],
  ["migrateQuestions", "boot-time schema migration/backfill run from the Db constructor — no listener is wired yet (allowlists the WHOLE method: a new live-write added inside it would be missed)"],
]);

// Method -> the joined field it writes (every entry must call a notifier; a stale name fails too).
const JOINED_FIELD_SITES = new Map([
  ["updateTask", "tasks.column_key / title (inbox row's linked-task lane + title)"],
  ["deleteTask", "tasks row removed (linked-task lane/title go null)"],
  ["applyBoardColumnLayout", "tasks.column_key bulk re-lane"],
  ["setProcessState", "sessions.process_state (asking-session liveness)"],
  ["setResumability", "sessions.resumability"],
  ["setEngineSessionId", "sessions.resumability -> resumable"],
  ["recoverStaleSessions", "sessions.process_state live/starting -> exited at boot"],
  ["updateProject", "projects.name"],
  ["updateAgent", "agents.name"],
]);
const NOTIFY_CALL_RE = /\bnotifyQuestions(?:Changed|IfTaskReferenced|IfSessionHasOpen|IfProjectHasQuestions)\(/;
const WRITE_RE = /\b(?:UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO)\s+questions\b/g;
const METHOD_RE = /^  (?:(?:private|public|protected|static|async)\s+)*([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\(/;

/** Blank every comment, preserving newlines (so line numbers survive). */
function stripComments(text) {
  let out = "";
  let i = 0;
  let mode = null; // null | "line" | "block" | "'" | '"' | "`"
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (mode === "line") { if (c === "\n") { mode = null; out += c; } else out += " "; i++; continue; }
    if (mode === "block") { if (c === "*" && d === "/") { mode = null; out += "  "; i += 2; } else { out += c === "\n" ? "\n" : " "; i++; } continue; }
    if (mode) {
      out += c;
      if (c === "\\") { out += d ?? ""; i += 2; continue; }
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === "/" && d === "/") { mode = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && d === "*") { mode = "block"; out += "  "; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") { mode = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Methods of `text` (db.ts) named in JOINED_FIELD_SITES whose body lacks a notifier call, plus names not found. */
export function scanJoinedSites(text) {
  const lines = stripComments(text).split("\n");
  const starts = [];
  lines.forEach((ln, idx) => { const m = METHOD_RE.exec(ln); if (m && !/^\s*(if|for|while|switch|return|catch)\b/.test(ln)) starts.push({ name: m[1], start: idx }); });
  const missing = [], unwired = [];
  for (const name of JOINED_FIELD_SITES.keys()) {
    const i = starts.findIndex((m) => m.name === name);
    if (i < 0) { missing.push(name); continue; }
    const body = lines.slice(starts[i].start, starts[i + 1] ? starts[i + 1].start : lines.length).join("\n");
    if (!NOTIFY_CALL_RE.test(body)) unwired.push(name);
  }
  return { missing, unwired };
}

/** → { sites: [{line, method}], violations: [{line, method}], usedAllow: Set } for one db.ts text. */
export function scanDbText(text) {
  const clean = stripComments(text);
  const lines = clean.split("\n");
  const methods = []; // {name, start}
  lines.forEach((ln, idx) => { const m = METHOD_RE.exec(ln); if (m && !/^\s*(if|for|while|switch|return|catch)\b/.test(ln)) methods.push({ name: m[1], start: idx }); });
  const enclosing = (idx) => { let best = null; for (const m of methods) { if (m.start <= idx) best = m; else break; } return best; };
  const bodyOf = (m) => { const next = methods.find((x) => x.start > m.start); return lines.slice(m.start, next ? next.start : lines.length).join("\n"); };
  const sites = [], violations = [], usedAllow = new Set();
  lines.forEach((ln, idx) => {
    WRITE_RE.lastIndex = 0;
    if (!WRITE_RE.test(ln)) return;
    const m = enclosing(idx);
    const rec = { line: idx + 1, method: m?.name ?? "(top level)" };
    sites.push(rec);
    if (m && ALLOWLIST.has(m.name)) { usedAllow.add(m.name); return; }
    if (!m || !/\bnotifyQuestionsChanged\(/.test(bodyOf(m))) violations.push(rec);
  });
  return { sites, violations, usedAllow };
}

let failures = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `\n      ${extra}` : ""}`); if (!cond) failures++; };

const dbText = fs.readFileSync(path.join(SRC, "db.ts"), "utf8");
const real = scanDbText(dbText);

check("real db.ts: the scan found a realistic number of questions-write sites (>= 15; else the pattern is broken)", real.sites.length >= 15, `found ${real.sites.length}`);
check("real db.ts: every questions write sits in a method that calls notifyQuestionsChanged() (or is allowlisted)", real.violations.length === 0,
  real.violations.map((v) => `db.ts:${v.line} in ${v.method}()`).join("; "));
for (const name of ALLOWLIST.keys()) check(`allowlist entry ${name} still matches a real site (no stale entries)`, real.usedAllow.has(name));

const joined = scanJoinedSites(dbText);
check("joined-field sites: every named method exists in db.ts (no stale name)", joined.missing.length === 0, joined.missing.join(", "));
check("joined-field sites: every named method calls a questions notifier", joined.unwired.length === 0, joined.unwired.join(", "));
for (const name of JOINED_FIELD_SITES.keys()) {
  // Un-wire exactly this method's notifier call(s) (greedy within the method body up to the next 2-space method).
  const re = new RegExp("(\\n  (?:private |public )?" + name + "\\([\\s\\S]*?)(?=\\n  (?:private |public |async )?[A-Za-z_]\\w*\\s*(?:<[^>\\n]*>)?\\()");
  const m = re.exec(dbText);
  const mutated = m ? dbText.replace(re, (_, body) => body.replace(/this\.notifyQuestions\w+\(/g, "this.noopQuestions(")) : dbText;
  check("control: un-wiring " + name + "() is reported by the joined-field rule", mutated !== dbText && scanJoinedSites(mutated).unwired.includes(name));
}

// POSITIVE CONTROLS — the same scan must FAIL on known-bad text.
const planted = dbText.replace(/\n  markQuestionSurfaced\(/, '\n  plantedUnwiredWriter(id: string): void {\n    this.db.prepare("UPDATE questions SET note = ? WHERE id = ?").run("x", id);\n  }\n  markQuestionSurfaced(');
check("control: the planting actually changed the text", planted !== dbText);
const plantedRes = scanDbText(planted);
check("control: a planted UNWIRED `UPDATE questions` method is reported", plantedRes.violations.some((v) => v.method === "plantedUnwiredWriter"));

// Un-wire a REAL mutator: strip the notify call from answerQuestion only.
const unwired = dbText.replace(/(  answerQuestion\([\s\S]*?)this\.notifyQuestionsChanged\(\);/, "$1/* removed */");
check("control: the mutation actually changed the text", unwired !== dbText);
check("control: un-wiring the REAL answerQuestion() is reported", scanDbText(unwired).violations.some((v) => v.method === "answerQuestion"));

// A comment that merely mentions the SQL must not count as a site.
const withComment = dbText.replace(/\n  markQuestionSurfaced\(/, '\n  // UPDATE questions SET x = 1  (prose only)\n  markQuestionSurfaced(');
check("control: a COMMENT mentioning `UPDATE questions` is not a site", scanDbText(withComment).sites.length === real.sites.length);

// Blind-spot re-check: no other src module writes the table.
const others = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && p !== path.join(SRC, "db.ts")) {
      WRITE_RE.lastIndex = 0;
      if (WRITE_RE.test(stripComments(fs.readFileSync(p, "utf8")))) others.push(path.relative(SRC, p));
    }
  }
})(SRC);
check("no module other than db.ts writes the `questions` table", others.length === 0, others.join(", "));

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
