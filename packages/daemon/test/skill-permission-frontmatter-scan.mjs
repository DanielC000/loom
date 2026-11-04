// Card 015fdb23 (round 2: also delivers card 979f29b9's "warn only" owner decision, f635bad6) — the
// bounded, spawn-time cwd-skills permission-frontmatter scan (scanCwdSkillsForPermissionFrontmatter,
// skills/permission-scan.ts), the shared detector it routes through (detectPermissionWidening, card
// 87a51903), and the durable event + owner-push dedupe it feeds (SessionService.
// handleSkillPermissionFrontmatterWarning). See docs/decisions/
// 015fdb23-skill-shell-execution-disable-and-cwd-skill-scan.md for the scope limit this scan accepts
// (only <cwd>/.claude/skills itself), why a Loom-owned name is excluded, and the dedupe key shape.
//
// PART 1: scanCwdSkillsForPermissionFrontmatter as a pure function against real fixture directories —
// no daemon, no pty, no spawn.
// PART 2: SessionService.handleSkillPermissionFrontmatterWarning against a real in-memory Db +
// SessionService, same technique as instructions-loaded-hook.mjs's PART 2.
// PART 3: the push dedupe (card 979f29b9) — same content twice ⇒ one push; content changed ⇒ a second.
// PART 4 (CR round 4, item 3): the REAL injectSkills, proving a forged on-disk manifest+fingerprints
// sidecar for an "evil" skill cannot make the scan trust it — only this daemon process's own placements
// (an in-memory registry, never disk) are ever excluded.
//
// RUN: pnpm build (repo root) then `node test/skill-permission-frontmatter-scan.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-skperm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { scanCwdSkillsForPermissionFrontmatter, PERMISSION_SCAN_MAX_ENTRIES, PERMISSION_SCAN_MAX_READ_BYTES, TRUNCATION_NAMES_MAX, isScannedPermissionField } =
  await import("../dist/skills/permission-scan.js");
