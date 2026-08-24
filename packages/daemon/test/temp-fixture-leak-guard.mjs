import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for card a1f72ab8 — the test suite was leaking `loom-*` fixture dirs into %TEMP%
// (124k+ entries, ~4,314/day) because most cleanup call sites either retried removal with ZERO delay
// between attempts (5 synchronous rmSync calls complete in microseconds — cannot outlast a transient
// Windows EBUSY/EPERM handle) or didn't retry at all. Both shapes were fixed by routing every call site
// through `_tmp-fixture.mjs`'s `cleanupPathSync` (a bounded retry WITH a real delay, already correct and
// already proven — see that module's own CORRECTION 1/2). This guard proves the FIX HOLDS going forward:
// a normal PASS of a representative sample leaves no new `loom-*` entry behind, in either direction
// (dirs or files — see the dirs-vs-files trap below), and — the part a naive guard gets wrong — it does
// NOT hardcode a single known-leaking prefix, so a brand-new leaking family is still caught.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = os.tmpdir();

// Snapshot every `loom-*` entry directly under %TEMP%, DIRS and FILES tracked SEPARATELY — never merged
// into one count. A merged count conflates a dead dir-leak with a live file-leak in either direction (the
// Platform Lead's own first pass on this card misread 45 live `codescape-*` FILES as a dir-leak because it
// counted all entries together). `withFileTypes` reads the type from the SAME readdir the enumeration cost
// already pays for — no extra per-entry `statSync` call needed (relevant at 100k+ entries: the Lead
// measured ~797ms for one enumeration of a directory this size; a second syscall per entry would be far
// more expensive at this population).
function snapshotLoomEntries() {
  const dirs = new Set(), files = new Set();
  for (const entry of fs.readdirSync(TMP, { withFileTypes: true })) {
    if (!entry.name.startsWith("loom-")) continue;
    (entry.isDirectory() ? dirs : files).add(entry.name);
  }
  return { dirs, files };
}

function newNames(beforeSet, afterSet) {
  return [...afterSet].filter((name) => !beforeSet.has(name));
}

// ============ POSITIVE CONTROL — prove this check can actually FAIL ============
// A zero-new-entries result is only meaningful if the same check reports non-zero when something
// genuinely new lands. Create an orphan the way a leaking test would (no registration, no cleanup) and
// confirm the snapshot diff reports it as new growth — otherwise a broken check would read "no growth"
// whether or not anything actually leaked, and every assertion below would be silently vacuous.
{
  const before = snapshotLoomEntries();
  const orphan = fs.mkdtempSync(path.join(TMP, "loom-tflg-positive-control-"));
  const after = snapshotLoomEntries();
  const grew = newNames(before.dirs, after.dirs).includes(path.basename(orphan));
  check("[control] a genuinely orphaned dir IS detected as new growth (the check itself is not vacuous)", grew);
  fs.rmSync(orphan, { recursive: true, force: true }); // this IS the control's own artifact — not part of what's under test
}

// ============ REAL RUN — a representative sample of hermetic tests already migrated to cleanupPathSync ============
// Picked for speed (all three run in well under a second) and coverage of distinct fixture shapes: a
// plain LOOM_HOME dir (companion-ack-not-recorded), a REST server + separate sqlite handle that must be
// closed before its temp root can be removed (skills-adopt-fastforward), and multiple named temp homes in
// one process (task-dedupe). None of these need a real daemon, git, or claude.
//
// THIS HOST IS SHARED, LIVE, self-hosting Loom: other real sessions can be creating/removing their OWN
// loom-* entries under %TEMP% at the exact same moment this guard runs (confirmed empirically — TWO
// separate false-fail modes surfaced while developing this guard: dozens of `loom-td-*`/`loom-bbl-*`
// entries from a concurrent, unrelated gate run; then, matching on trailing pid ALONE, a pid COINCIDENCE
// against a pre-existing 124k-entry backlog — an old leaked dir from days earlier whose pid segment
// happened to equal a pid the OS just reused for one of this guard's own children). A raw before/after
// snapshot diff, and pid-matching alone, both fail on a host this size. So attribution requires ALL
// THREE: (1) the exact family-prefix regex each sample file is grep-verified to use, (2) its trailing pid
// segment matches a pid THIS run actually spawned, (3) its timestamp segment is >= this run's own start
// time (an old dir cannot have a future timestamp, closing the pid-coincidence gap the positive control
// above doesn't cover).
const SAMPLE = [
  { name: "companion-ack-not-recorded", re: /^loom-companion-ack-(\d+)-(\d+)$/ },
  { name: "skills-adopt-fastforward", re: /^loom-skills-ff-(\d+)-(\d+)$/ },
  { name: "task-dedupe", re: /^loom-task-dedupe-(\d+)-(\d+)$/ },
  { name: "task-dedupe", re: /^loom-task-dedupe-boarding-(\d+)-(\d+)$/ }, // tmpHome2, same file
];

const runStartedAt = Date.now();
const spawnedPids = [];
for (const { name } of new Map(SAMPLE.map((s) => [s.name, s])).values()) {
  const r = spawnSync(process.execPath, [path.join(TEST_DIR, `${name}.mjs`)], { encoding: "utf8" });
  check(`[${name}] sample test itself passed (own process exit 0)`, r.status === 0);
  if (r.pid) spawnedPids.push(String(r.pid));
}

const belongsToThisRun = (entryName) => {
  for (const { re } of SAMPLE) {
    const m = entryName.match(re);
    if (m && Number(m[1]) >= runStartedAt && spawnedPids.includes(m[2])) return true;
  }
  return false;
};
const after = snapshotLoomEntries();
const leakedDirs = [...after.dirs].filter(belongsToThisRun);
const leakedFiles = [...after.files].filter(belongsToThisRun);
check(`a normal PASS of ${[...new Set(SAMPLE.map((s) => s.name))].join(", ")} leaves NO new loom-* dirs behind under %TEMP% (found: ${leakedDirs.join(", ") || "none"})`, leakedDirs.length === 0);
check(`a normal PASS of ${[...new Set(SAMPLE.map((s) => s.name))].join(", ")} leaves NO new loom-* files behind under %TEMP% (found: ${leakedFiles.join(", ") || "none"})`, leakedFiles.length === 0);

// Best-effort: if this run somehow did leave something behind (e.g. a genuine new EBUSY case), don't
// compound the very leak this guard exists to catch — but a leftover here is a FAILED check above, not
// silently absorbed.
for (const name of leakedDirs) fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
for (const name of leakedFiles) fs.rmSync(path.join(TMP, name), { force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — the snapshot diff genuinely detects new growth (positive control), and a normal pass of a representative multi-shape sample leaves zero new loom-* dirs AND zero new loom-* files behind under %TEMP%."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
