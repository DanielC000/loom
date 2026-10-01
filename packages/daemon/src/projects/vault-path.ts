import fs from "node:fs";
import path from "node:path";
import type { RepoRegistryEntry } from "@loom/shared";
import { expandTilde } from "../paths.js";
import { isGitRepo } from "../git/reader.js";
import { comparisonKey } from "./repos.js";

/** Result of {@link validateVaultPath}. `ok:false` names the offending value. */
export type VaultPathCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * The SHARED absolute-path guard for a project's `vaultPath` — mirrors `validateReferenceRepos`
 * (reference-repos.ts), which already enforces this for the structurally identical `referenceRepos`
 * field.
 *
 * `raw` MUST be non-empty before calling this — an empty vaultPath is the legitimate "no vault bound" /
 * explicit-unbind case and must never be routed through this check.
 *
 * Existence is intentionally NOT checked here (unlike referenceRepos' isGitRepo check) — that stays
 * call-site-specific: a vault-only project requires an EXISTING directory (`isExistingDir`), while a
 * code project's optional vault gets auto-scaffolded (`ensureVaultRoot`) rather than required to pre-exist.
 * Idempotent on an already-expanded absolute input (expandTilde is a no-op on a path with no leading `~`),
 * so callers that already `expandTilde`d upstream can pass the result straight through.
 *
 * @decision 96c4b245 — reject a non-absolute vaultPath here; there's no recoverable base to resolve it against, so never guess one at render/boot time instead.
 * @decision d867e478 — "" is the legitimate no-vault/unbind case, not a validation failure; every call site must guard it, never route it through this check.
 */
export function validateVaultPath(raw: string): VaultPathCheck {
  const expanded = expandTilde(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `vaultPath must be an absolute path: ${expanded}` };
  }
  return { ok: true, value: expanded };
}

/** Result of {@link checkVaultPathRepoContainment} / {@link checkVaultRepoTripleContainment}. */
export type VaultPathContainmentCheck =
  | { ok: true }
  | { ok: false; error: string };

type PathCanonResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * @decision 5ba4412d — never treat every `\\?\…`-prefixed path as safe: ONLY `\\?\<drive>:\…` (or
 * `//?/<drive>:/…`) canonicalizes correctly through realpath. `\\?\UNC\…` is the extended-length
 * spelling of a UNC NETWORK path and must be refused exactly like a plain `\\host\share\…` form.
 *
 * Is `p` a form `fs.realpathSync.native` cannot be trusted to collapse to a comparable local path? Three
 * families: a genuine UNC network path, INCLUDING its extended-length spelling (`\\?\UNC\host\share\…`)
 * and the loopback admin-share alias (`\\localhost\c$\…`); a DOS device namespace path (`\\.\…`); and the
 * NT native namespace prefix (`\??\…`). The ONE exemption is the extended-length LOCAL drive form,
 * `\\?\<drive>:\…` (or its forward-slash spelling `//?/<drive>:/…`) — verified directly to canonicalize
 * correctly through realpath, so it is deliberately let through rather than refused.
 */
function isUnsafeToCanonicalize(p: string): boolean {
  if (/^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/.test(p)) return false; // \\?\C:\... / //?/C:/... — safe, exempt
  if (/^[\\/]{2}/.test(p)) return true; // any other \\... form: UNC, \\?\UNC\..., \\.\device
  if (/^\\\?\?\\/.test(p)) return true; // the NT native namespace prefix \??\...
  return false;
}

/**
 * @decision 5ba4412d — refuse any win32 path segment ending in `.`/` ` rather than normalizing it: Win32
 * strips that trailing character resolving a child process's cwd, so `<repoPath>.` can land `git` inside
 * the REAL repo even though `fs.realpathSync.native` treats the two forms as distinct, nonexistent paths.
 *
 * On win32, does ANY of `p`'s path segments end in `.` or ` `? Refusing is simpler and safer than trying
 * to replicate Win32's own stripping rules. POSIX has no such stripping — a trailing `.`/` ` there is an
 * ordinary, meaningful filename character — so this check is win32-only.
 */
function hasWin32UnsafeTrailingSegment(p: string): boolean {
  if (process.platform !== "win32") return false;
  return p.split(/[\\/]+/).some((seg) => seg !== "" && /[. ]$/.test(seg));
}

