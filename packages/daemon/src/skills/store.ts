import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diff3Merge } from "node-diff3";
import type { SkillSummary } from "@loom/shared";
import { SKILLS_DIR, SKILL_BASE_DIR } from "../paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> daemon root -> assets/skills. Overridable via LOOM_ASSET_SKILLS so hermetic tests can
// point the bundled-asset side at a temp dir (publish writes here — never the real repo asset in a test).
const ASSET_SKILLS = process.env.LOOM_ASSET_SKILLS || path.join(__dirname, "..", "..", "assets", "skills");

/**
 * CRUD over the Loom skill store (~/.loom/skills). A skill is a directory with a SKILL.md playbook;
 * the editable unit IS that SKILL.md (frontmatter `name`/`description` + body). The daemon owns the
 * filesystem; injectSkills() mirrors the store into each session at spawn, so edits apply next spawn.
 */

// Skill names are kebab slugs — also the directory name, so this guards against path traversal.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

const skillMd = (name: string): string => path.join(SKILLS_DIR, name, "SKILL.md");

/** Atomic file write (tmp + rename) — the store's durability idiom, shared by the companion skill store. */
export function atomicWriteFile(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Parse `description:` out of a SKILL.md frontmatter block (empty string if absent). */
export function descriptionOf(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1]?.match(/^description:\s*(.*)$/m);
  return (m?.[1] ?? "").trim();
}

