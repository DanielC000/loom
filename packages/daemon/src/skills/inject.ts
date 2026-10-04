import fs from "node:fs";
import path from "node:path";
import type { SessionRole } from "@loom/shared";
import { SKILLS_DIR, OBSIDIAN_PREFLIGHT_FRAGMENT } from "../paths.js";
import { claudeSkillsDir, doctrineGitExcludeEntries } from "../pty/claude-doctrine.js";
import { isValidSkillName, isBundledSkill, skillProvenance } from "./store.js";
import { LOCKED_PROFILE_ROLES } from "../profiles/validate.js";
import { resolveGitDirsSync } from "../git/repo-lock.js";

const MANIFEST = ".loom-skills.json"; // records which skill names EACH session injected into the doctrine dir's skills subtree

/** The skills whose injected SKILL.md gets the Obsidian "vault preflight" fragment appended — and ONLY
 *  these — when the session's project has `obsidian.autoStart` on. Every other skill is untouched. */
const OBSIDIAN_FRAGMENT_SKILLS = new Set(["loom-pickup", "loom-session-end"]);

/** Map a Loom-DRIVEN session role to its operating-doctrine skill name in the store. A role here MUST get
 *  its doctrine skill no matter what the profile's pinned subset says (a subset that omits "worker" must
 *  still ship the worker doctrine). run/plain/null carry no doctrine ⇒ absent here. */
const ROLE_DOCTRINE_SKILL: Partial<Record<SessionRole, string>> = {
  worker: "worker",
  manager: "orchestrate",
  platform: "platform-lead",
  auditor: "platform-audit",
  "workspace-auditor": "workspace-audit",
  setup: "setup-assistant",
};

/** The store skill name carrying `role`'s operating doctrine, or null when the role has none (run/plain/
 *  assistant/operator/null). The single source for both harnesses' role→doctrine mapping. */
export function roleDoctrineSkillName(role: string | null | undefined): string | null {
  return (role && ROLE_DOCTRINE_SKILL[role as SessionRole]) || null;
}

/** Per-session injected-skill record for a shared `.claude/skills`: `{ "<sessionId>": ["worker", …] }`.
 *  Keyed by session so a concurrent session sharing the cwd never strips another's (or the repo's) skills. */
type Manifest = Record<string, string[]>;

/** A manifest entry is only ever used to build a path under `targetDir` for delivery/pruning — including
 *  `fs.rmSync(..., { recursive: true, force: true })`. The manifest file lives in the repo/worktree and is
 *  committable, so it's untrusted input: an entry like `"../../../victim"` or `""`/`"."` must never reach
 *  that path.join unvalidated. Require the SAME kebab-slug shape the skill store itself enforces (also a
 *  basename — no separators — and never `.`/`..`, though those are already excluded by the shape). */
export function isSafeManifestEntry(n: unknown): n is string {
  return typeof n === "string" && isValidSkillName(n) && path.basename(n) === n;
}

/**
 * Whether any of `candidates` (ancestor dirs of the injection target, outermost first) is a symlink or
 * junction that resolves OUTSIDE `cwd` — e.g. a committed git symlink, or a Windows junction a user
 * created by hand. Must run BEFORE any mkdir/write: `fs.mkdirSync(dir, { recursive: true })` happily
 * traverses an EXISTING symlink/junction ancestor and creates directories on the far side, so checking
 * only after the fact is already too late. Only an ancestor that already EXISTS can redirect anywhere —
 * a missing one is about to be freshly created by mkdirSync, under the real `cwd`, so `fs.realpathSync`
 * failing (ENOENT) on a candidate just means "nothing to escape through yet," not an error worth
 * surfacing. Returns the first escaping candidate (its real target, for the log line), or null if none
 * escape — including when `cwd` itself can't be resolved, in which case the caller's own mkdir is left
 * to surface whatever is actually wrong with `cwd`.
 */
