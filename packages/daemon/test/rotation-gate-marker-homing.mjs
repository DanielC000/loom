import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Tests for card 6dd3a17c's fix to packages/daemon/scripts/rotation-gate.mjs — see that file's own header
// (@decision 6dd3a17c) and docs/decisions/6dd3a17c-marker-union-scan-excludes-rules-files-own-rotation-gate-section.md
// for the full defect: a rules file's own §ROTATION-GATE section carries a fenced block ENUMERATING every
// marker token (--audit-vault's drift detector requires it to be there), which meant the marker UNION SCAN
// — an exact-substring search over the whole rules file — was satisfying every marker from that
// enumeration ALONE, whether or not the rule each token protects had a home anywhere else. The gate's
// marker check could never go red against a rules file shaped like the real one.
//
// The regression proof below is section-scoped, not fence-scoped: an earlier attempt at this fix (fence-only
// exclusion) was proven INSUFFICIENT during this card's own checkpoint — with only the fenced block removed,
// 6 of 12 markers still resolved via the §ROTATION-GATE section's own surrounding DISCUSSION PROSE. Case A
// below reproduces that full shape (enumeration fence + discussion prose, no other section), Case B proves
// the exclusion is section-SCOPED (a marker genuinely homed in a DIFFERENT section still resolves), and
// Case C proves the boundary is structural (content just outside the section still counts).
//
// Run: node packages/daemon/test/rotation-gate-marker-homing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-mh-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// The 12 marker tokens rotation-gate.mjs's own MARKERS array currently requires — kept as a local
// literal here, same convention as the sibling test files (rotation-gate-vault-audit.mjs etc.).
const ALL_MARKER_TOKENS = [
  "Orchestrator Rules",
  "THE FOUR-LEG VERIFY",
  "LIVE COMMITMENTS",
  "OWNER-GATED",
  "ROTATE AT 40 KB",
  "THE SAFE-WRITE",
  "MULTI-HARNESS EPIC",
  "NO-CLEARANCE-FROM-SILENCE",
  "QUIET-LANE",
  "MGR122-FLOOR",
  "PRAISE-IS-THE-LEAST-AUDITED-INPUT",
  "PRE-MERGE-PAIR",
];

// An --active doc with NO markers at all and NO "live commitments"-matching heading — deliberately bare,
// so every one of the 12 markers' resolution in the assertions below comes ONLY from --rules, with no
// active-doc marker (in particular "LIVE COMMITMENTS" itself) to account for in the missing-count math.
// commitmentsList/commitmentsFloor stay untouched by this fix (card 6dd3a17c: marker union scan only), so
// the LIVE COMMITMENTS floor failure this produces is expected and orthogonal to every check below, which
// only ever asserts on the "missing N/12 marker(s)" line.
function bareActiveDoc() {
  return ["# Rotating log (fixture)", "", "Nothing relevant here at all.", ""].join("\n");
}

// Mirrors the REAL vault shape that produced the defect: a §ROTATION-GATE heading whose section contains
// a fenced enumeration of every marker token PLUS discussion prose that also names several tokens outside
// the fence (the real vault's own §ROTATION-GATE section does exactly this — see the card's LEG C finding).
// `otherSection`, when given, is a SEPARATE, later section — never inside §ROTATION-GATE — used by Case B/C
// to prove a genuine home outside the excluded section still resolves.
function rulesFixture({ enumeratedMarkers = ALL_MARKER_TOKENS, discussedMarkers = ALL_MARKER_TOKENS, otherSectionMarker = null } = {}) {
  const lines = [
    "# Fixture rules doc — deliberately carries none of the 12 marker tokens outside the guarded section",
    "",
    "## 🔴🔴 §ROTATION-GATE — the rotation is where rules die",
    "The gate below asserts these markers:",
    "```",
    enumeratedMarkers.join(" · "),
    "```",
  ];
  for (const m of discussedMarkers) lines.push(`Discussion: ${m} is important because the rule it protects matters.`);
  lines.push("");
  if (otherSectionMarker) {
    lines.push("## §SOME OTHER SECTION — a genuinely different rule, unrelated to rotation-gate housekeeping");
    lines.push(`${otherSectionMarker} is documented here as real content, not as part of any marker list.`);
    lines.push("");
  }
  return lines.join("\n");
}

function runGate(argsArr) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argsArr], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const activePath = writeFixture("active.md", bareActiveDoc());

// ── Case A: THE DEFECT — a rules file shaped like the real vault (enumeration fence + discussion prose,
// no marker genuinely homed anywhere else) must NOT satisfy any marker. This is what the pre-fix script
// got wrong: every one of the 12 was satisfied by this fixture alone. ─────────────────────────────────────
{
  const enumOnlyPath = writeFixture("rules-enum-only.md", rulesFixture());
  const r = runGate(["--active", activePath, "--rules", enumOnlyPath, "--lint"]);
  check("A. a rules file with ONLY the §ROTATION-GATE enumeration+prose (no other home): exits 1", r.status === 1);
  check("A. names all 12 markers missing — the enumeration section satisfies none of them", /missing 12\/12 marker\(s\)/.test(r.stderr));
  for (const token of ALL_MARKER_TOKENS) {
    check(`A. "${token}" is named as missing`, r.stderr.includes(token));
  }
}

// ── Case B: SECTION-SCOPED, not a blanket "ignore this rules file" — a marker with a genuine home in a
// DIFFERENT section must still resolve via --rules (required by @decision 4cbb2999: at least one marker
// must be able to resolve as rules-file-only, or nothing proves the rules file is load-bearing). ─────────
{
  const withHomePath = writeFixture("rules-with-real-home.md", rulesFixture({ otherSectionMarker: "QUIET-LANE" }));
  const r = runGate(["--active", activePath, "--rules", withHomePath, "--lint"]);
  check("B. QUIET-LANE has a real home in a DIFFERENT section: resolves via --rules, not missing", r.status === 1 && !/QUIET-LANE/.test(r.stderr.match(/missing.*$/m)?.[0] ?? ""));
  const missingLine = r.stderr.split("\n").find((l) => l.includes("missing")) ?? "";
  check("B. exactly 11 still missing (only QUIET-LANE resolved)", /missing 11\/12/.test(missingLine));
}

// ── Case C: STRUCTURAL BOUNDARY — content genuinely OUTSIDE the §ROTATION-GATE section (a later, distinct
// heading) still counts, mirroring the existing heading-anchor test family's own boundary proof. Same
// fixture as Case B, just re-asserting the boundary is real (not "the whole rules file is now excluded"). ──
{
  const boundaryPath = writeFixture("rules-boundary.md", rulesFixture({ otherSectionMarker: "PRE-MERGE-PAIR" }));
  const r = runGate(["--active", activePath, "--rules", boundaryPath, "--lint"]);
  const missingLine = r.stderr.split("\n").find((l) => l.includes("missing")) ?? "";
  check("C. a marker homed in the section AFTER §ROTATION-GATE resolves (structural boundary, not name-based)", !missingLine.includes("PRE-MERGE-PAIR"));
  check("C. the enumeration-only markers are still all missing (11 of them)", /missing 11\/12/.test(missingLine));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-gate.mjs's marker union scan excludes a rules file's own §ROTATION-GATE section (fence AND surrounding discussion prose), a marker with a genuine home in a different section still resolves via --rules, and the boundary is structural (heading depth), not name- or fence-based."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
