import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6ee2f9dd — pins what Loom's own detectPermissionWidening (dist/skills/permissionWidening.js; pure
// text, no fs/LOOM_HOME) reports for 712148f1's 13 loader-acceptance row-shapes, each carrying its
// measured Bun result as a one-line comment.
//
// PART A — the 13 shapes: zero under-detection gaps (every one still fails closed, via a direct per-key
//   label, the generic `frontmatter-unrecognized` vector, or both — except two: a correctly-allowlisted
//   boring line, and an accepted pre-existing over-label on an inert nested value).
// PART B — positive/negative controls, run BEFORE trusting PART A.
//
// @decision 712148f1 — these rows are MEASURED-VIA-PROXY ACCEPTED (real local Bun 1.3.10), never a
// byte-identical measurement of the installed claude.exe build's own bundled runtime; see that record's
// Round 7 for the full method/caveats and why the merge-key/quoted-key catches are structural, not semantic.
//
// Run after build: node test/skill-permission-widening-yaml-shapes.mjs
import { detectPermissionWidening } from "../dist/skills/permissionWidening.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ========================================================================================================
// PART A — the 13 measured shapes
// ========================================================================================================

// Bun.YAML.parse('"allowed-tools": Bash\n') => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] quoted key (double-quoted \"allowed-tools\") — labeled AND flagged unrecognized",
  same(detectPermissionWidening('---\nname: x\n"allowed-tools": Bash\n---\nbody\n'), ["allowed-tools", "frontmatter-unrecognized"]));

// Bun.YAML.parse("'hooks': {}\n") => {"hooks":{}} — key live.
check("[6ee2f9dd] quoted key (single-quoted 'hooks') — labeled AND flagged unrecognized",
  same(detectPermissionWidening("---\nname: x\n'hooks': {}\n---\nbody\n"), ["hooks", "frontmatter-unrecognized"]));

// Bun.YAML.parse("allowed-tools : Bash\n") => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] space before the colon — a correctly-allowlisted boring line, still directly labeled "
    + "(NOT flagged unrecognized — this is the one non-frontmatter-unrecognized catch in this file)",
  same(detectPermissionWidening("---\nname: x\nallowed-tools : Bash\n---\nbody\n"), ["allowed-tools"]));

// Bun.YAML.parse("{name: x, allowed-tools: Bash}\n") => {"name":"x","allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] flow mapping, single-line, as the WHOLE frontmatter doc — labeled AND flagged unrecognized",
  same(detectPermissionWidening("---\n{name: x, allowed-tools: Bash}\n---\nbody\n"), ["allowed-tools", "frontmatter-unrecognized"]));

// Bun.YAML.parse("{\n  name: x,\n  allowed-tools: Bash\n}\n") => {"name":"x","allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] flow mapping, multi-line (the brace on its own line), as the WHOLE frontmatter doc — "
    + "only flagged unrecognized (the per-key label scan can't span the newline after `{`; the opening "
    + "`{` line itself already fails the allowlist, so still caught)",
  same(detectPermissionWidening("---\nname: x\n{\n  name: x,\n  allowed-tools: Bash\n}\n---\nbody\n"), ["frontmatter-unrecognized"]));

// Bun.YAML.parse("? allowed-tools\n: Bash\n") => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] explicit key (`? allowed-tools` / `: Bash`) — only flagged unrecognized (the `?`-led "
    + "line never matches the allowlist's own key/colon shape, so no independent per-key label)",
  same(detectPermissionWidening("---\nname: x\n? allowed-tools\n: Bash\n---\nbody\n"), ["frontmatter-unrecognized"]));

// Bun.YAML.parse("!!str allowed-tools: Bash\n") => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] tagged key (`!!str allowed-tools: Bash`) — only flagged unrecognized",
  same(detectPermissionWidening("---\nname: x\n!!str allowed-tools: Bash\n---\nbody\n"), ["frontmatter-unrecognized"]));