function escapedAncestor(cwd: string, candidates: string[]): { path: string; real: string } | null {
  let cwdReal: string;
  try { cwdReal = fs.realpathSync(cwd); } catch { return null; }
  for (const candidate of candidates) {
    let real: string;
    try { real = fs.realpathSync(candidate); } catch { continue; } // doesn't exist yet — safe, mkdirSync will create it fresh
    const rel = path.relative(cwdReal, real);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return { path: candidate, real };
  }
  return null;
}

/** Filter a raw manifest entry list (one session's record) down to safe names. A non-array value (e.g. a
 *  dict `{"x":5}` where an array was expected) is COERCED to `[]` rather than thrown on — readManifest's
 *  caller must never have injection disabled for the whole session just because one record is malformed.
 *  Dropped entries are logged, bounded + truncated (untrusted content, but still worth seeing what/how many). */
function sanitizeManifestEntries(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.log(`[skills] manifest record for '${context}' is not an array (${typeof raw}); treating as empty`);
    return [];
  }
  const safe: string[] = [];
  const dropped: string[] = [];
  for (const n of raw) {
    if (isSafeManifestEntry(n)) safe.push(n);
    else dropped.push(typeof n === "string" ? n.slice(0, 80) : `<${typeof n}>`);
  }
  if (dropped.length) {
    const shown = dropped.slice(0, 5).join(", ");
    console.log(`[skills] dropped ${dropped.length} invalid manifest entr${dropped.length === 1 ? "y" : "ies"} for '${context}': ${shown}${dropped.length > 5 ? ", …" : ""}`);
  }
  return safe;
}

/** Read the manifest map. A legacy ARRAY (the pre-subset single-session format) is adopted AS the current
 *  session's record so it reconciles + retires cleanly on this run. Any other shape ⇒ empty map.
 *  A MISSING file is the normal first-run case (silent empty map); a present-but-CORRUPT manifest (a torn
 *  write, bad JSON) is SURFACED — it means we lost the record of what other sessions injected, so we log it
 *  rather than swallow it — then recover to an empty map (safe: every existing dir then reads as the repo's
 *  own and is left untouched; we only add our own `want`).
 *  Every entry — in the legacy array form and in every session's record in the dict form — is validated by
 *  `sanitizeManifestEntries` before it's trusted: the manifest is repo/worktree-committable and its entries
 *  flow straight into a prune `rmSync`, so an invalid entry here would otherwise be a path-escape/wipe
 *  vector (card 97e6a1c6). */