const { fingerprintSkillDir, injectSkills } = await import("../dist/skills/inject.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const scratchRoot = path.join(tmpHome, "scratch-cwd");

function writeSkill(cwd, name, frontmatterBody, bodyText = "hello") {
  const dir = path.join(cwd, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatterBody}---\n${bodyText}\n`);
}

try {
  // ===================================================================================================
  // PART 1 — scanCwdSkillsForPermissionFrontmatter: pure, bounded, best-effort
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });

    writeSkill(cwd, "clean-skill", "name: clean-skill\ndescription: nothing to see\n");
    writeSkill(cwd, "allowed-tools-skill", "name: allowed-tools-skill\nallowed-tools: Bash(*)\n");
    writeSkill(cwd, "hooks-skill", "name: hooks-skill\nhooks:\n  Stop:\n");
    writeSkill(cwd, "both-skill", "name: both-skill\nallowed-tools: Bash(*)\nhooks:\n  Stop:\n");
    writeSkill(cwd, "loom-owned-skill", "name: loom-owned-skill\nallowed-tools: Bash(*)\n"); // excluded via claimedByLoom + a matching fingerprint

    // CR round 3, finding 3: bare manifest membership is no longer enough — exclusion now requires a
    // recorded fingerprint that matches the name's CURRENT on-disk content. Build that map the same way
    // injectSkills itself would (its own exported fingerprintSkillDir), never a second hashing scheme.
    const loomOwnedFp = fingerprintSkillDir(path.join(cwd, ".claude", "skills", "loom-owned-skill"));
    const claimedFps1 = new Map([["loom-owned-skill", new Set([loomOwnedFp])]]);

    const { findings: findings1, truncated: truncated1 } = scanCwdSkillsForPermissionFrontmatter(cwd, new Set(["loom-owned-skill"]), claimedFps1);
    const byName = (n) => findings1.find((f) => f.name === n);
    check("PART1-1: a clean skill (no allowed-tools/hooks) is never flagged", !byName("clean-skill"));
    check("PART1-2: allowed-tools alone is flagged with exactly that field",
      byName("allowed-tools-skill")?.fields?.length === 1 && byName("allowed-tools-skill").fields[0] === "allowed-tools");
    check("PART1-3: hooks alone is flagged with exactly that field",
      byName("hooks-skill")?.fields?.length === 1 && byName("hooks-skill").fields[0] === "hooks");
    check("PART1-4: both fields present are both reported",
      byName("both-skill")?.fields?.includes("allowed-tools") && byName("both-skill").fields.includes("hooks"));
    check("PART1-5: a Loom-claimed name with a MATCHING recorded fingerprint is excluded even though its frontmatter would otherwise match (NEGATIVE CONTROL for the exclusion)",
      !byName("loom-owned-skill"));
    check("PART1-5b: a fingerprint-based exclusion is genuine, not a no-op — this scan found nothing to truncate/exclude from a clean read",
      truncated1.length === 0);
    check("PART1-6: exactly 3 findings total (allowed-tools-skill, hooks-skill, both-skill — not loom-owned, not clean)",
      findings1.length === 3);
    check("PART1-6b: never reports shell-inline/shell-fenced — the shared detector's full vocabulary, deliberately narrowed",
      findings1.every((f) => f.fields.every((v) => v === "allowed-tools" || v === "hooks")));
    check("PART1-6c: every finding carries a non-empty contentHash", findings1.every((f) => typeof f.contentHash === "string" && f.contentHash.length > 0));
    check("PART1-6d: a RESCAN of unchanged content yields the SAME contentHash (deterministic, not a nonce)",
      scanCwdSkillsForPermissionFrontmatter(cwd, new Set(["loom-owned-skill"]), claimedFps1).findings.find((f) => f.name === "allowed-tools-skill")?.contentHash
        === byName("allowed-tools-skill").contentHash);
    check("PART1-6e: two DIFFERENT flagged skills get DIFFERENT contentHash (not a constant stand-in)",
      byName("allowed-tools-skill").contentHash !== byName("hooks-skill").contentHash);

    // CR round 3, finding 3's own required test: a claimed name whose current content no longer matches
    // the fingerprint recorded at placement (edited AFTER Loom placed it, e.g. to add hooks) must be
    // scanned like any other non-Loom-owned content, never trusted on bare membership alone.
    const editedName = "edited-claimed-skill";
    writeSkill(cwd, editedName, "name: edited-claimed-skill\ndescription: clean at placement time\n");
    const staleFp = fingerprintSkillDir(path.join(cwd, ".claude", "skills", editedName)); // "recorded" at placement
    writeSkill(cwd, editedName, "name: edited-claimed-skill\nhooks:\n  Stop:\n"); // edited AFTER that recording
    const claimedFps2 = new Map([["loom-owned-skill", new Set([loomOwnedFp])], [editedName, new Set([staleFp])]]);
    const scanAfterEdit = scanCwdSkillsForPermissionFrontmatter(cwd, new Set(["loom-owned-skill", editedName]), claimedFps2);
    check("PART1-6f: a claimed name EDITED since its recorded fingerprint is NOT excluded — it IS flagged",
      scanAfterEdit.findings.some((f) => f.name === editedName && f.fields.includes("hooks")));
    check("PART1-6g: the OTHER claimed name (unedited, fingerprint still matches) stays excluded in the same call",
      !scanAfterEdit.findings.some((f) => f.name === "loom-owned-skill"));
    check("PART1-6h: a claimed name with NO fingerprint map at all (3rd arg omitted) cannot be verified and so is ALSO scanned — fail toward scanning, never toward trusting an unverifiable claim",
      scanCwdSkillsForPermissionFrontmatter(cwd, new Set(["loom-owned-skill"])).findings.some((f) => f.name === "loom-owned-skill"));

    // No .claude/skills dir at all — must return empty findings/truncated and never throw.
    const cwdEmpty = path.join(scratchRoot, `p1-empty-${sfx}`);
    fs.mkdirSync(cwdEmpty, { recursive: true });
    let threwOnMissing = false;
    let resultEmpty = null;
    try { resultEmpty = scanCwdSkillsForPermissionFrontmatter(cwdEmpty, []); } catch { threwOnMissing = true; }
    check("PART1-7: a cwd with no .claude/skills dir returns empty findings/truncated and never throws",
      !threwOnMissing && Array.isArray(resultEmpty?.findings) && resultEmpty.findings.length === 0 && Array.isArray(resultEmpty?.truncated) && resultEmpty.truncated.length === 0);
    check("PART1-7b: a missing .claude/skills dir (ENOENT) is a LEGITIMATE clean scan — incomplete:false (negative control for PART1-11/11a below)",
      resultEmpty?.incomplete === false);

    // CR round 4, item 2, shape 1: a non-ENOENT readdir error on the target dir itself. `.claude/skills`
    // is itself a FILE here (not a directory) — a real ENOTDIR, never ENOENT — so the scan genuinely
    // could not run and must never be reported the same way as PART1-7's verified-clean "missing dir".
    const cwdNotDir = path.join(scratchRoot, `p1-notdir-${sfx}`);
    fs.mkdirSync(path.join(cwdNotDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwdNotDir, ".claude", "skills"), "not a directory");
    const resultNotDir = scanCwdSkillsForPermissionFrontmatter(cwdNotDir, []);
    check("PART1-11: a non-ENOENT readdir error (ENOTDIR) never throws — still returns empty findings/truncated",
      Array.isArray(resultNotDir.findings) && resultNotDir.findings.length === 0 && Array.isArray(resultNotDir.truncated) && resultNotDir.truncated.length === 0);
    check("PART1-11a: ...and IS reported incomplete:true — the exact 'never treat a scan error as clean' gap item 2 closes",
      resultNotDir.incomplete === true);
    check("PART1-11b: card 22813c50 (M2) — incompleteEntries names the whole-dir failure (name:null) with a real errno",
      resultNotDir.incompleteEntries.length === 1 && resultNotDir.incompleteEntries[0].name === null
        && typeof resultNotDir.incompleteEntries[0].errno === "string" && resultNotDir.incompleteEntries[0].errno.length > 0);

    // CR round 4, item 2, shape 2: a SKILL.md that EXISTS but can't be READ — here, SKILL.md is itself a
    // DIRECTORY (a real EISDIR on read, not an ENOENT "no such file"). Must mark the scan incomplete,
    // never silently treated the same as "no SKILL.md under this entry."
    const cwdUnreadable = path.join(scratchRoot, `p1-unreadable-${sfx}`);
    const unreadableSkillDir = path.join(cwdUnreadable, ".claude", "skills", "unreadable-skill");
    fs.mkdirSync(path.join(unreadableSkillDir, "SKILL.md"), { recursive: true }); // SKILL.md as a DIR, not a file
    const resultUnreadable = scanCwdSkillsForPermissionFrontmatter(cwdUnreadable, []);
    check("PART1-12: a SKILL.md that exists but can't be read produces no finding for that name",
      !resultUnreadable.findings.some((f) => f.name === "unreadable-skill"));
    check("PART1-12a: ...and marks the scan incomplete:true — never silently folded into 'no SKILL.md there'",
      resultUnreadable.incomplete === true);
    check("PART1-12b: card 22813c50 (M2) — incompleteEntries names the one failing skill with a real errno",
      resultUnreadable.incompleteEntries.length === 1 && resultUnreadable.incompleteEntries[0].name === "unreadable-skill"
        && typeof resultUnreadable.incompleteEntries[0].errno === "string" && resultUnreadable.incompleteEntries[0].errno.length > 0);

    // Symlinked skill dir is never followed, even though its REAL target carries allowed-tools.
    const cwdLink = path.join(scratchRoot, `p1-link-${sfx}`);
    fs.mkdirSync(cwdLink, { recursive: true });
    const realTarget = path.join(scratchRoot, `p1-link-target-${sfx}`);
    writeSkill(realTarget, "real-skill", "name: real-skill\nallowed-tools: Bash(*)\n");
    fs.mkdirSync(path.join(cwdLink, ".claude", "skills"), { recursive: true });
    let symlinkMade = false;
    try {
      fs.symlinkSync(path.join(realTarget, ".claude", "skills", "real-skill"), path.join(cwdLink, ".claude", "skills", "linked-skill"), "junction");
      symlinkMade = true;
    } catch { /* no permission on this host — skip this one assertion, don't fail the whole run for an environment limit */ }
    if (symlinkMade) {
      const { findings: findingsLink } = scanCwdSkillsForPermissionFrontmatter(cwdLink, []);
      check("PART1-8: a symlinked/junctioned skill dir is never followed, even though its real target matches",
        !findingsLink.some((f) => f.name === "linked-skill"));
    } else {
      console.log("SKIP   PART1-8: symlink/junction creation not permitted on this host — assertion skipped, not failed");
    }

    // Truncated read: a SKILL.md whose frontmatter fields sit within the byte cap still matches even
    // though the file as a whole exceeds it (padding AFTER the closing --- fence, never inside it).
    // CR round 4, item 1: a big BODY past the cap, with a SMALL frontmatter that closed well within it,
    // must NOT be reported as a readBytes truncation — that used to fire on ANY oversized SKILL.md
    // (escalating to the owner on harmless repos: 11 of Loom's own 14 bundled skills are over 4 KB),
    // training the owner to ignore the alert and defeating "warn only". Only a frontmatter block that
    // itself didn't close within the read is the real missed-detection risk (PART1-9c below).
    const cwdBig = path.join(scratchRoot, `p1-big-${sfx}`);
    const bigDir = path.join(cwdBig, ".claude", "skills", "big-skill");
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(path.join(bigDir, "SKILL.md"), `---\nname: big-skill\nallowed-tools: Bash(*)\n---\n${"x".repeat(PERMISSION_SCAN_MAX_READ_BYTES * 3)}\n`);
    const { findings: findingsBig, truncated: truncatedBig, incomplete: incompleteBig } = scanCwdSkillsForPermissionFrontmatter(cwdBig, []);
    check("PART1-9: a file far larger than the read cap still matches when its frontmatter fields sit within the cap",
      findingsBig.some((f) => f.name === "big-skill" && f.fields.includes("allowed-tools")));
    check("PART1-9a: that same oversized file (small frontmatter, closed well within the cap) is NOT reported as a readBytes truncation — a big body alone never trips it",
      !truncatedBig.some((t) => t.cap === "readBytes" && t.names.includes("big-skill")));
    check("PART1-9a2: and the scan is NOT incomplete either — a big-body-small-frontmatter file is a genuinely clean, fully-verified read",
      incompleteBig === false);

    // CR round 4, item 1's own required test: Loom's own LARGEST bundled SKILL.md — a big body, normal
    // (small) frontmatter — must scan CLEAN, exactly the harmless-repo shape the finding names.
    const orchestrateSkillMd = path.join(__dirname, "..", "assets", "skills", "orchestrate", "SKILL.md");
    const orchestrateContent = fs.readFileSync(orchestrateSkillMd, "utf8");
    check("PART1-9a3: sanity — the real bundled orchestrate/SKILL.md is genuinely far larger than the read cap (proves this is testing the real oversized-file shape, not a fixture smaller than the cap)",
      orchestrateContent.length > PERMISSION_SCAN_MAX_READ_BYTES * 2);
    const cwdOrch = path.join(scratchRoot, `p1-orch-${sfx}`);
    const orchDir = path.join(cwdOrch, ".claude", "skills", "orchestrate-copy");
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(orchDir, "SKILL.md"), orchestrateContent);
    const { findings: findingsOrch, truncated: truncatedOrch, incomplete: incompleteOrch } = scanCwdSkillsForPermissionFrontmatter(cwdOrch, []);
    check("PART1-9a4: Loom's own largest bundled SKILL.md shape (big body, normal frontmatter) scans CLEAN — no finding, no truncation, not incomplete",
      !findingsOrch.some((f) => f.name === "orchestrate-copy") && !truncatedOrch.some((t) => t.names.includes("orchestrate-copy")) && incompleteOrch === false);

    // FORMER "named, accepted gap": a frontmatter block whose OWN closing fence sits past the read cap
    // used to be silently undetected. CR round 3, finding 1: it is STILL undetected (detectPermissionWidening's
    // own bound is unchanged — see the decision record) but is now LOUD via the same readBytes truncation,
    // so a reader is told to look closer rather than seeing a clean scan that missed something.
    const cwdHugeFm = path.join(scratchRoot, `p1-hugefm-${sfx}`);
    const hugeFmDir = path.join(cwdHugeFm, ".claude", "skills", "huge-frontmatter-skill");
    fs.mkdirSync(hugeFmDir, { recursive: true });
    const paddingKeys = Array.from({ length: 400 }, (_, i) => `padding-key-${i}: some filler value here\n`).join("");
    fs.writeFileSync(path.join(hugeFmDir, "SKILL.md"), `---\nname: huge-frontmatter-skill\n${paddingKeys}allowed-tools: Bash(*)\n---\nbody\n`);
    const { findings: findingsHugeFm, truncated: truncatedHugeFm } = scanCwdSkillsForPermissionFrontmatter(cwdHugeFm, []);
    check("PART1-9b: a frontmatter block whose OWN closing fence sits past the read cap still isn't DETECTED as allowed-tools/hooks (detectPermissionWidening's own bound, unchanged)",
      !findingsHugeFm.some((f) => f.name === "huge-frontmatter-skill"));
    check("PART1-9c: NO LONGER SILENT — that exact miss is now reported as a readBytes truncation naming the skill, replacing the old accepted-gap silence",
      truncatedHugeFm.some((t) => t.cap === "readBytes" && t.names.includes("huge-frontmatter-skill")));

    // Card 22813c50 (N1): an EMPTY frontmatter block (opening and closing fence on CONSECUTIVE lines, no
    // blank line between) whose file then runs well past the read cap used to be misreported as a
    // readBytes truncation — FRONTMATTER_RE could never match the empty block at all, of any size, so
    // frontmatterReadIncomplete always said "never closed" even though the (empty) block closed
    // immediately. Fixed; this proves the scan-level symptom the CR named is gone.
    const cwdEmptyFm = path.join(scratchRoot, `p1-emptyfm-${sfx}`);
    const emptyFmDir = path.join(cwdEmptyFm, ".claude", "skills", "empty-frontmatter-skill");
    fs.mkdirSync(emptyFmDir, { recursive: true });
    fs.writeFileSync(path.join(emptyFmDir, "SKILL.md"), `---\n---\n${"x".repeat(5000)}\n`);
    const { findings: findingsEmptyFm, truncated: truncatedEmptyFm, incomplete: incompleteEmptyFm } = scanCwdSkillsForPermissionFrontmatter(cwdEmptyFm, []);
    check("PART1-9d: card 22813c50 (N1) — an empty frontmatter block with a long body is NOT reported as a readBytes truncation",
      !truncatedEmptyFm.some((t) => t.names.includes("empty-frontmatter-skill")));
    check("PART1-9e: ...no finding either (an empty block has nothing to detect) and the scan is not incomplete",
      !findingsEmptyFm.some((f) => f.name === "empty-frontmatter-skill") && incompleteEmptyFm === false);

    // Entry-count cap: more directory entries than PERMISSION_SCAN_MAX_ENTRIES — the scan must not throw
    // and must not scan an unbounded number of them. Every entry here carries allowed-tools, so a HIGHER
    // finding count than the cap would prove the bound isn't being honored. CR round 3, finding 1: the
    // cap hit is itself now a loud "entries" truncation naming the skipped entries (bounded, with a true
    // skippedCount) — a hostile repo padding past the cap can no longer evade the scan silently.
    const cwdMany = path.join(scratchRoot, `p1-many-${sfx}`);
    // Skipped count (manyTotal - cap) deliberately EXCEEDS TRUNCATION_NAMES_MAX so PART1-10c below
    // actually exercises the names-list bound, not a count that happens to already fit under it.
    const manyTotal = PERMISSION_SCAN_MAX_ENTRIES + TRUNCATION_NAMES_MAX + 20;
    for (let i = 0; i < manyTotal; i++) {
      writeSkill(cwdMany, `many-${String(i).padStart(4, "0")}`, `name: many-${i}\nallowed-tools: Bash(*)\n`);
    }
    const { findings: findingsMany, truncated: truncatedMany } = scanCwdSkillsForPermissionFrontmatter(cwdMany, []);
    check(`PART1-10: a directory with more entries than PERMISSION_SCAN_MAX_ENTRIES (${PERMISSION_SCAN_MAX_ENTRIES}) is never scanned past that cap`,
      findingsMany.length <= PERMISSION_SCAN_MAX_ENTRIES);
    const entriesTrunc = truncatedMany.find((t) => t.cap === "entries");
    check("PART1-10a: the entry-count cap hit is itself reported (cap:'entries'), not swallowed", !!entriesTrunc);
    check("PART1-10b: its skippedCount carries the TRUE number skipped, even once names is bounded", entriesTrunc?.skippedCount === manyTotal - PERMISSION_SCAN_MAX_ENTRIES);
    check(`PART1-10c: names is bounded to TRUNCATION_NAMES_MAX (${TRUNCATION_NAMES_MAX}), never unboundedly large even when thousands of entries pad past the cap`,
      entriesTrunc?.names.length === Math.min(TRUNCATION_NAMES_MAX, manyTotal - PERMISSION_SCAN_MAX_ENTRIES));
    check("PART1-10d: a hostile skill padded PAST the cap (alphabetically last, 'zzz-evil') is named in the truncation — this is exactly the padding-evasion shape the finding closes",
      (() => {
        const cwdEvil = path.join(scratchRoot, `p1-evil-${sfx}`);
        for (let i = 0; i < PERMISSION_SCAN_MAX_ENTRIES; i++) writeSkill(cwdEvil, `aaa-${String(i).padStart(4, "0")}`, "name: pad\n");
        writeSkill(cwdEvil, "zzz-evil", "name: zzz-evil\nhooks:\n  Stop:\n");
        const r = scanCwdSkillsForPermissionFrontmatter(cwdEvil, []);
        const evilTrunc = r.truncated.find((t) => t.cap === "entries");
        return !r.findings.some((f) => f.name === "zzz-evil") && !!evilTrunc && evilTrunc.names.includes("zzz-evil");
      })());
  }

  // ===================================================================================================
  // PART 1b — card 712148f1 round 3, MAJOR 2: the scan's own vocabulary is now EXCLUDE-shaped (every
  // vector but the two shell forms disableSkillShellExecution already neutralizes), not an INCLUDE
  // allowlist of exactly "allowed-tools"/"hooks" — so a skill whose frontmatter trips ONLY
  // frontmatter-unrecognized (no allowed-tools/hooks key also independently labeled) must now surface a
  // real finding, where the OLD allowlist-shaped SCAN_FIELDS would have silently dropped it entirely
  // (zero findings for a skill the shared detector genuinely flagged).
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1b-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });

    // An explicit YAML key (`? ... : ...`) — unrelated to allowed-tools/hooks by NAME, so the old
    // allowlist-shaped SCAN_FIELDS reported NOTHING for this skill at all; it is now surfaced via the
    // frontmatter-unrecognized field.
    writeSkill(cwd, "unrecognized-fm-only", 'name: unrecognized-fm-only\n? weird-key\n: value\n');
    // A quoted allowed-tools key — BOTH a specific key label AND frontmatter-unrecognized, proving the
    // new field is additive alongside an already-caught one, not a replacement for it.
    writeSkill(cwd, "unrecognized-fm-plus-tools", 'name: unrecognized-fm-plus-tools\n"allowed-tools": Bash(*)\n');

    const { findings, truncated, incomplete } = scanCwdSkillsForPermissionFrontmatter(cwd, []);
    const byName = (n) => findings.find((f) => f.name === n);
    check("PART1b-1: a skill whose ONLY hazard is unrecognized frontmatter syntax is now a real finding "
        + "(the old allowlist-shaped SCAN_FIELDS would have reported ZERO findings here)",
      byName("unrecognized-fm-only")?.fields?.includes("frontmatter-unrecognized"));
    check("PART1b-1b: ...and carries NO allowed-tools/hooks label (it genuinely has neither)",
      !byName("unrecognized-fm-only")?.fields?.includes("allowed-tools") && !byName("unrecognized-fm-only")?.fields?.includes("hooks"));
    check("PART1b-2: a skill with BOTH a specific key AND unrecognized syntax reports both fields",
      byName("unrecognized-fm-plus-tools")?.fields?.includes("allowed-tools")
        && byName("unrecognized-fm-plus-tools")?.fields?.includes("frontmatter-unrecognized"));
    check("PART1b-3: nothing else about the scan broke — no truncation, not incomplete",
      truncated.length === 0 && incomplete === false);

    // isScannedPermissionField itself: the EXCLUDE-shaped predicate the scan's own filter now uses —
    // today's real vectors are all included, the two shell forms stay excluded (disableSkillShellExecution
    // already neutralizes them), and — the actual "future vector" proof — a SYNTHETIC vector id that
    // does not exist in today's SkillPermissionVector union at all is ALSO included by default. This is
    // what a runtime fixture for a real not-yet-invented vector cannot otherwise prove: the design is
    // EXCLUDE-shaped, so nothing here needs updating when SkillPermissionVector grows a new member.
    check("PART1b-4: today's real non-shell vectors are all included by isScannedPermissionField",
      isScannedPermissionField("allowed-tools") && isScannedPermissionField("hooks") && isScannedPermissionField("frontmatter-unrecognized"));
    check("PART1b-5: the two shell forms stay excluded",
      !isScannedPermissionField("shell-inline") && !isScannedPermissionField("shell-fenced"));
    check("PART1b-6: a SYNTHETIC vector id that does not exist in today's SkillPermissionVector union is "
        + "ALSO included by default — proves the filter is EXCLUDE-shaped, not an allowlist that would "
        + "silently drop a real future vector the way the old SCAN_FIELDS array did for frontmatter-unrecognized",
      isScannedPermissionField("some-future-vector-id"));
  }

  // ===================================================================================================
  // PART 1c — card 9d01b4c1: a BOM-prefixed SKILL.md must still produce a scan finding. Before the fix,
  // scanCwdSkillsForPermissionFrontmatter called detectPermissionWidening/frontmatterReadIncomplete on
  // the RAW head.content — a leading U+FEFF hid `---` from FRONTMATTER_OPEN_RE's start anchor, so these
  // two skills scanned as "clean" even though skill-permission-guard.mjs's refuse path already caught
  // the identical content.
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1c-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });
    const BOM = "﻿";

    function writeBomSkill(name, frontmatterBody, bodyText = "hello") {
      const dir = path.join(cwd, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `${BOM}---\n${frontmatterBody}---\n${bodyText}\n`);
    }

    writeBomSkill("bom-hooks-skill", "name: bom-hooks-skill\nhooks:\n  Stop:\n");
    // An explicit YAML key (`? ... : ...`) — unrecognized syntax, no allowed-tools/hooks label.
    writeBomSkill("bom-unrecognized-skill", "name: bom-unrecognized-skill\n? weird-key\n: value\n");

    const { findings: findings1c, truncated: truncated1c, incomplete: incomplete1c } =
      scanCwdSkillsForPermissionFrontmatter(cwd, []);
    const byName1c = (n) => findings1c.find((f) => f.name === n);
    check("PART1c-1: a BOM-prefixed hooks skill IS flagged with exactly that field",
      byName1c("bom-hooks-skill")?.fields?.length === 1 && byName1c("bom-hooks-skill").fields[0] === "hooks");
    check("PART1c-2: a BOM-prefixed unrecognized-syntax skill IS flagged as frontmatter-unrecognized",
      byName1c("bom-unrecognized-skill")?.fields?.includes("frontmatter-unrecognized"));
    check("PART1c-3: neither BOM fixture trips a truncation or marks the scan incomplete",
      truncated1c.length === 0 && incomplete1c === false);

    // Negative control: the SAME fixtures WITHOUT the BOM must still be flagged — proves the BOM is what
    // was defeating detection, not that these fixtures are unconditionally undetectable for some other
    // reason (e.g. a typo in the frontmatter shape).
    writeSkill(cwd, "nobom-hooks-skill", "name: nobom-hooks-skill\nhooks:\n  Stop:\n");
    writeSkill(cwd, "nobom-unrecognized-skill", "name: nobom-unrecognized-skill\n? weird-key\n: value\n");
    const { findings: findingsNoBom } = scanCwdSkillsForPermissionFrontmatter(cwd, []);
    check("PART1c-4 (negative control): the identical non-BOM hooks fixture is ALSO flagged",
      findingsNoBom.find((f) => f.name === "nobom-hooks-skill")?.fields?.includes("hooks"));
    check("PART1c-5 (negative control): the identical non-BOM unrecognized fixture is ALSO flagged",
      findingsNoBom.find((f) => f.name === "nobom-unrecognized-skill")?.fields?.includes("frontmatter-unrecognized"));

    // Card 9d01b4c1 round 3 / card 22813c50 — a DOUBLE-BOM hooks skill is NOT flagged: the static-scan
    // finding is that the real loader strips exactly ONE leading BOM, so a double-BOM file's frontmatter
    // is INERT there too (a leftover BOM still blocks its own `^---` test). Before dropping this scan's
    // own redundant caller-side pre-split, this fixture WOULD have been flagged (two strips total — the
    // caller's one plus the detector's own — reaching a clean `---` the real loader never reaches).
    function writeDoubleBomSkill(name, frontmatterBody, bodyText = "hello") {
      const dir = path.join(cwd, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `${BOM}${BOM}---\n${frontmatterBody}---\n${bodyText}\n`);
    }
    writeDoubleBomSkill("double-bom-hooks-skill", "name: double-bom-hooks-skill\nhooks:\n  Stop:\n");
    const { findings: findingsDoubleBom, incomplete: incompleteDoubleBom } = scanCwdSkillsForPermissionFrontmatter(cwd, []);
    check("PART1c-5a: a DOUBLE-BOM-prefixed hooks skill is NOT flagged — matches the real loader's own inert treatment",
      !findingsDoubleBom.some((f) => f.name === "double-bom-hooks-skill"));
    check("PART1c-5b: ...and the scan is not incomplete either (a double BOM is a clean miss, not an I/O error)",
      incompleteDoubleBom === false);

    // Card 9d01b4c1 round 2, MINOR: PART1c-1/2 above only ever exercise detectPermissionWidening's own
    // BOM split (both fixtures' frontmatter closes well within the read cap). frontmatterReadIncomplete's
    // OWN BOM split (the `head.truncated && frontmatterReadIncomplete(body)` branch in
    // scanCwdSkillsForPermissionFrontmatter) was never exercised with a BOM present — a BOM-led
    // frontmatter block whose closing fence sits past PERMISSION_SCAN_MAX_READ_BYTES must still surface as
    // a readBytes truncation, exactly like the non-BOM "huge-frontmatter-skill" fixture above (PART1-9b/9c).
    const bomHugeFmDir = path.join(cwd, ".claude", "skills", "bom-huge-frontmatter-skill");
    fs.mkdirSync(bomHugeFmDir, { recursive: true });
    const bomPaddingKeys = Array.from({ length: 400 }, (_, i) => `padding-key-${i}: some filler value here\n`).join("");
    fs.writeFileSync(path.join(bomHugeFmDir, "SKILL.md"), `${BOM}---\nname: bom-huge-frontmatter-skill\n${bomPaddingKeys}allowed-tools: Bash(*)\n---\nbody\n`);
    const { findings: findingsBomHugeFm, truncated: truncatedBomHugeFm } = scanCwdSkillsForPermissionFrontmatter(cwd, []);
    check("PART1c-6: a BOM-led frontmatter block whose own closing fence sits past the read cap still isn't DETECTED (detectPermissionWidening's own bound, unchanged)",
      !findingsBomHugeFm.some((f) => f.name === "bom-huge-frontmatter-skill"));
    check("PART1c-7: ...but IS reported as a readBytes truncation naming the skill — proves frontmatterReadIncomplete's own BOM split actually fires on this path too, not just detectPermissionWidening's",
      truncatedBomHugeFm.some((t) => t.cap === "readBytes" && t.names.includes("bom-huge-frontmatter-skill")));

    // Card 22813c50 round 2, mutant (c): `scanCwdSkillsForPermissionFrontmatter` must pass `head.content`
    // UNSPLIT to `frontmatterReadIncomplete` — never a caller-side pre-split on top of that function's
    // own internal one-BOM split. A DOUBLE-BOM frontmatter block past the read cap is inert to the real
    // loader (same reasoning as PART1c-5a/5b above) — a caller-side pre-split here would double-strip it
    // and wrongly report it as a readBytes truncation.
    const doubleBomHugeFmDir = path.join(cwd, ".claude", "skills", "double-bom-huge-frontmatter-skill");
    fs.mkdirSync(doubleBomHugeFmDir, { recursive: true });
    fs.writeFileSync(path.join(doubleBomHugeFmDir, "SKILL.md"), `${BOM}${BOM}---\nname: double-bom-huge-frontmatter-skill\n${bomPaddingKeys}allowed-tools: Bash(*)\n---\nbody\n`);
    const { findings: findingsDoubleBomHugeFm, truncated: truncatedDoubleBomHugeFm, incomplete: incompleteDoubleBomHugeFm } =
      scanCwdSkillsForPermissionFrontmatter(cwd, []);
    check("PART1c-8: a DOUBLE-BOM-led frontmatter block past the read cap is not DETECTED (matches the single-BOM case's own bound)",
      !findingsDoubleBomHugeFm.some((f) => f.name === "double-bom-huge-frontmatter-skill"));
    check("PART1c-9: ...and is NOT reported as a readBytes truncation either — matches the real loader's inert treatment of a double BOM, unlike the single-BOM PART1c-7 case above",
      !truncatedDoubleBomHugeFm.some((t) => t.cap === "readBytes" && t.names.includes("double-bom-huge-frontmatter-skill")));
    check("PART1c-10: ...and the scan is not incomplete either",
      incompleteDoubleBomHugeFm === false);
  }

  // ===================================================================================================
  // PART 1d — card 99f2ae1a: the installed CLI's own loader sees a live frontmatter block this scan's
  // own detector (via FRONTMATTER_OPEN_RE/FRONTMATTER_RE) either misses entirely or captures a different
  // body for. Written directly (not via `writeSkill`, which always emits a plain opening fence) so each
  // fixture's exact evasion shape lands byte-for-byte.
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1d-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });

    function writeRawSkill(name, raw) {
      const dir = path.join(cwd, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
    }

    writeRawSkill("fence-close-midline", "---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody");
    writeRawSkill("fence-open-nbsp", "--- \nname: x\nhooks:\n  Stop: []\n---\nbody");
    writeRawSkill("fence-open-crcr", "---\r\r\nname: x\nhooks:\n  Stop: []\n---\nbody");
    writeRawSkill("fence-open-second-bom", "---﻿\nname: x\nhooks:\n  Stop: []\n---\nbody");
    writeRawSkill("fence-open-vtab", "---\u000B\nname: x\nhooks:\n  Stop: []\n---\nbody");
    // Negative control: an ordinary, boring fence the scan already caught before this card — proves the
    // new check doesn't newly flag a shape it already handled correctly.
    writeSkill(cwd, "fence-ordinary-hooks", "name: fence-ordinary-hooks\nhooks:\n  Stop: []\n");

    const { findings: findings1d, truncated: truncated1d, incomplete: incomplete1d } =
      scanCwdSkillsForPermissionFrontmatter(cwd, []);
    const byName1d = (n) => findings1d.find((f) => f.name === n);
    for (const name of ["fence-close-midline", "fence-open-nbsp", "fence-open-crcr", "fence-open-second-bom", "fence-open-vtab"]) {
      check(`PART1d: ${name} IS flagged with frontmatter-fence-unrecognized`,
        byName1d(name)?.fields?.includes("frontmatter-fence-unrecognized"));
    }
    check("PART1d: the ordinary boring fence is flagged for its real hooks: key, NOT for its fence shape",
      byName1d("fence-ordinary-hooks")?.fields?.length === 1 && byName1d("fence-ordinary-hooks").fields[0] === "hooks");
    check("PART1d: none of the six fixtures trips a truncation or marks the scan incomplete",
      truncated1d.length === 0 && incomplete1d === false);
  }

  // ===================================================================================================
  // PART 1e — card 99f2ae1a, Code Review round 2 MAJOR: an evasion OPEN fence whose real-loader-visible
  // CLOSE sits past PERMISSION_SCAN_MAX_READ_BYTES used to report findings=[] AND truncated=[] — a
  // silent miss with NO signal anywhere, because `frontmatterFenceUnrecognized` never found a close
  // within the truncated head (nothing to disagree about) AND `frontmatterReadIncomplete` never saw the
  // evasion open at all (Loom's own narrower FRONTMATTER_OPEN_RE doesn't match it). Fixed by widening
  // `frontmatterReadIncomplete` itself — this PART proves the fix through the REAL scan, byte-capped read
  // included, not just the unit-level function.
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1e-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });

    function writeRawSkill(name, raw) {
      const dir = path.join(cwd, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
    }

    // Padding well past PERMISSION_SCAN_MAX_READ_BYTES (4096) before the closing fence, so the real read
    // head never reaches it — mirrors the huge-frontmatter-skill fixture's own padding shape above.
    const padding = "x".repeat(6000);
    writeRawSkill("fence-open-nbsp-past-cap", `--- \nname: a\nhooks:\n  Stop: []\ndescription: ${padding}\n---\nbody`);
    writeRawSkill("fence-open-crcr-past-cap", `---\r\r\nname: a\nhooks:\n  Stop: []\ndescription: ${padding}\n---\nbody`);
    // Negative control: the SAME padding shape with a PLAIN open fence already reports correctly before
    // this fix (PART1-9b/9c above) — proves the padding/cap shape itself is fine and isolates the evasion
    // open as the only variable.
    writeRawSkill("fence-open-plain-past-cap", `---\nname: a\nhooks:\n  Stop: []\ndescription: ${padding}\n---\nbody`);

    const { findings: findings1e, truncated: truncated1e, incomplete: incomplete1e } =
      scanCwdSkillsForPermissionFrontmatter(cwd, []);
    const byName1e = (n) => findings1e.find((f) => f.name === n);
    const truncNames1e = truncated1e.filter((t) => t.cap === "readBytes").flatMap((t) => t.names);
    for (const name of ["fence-open-nbsp-past-cap", "fence-open-crcr-past-cap", "fence-open-plain-past-cap"]) {
      check(`PART1e: ${name} is NOT detected (its closing fence sits past the read cap, same bound as PART1-9b)`,
        !byName1e(name));
      check(`PART1e: ${name} IS reported as a readBytes truncation — no longer a silent miss`,
        truncNames1e.includes(name));
    }
    check("PART1e: the scan is not incomplete either (a byte-capped read is a truncation, not an I/O error)",
      incomplete1e === false);
  }

  // ===================================================================================================
  // PART 1f — card 77571109 (99f2ae1a round 3): the OPENING fence LINE itself straddles
  // PERMISSION_SCAN_MAX_READ_BYTES before ever reaching its own `\n` — neither FRONTMATTER_OPEN_RE nor
  // REAL_LOADER_FENCE_OPEN_RE can match without one (both require a line terminator), so pre-fix this
  // returned findings=[] AND truncated=[] — a silent miss worse than PART1e's (there, the OPEN half was
  // at least seen; here nothing is). B4 pads the open fence's own line with plain spaces past the cap;
  // B4b does the same with NBSP (U+00A0) — both are `\s` to the real loader's recovered fence regex.
  // ===================================================================================================
  {
    const cwd = path.join(scratchRoot, `p1f-${sfx}`);
    fs.mkdirSync(cwd, { recursive: true });

    function writeRawSkill(name, raw) {
      const dir = path.join(cwd, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
    }

    const spacePad = " ".repeat(4200);
    writeRawSkill("open-fence-line-spaces-past-cap", `---${spacePad}\nhooks:\n  Stop: []\n---\nbody`); // B4
    const nbspPad = String.fromCharCode(0xa0).repeat(4200); // NBSP via an explicit escape, never a literal byte — an editor normalizing NBSP to a plain space would silently turn B4b into B4
    writeRawSkill("open-fence-line-nbsp-past-cap", `---${nbspPad}\nhooks:\n  Stop: []\n---\nbody`); // B4b

    const { findings: findings1f, truncated: truncated1f, incomplete: incomplete1f } =
      scanCwdSkillsForPermissionFrontmatter(cwd, []);
    const byName1f = (n) => findings1f.find((f) => f.name === n);
    const truncNames1f = truncated1f.filter((t) => t.cap === "readBytes").flatMap((t) => t.names);
    for (const name of ["open-fence-line-spaces-past-cap", "open-fence-line-nbsp-past-cap"]) {
      check(`PART1f: ${name} is NOT detected (its closing fence sits past the read cap, same bound as PART1e)`,
        !byName1f(name));
      check(`PART1f: ${name} IS reported as a readBytes truncation — no longer a silent miss (card 77571109)`,
        truncNames1f.includes(name));
    }
    check("PART1f: the scan is not incomplete either (a byte-capped read is a truncation, not an I/O error)",
      incomplete1f === false);
  }

  // ===================================================================================================
  // PART 2 — SessionService.handleSkillPermissionFrontmatterWarning: the durable event write
  // ===================================================================================================
  {
    const db = new Db();
    const proj = `skperm-proj-${sfx}`, agent = `skperm-ag-${sfx}`;
    const now = new Date().toISOString();
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const mkSession = (o) => db.insertSession({
      id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
      worktreePath: null, branch: null,
    });
    const ptyStub = {};
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const mgr = `skperm-mgr-${sfx}`, wkr = `skperm-wkr-${sfx}`, task = `skperm-task-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: task });
    sessions.handleSkillPermissionFrontmatterWarning(wkr, {
      role: "worker", scope: "<cwd>/.claude/skills",
      findings: [{ name: "sketchy-skill", fields: ["allowed-tools", "hooks"], contentHash: "hash-a" }],
    });
    const rows = db.listEventsForWorker(wkr).filter((e) => e.kind === "skill_permission_frontmatter_warning");
    check("PART2-1: exactly one skill_permission_frontmatter_warning event appended", rows.length === 1);
    check("PART2-2: filed under workerSessionId = the session itself, managerSessionId = its parent, taskId = its task",
      rows[0]?.workerSessionId === wkr && rows[0]?.managerSessionId === mgr && rows[0]?.taskId === task);
    check("PART2-3: detail carries role/scope/findings exactly as passed",
      rows[0]?.detail?.role === "worker" && rows[0]?.detail?.scope === "<cwd>/.claude/skills"
        && Array.isArray(rows[0]?.detail?.findings) && rows[0].detail.findings[0]?.name === "sketchy-skill"
        && rows[0].detail.findings[0]?.fields?.includes("allowed-tools") && rows[0].detail.findings[0]?.fields?.includes("hooks"));
    check("PART2-3b: contentHash is NEVER persisted onto the durable event's detail (dedupe-key-internal only)",
      !("contentHash" in (rows[0]?.detail?.findings?.[0] ?? {})));
    check("PART2-3c: a non-assistant role's detail never carries isRepeat at all (irrelevant to its classify() outcome)",
      !("isRepeat" in (rows[0]?.detail ?? {})));

    // A parentless session (no manager) — managerSessionId falls back to the session's own id, same
    // convention as every other no-manager-having event in this file (e.g. claude_boot_dialog_stuck).
    const assistantId = `skperm-asst-${sfx}`;
    mkSession({ id: assistantId, role: "assistant" });
    sessions.handleSkillPermissionFrontmatterWarning(assistantId, {
      role: "assistant", scope: "<cwd>/.claude/skills", findings: [{ name: "x", fields: ["hooks"], contentHash: "hash-b" }],
    });
    const rowsA = db.listEventsForWorker(assistantId).filter((e) => e.kind === "skill_permission_frontmatter_warning");
    check("PART2-4: a parentless (assistant) session files managerSessionId = its own id",
      rowsA.length === 1 && rowsA[0]?.managerSessionId === assistantId);

    // Throwing DB: the handler must swallow, never propagate back into the spawn-time call site.
    const throwingDb = {
      getSession() { throw new Error("boom"); },
      appendEvent() { throw new Error("boom"); },
    };
    const throwingSessions = new SessionService(throwingDb, ptyStub, new OrchestrationControl());
    let threw = false;
    try {
      throwingSessions.handleSkillPermissionFrontmatterWarning(wkr, { role: "worker", scope: "x", findings: [] });
    } catch { threw = true; }
    check("PART2-5: the handler does NOT throw when the DB-holding call throws", !threw);

    // CR round 3, finding 1/5: an entirely-clean call (no findings, no truncated) for a NON-assistant
    // role appends NO durable event at all — nothing to report, and no dedupe bookkeeping to do either.
    const wkr2 = `skperm-wkr2-${sfx}`;
    mkSession({ id: wkr2, role: "worker", parentSessionId: mgr, taskId: task });
    sessions.handleSkillPermissionFrontmatterWarning(wkr2, { role: "worker", scope: "<cwd>/.claude/skills", findings: [] });
    check("PART2-6: a clean (zero findings, zero truncated) call for a non-assistant role appends NO event",
      db.listEventsForWorker(wkr2).filter((e) => e.kind === "skill_permission_frontmatter_warning").length === 0);

    // CR round 3, finding 1: a TRUNCATION-only call (no real findings) still appends an event, and
    // detail.truncated carries it through — the Companion-facing escalation this card requires reads off
    // this same detail, so the field must actually reach the durable record, not just the host.ts call.
    const wkr3 = `skperm-wkr3-${sfx}`;
    mkSession({ id: wkr3, role: "worker", parentSessionId: mgr, taskId: task });
    sessions.handleSkillPermissionFrontmatterWarning(wkr3, {
      role: "worker", scope: "<cwd>/.claude/skills", findings: [],
      truncated: [{ cap: "entries", names: ["zzz-evil"], skippedCount: 1 }],
    });
    const rows3 = db.listEventsForWorker(wkr3).filter((e) => e.kind === "skill_permission_frontmatter_warning");
    check("PART2-7: a truncation-only call (no real findings) STILL appends exactly one event", rows3.length === 1);
    check("PART2-7b: detail.truncated carries the truncation through, exactly as passed",
      Array.isArray(rows3[0]?.detail?.truncated) && rows3[0].detail.truncated[0]?.cap === "entries" && rows3[0].detail.truncated[0]?.names?.includes("zzz-evil"));
  }

  // ===================================================================================================
  // PART 3 — the push dedupe (card 979f29b9): per (cwd, sorted {name,contentHash}[]), assistant only
  // ===================================================================================================
  {
    const db = new Db();
    const proj = `skdd-proj-${sfx}`, agent = `skdd-ag-${sfx}`;
    const now = new Date().toISOString();
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const sharedCwd = path.join(scratchRoot, `p3-repo-${sfx}`); // a stable repo path, same across "resumes"
    const mkSessionAt = (id, cwd) => db.insertSession({
      id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`, title: null, cwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "assistant", parentSessionId: null, taskId: null, worktreePath: null, branch: null,
    });
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const contentA = [{ name: "hooked-skill", fields: ["hooks"], contentHash: "sha-AAA" }];
    const contentAChanged = [{ name: "hooked-skill", fields: ["hooks"], contentHash: "sha-BBB" }]; // same name, DIFFERENT content

    // Spawn 1 of session X at sharedCwd — first sighting, never a repeat.
    const x1 = `skdd-x1-${sfx}`;
    mkSessionAt(x1, sharedCwd);
    sessions.handleSkillPermissionFrontmatterWarning(x1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    const rowX1 = db.listEventsForWorker(x1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-1: first sighting at a cwd is NEVER a repeat (isRepeat:false)", rowX1?.detail?.isRepeat === false);

    // Spawn 2 — a DIFFERENT session id (a resume/recycle mints a new one) but the SAME cwd and SAME
    // content: must dedupe (isRepeat:true), proving the key is per-cwd, not per-session-id.
    const x2 = `skdd-x2-${sfx}`;
    mkSessionAt(x2, sharedCwd);
    sessions.handleSkillPermissionFrontmatterWarning(x2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    const rowX2 = db.listEventsForWorker(x2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-2: SAME content, a DIFFERENT session id, SAME cwd (a resume/recycle shape) ⇒ isRepeat:true (deduped)",
      rowX2?.detail?.isRepeat === true);
    check("PART3-2b: the durable event still lands on the repeat too (kept per spawn, only the push is suppressed)",
      db.listEventsForWorker(x2).filter((e) => e.kind === "skill_permission_frontmatter_warning").length === 1);

    // Spawn 3 — same skill NAME, but its content (hash) CHANGED: must NOT dedupe.
    const x3 = `skdd-x3-${sfx}`;
    mkSessionAt(x3, sharedCwd);
    sessions.handleSkillPermissionFrontmatterWarning(x3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentAChanged });
    const rowX3 = db.listEventsForWorker(x3).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-3: CHANGED content (new contentHash for the same skill name) ⇒ isRepeat:false (re-alerts)",
      rowX3?.detail?.isRepeat === false);

    // Spawn 4 — back to the ORIGINAL content (contentA) after the change: must NOT dedupe against x1/x2
    // (the stored key is now x3's), proving this is a last-write comparison, not a historical set.
    const x4 = `skdd-x4-${sfx}`;
    mkSessionAt(x4, sharedCwd);
    sessions.handleSkillPermissionFrontmatterWarning(x4, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    const rowX4 = db.listEventsForWorker(x4).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-4: reverting to the PRIOR content after a change is itself a change vs. the LAST stored key ⇒ isRepeat:false",
      rowX4?.detail?.isRepeat === false);

    // A DIFFERENT cwd (a different repo) with the SAME content never dedupes against sharedCwd's key —
    // proves the key is scoped per-cwd, not a single global content set.
    const otherCwd = path.join(scratchRoot, `p3-other-repo-${sfx}`);
    const y1 = `skdd-y1-${sfx}`;
    mkSessionAt(y1, otherCwd);
    sessions.handleSkillPermissionFrontmatterWarning(y1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    const rowY1 = db.listEventsForWorker(y1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-5: the SAME content at a DIFFERENT cwd never dedupes against another repo's stored key",
      rowY1?.detail?.isRepeat === false);

    // CR round 3, finding 5: a CLEAN scan (zero findings) clears the stale dedupe key, so a LATER
    // re-appearance of the SAME content that was already alerted on once re-alerts rather than staying
    // deduped forever against a sighting from before the repo went clean.
    const cleanCycleCwd = path.join(scratchRoot, `p3-clean-cycle-${sfx}`);
    const z1 = `skdd-z1-${sfx}`;
    mkSessionAt(z1, cleanCycleCwd);
    sessions.handleSkillPermissionFrontmatterWarning(z1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-6: (clean-cycle) first sighting ⇒ isRepeat:false",
      db.listEventsForWorker(z1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const z2 = `skdd-z2-${sfx}`;
    mkSessionAt(z2, cleanCycleCwd);
    sessions.handleSkillPermissionFrontmatterWarning(z2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-6b: (clean-cycle) same content again ⇒ isRepeat:true (ordinary dedupe, confirmed BEFORE testing the clear)",
      db.listEventsForWorker(z2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);

    const z3 = `skdd-z3-${sfx}`;
    mkSessionAt(z3, cleanCycleCwd);
    sessions.handleSkillPermissionFrontmatterWarning(z3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [] });
    check("PART3-7: (clean-cycle) a CLEAN scan appends NO event and clears the stale key (no error)",
      db.listEventsForWorker(z3).filter((e) => e.kind === "skill_permission_frontmatter_warning").length === 0);

    const z4 = `skdd-z4-${sfx}`;
    mkSessionAt(z4, cleanCycleCwd);
    sessions.handleSkillPermissionFrontmatterWarning(z4, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-8: (clean-cycle) the SAME content reappearing AFTER a clean scan is NOT deduped (isRepeat:false) — the clean scan genuinely cleared the key",
      db.listEventsForWorker(z4).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    // A non-assistant role at the SAME cwd/content never even computes isRepeat (classify() doesn't need
    // it for that role — see classify()'s own test coverage in companion-attention-push.mjs).
    const w1 = `skdd-w1-${sfx}`;
    db.insertSession({
      id: w1, projectId: proj, agentId: agent, engineSessionId: `eng-${w1}`, title: null, cwd: sharedCwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker", parentSessionId: null, taskId: null, worktreePath: null, branch: null,
    });
    sessions.handleSkillPermissionFrontmatterWarning(w1, { role: "worker", scope: "<cwd>/.claude/skills", findings: contentA });
    const rowW1 = db.listEventsForWorker(w1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-9: a non-assistant role never carries isRepeat, even sharing an assistant's deduped cwd",
      !("isRepeat" in (rowW1?.detail ?? {})));

    // CR round 4, item 4: the TRUNCATION dedupe key is now content-aware (skippedCount + size/mtime) —
    // a hooked skill whose file keeps changing while still past the readBytes cap must keep re-alerting,
    // never dedupe forever against stale truncation metadata.
    const truncCwd = path.join(scratchRoot, `p3-trunc-${sfx}`);
    const truncV1 = [{ cap: "readBytes", names: ["huge-hooked-skill"], size: 50000, mtimeMs: 1000 }];
    const truncV1Again = [{ cap: "readBytes", names: ["huge-hooked-skill"], size: 50000, mtimeMs: 1000 }]; // same values, fresh object
    const truncV2 = [{ cap: "readBytes", names: ["huge-hooked-skill"], size: 50500, mtimeMs: 2000 }]; // file CHANGED

    const t1 = `skdd-t1-${sfx}`;
    mkSessionAt(t1, truncCwd);
    sessions.handleSkillPermissionFrontmatterWarning(t1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], truncated: truncV1 });
    check("PART3-T1: first sighting of a readBytes truncation ⇒ isRepeat:false",
      db.listEventsForWorker(t1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const t2 = `skdd-t2-${sfx}`;
    mkSessionAt(t2, truncCwd);
    sessions.handleSkillPermissionFrontmatterWarning(t2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], truncated: truncV1Again });
    check("PART3-T2: the SAME truncation metadata (size/mtime unchanged) ⇒ isRepeat:true (deduped)",
      db.listEventsForWorker(t2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);

    const t3 = `skdd-t3-${sfx}`;
    mkSessionAt(t3, truncCwd);
    sessions.handleSkillPermissionFrontmatterWarning(t3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], truncated: truncV2 });
    check("PART3-T3: the file CHANGED (size/mtime differ) while STILL past the cap ⇒ isRepeat:false — re-alerts, not deduped against stale metadata",
      db.listEventsForWorker(t3).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    // Same content-awareness for the "entries" cap's own skippedCount (previously dropped from the key
    // entirely — only `cap`+`names` were hashed).
    const entCwd = path.join(scratchRoot, `p3-ent-${sfx}`);
    const entV1 = [{ cap: "entries", names: ["zzz-evil"], skippedCount: 5 }];
    const entV2 = [{ cap: "entries", names: ["zzz-evil"], skippedCount: 6 }]; // more entries padded in since

    const e1 = `skdd-e1-${sfx}`;
    mkSessionAt(e1, entCwd);
    sessions.handleSkillPermissionFrontmatterWarning(e1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], truncated: entV1 });
    check("PART3-E1: first sighting of an entries truncation ⇒ isRepeat:false",
      db.listEventsForWorker(e1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const e2 = `skdd-e2-${sfx}`;
    mkSessionAt(e2, entCwd);
    sessions.handleSkillPermissionFrontmatterWarning(e2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], truncated: entV2 });
    check("PART3-E2: skippedCount CHANGED (same name/cap, more entries now padded in) ⇒ isRepeat:false — the count change alone defeats the old dedupe",
      db.listEventsForWorker(e2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    // CR round 4, item 2: an INCOMPLETE scan never clears, and never updates, the stored dedupe key —
    // and always surfaces (isRepeat:false), since it never genuinely re-verified the repo.
    const incCwd = path.join(scratchRoot, `p3-inc-${sfx}`);
    const i1 = `skdd-i1-${sfx}`;
    mkSessionAt(i1, incCwd);
    sessions.handleSkillPermissionFrontmatterWarning(i1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-I1: (incomplete-dedupe setup) first REAL sighting of contentA at this cwd ⇒ isRepeat:false",
      db.listEventsForWorker(i1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const i2 = `skdd-i2-${sfx}`;
    mkSessionAt(i2, incCwd);
    sessions.handleSkillPermissionFrontmatterWarning(i2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true });
    const rowI2 = db.listEventsForWorker(i2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0];
    check("PART3-I2: an INCOMPLETE scan (zero findings) still files an event — never treated as the clean no-op",
      !!rowI2);
    check("PART3-I2b: ...and isRepeat:false (an incomplete scan never dedupes, always surfaces)",
      rowI2?.detail?.isRepeat === false);
    check("PART3-I2c: ...and detail.incomplete:true is carried through",
      rowI2?.detail?.incomplete === true);

    const i3 = `skdd-i3-${sfx}`;
    mkSessionAt(i3, incCwd);
    sessions.handleSkillPermissionFrontmatterWarning(i3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-I3: the SAME real content (contentA) reappearing right after an incomplete scan DEDUPES (isRepeat:true) — proving i2's incomplete scan did NOT clear i1's real stored baseline (the bug this item fixes would have cleared it on i2, making this a false 'first sighting' again)",
      db.listEventsForWorker(i3).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);

    const i4 = `skdd-i4-${sfx}`;
    mkSessionAt(i4, incCwd);
    sessions.handleSkillPermissionFrontmatterWarning(i4, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentAChanged });
    check("PART3-I4: genuinely CHANGED real content right after that ⇒ isRepeat:false — ordinary dedupe still correctly discriminates a real change, undisturbed by the incomplete scan that passed through in between",
      db.listEventsForWorker(i4).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    // Card 22813c50 (M2): an incomplete scan now dedupes on ITS OWN key (`skill-perm-incomplete-last:*`),
    // separate from the findings-baseline key above — a STABLE I/O condition must stop re-pushing on every
    // resume, but a CHANGED one, or a later recurrence after a genuinely complete scan, must still re-alert.
    const inc2Cwd = path.join(scratchRoot, `p3-inc2-${sfx}`);
    const entriesV1 = [{ name: "flaky-skill", errno: "EACCES" }];
    const entriesV2 = [{ name: "flaky-skill", errno: "EBUSY" }]; // same name, DIFFERENT errno

    const j1 = `skdd-j1-${sfx}`;
    mkSessionAt(j1, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesV1 });
    check("PART3-J1: first sighting of this incomplete condition ⇒ isRepeat:false",
      db.listEventsForWorker(j1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const j2 = `skdd-j2-${sfx}`;
    mkSessionAt(j2, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesV1 });
    check("PART3-J2: the IDENTICAL incomplete condition again ⇒ isRepeat:true — the M2 fix: a stable I/O error no longer re-pushes every resume",
      db.listEventsForWorker(j2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);

    const j3 = `skdd-j3-${sfx}`;
    mkSessionAt(j3, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesV2 });
    check("PART3-J3: the errno CHANGED (same name) ⇒ isRepeat:false — a genuinely different failure still re-alerts",
      db.listEventsForWorker(j3).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const j4 = `skdd-j4-${sfx}`;
    mkSessionAt(j4, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j4, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [] });
    check("PART3-J4: a genuinely CLEAN+COMPLETE scan right after ⇒ no event (and clears the incomplete baseline)",
      db.listEventsForWorker(j4).filter((e) => e.kind === "skill_permission_frontmatter_warning").length === 0);

    const j5 = `skdd-j5-${sfx}`;
    mkSessionAt(j5, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j5, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesV2 });
    check("PART3-J5: the SAME incomplete condition (entriesV2) recurring AFTER a clean scan ⇒ isRepeat:false — 'clear it on the next complete scan' means it must NOT stay deduped against j3's old baseline",
      db.listEventsForWorker(j5).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const j6 = `skdd-j6-${sfx}`;
    mkSessionAt(j6, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j6, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA });
    check("PART3-J6: a REAL finding right after an incomplete scan is reported with its own isRepeat, undisturbed by the incomplete-only key (proves the two keys never cross-contaminate)",
      db.listEventsForWorker(j6).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    // Card 22813c50 round 2, mutant (e): j6 above (incomplete:false, WITH a real finding) must go
    // through the "complete" branch's own `this.db.deleteMeta(incompleteKey)` — the SAME unconditional
    // clear a clean scan gets — not just through the all-clean early-return. If that clear were ever
    // dropped from the complete-WITH-findings branch specifically, j5's stale entriesV2 baseline would
    // still be sitting in `incompleteKey`, and the SAME incomplete condition recurring right after j6
    // would wrongly dedupe against it instead of surfacing as a fresh sighting.
    const j7 = `skdd-j7-${sfx}`;
    mkSessionAt(j7, inc2Cwd);
    sessions.handleSkillPermissionFrontmatterWarning(j7, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesV2 });
    check("PART3-J7: the SAME incomplete condition (entriesV2) recurring right after j6's complete-WITH-findings scan ⇒ isRepeat:false — j6 must have cleared the incomplete baseline too, not just a genuinely clean scan",
      db.listEventsForWorker(j7).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);
  }

  // ===================================================================================================
  // PART 3b — card 22813c50 round 2 (the blocking MAJOR, owner decision f635bad6 "warn loudly"): an
  // INCOMPLETE scan that ALSO carries a NEW real finding or truncation must NEVER be suppressed as a
  // repeat merely because the incomplete condition itself repeated. Before this fix, `isRepeat` for the
  // `incomplete` branch was computed from the incomplete-entries key alone — a stale baseline match
  // would silently swallow a genuinely new, real finding arriving in the SAME call.
  // ===================================================================================================
  {
    const db = new Db();
    const proj = `skmj-proj-${sfx}`, agent = `skmj-ag-${sfx}`;
    const now = new Date().toISOString();
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const majorCwd = path.join(scratchRoot, `p3b-major-${sfx}`);
    const mkSessionAt = (id) => db.insertSession({
      id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`, title: null, cwd: majorCwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "assistant", parentSessionId: null, taskId: null, worktreePath: null, branch: null,
    });
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const entriesM = [{ name: "flaky-skill", errno: "EACCES" }];
    const contentA = [{ name: "hooked-skill", fields: ["hooks"], contentHash: "sha-AAA" }];
    const truncM = [{ cap: "readBytes", names: ["huge-skill"] }];

    const m1 = `skmj-m1-${sfx}`;
    mkSessionAt(m1);
    sessions.handleSkillPermissionFrontmatterWarning(m1, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesM });
    check("PART3-M1: first sighting of this incomplete condition ⇒ isRepeat:false",
      db.listEventsForWorker(m1).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const m2 = `skmj-m2-${sfx}`;
    mkSessionAt(m2);
    sessions.handleSkillPermissionFrontmatterWarning(m2, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesM });
    check("PART3-M2: (precondition) the IDENTICAL incomplete condition alone, no findings/truncation ⇒ isRepeat:true — confirms the baseline genuinely matches before testing the interaction below",
      db.listEventsForWorker(m2).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);

    const m3 = `skmj-m3-${sfx}`;
    mkSessionAt(m3);
    sessions.handleSkillPermissionFrontmatterWarning(m3, { role: "assistant", scope: "<cwd>/.claude/skills", findings: contentA, incomplete: true, incompleteEntries: entriesM });
    check("PART3-M3 (THE MAJOR FIX): the SAME incomplete condition, but this call ALSO carries a NEW real finding ⇒ isRepeat:false — must be pushed loudly, never deduped just because the incomplete-entries key alone still matches",
      db.listEventsForWorker(m3).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const m4 = `skmj-m4-${sfx}`;
    mkSessionAt(m4);
    sessions.handleSkillPermissionFrontmatterWarning(m4, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesM, truncated: truncM });
    check("PART3-M4: same shape, but with a NEW truncation instead of a finding ⇒ isRepeat:false — truncated must defeat the dedupe exactly like findings does",
      db.listEventsForWorker(m4).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === false);

    const m5 = `skmj-m5-${sfx}`;
    mkSessionAt(m5);
    sessions.handleSkillPermissionFrontmatterWarning(m5, { role: "assistant", scope: "<cwd>/.claude/skills", findings: [], incomplete: true, incompleteEntries: entriesM });
    check("PART3-M5: back to the bare incomplete condition alone (no findings/truncation) ⇒ isRepeat:true — the incomplete-entries baseline itself was never overwritten by m3/m4's own findings/truncated, proving `metaKey` (and the dedupe write) stayed untouched by the comparison-only read",
      db.listEventsForWorker(m5).filter((e) => e.kind === "skill_permission_frontmatter_warning")[0]?.detail?.isRepeat === true);
  }

  // ===================================================================================================
  // PART 4 — CR round 4, item 3: the REAL injectSkills, proving a forged on-disk manifest+fingerprints
  // sidecar for an "evil" skill cannot make the scan trust it, while a GENUINE same-process placement
  // still IS correctly excluded (the fix must not simply make every claimed name unconditionally scanned).
  // ===================================================================================================
  {
    fs.mkdirSync(path.join(tmpHome, "skills"), { recursive: true }); // the global skills STORE (SKILLS_DIR)

    // --- 4a: a REAL placement, through THIS process's own injectSkills, is genuinely excluded ---------
    const legitStoreDir = path.join(tmpHome, "skills", "legit-skill");
    fs.mkdirSync(legitStoreDir, { recursive: true });
    fs.writeFileSync(path.join(legitStoreDir, "SKILL.md"), "---\nname: legit-skill\nallowed-tools: Bash(*)\n---\nbody\n");
    const cwdLegit = path.join(scratchRoot, `p4-legit-${sfx}`);
    const legitSid = `legit-sid-${sfx}`;
    const legitResult = injectSkills(cwdLegit, legitSid, ["legit-skill"], null, false, () => true);
    check("PART4a-1: a genuinely placed skill's fingerprint IS recorded in the daemon-side registry (precondition for the exclusion below)",
      legitResult.claimedFingerprints.has("legit-skill"));
    const legitScan = scanCwdSkillsForPermissionFrontmatter(cwdLegit, legitResult.claimedNames, legitResult.claimedFingerprints);
    check("PART4a-2: ...and end-to-end, the scan does NOT flag it, even though its frontmatter carries allowed-tools",
      !legitScan.findings.some((f) => f.name === "legit-skill"));

    // --- 4b: a FORGED on-disk manifest+fingerprints sidecar for an "evil" skill cannot fool the scan ---
    const cwdEvil = path.join(scratchRoot, `p4-forge-${sfx}`);
    const evilSkillsDir = path.join(cwdEvil, ".claude", "skills");
    const evilDir = path.join(evilSkillsDir, "evil-skill");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "SKILL.md"), "---\nname: evil-skill\nhooks:\n  Stop:\n---\nbody\n");
    const evilFp = fingerprintSkillDir(evilDir); // the attacker has full read access too — computes this correctly
    const forgedSid = `forged-sid-${sfx}`;
    fs.writeFileSync(path.join(evilSkillsDir, ".loom-skills.json"), JSON.stringify({ [forgedSid]: ["evil-skill"] }));
    fs.writeFileSync(path.join(evilSkillsDir, ".loom-skills-fingerprints.json"), JSON.stringify({ [forgedSid]: { "evil-skill": evilFp } }));

    const evilResult = injectSkills(cwdEvil, `real-sid-${sfx}`, [], null, false, () => true);
    check("PART4b-1: the forged sid's claim IS carried into claimedNames — the forgery landed, not pre-filtered away",
      evilResult.claimedNames.includes("evil-skill"));
    check("PART4b-2: but claimedFingerprints has NO entry for it — this daemon process never placed it, so the daemon-side registry has nothing to say",
      !evilResult.claimedFingerprints.has("evil-skill"));
    const evilScan = scanCwdSkillsForPermissionFrontmatter(cwdEvil, evilResult.claimedNames, evilResult.claimedFingerprints);
    check("PART4b-3: STILL FLAGGED — a forged manifest+fingerprints sidecar cannot make the scan trust 'evil-skill' as Loom's own",
      evilScan.findings.some((f) => f.name === "evil-skill" && f.fields.includes("hooks")));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the cwd-skill permission scan is bounded/correct and the durable event appends exactly as designed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