/**
 * @decision 5ba4412d — never canonicalize a possibly-not-yet-existing candidate via a plain
 * `path.resolve` fallback (as {@link canonicalizeExistingPath} does): walk to the deepest EXISTING
 * ancestor and realpath THAT — the plain fallback lets a junction/short-name candidate slip past containment.
 *
 * Canonicalize `raw` for a containment/equality COMPARISON — tolerating a path that does not exist on
 * disk yet, unlike {@link canonicalizeExistingPath} (`repos.ts`), which assumes existence.
 *
 * Walks up from `raw` to the DEEPEST EXISTING ANCESTOR, resolves THAT via `fs.realpathSync.native`
 * (collapsing symlinks/junctions/short names/the safe `\\?\<drive>:\` prefix — the OS does the real
 * work), then rejoins the missing tail segments onto the real form. So `<junction>\docs` (docs not yet
 * created) still resolves through the junction to its real target, and `R~1\docs` still resolves through
 * the short name — exactly as if the full path already existed. Refuses outright, rather than risk a
 * false negative, any path this function cannot safely normalize: a genuine UNC/device/NT-namespace form
 * (see {@link isUnsafeToCanonicalize}) or, on win32, a path with any segment ending in `.`/` ` (see
 * {@link hasWin32UnsafeTrailingSegment}).
 *
 * Bounded: `dirname` reaches a fixed point (a path's own root, where `dirname(p) === p`) in finitely many
 * steps, so the walk always terminates even for a path with NO existing ancestor at all (falls back to
 * the resolved-but-unreal `path.resolve` form in that pathological case, matching
 * {@link canonicalizeExistingPath}'s own fallback).
 */
