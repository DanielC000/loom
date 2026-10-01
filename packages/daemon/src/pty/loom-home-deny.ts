import path from "node:path";
import type { SessionRole } from "@loom/shared";
import { LOOM_HOME, LOOM_HOME_WRITE_DENY_REGISTRY, LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY } from "../paths.js";
import { canonicalizeExistingPath, comparisonKey } from "../projects/repos.js";

/**
 * LOOM_HOME, resolved through the SAME junction/symlink-collapsing helper every other path-identity
 * check in this repo uses (`canonicalizeExistingPath` — git/repo-lock.ts, projects/repos.ts,
 * vault/versioner.ts), resolved ONCE at module load (LOOM_HOME never changes at runtime) and forward-
 * slashed to match the CLI's gitignore-style deny-rule syntax on Windows. A raw, unresolved `LOOM_HOME`
 * string — what `SETTINGS_DIR_READ_DENY_RULE` (claude-settings.ts) uses today — can be bypassed via a
 * junction/symlink alias; this module deliberately does not repeat that gap for the broader write deny.
 */
export const LOOM_HOME_REAL = canonicalizeExistingPath(LOOM_HOME).replace(/\\/g, "/");

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Convert an absolute, forward-slashed path into the Claude Code CLI's documented UNIVERSAL-ABSOLUTE
 * glob form — `//<path>` on POSIX, `//<drive-letter>/<rest>` on Windows (lowercase drive, no colon). A
 * single leading slash is documented as relative to the SETTINGS FILE's own directory, not an absolute
 * anchor, so a bare `Edit(/home/u/.loom/**)` from a --settings file probably matches nothing real on
 * POSIX. This is the ONE helper that emits the documented form, used for every rule this module builds,
 * on every OS — see card 37310431's decision record, Ruling A.
 */
export function toClaudeAbsoluteGlob(absPath: string): string {
  const slashed = toForwardSlash(absPath);
  const winDrive = /^(?<drive>[A-Za-z]):\/(?<rest>.*)$/.exec(slashed);
  if (winDrive?.groups) {
    return `//${winDrive.groups.drive!.toLowerCase()}/${winDrive.groups.rest}`;
  }
  return `/${slashed}`;
}

/** A directory gets a recursive `Edit(<path>/**)` glob; a file gets an exact `Edit(<path>)` — the CLI's
 *  matcher only accepts the literal form for a file (confirmed: `Write(...)` entries are REJECTED
 *  outright, and only `Edit(...)` is a recognized rule name — see the card 37310431 decision record). */
function ruleFor(absPath: string, kind: "file" | "dir"): string {
  const p = toClaudeAbsoluteGlob(absPath);
  return kind === "dir" ? `Edit(${p}/**)` : `Edit(${p})`;
}

export interface LoomHomeDenyOptions {
  role?: SessionRole | null;
  sessionId: string;
  /**
   * The reserved "Loom Platform" project's CURRENT bound roots, resolved by the caller from the DB/service
   * PER SPAWN. `repoPaths` is a SET of candidates (CLAUDE.md/`.claude/**`'s readers); `vaultPath` is
   * single-valued (the resume doc's root). Each instruction-registry entry names which it follows via its
   * `platformRoot` field (`paths.ts`). `undefined`/empty-and-null ⇒ the instruction registry is emitted at
   * LOOM_HOME_REAL only, unchanged from before this field existed.
   *
   * @decision 37310431 — `repoPaths` must stay a set built from `project.repoPath` UNIONED with
   * `db.listSessionCwdsForProjectRole`'s live/resumable platform-role session cwds, never `project.repoPath`
   * alone: a Lead's `cwd` is pinned at spawn/recycle and outlives a rebind (card 00a999e8). See record.
   */
  platformHomePaths?: { repoPaths?: readonly string[] | null; vaultPath?: string | null } | null;
}