function bundledNames(): Set<string> {
  try {
    return new Set(fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  } catch { return new Set(); }
}

/**
 * True when `name` is a Loom-bundled/shipped skill (a dir in the asset set) — i.e. NOT a user-created
 * skill. LOAD-BEARING for the ungated `loom-setup` surface: `skill_write` there is bounded STRICTLY to
 * the USER skill store, so it rejects any bundled name (it must never touch the bundled/dev skill set —
 * the human Skills UI owns reset/publish of those). Computed live from ASSET_SKILLS so it reflects
 * exactly the skills shipped to this install (dev sees platform-* too; end users do not).
 */
export function isBundledSkill(name: string): boolean {
  return bundledNames().has(name);
}

const assetMd = (name: string): string => path.join(ASSET_SKILLS, name, "SKILL.md");
// The `base` snapshot lives as a flat <name>.md OUTSIDE SKILLS_DIR (see paths.ts › SKILL_BASE_DIR) so
// inject.ts (which mirrors the skill DIR) never copies it and listSkills/seed never treat it as a skill.
const baseFile = (name: string): string => path.join(SKILL_BASE_DIR, `${name}.md`);

function readFileOrNull(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** Atomic write of `name`'s base snapshot (tmp+rename), creating SKILL_BASE_DIR if needed. */
function writeBase(name: string, content: string): void {
  fs.mkdirSync(SKILL_BASE_DIR, { recursive: true });
  atomicWriteFile(baseFile(name), content);
}

// --- Per-file (references/**, scripts/**, …) tracking ----------------------------------------------
// Everything above tracks ONLY SKILL.md. A skill dir can carry other files (reference docs, helper
// scripts, a NOTICE) that seed.ts backfills seed-if-absent (cpSync force:false) and then never touches
// again — an edit to an already-seeded one of these never reached an existing install (board card
// 75a0755d). The functions below extend base-snapshot tracking to the WHOLE skill directory so those
// files fast-forward too, on the same pristine-only, never-clobber terms as SKILL.md.
//
// Base snapshots for these files live at SKILL_BASE_DIR/<name>/<relPath>, mirroring the skill's own
// tree — a SIBLING of the flat <name>.md used for SKILL.md's base, never colliding with it (one is a
// file, the other a directory) and never re-injected (SKILL_BASE_DIR is outside SKILLS_DIR).
//
// Pre-fast-forward backups (the one-time safety net below) live under a reserved
// SKILL_BASE_DIR/.pre-ff-backups/<name>/<relPath> namespace — `.pre-ff-backups` can never collide with
// a real skill name (NAME_RE forbids a leading dot).
const FILE_BASE_ROOT = SKILL_BASE_DIR;
const PRE_FF_BACKUP_ROOT = path.join(SKILL_BASE_DIR, ".pre-ff-backups");
const toOsPath = (root: string, name: string, relPath: string): string => path.join(root, name, ...relPath.split("/"));
const storeExtraFile = (name: string, relPath: string): string => toOsPath(SKILLS_DIR, name, relPath);
const assetExtraFile = (name: string, relPath: string): string => toOsPath(ASSET_SKILLS, name, relPath);
const fileBasePath = (name: string, relPath: string): string => toOsPath(FILE_BASE_ROOT, name, relPath);
const fileBackupPath = (name: string, relPath: string): string => toOsPath(PRE_FF_BACKUP_ROOT, name, relPath);

/** Recursively list files under `root` as POSIX-style relative paths ("references/foo.md"). Missing/
 *  unreadable dir → []. Used to enumerate a skill's non-SKILL.md files on both the store and asset side. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  rec(root, "");
  return out;
}

/** Every non-SKILL.md relative file path for a bundled skill, from the STORE side only. Walking the
 *  asset side too would be redundant here: every call site below (customization state, base backfill,
 *  advance) reads `mine` from the store FIRST and bails to a no-op the instant it's missing — and by
 *  the time any of these run, seed.ts's cpSync(force:false) has already copied a brand-new asset file
 *  into the store, so an asset-only path (not yet copied) would never do anything but add a redundant
 *  directory walk per skill per call. A store-only path (removed from a later bundle) still enumerates
 *  correctly — see the deletions note on advancePristineExtraFiles. */
function extraFileRelPaths(name: string): string[] {
  return walkFiles(path.join(SKILLS_DIR, name)).filter((p) => p !== "SKILL.md").sort();
}

/** Heuristic binary-file sniff (a NUL byte in the first 8KB — the same signal git/most tools use).
 *  Reading a binary file as utf8 (as every other function in this module does) mangles it into
 *  replacement characters on the very first read; writing that back would corrupt the store file AND
 *  the "recoverable" backup with the SAME mangled bytes, defeating the safety net exactly when it's
 *  needed. Only reachable via extraFileRelPaths (references/scripts/…, never SKILL.md), so this is
 *  purely a latent-future guard — no bundled skill ships a binary file today — not a proper binary FF
 *  path: a binary file is simply left alone (never tracked, compared, or advanced), same "leave it"
 *  posture as a file with no shipped counterpart. Unreadable path → false (let the normal
 *  readFileOrNull path decide; nothing to sniff). */
function isBinaryFile(p: string): boolean {
  let fd: number;
  try { fd = fs.openSync(p, "r"); } catch { return false; }
  try {
    const buf = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; } finally { fs.closeSync(fd); }
}

/**
 * base/mine/shipped for ONE non-SKILL.md file of a bundled skill. Unlike threeVersions (SKILL.md,
 * missing base ?? SHIPPED — conservative, because a real edit surface exists for SKILL.md via the
 * Skills UI), a missing base here falls back to `mine`: every skill write route (`PUT/POST
 * /api/skills/:name`, `/adopt`, `/reset`, `/publish`) reads/writes SKILL.md only, so NO product surface
 * can ever edit a reference doc or helper script file — on-disk drift here can only be an old seed,
 * never a legitimate edit. Falling back to `mine` records "last synced" accurately instead of permanently
 * freezing already-stale content as customized (which `?? shipped` would do). null when there's no
 * store copy (nothing to compare), no shipped counterpart (removed from the bundle — see the deletions
 * note below; leave the store file alone rather than comparing it to nothing), or either side looks
 * binary (see isBinaryFile — leave it alone rather than risk a utf8-mangled read/write).
 */
function fileThreeVersions(name: string, relPath: string): { base: string; mine: string; shipped: string } | null {
  const storePath = storeExtraFile(name, relPath);
  if (isBinaryFile(storePath)) return null;
  const mine = readFileOrNull(storePath);
  if (mine == null) return null;
  const assetPath = assetExtraFile(name, relPath);
  if (isBinaryFile(assetPath)) return null;
  const shipped = readFileOrNull(assetPath);
  if (shipped == null) return null;
  const base = readFileOrNull(fileBasePath(name, relPath)) ?? mine;
  return { base, mine, shipped };
}

/** Write `content` as one file's base snapshot (tmp+rename via atomicWriteFile, creating parent dirs as
 *  needed) — the per-file analog of writeBase, shared by seedFileBaseSnapshots (base := mine, first
 *  sight), advanceExtraFile (base := shipped, on fast-forward), and resetSkillToBundled (base := shipped,
 *  on explicit discard — see its own doc for why the WHOLE directory's bases must move together). */
function writeFileBaseSnapshot(name: string, relPath: string, content: string): void {
  const basePath = fileBasePath(name, relPath);
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  atomicWriteFile(basePath, content);
}

/**
 * Backfill the per-file `base` snapshot for every bundled skill's non-SKILL.md files that have none —
 * seed-if-absent, mirrors seedBaseSnapshots but base := MINE (see fileThreeVersions' doc for why: no
 * edit surface exists for these files, so the current store content IS an accurate "last synced" point,
 * unlike SKILL.md where base := shipped is the safe read). Called from seedGlobalSkills() at boot,
 * AFTER seedBaseSnapshots() (ordering is not load-bearing between the two, but mirrors it) and BEFORE
 * autoFastForwardPristineSkills() (base must exist for that equality to mean anything).
 *
 * Runs before the DB even opens, across the WHOLE store (every bundled skill's every file) — a wider
 * surface than the single-file-per-skill seedBaseSnapshots, so a per-skill try/catch here is NOT
 * optional the way it might look by parity: one bad file (a permission error, a weird special file)
 * must not take the whole boot sequence down with it. Returns "name/relPath" for every file backfilled.
 */
export function seedFileBaseSnapshots(): string[] {
  const seeded: string[] = [];
  for (const name of bundledNames()) {
    try {
      for (const relPath of extraFileRelPaths(name)) {
        const basePath = fileBasePath(name, relPath);
        if (fs.existsSync(basePath)) continue; // already snapshotted — never clobber (seed-if-absent)
        const storePath = storeExtraFile(name, relPath);
        if (isBinaryFile(storePath)) continue; // leave binary files untracked — see isBinaryFile's doc
        const mine = readFileOrNull(storePath);
        if (mine == null) continue; // not (yet) in the store — nothing to snapshot
        if (readFileOrNull(assetExtraFile(name, relPath)) == null) continue; // no shipped counterpart —
        // removed from the bundle (the deletions policy): leave it alone COMPLETELY, not just
        // untouched-but-tracked — recording a base for a file we'll never compare against again is
        // pointless disk churn and confusing state, not merely inert.
        writeFileBaseSnapshot(name, relPath, mine);
        seeded.push(`${name}/${relPath}`);
      }
    } catch { /* best-effort per skill — a bad file must never break boot */ }
  }
  return seeded;
}

/**
 * Advance ONE non-SKILL.md file to `shipped`, first taking a ONE-TIME backup of what's about to be
 * overwritten (SKILL_BASE_DIR/.pre-ff-backups/<name>/<relPath>) if — and only if — no backup exists yet
 * for this exact file. This is the recoverability net for the one residual risk in the base:=mine
 * backfill above: if a file's on-disk content before this fix shipped happened to be a rare, out-of-
 * band hand-edit (no product surface makes this possible, but the file is still just a plain file on
 * disk) rather than genuine staleness, the pre-overwrite content is never lost — it's one rename away
 * under .pre-ff-backups. The backup is written ONCE per file, ever: a file that's already been through
 * one fast-forward has no more "was this actually customized" ambiguity to hedge against on the next.
 */
function advanceExtraFile(name: string, relPath: string, shipped: string): void {
  const backupPath = fileBackupPath(name, relPath);
  if (!fs.existsSync(backupPath)) {
    const current = readFileOrNull(storeExtraFile(name, relPath));
    if (current != null) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      atomicWriteFile(backupPath, current);
    }
  }
  const storePath = storeExtraFile(name, relPath);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  atomicWriteFile(storePath, shipped);
  writeFileBaseSnapshot(name, relPath, shipped);
}

/**
 * Advance every PRISTINE, out-of-date non-SKILL.md file of a bundled skill to shipped — the reference/
 * script analog of the SKILL.md fast-forward, gated PER FILE (not per skill): a skill whose SKILL.md is
 * customized can still have a reference file advance, and vice versa, because there is no single
 * "is this skill pristine" bit that means anything across a multi-file directory. Called from both
 * autoFastForwardPristineSkills (boot) and adoptSkillUpdate (the manual "Adopt update" UI action) — the
 * "normal update path" for a bundled skill in both cases.
 *
 * Deletions: a store file whose bundle counterpart is gone (fileThreeVersions returns null) is left
 * exactly where it is — never removed. Safer default: a file Loom no longer ships may still be in use
 * (e.g. cross-referenced from SKILL.md prose), and there is no UI signal yet to tell a stale leftover
 * from a deliberately-kept one.
 *
 * Returns the relPaths advanced, and logs one line per file so a post-deploy sweep is auditable.
 */
function advancePristineExtraFiles(name: string): string[] {
  const advanced: string[] = [];
  for (const relPath of extraFileRelPaths(name)) {
    const v = fileThreeVersions(name, relPath);
    if (!v) continue;
    const customized = normalizeForCompare(v.mine) !== normalizeForCompare(v.base);
    const updateAvailable = normalizeForCompare(v.base) !== normalizeForCompare(v.shipped);
    if (customized || !updateAvailable) continue; // protect user edits; skip when nothing to advance
    advanceExtraFile(name, relPath, v.shipped);
    advanced.push(relPath);
    console.log(`[skills] fast-forwarded ${name}/${relPath}`);
  }
  return advanced;
}

/** OR-aggregate of a bundled skill's non-SKILL.md files into the same two flags customizationState
 *  reports for SKILL.md — see listSkills' doc: the single customized/updateAvailable pair stays a
 *  per-skill display concern even though enforcement (advancePristineExtraFiles) is per-file. */
function extraFilesCustomizationState(name: string): { customized: boolean; updateAvailable: boolean } {
  let customized = false;
  let updateAvailable = false;
  for (const relPath of extraFileRelPaths(name)) {
    const v = fileThreeVersions(name, relPath);
    if (!v) continue;
    if (normalizeForCompare(v.mine) !== normalizeForCompare(v.base)) customized = true;
    if (normalizeForCompare(v.base) !== normalizeForCompare(v.shipped)) updateAvailable = true;
  }
  return { customized, updateAvailable };
}

// LOAD-BEARING: store SKILL.md is written CRLF on Windows; the asset may be CRLF or LF. Normalize both
// (CRLF/CR -> LF, strip trailing per-line whitespace, strip trailing newlines) BEFORE comparing, else a
// clean skill reads permanently "out of sync" purely on line-ending difference.
function normalizeForCompare(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n+$/, "");
}