function readManifest(manifestPath: string, sessionId: string): Manifest {
  let text: string;
  try { text = fs.readFileSync(manifestPath, "utf8"); }
  catch { return {}; } // no manifest yet — normal first run, not an error worth surfacing
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt manifest at ${manifestPath}: ${(e as Error).message}`); return {}; }
  if (Array.isArray(raw)) return { [sessionId]: sanitizeManifestEntries(raw, sessionId) }; // legacy global array → this session owns it now
  if (raw && typeof raw === "object") {
    const out: Manifest = {};
    for (const [sid, ns] of Object.entries(raw as Record<string, unknown>)) out[sid] = sanitizeManifestEntries(ns, sid);
    return out;
  }
  return {};
}

/**
 * Atomically deliver one store skill dir into the session's .claude/skills, mirroring the tmp+rename
 * pattern store.ts uses for SKILL.md — but for a DIRECTORY: copy into a sibling tmp dir first, then swap
 * it into place. Two correctness wins over a bare cpSync into `dest`:
 *  - ATOMIC: `dest` is only ever the FULLY-copied tmp renamed in. A copy interrupted partway never leaves a
 *    half-written skill at `dest`, and the existing `dest` (the session's live doctrine) is removed ONLY
 *    after the new copy is ready — so a failed copy leaves the old skill intact instead of nuking it.
 *  - RETRIED + SURFACED: transient FS errors (AV/lock/EBUSY on Windows) get a few attempts; a persistent
 *    failure is logged and reported back (false) so the caller can surface it — never silently swallowed,
 *    which would let a session run WITHOUT its pinned doctrine skill.
 * Returns true iff the skill is now in place.
 */
function copySkillAtomic(src: string, dest: string): boolean {
  const tmp = `${dest}.loom-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Clear a stale tmp DIR from a prior crash so we never MERGE old store content into the fresh copy.
      // A stale tmp FILE is anomalous (we only ever create tmp dirs) — leave it so cpSync surfaces the type
      // mismatch rather than us blindly deleting an unexpected file at our temp path.
      try { if (fs.statSync(tmp).isDirectory()) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* no stale tmp */ }
      fs.cpSync(src, tmp, { recursive: true });           // build the new copy off to the side
      fs.rmSync(dest, { recursive: true, force: true });  // retire the old copy ONLY now the new one is ready
      fs.renameSync(tmp, dest);                            // atomic swap into place
      return true;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to inject '${path.basename(dest)}' after 3 attempts: ${(lastErr as Error)?.message}`);
  return false;
}

/**
 * Append the Obsidian "vault preflight" fragment to a JUST-injected skill's SKILL.md, after its whole body
 * and NEVER into the top frontmatter block. Called ONLY when a session's project has `obsidian.autoStart`
 * on (the additive-when-off invariant: with it off this is never reached, so the injected file is
 * byte-identical to the store base). Uses the SAME atomic tmp+swap discipline as copySkillAtomic. Because
 * copySkillAtomic re-copies the fresh store base on every inject BEFORE this runs, the append is not
 * idempotency-sensitive — each inject starts from a fragment-free base and appends exactly once.
 * Best-effort: the fragment is a pure enhancement (the base skill is fully functional without it), so a
 * failure is logged and the session runs with the short base skill rather than blocking the spawn.
 */
function appendObsidianFragment(skillDir: string, fragment: string): void {
  const skillMd = path.join(skillDir, "SKILL.md");
  let body: string;
  try { body = fs.readFileSync(skillMd, "utf8"); }
  catch { return; } // no SKILL.md to extend (a fragment-target skill with no SKILL.md) — nothing to do
  // Exactly the store base bytes, then a single blank-line separator, then the fragment verbatim. This is
  // the ONLY delta from the off (byte-identical) case, so the test can reconstruct it deterministically.
  const combined = `${body.endsWith("\n") ? body : `${body}\n`}\n${fragment}`;
  const tmp = `${skillMd}.loom-frag-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.writeFileSync(tmp, combined);
      fs.renameSync(tmp, skillMd); // atomic swap over the fresh base copy (rename replaces on win32 + posix)
      return;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to append obsidian preflight to ${skillMd} after 3 attempts: ${(lastErr as Error)?.message}`);
}

/**
 * Deliver Loom's managed skills to a session by mirroring ~/.loom/skills/<name> into
 * <cwd>/.claude/skills/<name>. Claude discovers these as PROJECT-LOCAL skills (bare names) —
 * WITHOUT touching the user's personal set or CLAUDE_CONFIG_DIR.
 *
 * @decision d63585ca — project-local does NOT shadow same-named personal skills (Claude Code's
 * precedence is the OPPOSITE); a bundled name colliding with a personal skill loses the collision
 * and never fires, with no config lever to reverse it — so Loom's own skill names must never collide.
 *
 * `subset` (profile-pinned, per session): when a non-empty list, deliver ONLY those skills; null/empty ⇒
 * ALL store skills (today's behavior — the regression-guarded default) — EXCEPT for a LOCKED role (see
 * below), where the default additionally withholds any AGENT-authored user-store skill.
 *
 * `role` (the session's resolved role): its operating-doctrine skill (worker→"worker", manager→
 * "orchestrate", …) is FORCE-INCLUDED regardless of the subset — a profile whose subset omits its own
 * role doctrine would otherwise ship a doctrine-less session. Only added if the doctrine skill is in the
 * store (a missing one is still dropped, like any subset name). null/run/plain ⇒ no doctrine skill. A
 * doctrine skill is always bundled, so it is never affected by the locked-role filter below.
 *
 * @decision 509176c8 — a LOCKED role's deliver-all default must withhold an AGENT-written (or
 * unstamped — fail closed) user-store skill; a human-written one, or an explicit non-empty `subset`
 * (human-only to set), still flows. See the full record for why.
 *
 * Shared-cwd safety (the load-bearing invariant): managers/platform/plain sessions SHARE project.repoPath
 * as cwd, so two sessions with DIFFERENT subsets write the SAME `.claude/skills`. The manifest is therefore
 * keyed PER SESSION, and this function only ever PRUNES a skill THIS session previously injected — and even
 * then only if no OTHER session's record still claims it. So injecting session B's subset can never strip
 * session A's skills (or vice-versa); the shared dir holds the UNION of all live sessions' subsets. (A
 * separate-cwd session — every worker, in its own worktree — gets its subset delivered EXACTLY, no union.)
 *
 * Safety (unchanged):
 *  - Manages ONLY skill names Loom ships; NEVER clobbers a repo's own pre-existing project-local skill of
 *    the same name. "Repo's own" = a pre-existing dir NO session's manifest claims (mine or another's).
 *  - Each session gets an INDEPENDENT recursive COPY of the skill (NOT a junction/symlink). A junction
 *    is fatal on Windows: worktree removal (git/worktrees.ts removeWorktree's recursive-rm backstop)
 *    follows the junction and deletes the STORE's SKILL.md contents, nuking ~/.loom/skills for every
 *    later session. A copy is deleted with the worktree without ever reaching the store.
 *  - Hides the injected skills from git via the shared .git/info/exclude (local only; never edits a tracked
 *    .gitignore) — resolved through to the main repo's common dir even when `cwd` is a linked worktree, so a
 *    worker session hides its own injected skills instead of relying on the manager having synced them.
 *
 * `obsidianEnabled` (per session, from `opts.sessionEnv?.LOOM_OBSIDIAN_AUTOSTART === "1"` at the spawn
 * seam): when TRUE, the Obsidian "vault preflight" fragment is appended to the injected loom-pickup/
 * loom-session-end SKILL.md (after its body; frontmatter untouched). Default FALSE ⇒ NO fragment read, NO append — every
 * injected file is byte-identical to the store base (the additive-when-off invariant, mirroring
 * browserTesting/documentConversion). Only loom-pickup + loom-session-end are affected; all other skills are
 * byte-identical regardless.
 */
export function injectSkills(cwd: string, sessionId: string, subset?: string[] | null, role?: SessionRole | null, obsidianEnabled = false): void {
  let storeNames: string[];
  try {
    // Filtered through the SAME `isValidSkillName` predicate the manifest-entry sanitizer uses (card
    // 97e6a1c6 review): what we WRITE into the manifest must always be a subset of what the read side
    // accepts, or a store dir outside that shape gets recorded on spawn 1, dropped on spawn 2 (since
    // sanitizeManifestEntries rejects it), then permanently misread as "repo's own" — never refreshed,
    // never pruned, and logged as invalid on every subsequent spawn.
    storeNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter(isValidSkillName);
  } catch { return; } // no store yet
  const targetDir = claudeSkillsDir(cwd);
  const claudeDir = path.dirname(targetDir);
  // Refuse BEFORE any write if `.claude` or `.claude/skills` is a symlink/junction redirecting outside
  // this session's own cwd (card 5c3d0518, from the review of 97e6a1c6) — otherwise every injection write
  // below (mkdir, the skill copies, the manifest) lands on whatever that link points at instead of this
  // repo. Logged loudly and skipped for this session, never thrown into the spawn: the session still
  // boots, just without its injected skills, exactly like the existing "no store yet" early-return above
  // and the non-fatal catch around this call at its one call site (pty/host.ts).
  const escaped = escapedAncestor(cwd, [claudeDir, targetDir]);
  if (escaped) {
    console.log(`[skills] refusing injection: ${escaped.path} resolves to ${escaped.real}, outside this session's working directory (${cwd}) — skill injection skipped for this session`);
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // What THIS session should have present: a non-empty subset ∩ the store, else ALL store skills — EXCEPT
  // for a locked role, where "all" excludes an agent-written (or unstamped — fail closed) user skill
  // (card 509176c8; see this function's own doc comment + the decision record for why).
  //
  // @decision 509176c8 — round 2's `isTrustedBundledContent` check was CUT (round 3): it withheld
  // legitimate bundled skills (a pre-provenance customization, or a pristine copy ahead of reseed).
  //
  // @decision 9a3dea30 — round 2: `isBundledSkill(n)` flips true the instant an asset merges, before the
  // next boot's rename-aside fix ever runs, so a still-"agent"-stamped collision must stay excluded even
  // once isBundledSkill is true. Provenance-only — never content-equality (see the decision record).
  const isLockedRole = role != null && LOCKED_PROFILE_ROLES.has(role);
  const want = subset && subset.length
    ? storeNames.filter((n) => subset.includes(n))
    : isLockedRole
      ? storeNames.filter((n) => (isBundledSkill(n) && skillProvenance(n) !== "agent") || skillProvenance(n) === "human")
      : storeNames;
  // FORCE-INCLUDE the role's operating-doctrine skill regardless of the subset (a profile whose subset
  // omits "worker"/"orchestrate"/… must still ship its role doctrine). Only when present in the store and
  // not already wanted; a no-subset session already has every store skill, so this only bites under a subset.
  const roleSkill = role ? ROLE_DOCTRINE_SKILL[role] : undefined;
  if (roleSkill && storeNames.includes(roleSkill) && !want.includes(roleSkill)) want.push(roleSkill);

  const manifestPath = path.join(targetDir, MANIFEST);
  const manifest = readManifest(manifestPath, sessionId);
  const myPrev = manifest[sessionId] ?? [];
  // Union of every OTHER session's injected skills sharing this cwd — these must NEVER be stripped here
  // and are NOT the repo's own (the landmine-2 invariant: concurrent sessions share project.repoPath).
  const otherClaimed = new Set<string>();
  for (const [sid, ns] of Object.entries(manifest)) if (sid !== sessionId) for (const n of ns) otherClaimed.add(n);

  // Read the Obsidian preflight fragment ONCE, and ONLY when the project enabled it AND a fragment-target
  // skill is actually being delivered — so with obsidian.autoStart off (the default) this asset is never
  // touched and every injected file is byte-identical to the store base. A missing/unreadable fragment
  // degrades to the short base skill (best-effort; the fragment is a pure enhancement).
  let obsidianFragment: string | null = null;
  if (obsidianEnabled && want.some((n) => OBSIDIAN_FRAGMENT_SKILLS.has(n))) {
    try { obsidianFragment = fs.readFileSync(OBSIDIAN_PREFLIGHT_FRAGMENT, "utf8"); }
    catch (e) { console.log(`[skills] obsidian preflight fragment unavailable at ${OBSIDIAN_PREFLIGHT_FRAGMENT}: ${(e as Error).message}`); }
  }

  const placed: string[] = [];
  const failed: string[] = [];
  for (const name of want) {
    const dest = path.join(targetDir, name);
    const exists = fs.existsSync(dest);
    // A pre-existing dir that NO loom session claims (not mine, not another session's) is the repo's OWN
    // project-local skill — never clobber it. A dir another session injected IS loom's: re-copying the
    // same store content is idempotent and harmless.
    if (exists && !myPrev.includes(name) && !otherClaimed.has(name)) continue;
    const src = path.join(SKILLS_DIR, name);
    // COPY (atomic tmp+swap), never junction: a junction here lets worktree removal's recursive rm follow
    // it into the store and delete the store's SKILL.md (see header). An independent copy is self-contained.
    // A copy that ultimately fails is recorded (`failed`) and surfaced below — NOT silently skipped, which
    // would let the session run WITHOUT its pinned doctrine skill.
    if (copySkillAtomic(src, dest)) {
      placed.push(name);
      // ONLY the fragment-target skills, and ONLY when enabled + the fragment loaded. Runs after the fresh
      // base copy (copySkillAtomic re-copies the fragment-free store base first), so the append lands once.
      if (obsidianFragment && OBSIDIAN_FRAGMENT_SKILLS.has(name)) appendObsidianFragment(dest, obsidianFragment);
    } else failed.push(name);
  }

  // Prune ONLY skills I previously injected that I no longer want — and only when no OTHER session still
  // claims them. This is what makes a subset change / store deletion safe under a shared cwd: removing my
  // stale skills can never strip a concurrent session's (nor the repo's own, which is in no manifest).
  for (const stale of myPrev) {
    if (want.includes(stale)) continue;        // still want it (placed this run, or a repo collision left alone)
    if (otherClaimed.has(stale)) continue;     // a concurrent session still needs it — keep
    const target = path.join(targetDir, stale);
    // Defense in depth (card 97e6a1c6): `myPrev` is already sanitized by readManifest, so this should
    // never trip in practice — but never rmSync anything that isn't a DIRECT CHILD of targetDir, in case
    // a future manifest source (or a validation bug) ever lets something else through.
    if (path.dirname(target) !== targetDir) { console.log(`[skills] refusing to prune out-of-scope manifest entry: ${stale}`); continue; }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  manifest[sessionId] = placed; // record ONLY what I actually injected (never the repo's own / collisions)
  // Atomic manifest write (tmp+rename, like store.ts): a torn write here corrupts the shared per-session
  // record — readManifest then has to discard it, losing every concurrent session's claims. Writing to a
  // tmp and renaming means a reader sees either the old whole map or the new whole map, never a half file.
  const manifestTmp = `${manifestPath}.tmp`;
  try {
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest));
    fs.renameSync(manifestTmp, manifestPath);
  } catch (e) {
    console.log(`[skills] failed to write manifest ${manifestPath}: ${(e as Error).message}`);
    try { fs.rmSync(manifestTmp, { force: true }); } catch { /* best effort */ }
  }
  hideFromGit(cwd, [...placed, MANIFEST]);

  // Surface any copy that never landed (after persisting the manifest + git-hide for what DID land, so the
  // partial success is recorded and recoverable). The caller treats this as non-fatal but it's now VISIBLE
  // in the daemon log instead of a silent missing-skill.
  if (failed.length) throw new Error(`injectSkills: failed to deliver ${failed.length} skill(s) to ${targetDir}: ${failed.join(", ")}`);
}