/**
 * Build the Edit() deny rules protecting LOOM_HOME's known-sensitive paths from a spawned agent's own
 * native Edit/Write/Bash tools. Round 2 (card 37310431): a FLAT map over the STATIC registry
 * (`paths.ts#LOOM_HOME_WRITE_DENY_REGISTRY`) — no live `readdirSync` pass — UNIONED with a PER-ENTRY
 * role-conditional second registry (`LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY`) that denies files a
 * more-privileged FUTURE session reads as instructions (`PLATFORM-LEAD-RESUME*.md`/`CLAUDE.md`/
 * `.claude/**`). Delta security review, item 1: each instruction entry carries its OWN
 * `exemptRoles` (today, `platform` only, for every entry — see that registry's own doc for why `setup`
 * is deliberately NOT a blanket exemption) rather than one shared exempt-role set, so a future entry can
 * have a different exemption without widening every other entry's. A plain, human-driven session
 * (`role===null`) is exempt from the WHOLE instruction registry unconditionally — checked once, below,
 * since `null` isn't a member of `SessionRole` and can't live in any entry's `exemptRoles`. `sessionId`
 * is accepted (interface stability) but UNUSED — there is no sessionId-keyed logic anywhere in this file.
 *
 * Card 00a999e8 (round 3, Code Review): each instruction-registry entry is ALSO emitted rooted at EVERY
 * candidate named by whichever of `opts.platformHomePaths.repoPaths`/`.vaultPath` its OWN `platformRoot`
 * field picks — never both fields for one entry, and never a single shared root for the whole registry —
 * canonicalized through the same `canonicalizeExistingPath` helper LOOM_HOME_REAL uses (so a junction/
 * symlink alias of a rebound home can't slip the deny either), skipping a candidate that resolves to the
 * SAME real path as LOOM_HOME_REAL. This is deliberately per-entry: `PLATFORM-LEAD-RESUME*.md` is resolved
 * by `resolvePlatformLeadResumeDocPath`, passed `project.vaultPath` explicitly, while `CLAUDE.md`/
 * `.claude/**` are read by the harness itself relative to the session's spawn CWD — pinned at spawn/recycle,
 * never re-derived from the project row — so a rebind that moves `repoPath` and `vaultPath` APART needs
 * both entries covered at their own, independently-resolved root; rooting every entry at one shared path
 * (round 2 of this fix did) left whichever path an entry does NOT actually follow silently uncovered. And
 * `repoPaths` is deliberately a SET, not one path: a LIVE or still-resumable Platform Lead lineage keeps
 * reading whatever `cwd` it was spawned/recycled with even after `project.repoPath` is rebound forward —
 * see the decision record's "Round 3" note and `LoomHomeDenyOptions.platformHomePaths`'s own doc above.
 * When a given entry's own candidate set is empty, unresolvable, or every candidate equals LOOM_HOME_REAL
 * (the common case — not yet rebound, or LOOM_DEV off so the Platform project was never seeded), that
 * entry's rebound pass is a pure no-op.
 *
 * @decision 37310431 — do not reintroduce a live-disk enumeration here. See record for the Platform/Setup
 * homes incident that round 1's "deny everything present" design broke.
 */
export function loomHomeWriteDenyRules(opts: LoomHomeDenyOptions): string[] {
  const rules = new Set<string>();
  for (const entry of LOOM_HOME_WRITE_DENY_REGISTRY) {
    rules.add(ruleFor(path.join(LOOM_HOME_REAL, entry.relPath), entry.kind));
  }
  const role: SessionRole | null = opts.role ?? null;
  if (role !== null) {
    for (const entry of LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY) {
      if (entry.exemptRoles.includes(role)) continue;
      rules.add(ruleFor(path.join(LOOM_HOME_REAL, entry.relPath), entry.kind));
      const candidates = entry.platformRoot === "repoPath"
        ? (opts.platformHomePaths?.repoPaths ?? [])
        : (opts.platformHomePaths?.vaultPath ? [opts.platformHomePaths.vaultPath] : []);
      for (const candidate of candidates) {
        if (!candidate) continue;
        const reboundReal = canonicalizeExistingPath(candidate).replace(/\\/g, "/");
        if (comparisonKey(reboundReal) !== comparisonKey(LOOM_HOME_REAL)) {
          rules.add(ruleFor(path.join(reboundReal, entry.relPath), entry.kind));
        }
      }
    }
  }
  return [...rules];
}

/** Union `loomHomeWriteDenyRules(opts)` into `permission.deny`, de-duped, never replacing. The MAIN
 *  registry is unconditional across every role; the INSTRUCTION registry is role-dependent per-entry
 *  (see `loomHomeWriteDenyRules`'s own doc) — both are already folded into its single output, so this
 *  function itself has nothing further to decide. */
export function withLoomHomeWriteDenyForSpawn<P extends { deny: string[] }>(permission: P, opts: LoomHomeDenyOptions): P {
  const rules = loomHomeWriteDenyRules(opts);
  const missing = rules.filter((r) => !permission.deny.includes(r));
  if (!missing.length) return permission;
  return { ...permission, deny: [...permission.deny, ...missing] };
}