/**
 * Precise customization state for a BUNDLED skill, derived from the THREE versions (all line-ending /
 * whitespace tolerant via normalizeForCompare):
 *   mine    = the store SKILL.md (what sessions inject/use) — passed in as `storeContent`
 *   base    = the shipped content as of the user's last sync (<LOOM_HOME>/skill-base/<name>.md)
 *   shipped = the current bundled asset (Loom's latest)
 * Replaces the old ambiguous `diverged` (which conflated the two below):
 *  - customized      = mine != base  (the user edited their copy)
 *  - updateAvailable = base != shipped (Loom shipped a newer version since the last sync)
 * A MISSING base file is treated as == shipped — matching the seed-if-absent backfill (seedBaseSnapshots):
 * a pristine skill reads neither flag; a legacy-customized skill reads customized-only until a new asset
 * ships. Unreadable asset (not bundled) → both false.
 */
function customizationState(name: string, storeContent: string): { customized: boolean; updateAvailable: boolean } {
  const shipped = readFileOrNull(assetMd(name));
  if (shipped == null) return { customized: false, updateAvailable: false };
  const base = readFileOrNull(baseFile(name)) ?? shipped;
  const nMine = normalizeForCompare(storeContent);
  const nBase = normalizeForCompare(base);
  const nShipped = normalizeForCompare(shipped);
  return { customized: nMine !== nBase, updateAvailable: nBase !== nShipped };
}

