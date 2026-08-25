// Hermetic regression guard for card 8ea49acc, filed off the Code Reviewer's M2 finding on 8d158088:
// `packages/daemon/src/pty/claude-settings.ts` once shipped a DOUBLE-WRAPPED PreToolUse hook group
// (`hooks: [hookCmd]` where `hookCmd` is ALREADY a matcher-group, i.e. `{ hooks: [...] }`) — the inner
// element then has no `type`/`command`. Claude Code rejects the whole settings file on that shape and
// shows a BLOCKING interactive dialog on EVERY session spawn, unattended-unanswerable — the exact
// incident (fixed on main; nothing mechanically prevented it returning until this test).
//
// ⛔ `claude doctor` EXITS ZERO on an invalid settings file (measured by Codescape, 6 arms, 2026-08-25) —
// this guard does NOT shell out to it or reason about any exit code; it asserts the emitted OBJECT SHAPE
// directly, in-process.
//
// Whole-object iteration (DoD 1): for every key in the emitted `settings.hooks`, every group must have
// `Array.isArray(group.hooks)`, and every element of that array must be `{ type: "command", command:
// <string> }` — covers every present hook event AND every future one added the same way, from one
// definition. A `matcher` alongside a correctly-shaped `hooks` array (PreToolUse, vault-lint's
// PostToolUse) is the VALID form (DoD 3) and is not forbidden here.
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   pnpm build (repo root) then `node test/settings-hooks-shape.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The assertion under test: iterates the WHOLE hooks object (not per-entry), returns a list of shape
// violations (empty ⇒ valid). This exact function is what both the real emitted object and the
// negative-control (synthetic double-wrap, below) are checked against — a single definition, so a future
// hook event added to claude-settings.ts is covered automatically without touching this test.
function hooksShapeViolations(hooksObj) {
  const errors = [];
  if (typeof hooksObj !== "object" || hooksObj === null) return ["settings.hooks is not an object"];
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) { errors.push(`${event}: not an array of groups (got ${typeof groups})`); continue; }
    groups.forEach((group, gi) => {
      if (typeof group !== "object" || group === null) {
        errors.push(`${event}[${gi}]: group is not an object`);
        return;
      }
      if ("matcher" in group && typeof group.matcher !== "string") {
        errors.push(`${event}[${gi}]: matcher present but not a string`);
      }
      if (!Array.isArray(group.hooks)) {
        errors.push(`${event}[${gi}]: group.hooks is not an array (got ${JSON.stringify(group.hooks)})`);
        return;
      }
      group.hooks.forEach((h, hi) => {
        const shapeOk = typeof h === "object" && h !== null && h.type === "command" && typeof h.command === "string";
        if (!shapeOk) {
          errors.push(`${event}[${gi}].hooks[${hi}]: not { type: "command", command: <string> } (got ${JSON.stringify(h)})`);
        }
      });
    });
  }
  return errors;
}

const tmpHome = path.join(os.tmpdir(), `loom-settings-hooks-shape-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

try {
  const perm = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 2 };

  // --- Positive: the REAL emitted object (vaultPath set so PostToolUse is present too) must be clean.
  const withVault = JSON.parse(
    fs.readFileSync(writeSessionSettings("shape-vault", perm, "test-hook-token", os.tmpdir()), "utf8"),
  );
  const violations = hooksShapeViolations(withVault.hooks);
  check(
    "the real emitted settings.hooks (SessionStart/UserPromptSubmit/Stop/StopFailure/PreToolUse/"
      + "SubagentStop/PostToolUse) has zero shape violations",
    violations.length === 0,
  );
  if (violations.length) console.log("  violations:", violations);

  check("PreToolUse still carries its matcher alongside a correctly-shaped hooks array",
    typeof withVault.hooks.PreToolUse[0].matcher === "string" && withVault.hooks.PreToolUse[0].matcher.length > 0);
  check("PostToolUse (vault-lint) still carries its matcher alongside a correctly-shaped hooks array",
    withVault.hooks.PostToolUse[0].matcher === "Write|Edit");
  check("SubagentStop (no matcher, per card 8d158088) is still shape-valid without one",
    !("matcher" in withVault.hooks.SubagentStop[0]) && violations.length === 0);

  // --- Also check the no-vaultPath path (no PostToolUse key at all) is clean on its own.
  const plain = JSON.parse(
    fs.readFileSync(writeSessionSettings("shape-plain", perm, "test-hook-token"), "utf8"),
  );
  check("the no-vaultPath emitted settings.hooks (no PostToolUse) also has zero shape violations",
    hooksShapeViolations(plain.hooks).length === 0);
  check("no-vaultPath path correctly omits PostToolUse entirely", !("PostToolUse" in plain.hooks));

  // --- RED-PROOF (DoD 2): the SAME checker must FAIL against the exact historical double-wrap defect.
  // Reconstructs the real broken shape from cd0c7fee/8d158088 verbatim: `hookCmd` is already a
  // matcher-group (`{ hooks: [...] }`), and the bug wrapped IT again as `hooks: [hookCmd]` — so the inner
  // element of the outer `hooks` array is `{ hooks: [...] }`, which has no `type`/`command`.
  const hookCmd = { hooks: [{ type: "command", command: "node relay.mjs sess 4317 tok" }] };
  const doubleWrapped = {
    SessionStart: [hookCmd], // correct usage elsewhere in the same object — the checker must not false-flag this
    PreToolUse: [{ matcher: "mcp__x__y", hooks: [hookCmd] }], // the exact incident shape: hooks:[hookCmd] double-wraps an already-a-group value
  };
  const redViolations = hooksShapeViolations(doubleWrapped);
  check(
    "negative control: the checker DOES flag the exact double-wrap defect, and ONLY it — the correctly-"
      + "shaped SessionStart entry in the SAME object is not false-flagged (a shape assertion that "
      + "passes on both the correct and the broken object is worthless — the broken object is "
      + "structurally valid JSON)",
    redViolations.length === 1
      && redViolations[0].includes("PreToolUse[0].hooks[0]:")
      && redViolations[0].includes('not { type: "command"'),
  );
  if (redViolations.length !== 1) console.log("  (unexpected) redViolations:", redViolations);

  // --- Positive control on the checker itself: a well-formed object must NOT be flagged as broken.
  check("negative-control sanity: a well-formed hooks object is NOT flagged",
    hooksShapeViolations({ SessionStart: [hookCmd] }).length === 0);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the emitted settings.hooks object is shape-valid for every hook event "
    + "(Array.isArray(group.hooks), every element { type: \"command\", command: <string> }), matcher "
    + "handling is correct, and the checker is proven to fail on the exact historical double-wrap defect."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
