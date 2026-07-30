#!/usr/bin/env node
// Parse a FROZEN daemon-output.log snapshot into give-up / submit-attempt-1 / hook events, with
// magnitude-validated stamp extraction. NEVER point this at the live log -- copy it first.
//
// The stamp is a trailing whitespace-separated token (scripts/lib/line-timestamp.mjs, card ced00bfb),
// present only on lines emitted after the 2026-07-29 ~08:37Z relaunch. A naive "last token = epoch ms"
// parser will happily parse an OLD line that merely ends in a small number (a port, a pid, a count)
// into a garbage near-zero epoch. This parser instead requires the token be >= STAMP_MIN (~13 digits)
// and is positive-controlled against three known-unstamped lines before any count is trusted -- run this
// file directly (no args) to execute just that self-check.
//
// Usage: node parse-log-events.mjs <path-to-frozen-daemon-output.log> <out-events.json>
import fs from 'fs';
import readline from 'readline';

const STAMP_MIN = 1.7e12;

export function extractStamp(line) {
  const idx = line.lastIndexOf(' ');
  if (idx === -1) return null;
  const tok = line.slice(idx + 1).trim();
  if (!/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  if (!Number.isFinite(n) || n < STAMP_MIN) return null;
  return n;
}

function positiveControl() {
  const knownUnstamped = [
    '[pty] listening on 127.0.0.1:60848',
    '[submit] abc GIVE-UP RECOVERY: re-queued 3 message(s) at the front of pending, HELD from drain for up to 20000ms',
    '[hook] abc SessionStart session_id=1234',
  ];
  let ok = true;
  for (const c of knownUnstamped) {
    const s = extractStamp(c);
    if (s !== null) { ok = false; console.error(`POSITIVE CONTROL FAILED: "${c}" classified as stamped=${s}`); }
  }
  const knownStamped = 'x GIVE-UP RECOVERY after 4 Enter attempts 1785314994518';
  if (extractStamp(knownStamped) !== 1785314994518) { ok = false; console.error('POSITIVE CONTROL FAILED on known-stamped case'); }
  if (ok) console.error('positive control: OK (3 known-unstamped cases correctly rejected, 1 known-stamped case correctly parsed)');
  return ok;
}

// The ACTUAL classification line (not the budget-drop / requeue-success / suppressed / false-negative
// variants that also contain the substring "GIVE-UP RECOVERY" -- disambiguate by anchoring the full
// phrase, per the card's measurement-trap #4).
const GIVEUP_RE = /^\[submit\] (\S+) GIVE-UP RECOVERY after (\d+) Enter attempts — no engine output observed/;
// Post this investigation's observability fix, this line carries " gen=<N>" before the trailing
// " — awaiting confirmation" (log-only addition to pty/host.ts's fireEnterAndVerify, see findings.md).
// The optional group keeps this parser working against OLDER logs captured before that fix too.
const SUBMIT1_RE = /^\[submit\] (\S+) Enter attempt 1\/4 written(?: gen=(\d+))?/;
const HOOK_RE = /^\[hook\] (\S+) (\S+) session_id=/;

export async function parseLog(logPath) {
  const giveups = [], submit1s = [], hooks = [];
  let totalLines = 0, stampedLines = 0, unstampedLines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++; totalLines++;
    const stamp = extractStamp(line);
    if (stamp === null) unstampedLines++; else stampedLines++;
    let m;
    if ((m = GIVEUP_RE.exec(line))) giveups.push({ sessionId: m[1], attempt: Number(m[2]), stamp, lineNo });
    else if ((m = SUBMIT1_RE.exec(line))) submit1s.push({ sessionId: m[1], gen: m[2] !== undefined ? Number(m[2]) : null, stamp, lineNo });
    if ((m = HOOK_RE.exec(line))) hooks.push({ sessionId: m[1], event: m[2], stamp, lineNo });
  }
  return { giveups, submit1s, hooks, totalLines, stampedLines, unstampedLines };
}

// Windows-safe "run as CLI" check: compare basenames rather than full file:// URLs, whose path-separator
// form differs between import.meta.url and a raw argv path on Windows and would never match.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  if (!positiveControl()) process.exit(1);
  const [logPath, outPath] = process.argv.slice(2);
  if (!logPath) { console.error('usage: node parse-log-events.mjs <frozen-daemon-output.log> [out-events.json]'); process.exit(1); }
  const result = await parseLog(logPath);
  const sg = result.giveups.filter(g => g.stamp !== null);
  const ss = result.submit1s.filter(s => s.stamp !== null);
  console.log('total lines:', result.totalLines, 'stamped:', result.stampedLines, 'unstamped:', result.unstampedLines);
  console.log('give-up classification events: total', result.giveups.length, 'stamped', sg.length);
  if (sg.length) {
    const stamps = sg.map(g => g.stamp);
    console.log('  stamped range:', new Date(Math.min(...stamps)).toISOString(), '->', new Date(Math.max(...stamps)).toISOString());
  }
  console.log('Enter-attempt-1 (submit) events: total', result.submit1s.length, 'stamped', ss.length);
  if (outPath) { fs.writeFileSync(outPath, JSON.stringify(result)); console.log('wrote', outPath); }
}