export function listSkills(): SkillSummary[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  const bundled = bundledNames();
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let content = "";
    try { content = fs.readFileSync(skillMd(e.name), "utf8"); } catch { continue; } // dir without SKILL.md → not a skill
    const isBundled = bundled.has(e.name);
    let state: { customized: boolean; updateAvailable: boolean; mdCustomized: boolean; mdUpdateAvailable: boolean } | Record<string, never> = {};
    if (isBundled) {
      const md = customizationState(e.name, content);
      const extra = extraFilesCustomizationState(e.name);
      // OR across SKILL.md and every tracked reference/script file — "any part of this skill diverges
      // from what was last synced", the same single pair the UI has always read, now accurate for the
      // whole directory instead of blind to references/**/scripts/**. ALSO carry the SKILL.md-only pair
      // (mdCustomized/mdUpdateAvailable) separately: the web's "sync to shipped" destructive-discard
      // banner must trigger on SKILL.md divergence only, never on a reference-file-only divergence — a
      // reference file has no diff UI and no other edit surface, so offering a destructive sync behind
      // an empty diff would be worse than leaving the divergence to the sidebar dot / badge alone.
      state = {
        customized: md.customized || extra.customized,
        updateAvailable: md.updateAvailable || extra.updateAvailable,
        mdCustomized: md.customized,
        mdUpdateAvailable: md.updateAvailable,
      };
    }
    out.push({
      name: e.name,
      description: descriptionOf(content),
      bundled: isBundled,
      ...state,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Backfill the `base` snapshot for every bundled skill that has none — one-time, seed-if-absent (called
 * from seedGlobalSkills() at boot). base := the CURRENT shipped asset. Consequences (the SAFE direction):
 *  - pristine (mine == shipped): base == mine == shipped → neither customized nor update.
 *  - legacy-customized (mine != shipped, edited before base existed): base == shipped → customized, no
 *    update — until a NEW asset ships ahead of this base.
 * base only ADVANCES later on adopt / reset / publish (explicit syncs); an existing base staying behind a
 * freshly-shipped asset is exactly the "update available" signal. Returns the names backfilled.
 */
export function seedBaseSnapshots(): string[] {
  const seeded: string[] = [];
  for (const name of bundledNames()) {
    if (fs.existsSync(baseFile(name))) continue; // already snapshotted — never clobber (seed-if-absent)
    const shipped = readFileOrNull(assetMd(name));
    if (shipped == null) continue;
    writeBase(name, shipped);
    seeded.push(name);
  }
  return seeded;
}

/**
 * Boot-only auto-fast-forward of PRISTINE bundled skills (called from seedGlobalSkills() AFTER
 * seedBaseSnapshots() — base must be backfilled first so the equality below is meaningful). For each
 * bundled skill that has a store copy, advance `mine` to the shipped asset ONLY when it is LOSSLESS:
 *   customized:false  — normalizeForCompare(mine) === normalizeForCompare(base): the user has made NO
 *                       semantic edit, so taking shipped discards nothing (this IS the clean fast-forward
 *                       of mergeSkillContent line 168 and the `customized` flag of customizationState).
 *   updateAvailable:true — normalizeForCompare(base) !== normalizeForCompare(shipped): Loom shipped a
 *                       newer doctrine since the last sync; nothing to do otherwise.
 * When both hold, adopt shipped VERBATIM (adoptSkillUpdate advances base := shipped, clearing
 * updateAvailable). This makes self-host doctrine changes go live on restart like code does, WITHOUT
 * weakening the by-design protection of user edits: any customized:true skill is left for manual adopt
 * exactly as today — it is NEVER auto-advanced. The equality is the SAME merge-engine normalizeForCompare
 * used everywhere (customizationState / mergeSkillContent), never a new heuristic.
 *
 * ALSO advances the skill's non-SKILL.md files (references/**, scripts/**), gated PER FILE via
 * advancePristineExtraFiles — independently of whether SKILL.md itself is eligible this round. When
 * SKILL.md IS eligible, adoptSkillUpdate below already covers both (it calls advancePristineExtraFiles
 * itself); the `else` branch is what covers the mixed case — a customized SKILL.md (or one with nothing
 * to adopt) must not gate a still-pristine reference file's own advance.
 * Best-effort + boot-safe: each skill is wrapped in try/catch and this NEVER throws (mirrors
 * seedBaseSnapshots' tolerance). Returns the names of skills with SOME advancement (SKILL.md and/or
 * any file).
 */
export function autoFastForwardPristineSkills(): string[] {
  const advanced: string[] = [];
  for (const name of bundledNames()) {
    try {
      let didAdvance = false;
      const v = threeVersions(name);
      if (v) {
        const customized = normalizeForCompare(v.mine) !== normalizeForCompare(v.base);
        const updateAvailable = normalizeForCompare(v.base) !== normalizeForCompare(v.shipped);
        if (!customized && updateAvailable) {
          if (adoptSkillUpdate(name, v.shipped)) didAdvance = true; // clean FF == take shipped verbatim; also advances extra files
        } else if (advancePristineExtraFiles(name).length) {
          didAdvance = true; // SKILL.md not eligible this round — a reference/script file still can be
        }
      }
      if (didAdvance) advanced.push(name);
    } catch { /* best-effort per skill — a bad skill must never break boot */ }
  }
  return advanced;
}

/**
 * Store dir names left behind by a Loom bundled skill that stopped being bundled FOR AN END-USER
 * INSTALL — either a RENAME (the old name that seedGlobalSkills()'s seed-if-absent never removes once
 * the new `loom-*` name takes over) or an UNBUNDLE (a skill removed from the *published* asset set while
 * staying canonical in the repo/dev build — see codescape below). Growing this list is how a future
 * rename or unbundle gets auto-retired too. Deliberately HARDCODED, never derived (e.g. from "no matching
 * asset dir") — asset-absence alone can't distinguish a retired bundled skill from a user's own
 * UI-created skill of the same name, and only a name Loom itself shipped and then renamed/unbundled away
 * belongs here.
 */
export const RETIRED_BUNDLED_SKILL_NAMES: readonly string[] = [
  "pickup",       // -> loom-pickup
  "doc-hygiene",  // -> loom-doc-hygiene
  "session-end",  // -> loom-session-end
  "task-start",   // -> loom-task-start
  // codescape: NOT renamed — unbundled from the PUBLISHED release only (card 187873f9, codescape is a
  // private product end users can't access). Still canonical in packages/daemon/assets/skills/ (dev/
  // self-host keeps it bundled — see DEV_ONLY_SKILLS in scripts/curate-release-skills.mjs), so guard (b)
  // below (bundled.has(name) → skip) means this only ever fires against an end-user install whose OWN
  // dist/assets genuinely lacks it, never against the owner's dev/self-hosted daemon.
  "codescape",
];

/**
 * Boot-only auto-retire of orphaned store dirs left behind by a bundled-skill rename or unbundle (cards
 * 5ddc2289, 187873f9). seedGlobalSkills() is seed-IF-ABSENT — it adds a new/renamed name but never
 * removes an old store dir once its skill stops being bundled, so it lingers forever: injectSkills
 * mirrors the whole store, so every session keeps getting it injected, spending
 * skillListingBudgetFraction on a name nothing references anymore.
 *
 * A store dir `name` is retired ONLY when ALL hold:
 *  (a) `name` is in the hardcoded RETIRED_BUNDLED_SKILL_NAMES allowlist above.
 *  (b) `name` is NOT a CURRENT bundled asset (bundledNames() lacks it) — guards against ever deleting a
 *      live bundled skill even if a future asset ships reusing a retired name.
 *  (c) it is PRISTINE — the store's `mine` still equals its OWN `base` snapshot (the last-synced shipped
 *      content from before the rename, written by seedBaseSnapshots while `name` was still bundled and
 *      never deleted since). This is exactly `customized:false`. A MISSING base is NOT proof of pristine
 *      (it could be a user-created dir that happens to share a retired name) — that case is left
 *      untouched, fail-closed, same posture as a user-created asset-less skill.
 *
 * NEVER touches `~/.claude/skills` (the user's personal store) — this only ever walks SKILLS_DIR /
 * SKILL_BASE_DIR. Best-effort + boot-safe: each name is wrapped in try/catch and this never throws
 * (mirrors seedBaseSnapshots' / autoFastForwardPristineSkills' tolerance). Returns the names retired.
 */
export function retireOrphanedBundledSkillDirs(): string[] {
  const retired: string[] = [];
  const bundled = bundledNames();
  for (const name of RETIRED_BUNDLED_SKILL_NAMES) {
    try {
      if (bundled.has(name)) continue; // re-shipped under this name — never touch
      const mine = readFileOrNull(skillMd(name));
      if (mine == null) continue; // no store SKILL.md — nothing to retire
      const base = readFileOrNull(baseFile(name));
      if (base == null) continue; // no base snapshot on record — can't prove pristine, fail closed
      if (normalizeForCompare(mine) !== normalizeForCompare(base)) continue; // customized — never touch
      fs.rmSync(path.join(SKILLS_DIR, name), { recursive: true, force: true });
      try { fs.rmSync(baseFile(name), { force: true }); } catch { /* best-effort cleanup */ }
      retired.push(name);
    } catch { /* best-effort per name — a bad entry must never break boot */ }
  }
  return retired;
}

// --- 3-way adopt-update merge ----------------------------------------------------------------------
export interface SkillConflictHunk { mine: string; base: string; shipped: string; }
export interface SkillMergeResult { clean: boolean; merged: string; conflicts?: SkillConflictHunk[]; }

const toLf = (s: string): string => s.replace(/\r\n?/g, "\n");

/**
 * 3-way merge of a skill's SKILL.md — apply the shipped delta onto the user's edits using `base` as the
 * common ancestor. Line-based diff3 over LF-normalized lines (a=mine, o=base, b=shipped).
 *  - clean:true  → shipped's changes don't touch the user's edited lines (incl. the mine==base clean
 *    fast-forward where the WHOLE shipped update applies): `merged` is the ready-to-write content.
 *  - clean:false → genuine overlap: `conflicts` lists each conflicting hunk (mine/base/shipped text) for
 *    a per-hunk resolver, and `merged` is a whole-file fallback carrying git-style conflict markers
 *    (<<<<<<< mine / ||||||| base / ======= / >>>>>>> shipped) for a side-by-side editor.
 * `excludeFalseConflicts` collapses identical mine/shipped edits so they never read as conflicts.
 */
export function mergeSkillContent(base: string, mine: string, shipped: string): SkillMergeResult {
  // Clean fast-forward FIRST — when the user has made no SEMANTIC edit (mine == base under the SAME
  // normalizer customizationState uses: CRLF/CR, trailing per-line whitespace, and trailing newlines all
  // ignored), there is nothing to preserve, so adopt must take `shipped` VERBATIM. Routing this case
  // through diff3 is not merely redundant, it's WRONG: diff3 below normalizes only with `toLf`, so a
  // PHANTOM difference customizationState already discounts (a lone CRLF, a trailing space, a missing final
  // newline) reads to diff3 as a user edit and can DROP or CONFLICT shipped's additions — advancing base to
  // shipped while leaving `mine` stale (the adopt-staleness bug: a "not customized" skill that adopt left
  // missing shipped lines). Comparing with normalizeForCompare here keeps "no user edit" meaning the same
  // thing in the state model and the merge.
  if (normalizeForCompare(mine) === normalizeForCompare(base)) return { clean: true, merged: shipped };
  const regions = diff3Merge(toLf(mine).split("\n"), toLf(base).split("\n"), toLf(shipped).split("\n"), { excludeFalseConflicts: true });
  const out: string[] = [];
  const conflicts: SkillConflictHunk[] = [];
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue; }
    if (!r.conflict) continue;
    const c = r.conflict;
    conflicts.push({ mine: c.a.join("\n"), base: c.o.join("\n"), shipped: c.b.join("\n") });
    out.push("<<<<<<< mine", ...c.a, "||||||| base", ...c.o, "=======", ...c.b, ">>>>>>> shipped");
  }
  const merged = out.join("\n");
  return conflicts.length ? { clean: false, merged, conflicts } : { clean: true, merged };
}

/** Read base (snapshot), mine (store), shipped (asset) for a bundled skill; null if not bundled / no store copy. */
function threeVersions(name: string): { base: string; mine: string; shipped: string } | null {
  const shipped = readFileOrNull(assetMd(name));
  if (shipped == null) return null; // not a bundled skill
  const mine = readFileOrNull(skillMd(name));
  if (mine == null) return null;    // no store copy
  const base = readFileOrNull(baseFile(name)) ?? shipped; // missing base → treat as shipped (== seed outcome)
  return { base, mine, shipped };
}

/**
 * True iff a shipped update is available (base != shipped) for a bundled skill — the adopt/preview
 * guard for the REST layer (`/merge-preview`, `/adopt`). ALSO true when only a non-SKILL.md file (a
 * reference doc or helper script) has an update, even if SKILL.md itself is fully in sync (board card
 * 75a0755d, CR M2): listSkills already ORs a reference-file update into the `updateAvailable` badge the
 * UI shows, so this guard must widen the SAME way — otherwise the badge and the Adopt button render but
 * the click 409s "no update available", because the display and the guard disagreed about what counts.
 * When SKILL.md itself has nothing to adopt, adoptSkillUpdate's merge is a same-content no-op fast-
 * forward (mine == base == shipped) and the real work happens in its advancePristineExtraFiles call.
 */
export function skillUpdateAvailable(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const v = threeVersions(name);
  if (!v) return false;
  if (normalizeForCompare(v.base) !== normalizeForCompare(v.shipped)) return true;
  return extraFilesCustomizationState(name).updateAvailable;
}

/** Preview the adopt-update merge for a bundled skill. null if not a bundled skill with a store copy. */
export function previewSkillMerge(name: string): SkillMergeResult | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  return mergeSkillContent(v.base, v.mine, v.shipped);
}

