import type { SessionRole } from "@loom/shared";

/**
 * Pure, dependency-free helpers that compose the `-n <name>` Loom stamps on every fresh `claude` spawn
 * (card f9b47cd1) so a session is legible in Claude Code's own resume picker (`/resume`, prompt box,
 * terminal title) instead of the useless auto-default (a worker in a `loom/<hash>` worktree renders as
 * `3cccf1476f4f-XX`). Loom itself resumes by ENGINE SESSION ID, never by this name — so everything here
 * is purely additive legibility; nothing downstream depends on the exact string produced.
 *
 * Centralized here (prefix, per-segment caps, role→tag table) so a future scheme tweak is a one-liner,
 * per the owner-approved card. Consumed by `pty/host.ts` (buildSpawnArgs' `-n` emission, version-gated at
 * the createPty chokepoint) and `sessions/service.ts` (every fresh-spawn call site computes ITS name here
 * and threads it as `SpawnOpts.sessionName`; resume/fork spawns omit it — see buildSpawnArgs' doc).
 */

/**
 * The Claude Code version that introduced session naming (`-n`/`--name`; docs: sessions.md). Below this
 * — or when the installed version can't be read/parsed at all — the `-n` flag MUST be omitted entirely:
 * an older claude REJECTS the unknown flag and would break EVERY spawn (the load-bearing gate-free
 * recipe; see CLAUDE.md's spawn invariants). The gate consumes usage-status.ts's cached
 * `getCachedClaudeVersion()` — a NON-BLOCKING read, never a fresh probe from the spawn hot path.
 */
export const MIN_SESSION_NAME_VERSION = "2.1.196";

function parseVersionTuple(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * true iff `version` parses as an `X.Y.Z`-prefixed string that is >= `min` (default
 * {@link MIN_SESSION_NAME_VERSION}). `version` null/undefined/unparseable, or `min` unparseable ⇒ false
 * — FAILS CLOSED: never emit `-n` against a version we couldn't positively confirm supports it.
 */
export function meetsMinVersion(version: string | null | undefined, min: string = MIN_SESSION_NAME_VERSION): boolean {
  if (!version) return false;
  const a = parseVersionTuple(version);
  const b = parseVersionTuple(min);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  if (a[2] !== b[2]) return a[2] > b[2];
  return true; // equal
}

const LOOM_PREFIX = "loom";
// Per-segment caps chosen so the common case lands well inside the card's "~40 chars" target
// (`loom-` + project + `-` + agent + `-` + task ⇒ 5 + 16 + 1 + 12 + 1 + 16 = 51 worst-case, typically far
// shorter since the agent segment usually hits the short-slug table below and titles rarely max out).
const MAX_PROJECT_SEG = 16;
const MAX_AGENT_SEG = 12;
const MAX_TASK_SEG = 16;

// Unicode combining diacritical marks (U+0300-U+036F) — stripped after NFKD decomposition so e.g. "é"
// (which NFKD splits into "e" + a combining acute accent) folds to plain "e" instead of being dropped
// entirely by the ASCII-only slug pass below.
const DIACRITIC_MARKS_RE = /[̀-ͯ]/g;

/**
 * Lowercase, ASCII-fold (NFKD decompose + drop combining diacritics, so e.g. "Café" → "cafe" rather than
 * being dropped), collapse any run of non `[a-z0-9]` to a single `-`, trim leading/trailing `-`, cap to
 * `maxLen` (trimming a trailing `-` left by the cut). A result that's empty after folding (pure emoji/
 * CJK/punctuation input, or an empty string) falls back to `fallback` — a session name segment must never
 * be empty.
 */
export function slugify(input: string, maxLen: number, fallback: string): string {
  const folded = input.normalize("NFKD").replace(DIACRITIC_MARKS_RE, "").toLowerCase();
  let s = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/g, "");
  return s || fallback;
}