/** Append local git-ignore patterns for the injected skill dirs + manifest, PLUS Claude Code's own
 *  `.claude/settings.local.json` (written by acceptEdits permission persistence — a Loom worktree never
 *  writes this itself, but it lands in every worker's `.claude/` regardless and a blind `git add -A`
 *  would otherwise stage it onto the worker's branch) — resolving through a linked worktree to the shared
 *  common dir ({@link resolveGitDirsSync}'s `commonDir`, git/repo-lock.ts) so a worktree-cwd session
 *  (every worker) hides both too, not just a repoPath-cwd session (manager/platform/setup/auditor).
 *  Deliberately just the ONE settings file, not all of `.claude/` — a repo may track a shared
 *  `.claude/settings.json` that must stay visible to git. `info/exclude` is not one of the handful of
 *  files git keeps per-worktree (HEAD, index, logs/HEAD, …) — it lives in the common dir and git resolves
 *  it there for every linked worktree too, so a write here takes effect for `git status` in the worktree
 *  immediately, no per-worktree copy needed. */
function hideFromGit(cwd: string, entries: string[]): void {
  const gitDir = resolveGitDirsSync(cwd)?.commonDir ?? null;
  if (!gitDir) return; // no .git resolvable — nothing to hide from
  const infoDir = path.join(gitDir, "info");
  try { fs.mkdirSync(infoDir, { recursive: true }); } catch { /* ignore */ }
  const excludePath = path.join(infoDir, "exclude");
  let cur = ""; try { cur = fs.readFileSync(excludePath, "utf8"); } catch { /* none */ }
  const want = doctrineGitExcludeEntries(entries);
  const missing = want.filter((p) => !cur.split(/\r?\n/).includes(p));
  if (missing.length === 0) return;
  const prefix = cur === "" || cur.endsWith("\n") ? "" : "\n";
  try { fs.appendFileSync(excludePath, `${prefix}# loom-managed exclusions (injected per session; do not commit)\n${missing.join("\n")}\n`); } catch { /* ignore */ }
}