// --- Per-file compare / resolve (references/**, scripts/**) ----------------------------------------
// Board card c01fd791. `75a0755d` taught the DAEMON to track the whole skill directory but left the
// compare VIEW SKILL.md-only, which produced a badge with no explorable diff and — for a file that is
// both customized AND has a shipped update — a badge that could never clear, because
// advancePristineExtraFiles correctly refuses to overwrite a user edit and the only escape was Reset (a
// whole-directory discard). These functions make the compare truthful per file and give that state a
// NON-DESTRUCTIVE resolution.
//
// Payload discipline: the summary below carries FLAGS ONLY (no content) and rides on the already-lazy
// update-diff read; file CONTENT is fetched one file at a time via skillFileDiff. listSkills is
// deliberately untouched — it is the hot read and already does a recursive walk per skill.

/** One tracked file's own customization state — flags only, no content (the cheap summary tier). */
export interface SkillFileState {
  /** POSIX-style path relative to the skill dir: "SKILL.md", "references/anti-patterns.md", … */
  path: string;
  /** mine != base — the user's copy carries an edit. */
  customized: boolean;
  /** base != shipped — Loom shipped a newer version of THIS file since the last sync. */
  updateAvailable: boolean;
}
/** One tracked file's full three-version view + the identity guard for a later resolve (content tier). */
export interface SkillFileDiff extends SkillFileState {
  base: string;
  mine: string;
  shipped: string;
  /** Content identity of `shipped` AS DISPLAYED — echoed back by resolveSkillFile. See its doc. */
  shippedHash: string;
}