// Bun.YAML.parse("base: &a\n  allowed-tools: Bash\n<<: *a\n") => {"base":{"allowed-tools":"Bash"},"allowed-tools":"Bash"}
// — the merge genuinely resolves `allowed-tools` live at the TOP level. Caught here anyway: the `<<:`
// line's own key can never match PLAIN_TOP_LEVEL_KEY_LINE_RE's `[A-Za-z0-9_-]+` charclass (`<` isn't in
// it) — a structural guarantee, not recognition of merge semantics.
check("[6ee2f9dd] merge key (`<<: *a`) — only flagged unrecognized, caught structurally via the `<<:` "
    + "line's own key shape, never by understanding the merge",
  same(detectPermissionWidening("---\nname: x\nbase: &a\n  allowed-tools: Bash\n<<: *a\n---\nbody\n"), ["frontmatter-unrecognized"]));

// Bun.YAML.parse('"allowed\\x2dtools": Bash\n') => {"allowed-tools":"Bash"} — escape resolved, key live
// (confirms a real YAML string-escape, not a lenient reader).
check("[6ee2f9dd] escaped-character quoted key (`\"allowed\\x2dtools\": Bash`) — only flagged unrecognized "
    + "(a quoted key always fails the allowlist's key shape regardless of what's inside the quotes)",
  same(detectPermissionWidening('---\nname: x\n"allowed\\x2dtools": Bash\n---\nbody\n'), ["frontmatter-unrecognized"]));

// Bun.YAML.parse("allowed-tools: &a Bash\n") => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] anchor value (`allowed-tools: &a Bash`) — labeled AND flagged unrecognized (double-caught: "
    + "direct label + the value's forbidden `&` start)",
  same(detectPermissionWidening("---\nname: x\nallowed-tools: &a Bash\n---\nbody\n"), ["allowed-tools", "frontmatter-unrecognized"]));

// Bun.YAML.parse("anchor: &a Bash\nallowed-tools: *a\n") => {"anchor":"Bash","allowed-tools":"Bash"} —
// the alias resolves, key live.
check("[6ee2f9dd] alias value (`allowed-tools: *a`, anchor defined on an earlier line) — labeled AND flagged unrecognized",
  same(detectPermissionWidening("---\nname: x\nanchor: &a Bash\nallowed-tools: *a\n---\nbody\n"), ["allowed-tools", "frontmatter-unrecognized"]));

// Bun.YAML.parse("allowed-tools: !!str Bash\n") => {"allowed-tools":"Bash"} — key live.
check("[6ee2f9dd] tagged value (`allowed-tools: !!str Bash`) — labeled AND flagged unrecognized",
  same(detectPermissionWidening("---\nname: x\nallowed-tools: !!str Bash\n---\nbody\n"), ["allowed-tools", "frontmatter-unrecognized"]));

// Bun.YAML.parse("other: {name: x, allowed-tools: Bash}\n") => {"other":{"name":"x","allowed-tools":"Bash"}}
// — allowed-tools is NESTED under `other`, never promoted to the top level: this is confirmed INERT data,
// not a real grant. The label here is a known, pre-existing, accepted over-match (the flow-mapping scan is
// block-wide, not line-scoped — same posture as the record's own NIT 5), never a missed widening.
check("[6ee2f9dd] flow mapping as a VALUE on another (non-whole-doc) line (`other: {..., allowed-tools: Bash}`) "
    + "— confirmed INERT by Bun (nested under `other`, never live at the top level); the label here is the "
    + "pre-existing accepted over-match, not evidence of a real grant",
  same(detectPermissionWidening("---\nname: x\nother: {name: y, allowed-tools: Bash}\n---\nbody\n"), ["allowed-tools"]));

// ========================================================================================================
// PART B — positive/negative controls (run before trusting PART A's "no gap" reading)
// ========================================================================================================
check("[6ee2f9dd][control] positive: an ordinary plain allowed-tools: line still fires (the detector CAN flag)",
  same(detectPermissionWidening("---\nname: x\nallowed-tools: Read\n---\nbody\n"), ["allowed-tools"]));
check("[6ee2f9dd][control] negative: a genuinely boring skill (a sequence, prose merely mentioning the field "
    + "names) is NOT flagged (the detector CAN report clean)",
  same(detectPermissionWidening("---\nname: x\ntags:\n  - a\n  - b\n---\n\nbody mentions allowed-tools and hooks in prose, not frontmatter.\n"), []));

console.log(failures === 0
  ? "\n✅ ALL PASS — all 13 712148f1 UNCONFIRMED-row shapes still fail closed; controls confirm the detector discriminates."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