/**
 * Canonical worker-agent display names (the bundled default rigs — profiles/seed.ts) → their short
 * naming-scheme slug, per the owner-approved examples (dev/bugfix/qa/webdesign/review/planning/docs/
 * content). Matched case-insensitively against the agent's OWN (user-editable) name; an agent the human
 * renamed, or a custom rig outside this table, falls back to a plain {@link slugify} of its name — so
 * every agent still gets a legible, deterministic segment, just not the curated abbreviation.
 */
const AGENT_SHORT_SLUG: Readonly<Record<string, string>> = {
  "dev": "dev",
  "bugfix": "bugfix",
  "qa tester": "qa",
  "web designer": "webdesign",
  "code reviewer": "review",
  "planning & triage": "planning",
  "docs & vault": "docs",
  "content strategy": "content",
};

function agentSlug(agentName: string): string {
  return AGENT_SHORT_SLUG[agentName.trim().toLowerCase()] ?? slugify(agentName, MAX_AGENT_SEG, "agent");
}

/** First `n` whitespace-split words of `title`, rejoined with single spaces (slugified afterward by the caller). */
function firstWords(title: string, n: number): string {
  return title.trim().split(/\s+/).slice(0, n).join(" ");
}

/**
 * Role → its fixed `loom-<project>-<tag>` tag, per the finalized naming scheme. `worker` and `platform`
 * are DELIBERATELY absent — a worker's name carries agent+task (see {@link composeWorkerSessionName}) and
 * the Platform Lead carries no project segment at all (see {@link PLATFORM_LEAD_SESSION_NAME}), so
 * neither routes through this fixed-tag table.
 */
const ROLE_TAG: Readonly<Partial<Record<SessionRole, string>>> = {
  manager: "mgr",
  assistant: "comp",
  setup: "setup",
  auditor: "audit",
  "workspace-auditor": "wsaudit",
  run: "run",
  operator: "operator",
};

/**
 * Compose the `loom-<project>-<tag>` session name for every role EXCEPT worker/platform-lead (see
 * {@link ROLE_TAG}'s doc). `role` undefined — a role-less "+New"/plain session — groups with `run` under
 * the finalized scheme's "Plain/run" bucket, and so does any role this table doesn't (yet) recognize.
 */
export function composeRoleSessionName(role: SessionRole | undefined, projectName: string): string {
  const tag = (role && ROLE_TAG[role]) || "run";
  return `${LOOM_PREFIX}-${slugify(projectName, MAX_PROJECT_SEG, "project")}-${tag}`;
}

/** The Platform Lead sits ABOVE every project (Platform Manager doctrine) — no project segment, ever. */
export const PLATFORM_LEAD_SESSION_NAME = `${LOOM_PREFIX}-lead`;

/**
 * Compose a worker session name: `loom-<project>-<agent>-<taskslug>`. `taskTitle` null (a taskless
 * spawn — an ad-hoc spike/no-commit review with no board card) slugs to the fixed segment `adhoc` instead
 * of a task title. When the composed base name already collides with `existingNames` (this worker's
 * LIVE siblings — the caller derives that set from its own project/manager scope), a 4-char lowercase
 * disambiguator carved from `disambiguatorId` (e.g. the new session's own id) is appended so the two stay
 * distinguishable in the resume picker; `existingNames` defaults to empty (no collision check) for a
 * caller that hasn't computed sibling names.
 */
export function composeWorkerSessionName(
  projectName: string,
  agentName: string,
  taskTitle: string | null,
  disambiguatorId: string,
  existingNames: ReadonlySet<string> = new Set(),
): string {
  const project = slugify(projectName, MAX_PROJECT_SEG, "project");
  const agent = agentSlug(agentName);
  const task = taskTitle ? slugify(firstWords(taskTitle, 3), MAX_TASK_SEG, "task") : "adhoc";
  const base = `${LOOM_PREFIX}-${project}-${agent}-${task}`;
  if (!existingNames.has(base)) return base;
  const suffix = disambiguatorId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toLowerCase();
  return suffix ? `${base}-${suffix}` : base;
}