function canonicalizeForContainment(raw: string): PathCanonResult {
  if (isUnsafeToCanonicalize(raw)) {
    return { ok: false, error: `path uses a network/device form that cannot be safely compared for containment: ${raw}` };
  }
  if (hasWin32UnsafeTrailingSegment(raw)) {
    return { ok: false, error: `path has a segment ending in '.' or ' ', which Windows silently strips and can alias a different real path: ${raw}` };
  }
  let current = path.resolve(raw);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return { ok: true, value: tail.length ? path.join(real, ...tail.reverse()) : real };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { ok: true, value: path.resolve(raw) };
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Are `a` and `b` the SAME real path, per {@link canonicalizeForContainment}? `ok:false` propagates an
 *  unsafe-to-compare input (a UNC form) from either side — the caller must refuse, never treat that as
 *  "not equal". */
function pathsCanonicallyEqual(a: string, b: string): { ok: true; value: boolean } | { ok: false; error: string } {
  const ra = canonicalizeForContainment(a);
  if (!ra.ok) return ra;
  const rb = canonicalizeForContainment(b);
  if (!rb.ok) return rb;
  return { ok: true, value: comparisonKey(ra.value) === comparisonKey(rb.value) };
}

/**
 * Are `a` and `b` the SAME real path — the CANONICAL comparison a caller should use to decide whether a
 * project's stored `repoPath`/`vaultPath` are an established pairing, instead of a raw `===` (a case or
 * trailing-separator difference is the SAME real directory, not a different one). Defaults to `false`
 * (never throws) when either side can't be safely compared (a UNC/device form) — the conservative choice
 * for a caller deciding whether to apply an EXEMPTION, where "unsure" must mean "don't exempt."
 */
export function canonicallyPaired(a: string, b: string): boolean {
  const result = pathsCanonicallyEqual(a, b);
  return result.ok && result.value;
}

/** Is `childKey` PROPERLY nested under `parentKey` (never equal — equality is the caller's OWN, separately
 *  worded case)? Both arguments MUST already be {@link comparisonKey}-folded, canonicalized forms — this
 *  helper does no normalization of its own, it only compares. */
function isProperlyUnder(childKey: string, parentKey: string): boolean {
  const rel = path.relative(parentKey, childKey);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Refuse a `vaultPath` candidate whose real directory tree overlaps a code repo's, in EITHER direction
 * (card 5ba4412d, following 6a48b759's equality-only alias check):
 *  - vaultPath EQUALS, or is NESTED INSIDE, a code repo — `vault/versioner.ts`'s `resolveVaultRepoContext`
 *    resolves a vault subfolder up to its `git rev-parse --show-toplevel` root, and `commitVault` then
 *    `git add .`s the WHOLE code tree.
 *  - a code repo is NESTED INSIDE vaultPath — the versioner git-inits the vault (or its existing root) and
 *    embeds the code repo as a gitlink.
 *
 * NOTE — this is an OVER-APPROXIMATION of "shares a governing git root", not an exact reproduction of
 * `git rev-parse --show-toplevel`'s own resolution: it refuses ANY vaultPath that is textually at-or-under,
 * or that textually contains, a code-repo path, without regard to nested `.git` boundaries, submodules, or
 * other real git structure in between. That is deliberate — it is cheaper and safer to be conservative
 * here than to precisely re-derive git's own root-walk for a candidate that may not exist on disk yet.
 *
 * Checked by PATH CONTAINMENT alone (via {@link canonicalizeForContainment}, tolerant of a not-yet-existing
 * candidate — see its own doc), never by invoking git on the vault candidate.
 *
 * `repoPaths` is every code-repo directory this project's vault must stay clear of — the CALLER decides
 * which ones apply (the effective repoPath, when it's a real, distinct code repo; every `repos` registry
 * entry). This function has no project-shape context of its own, so it never applies the vault-only/
 * legacy-pairing exemption itself (see {@link checkVaultRepoTripleContainment}'s own doc for that) —
 * filtering `repoPaths` down to the paths that should actually be checked is the caller's job.
 */
export function checkVaultPathRepoContainment(candidate: string, repoPaths: string[]): VaultPathContainmentCheck {
  const candidateResult = canonicalizeForContainment(candidate);
  if (!candidateResult.ok) return candidateResult;
  const candidateKey = comparisonKey(candidateResult.value);
  for (const repoPath of repoPaths) {
    const repoResult = canonicalizeForContainment(repoPath);
    if (!repoResult.ok) return repoResult;
    const repoKey = comparisonKey(repoResult.value);
    if (candidateKey === repoKey) {
      return { ok: false, error: `vaultPath equals/aliases the code repo at ${repoPath} — the vault auto-committer would commit into the code repo` };
    }
    if (isProperlyUnder(candidateKey, repoKey)) {
      return { ok: false, error: `vaultPath is inside the code repo at ${repoPath} — the vault auto-committer would commit into the code repo` };
    }
    if (isProperlyUnder(repoKey, candidateKey)) {
      return { ok: false, error: `vaultPath would contain the code repo at ${repoPath} — the vault auto-committer would embed the code repo as a gitlink` };
    }
  }
  return { ok: true };
}

/**
 * The SHARED containment check on the FULL, EFFECTIVE post-write `{repoPath, vaultPath, repos}` triple —
 * the ONE call site every create AND update surface (REST, manager, setup, platform) runs, regardless of
 * WHICH of the three fields a given write actually touches (card 5ba4412d review follow-up, closing three
 * bypasses a per-field, vaultPath-only check missed): a `repos`-only edit, a `repoPath`-only rebind that
 * leaves an existing vaultPath stranded inside/around the NEW repoPath, and a vault-only CREATE whose
 * `repos` registry was never checked against its own vaultPath at all.
 *
 * `triple` is the EFFECTIVE values this write is about to commit — for an update, that's
 * `patchValue ?? project.preexistingValue` per field, computed by the CALLER (this function has no
 * database access); for a create, it's simply the values being created.
 *
 * `opts.pairingIsIntentional` exempts the repoPath check specifically — never a `repos` entry, which is
 * never exempted — but ONLY when the triple's vaultPath and repoPath are STILL canonically equal after
 * THIS call. It is NOT derivable from the triple's own values (a code-project CREATE where a caller
 * explicitly duplicates repoPath into vaultPath produces the exact SAME {repoPath, vaultPath} shape as a
 * genuine vault-only pairing, yet the two must be judged oppositely — the first is exactly the alias bug
 * this card closes, the second is by design), so the CALLER states its intent explicitly:
 *  - An UPDATE caller passes the project's own stored `vaultOnly` fact — "was this already an
 *    established pairing before this write?" A call that leaves repoPath FIXED while moving vaultPath
 *    into a subfolder of it (or its parent) is NEVER exempted even when `vaultOnly` is true, because
 *    `pairedCheck` (the POST-patch equality) will be false.
 *  - A vault-only CREATE branch (no repoPath given by the caller — the SAME value gets assigned to both
 *    fields internally, by construction) passes `true` unconditionally: there is no separate code repo
 *    here BY DESIGN, regardless of whether that shared folder happens to itself be a git repo (e.g. an
 *    Obsidian-Git-managed vault) — `resolveVaultRepoContext` already treats that layout as legitimate.
 *  - A code-project CREATE branch (repoPath explicitly given) never passes it (defaults to `false`) — an
 *    explicit vaultPath===repoPath here is the asymmetry this card closes, not a design pairing.
 *
 * @decision 5ba4412d — compare the pre-patch pairing CANONICALLY (never a raw `===`), and require it to
 * ALSO still hold canonically AFTER this call — otherwise a paired project either keeps its exemption
 * while moving its vault into/around its own still-real repo, or loses it over a mere case/slash spelling.
 *
 * @decision b98957e9 — an UPDATE caller must never re-derive `pairingIsIntentional` via
 * {@link canonicallyPaired}(`project.repoPath`, `project.vaultPath`) again; that reproduced the exact
 * unsound vault-only inference this card replaced. Pass the project's stored `vaultOnly` fact instead.
 */
export async function checkVaultRepoTripleContainment(
  triple: { repoPath: string; vaultPath: string; repos: RepoRegistryEntry[] },
  opts: { pairingIsIntentional?: boolean } = {},
): Promise<VaultPathContainmentCheck> {
  if (!triple.vaultPath) return { ok: true }; // no vault bound — nothing to protect
  const pairedCheck = pathsCanonicallyEqual(triple.vaultPath, triple.repoPath);
  if (!pairedCheck.ok) return pairedCheck;
  const exemptRepoPath = !!opts.pairingIsIntentional && pairedCheck.value;
  const repoPaths: string[] = [];
  if (!exemptRepoPath && await isGitRepo(triple.repoPath)) repoPaths.push(triple.repoPath);
  for (const entry of triple.repos) repoPaths.push(entry.path);
  if (repoPaths.length === 0) return { ok: true };
  return checkVaultPathRepoContainment(triple.vaultPath, repoPaths);
}

/** Result of {@link checkVaultPathUpdate}. `value: undefined` means "no change requested" (the caller's
 *  patch omitted vaultPath); `value: ""` is a validated, legitimate unbind. */
export type VaultPathUpdateCheck =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

/**
 * The SHARED `vaultPath`-FIELD update guard — every `project_update`-shaped write surface (human REST
 * PATCH, the manager's own `project_update`, the setup operator's `project_update`, and the elevated
 * platform MCP `project_update`) calls this instead of hand-rolling its own trim/expand/validate/unbind
 * sequence, so a rebind or unbind validates IDENTICALLY everywhere — mirrors {@link checkRepoRebind}'s
 * role for `repoPath` (`projects/rebind.ts`).
 *
 * `raw` is the caller's incoming patch value exactly as received (untrimmed): `undefined` means "this
 * patch doesn't touch vaultPath" and passes through unchanged. A trimmed-empty value is the legitimate
 * explicit-unbind case per {@link validateVaultPath}'s own decision notes above, UNLESS it would strand a
 * vault-only project (refused instead — see the vault-only check below, which reads the project's own
 * stored `vaultOnly` fact, never a live `repoPath`/`isGitRepo` re-derivation).
 *
 * @decision b98957e9 — never re-derive vault-only-ness from `repoPath`/`vaultPath`/`isGitRepo` here
 * again; read the project's stored `vaultOnly` fact instead.
 *
 * CONTAINMENT (does this vaultPath alias, nest into, or get nested by a code repo) is deliberately NOT
 * this function's job — see {@link checkVaultRepoTripleContainment}, the SEPARATE shared check every
 * create/update surface also runs, on the full effective triple, regardless of which field changed. Doing
 * it here would only ever see the vaultPath field, reproducing the exact per-field blind spot that check
 * exists to close (a repoPath-only or repos-only write would never reach it).
 */
export async function checkVaultPathUpdate(
  project: { repoPath: string; vaultPath: string; vaultOnly: boolean },
  raw: string | undefined,
): Promise<VaultPathUpdateCheck> {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  if (!trimmed) {
    if (project.vaultOnly) {
      return { ok: false, error: "cannot unbind the vault of a vault-only project (it has no separate repoPath) — archive it instead" };
    }
    return { ok: true, value: "" };
  }
  const absCheck = validateVaultPath(expandTilde(trimmed));
  if (!absCheck.ok) return absCheck;
  return { ok: true, value: absCheck.value };
}

/** Result of {@link checkVaultOnlyOnUpdate}. `vaultOnlyPatch: undefined` means "leave the stored
 *  `vaultOnly` fact alone" (the project isn't vault-only, this write doesn't touch repoPath/vaultPath at
 *  all, or the pair is still canonically equal after the write); `vaultOnlyPatch: false` means "clear it
 *  in this same write" (a repoPath rebind diverged the pair). */
export type VaultOnlyUpdateCheck =
  | { ok: true; vaultOnlyPatch: boolean | undefined }
  | { ok: false; error: string };

/**
 * The SHARED `vaultOnly`-flag update guard — every surface that can change a project's `repoPath` and/or
 * `vaultPath` (human REST PATCH, the manager's own `project_update`, the setup operator's
 * `project_update`, and the elevated platform MCP `project_update`) calls this instead of recomputing the
 * clear-on-divergence logic itself (or, for the manager/setup surfaces, not checking it at all). Call it
 * AFTER `checkVaultPathUpdate`/`checkVaultRepoTripleContainment` have already approved the write (an
 * explicit unbind of a vault-only project is refused upstream, before this ever runs) and BEFORE
 * `Db.updateProject`, passing it the SAME `patch.repoPath`/`patch.vaultPath` values (`undefined` = "this
 * write doesn't touch that field") those checks saw.
 *
 * A vault-only project's invariant is "repoPath and vaultPath stay canonically paired" (LEAD ruling, card
 * `b98957e9` fix round). Three cases, by what THIS write changes:
 *  - a `repoPath` rebind (this write passes `patch.repoPath`) that leaves the pair diverged ⇒ clear the
 *    fact to `false` in the SAME write — only the REST PATCH and platform `project_update` surfaces can
 *    ever reach this branch (the only two surfaces that can rebind `repoPath` at all).
 *  - a `repoPath` rebind (alone, or together with `vaultPath`) that leaves the pair STILL canonically
 *    equal ⇒ leave the fact untouched (still `true`) — relocating both fields together onto one new
 *    shared folder is a legitimate move, not an unpairing.
 *  - a `vaultPath`-ONLY write (`patch.repoPath` is `undefined`) that would UNPAIR the project ⇒ REFUSE the
 *    write outright, rather than silently flipping the fact to `false` — a vault-only project has no
 *    separate repoPath to fall back to, so letting this through leaves it governed by neither path. Every
 *    one of the four surfaces can reach this branch (including the two that can never touch `repoPath` at
 *    all) — it is the asymmetry this helper exists to close.
 *
 * Never fires at all for a project that isn't `vaultOnly` (returns `vaultOnlyPatch: undefined`
 * unconditionally) — only project CREATE may ever set the fact `true`; this function never does.
 *
 * @decision b98957e9 — do not reproduce this per-surface; every repoPath/vaultPath update surface must
 * call this ONE helper, never a hand-rolled copy of the clear-on-divergence check.
 */
export function checkVaultOnlyOnUpdate(
  project: { repoPath: string; vaultPath: string; vaultOnly: boolean },
  patch: { repoPath?: string; vaultPath?: string },
): VaultOnlyUpdateCheck {
  if (!project.vaultOnly) return { ok: true, vaultOnlyPatch: undefined };
  if (patch.repoPath === undefined && patch.vaultPath === undefined) return { ok: true, vaultOnlyPatch: undefined };
  const effectiveRepoPath = patch.repoPath ?? project.repoPath;
  const effectiveVaultPath = patch.vaultPath ?? project.vaultPath;
  if (canonicallyPaired(effectiveRepoPath, effectiveVaultPath)) return { ok: true, vaultOnlyPatch: undefined };
  if (patch.repoPath !== undefined) return { ok: true, vaultOnlyPatch: false };
  return {
    ok: false,
    error: "moving a vault-only project's vaultPath away from its repoPath would unpair it (it has no separate repoPath) — move repoPath and vaultPath together to relocate it, or archive the project instead",
  };
}