/**
 * Content identity of one side of a diff, for the resolve TOCTOU guard. Hashes the RAW bytes, NOT
 * normalizeForCompare's output: this guard is fail-closed on purpose. A whitespace-only asset change
 * that normalization would discount still invalidates the token, costing the user one "re-open the
 * diff" round-trip — strictly better than the alternative failure, which is silently resolving against
 * content the user never saw. Truncated to 16 hex chars: this is a change DETECTOR, not a security
 * primitive (the asset side is Loom's own package dir, not attacker-controlled).
 */
function contentHash(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/**
 * Membership test for a caller-named file. The caller names a CHOICE FROM A SERVER-DERIVED SET — never
 * a path — so traversal ("../../etc/passwd"), absolute paths, and merely-untracked files all fail the
 * SAME check for the same reason, with no string sanitization to get subtly wrong. `extraFileRelPaths`
 * is a live walk of the store dir, so the set is always current.
 */
function isTrackedSkillFile(name: string, relPath: string): boolean {
  if (relPath === "SKILL.md") return true;
  return extraFileRelPaths(name).includes(relPath);
}

/**
 * Per-file flags for every tracked file of a bundled skill, SKILL.md FIRST then the extra files in
 * their existing sorted order. A file fileThreeVersions can't compare (binary, or no shipped
 * counterpart) is omitted entirely rather than reported as pristine — an omission is honest about
 * "not tracked"; a false `customized:false` would claim we checked.
 */
function skillFileStates(name: string): SkillFileState[] {
  const out: SkillFileState[] = [];
  const md = threeVersions(name);
  if (md) {
    out.push({
      path: "SKILL.md",
      customized: normalizeForCompare(md.mine) !== normalizeForCompare(md.base),
      updateAvailable: normalizeForCompare(md.base) !== normalizeForCompare(md.shipped),
    });
  }
  for (const relPath of extraFileRelPaths(name)) {
    const v = fileThreeVersions(name, relPath);
    if (!v) continue;
    out.push({
      path: relPath,
      customized: normalizeForCompare(v.mine) !== normalizeForCompare(v.base),
      updateAvailable: normalizeForCompare(v.base) !== normalizeForCompare(v.shipped),
    });
  }
  return out;
}

/**
 * base + shipped for SKILL.md's "what shipped changed" (base→shipped) diff, PLUS `files` — the per-file
 * flag summary across the whole skill directory. null if not a bundled skill.
 *
 * `base`/`shipped` are retained unchanged so both existing banners keep rendering exactly as before;
 * `files` is purely additive and content-free, so this stays a cheap read.
 */
export function skillUpdateDiff(name: string): { base: string; shipped: string; files: SkillFileState[] } | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  return { base: v.base, shipped: v.shipped, files: skillFileStates(name) };
}

/**
 * All three versions of ONE tracked file, fetched on demand when the user expands that file's row —
 * this is the content tier, deliberately never bundled into the summary above. SKILL.md is READABLE
 * here (so the file list renders uniformly) even though it is not RESOLVABLE — see resolveSkillFile.
 * null on an invalid name, an untracked path, or a file with no comparable three versions.
 */
export function skillFileDiff(name: string, relPath: string): SkillFileDiff | null {
  if (!isValidSkillName(name)) return null;
  if (!isTrackedSkillFile(name, relPath)) return null;
  const v = relPath === "SKILL.md" ? threeVersions(name) : fileThreeVersions(name, relPath);
  if (!v) return null;
  return {
    path: relPath,
    base: v.base,
    mine: v.mine,
    shipped: v.shipped,
    customized: normalizeForCompare(v.mine) !== normalizeForCompare(v.base),
    updateAvailable: normalizeForCompare(v.base) !== normalizeForCompare(v.shipped),
    shippedHash: contentHash(v.shipped),
  };
}

export type SkillFileResolveOutcome =
  | { ok: true; path: string; take: "mine" | "shipped" }
  | { ok: false; code: "invalid" | "not-found" | "not-diverged" | "stale-shipped"; message: string; shippedHash?: string };

/**
 * Resolve ONE diverged reference/script file, per the user's explicit choice. This is the escape hatch
 * for the state that had none: a file that is BOTH customized AND has a shipped update is skipped by
 * advancePristineExtraFiles (correctly — it protects the edit), so its badge could never clear and the
 * only remedy was Reset, a whole-directory discard.
 *
 *  take:"mine"    — leave `mine` BYTE-IDENTICAL; advance base := shipped ONLY. "I've seen the shipped
 *                   update and I'm keeping my version." updateAvailable clears; customized stays true,
 *                   which is honest — their copy really does still differ from shipped. NOTHING is
 *                   discarded, so this deliberately does NOT go through advanceExtraFile and writes NO
 *                   `.pre-ff-backups` entry: a backup here would misrepresent itself as a copy of
 *                   something that was overwritten, when nothing was. This is not a new semantics — it
 *                   is exactly what adoptSkillUpdate already does for SKILL.md when the user resolves
 *                   every conflict hunk to "mine" (write their content, advance base := shipped).
 *  take:"shipped" — take the shipped version via advanceExtraFile, so the pre-overwrite content lands
 *                   under `.pre-ff-backups` first. Destructive to THIS ONE FILE, never the directory,
 *                   and the REST layer only ever reaches it from a row already showing this file's diff.
 *
 * `expectedShippedHash` is a REQUIRED TOCTOU guard, not an optimization. `assets/**` is read LIVE from
 * the package dir (see CLAUDE.md), so an asset merge takes effect with no daemon restart — `shipped`
 * can change between the user reading the diff and clicking a button. Without this, take:"shipped"
 * would overwrite `mine` with content the displayed diff never showed: a discard behind a diff that no
 * longer shows what is being discarded, which is precisely the defect this card exists to close,
 * reappearing as a race. It guards take:"mine" too — that writes base := shipped, so it can otherwise
 * silently record a base the user never saw. Same class, lower stakes, one guard covers both.
 *
 * SKILL.md is REJECTED here: it has a real edit surface and its own 3-way merge/adopt/reset flow, and
 * routing it through a two-button per-file resolve would be a second, subtly-different notion of
 * "resolved" for the one file that already has one.
 */
export function resolveSkillFile(
  name: string,
  relPath: string,
  take: "mine" | "shipped",
  expectedShippedHash: string,
): SkillFileResolveOutcome {
  if (!isValidSkillName(name)) return { ok: false, code: "invalid", message: "invalid skill name" };
  if (relPath === "SKILL.md") {
    return { ok: false, code: "invalid", message: "SKILL.md resolves through adopt / reset, not per-file resolve" };
  }
  if (!isTrackedSkillFile(name, relPath)) return { ok: false, code: "invalid", message: "not a tracked file of this skill" };
  const v = fileThreeVersions(name, relPath);
  if (!v) return { ok: false, code: "not-found", message: "no comparable shipped version for this file" };

  const customized = normalizeForCompare(v.mine) !== normalizeForCompare(v.base);
  const updateAvailable = normalizeForCompare(v.base) !== normalizeForCompare(v.shipped);
  if (!customized && !updateAvailable) return { ok: false, code: "not-diverged", message: "this file is already in sync — nothing to resolve" };

  const currentHash = contentHash(v.shipped);
  if (expectedShippedHash !== currentHash) {
    return {
      ok: false,
      code: "stale-shipped",
      message: "the shipped version of this file changed since you opened the diff — re-open it to see the current change",
      shippedHash: currentHash,
    };
  }

  if (take === "shipped") advanceExtraFile(name, relPath, v.shipped); // backs up `mine` first
  else writeFileBaseSnapshot(name, relPath, v.shipped);               // base := shipped; `mine` untouched, no backup
  console.log(`[skills] resolved ${name}/${relPath} — took ${take}`);
  return { ok: true, path: relPath, take };
}

/**
 * Adopt the shipped update NON-DESTRUCTIVELY: write `mine` = resolvedContent (the clean merged content,
 * or the user-resolved content for a conflicted merge) and ADVANCE base := current shipped. Never auto-
 * applied — the REST layer calls this only on explicit user action and only when updateAvailable.
 * ALSO fast-forwards this skill's pristine non-SKILL.md files (advancePristineExtraFiles) — "adopt the
 * update" means sync this skill to shipped, not just its SKILL.md; a reference/script file the user
 * never touched should not need a second action to catch up. That call is best-effort (try/catch,
 * matching its boot sibling autoFastForwardPristineSkills): SKILL.md has ALREADY been written and its
 * base ALREADY advanced by this point, so an EPERM/EBUSY on one reference file must not 500 the whole
 * REST response for what is otherwise a successful adopt. Returns the new skill, or null if not a
 * bundled skill / invalid name / write failed.
 */
export function adoptSkillUpdate(name: string, resolvedContent: string): { name: string; content: string } | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  if (!writeSkill(name, resolvedContent)) return null;
  writeBase(name, v.shipped); // base = shipped: the update is now adopted (clears updateAvailable)
  try { advancePristineExtraFiles(name); } catch { /* best-effort — SKILL.md adopt already succeeded */ }
  return readSkill(name);
}

export function readSkill(name: string): { name: string; content: string } | null {
  if (!isValidSkillName(name)) return null;
  try { return { name, content: fs.readFileSync(skillMd(name), "utf8") }; } catch { return null; }
}

/** Create or overwrite a skill's SKILL.md. Returns false on an invalid name. */
export function writeSkill(name: string, content: string): boolean {
  if (!isValidSkillName(name)) return false;
  fs.mkdirSync(path.join(SKILLS_DIR, name), { recursive: true });
  atomicWriteFile(skillMd(name), content);
  return true;
}

export function deleteSkill(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  fs.rmSync(path.join(SKILLS_DIR, name), { recursive: true, force: true });
  return true;
}

/**
 * Restore a bundled skill in the store to its shipped asset version, discarding any UI edits.
 * Closes the seed-if-absent gap: seedGlobalSkills() never overwrites, so improvements to a bundled
 * skill don't reach an existing store on reboot — this is the explicit, per-skill opt-in refresh.
 * Returns false if the skill has no bundled asset (a user-created skill can't be "reset").
 *
 * mine = base = shipped for the WHOLE directory, not just SKILL.md (board card 75a0755d, CR M1): the
 * cpSync below already rewrites every reference doc / helper script file to shipped, but a reset that only
 * re-synced SKILL.md's base would leave every OTHER file's base stuck at its pre-reset value — reading
 * customized:true AND updateAvailable:true forever after, since mine (now shipped) would permanently
 * disagree with a base that reset never touched. That's this card's own bug, reintroduced through the
 * one action whose entire job is "discard and re-sync". Binary files are skipped (see isBinaryFile) —
 * cpSync already copied their real bytes correctly; there is simply no safe base to RECORD for them
 * without a utf8-mangling read, so (consistent with the rest of this module) they stay untracked.
 *
 * `.pre-ff-backups` entries for this skill are deliberately left in place, NOT cleared: they exist to
 * hedge against a rare pre-fix hand-edit being misread as `base` on first sight, and that hedge is about
 * the ORIGINAL pre-fix content, not this reset — an explicit, user-initiated "discard everything" is a
 * different action with a different intent, and clearing a backup subtree here would trade a real (if
 * currently unlikely) recovery path for no correctness benefit.
 *
 * The per-file base loop is wrapped best-effort (CR round 2 Minor #2), matching its two siblings
 * (seedFileBaseSnapshots' per-skill try/catch, adoptSkillUpdate's advance call) — an EBUSY/EPERM on one
 * file (e.g. a Windows AV lock) must not throw AFTER the destructive rmSync+cpSync above has ALREADY
 * discarded the old store contents: the route would 500 while the store is actually correct, and every
 * write here is unconditional + per-file atomic, so a second Reset click simply converges the rest.
 */
export function resetSkillToBundled(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const src = path.join(ASSET_SKILLS, name);
  try { if (!fs.statSync(src).isDirectory()) return false; } catch { return false; } // not a bundled skill
  const dest = path.join(SKILLS_DIR, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  // mine = base = shipped: a full discard also re-syncs the base snapshot, clearing any update-available.
  const shipped = readFileOrNull(assetMd(name));
  if (shipped != null) writeBase(name, shipped);
  try {
    for (const relPath of extraFileRelPaths(name)) {
      const assetPath = assetExtraFile(name, relPath);
      if (isBinaryFile(assetPath)) continue;
      const shippedFile = readFileOrNull(assetPath);
      if (shippedFile != null) writeFileBaseSnapshot(name, relPath, shippedFile);
    }
  } catch { /* best-effort — the store contents above are already correct; a stray base is self-healing on retry */ }
  return true;
}

/**
 * Inverse of resetSkillToBundled: write the STORE's SKILL.md back into the repo's bundled asset so a
 * UI edit becomes committable (the human commits — this never commits). RESTRICTED to names that
 * already exist as a bundled asset; it won't mint a new asset dir for a user-created skill.
 * Returns false if the skill has no bundled asset or no store SKILL.md.
 * HUMAN-only (REST) — like the vault/git writers, NO agent MCP tool exposes this.
 */
export function publishSkillToBundled(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const destDir = path.join(ASSET_SKILLS, name);
  try { if (!fs.statSync(destDir).isDirectory()) return false; } catch { return false; } // not a bundled skill
  let content: string;
  try { content = fs.readFileSync(skillMd(name), "utf8"); } catch { return false; } // no store SKILL.md to publish
  const dest = path.join(destDir, "SKILL.md");
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
  // The published edit IS the new shipped baseline: advance base to it so the skill reads PRISTINE
  // (mine == base == shipped) right after publish, instead of a stale "update available" against the
  // pre-publish base. Mirrors reset's base re-sync. (Dev/self-host flow; gated to isLoomDev at the REST.)
  writeBase(name, content);
  return true;
}

/** Starter SKILL.md for a freshly-created skill. */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe when this skill triggers and the steps to follow.\n`;
}
