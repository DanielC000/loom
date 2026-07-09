/**
 * Companion Capability & Permission-Lever Framework — §2, the plug-in pattern (one enforcement point, not
 * one per lever). See `Projects/Loom/Design/Companion Capability & Permission-Lever Framework.md` (vault).
 *
 * A capability is enabled by the PRESENCE of a `companion_capability_grants` row (db.ts): no grant ⇒ its
 * tools are never registered on the companion's MCP surface, so it stays inert + invisible — mirroring the
 * existing `chat_reply`/`skill_*`/`memory_*`/`reminder_*` per-session companion gate
 * (`companionSessionIds.has(sessionId)` in mcp/orchestration.ts). `resolveCompanionGrant` is the ONE
 * enforcement gate every lever is read through; `registerCompanionCapabilities` is the single chokepoint
 * that iterates the registry once per `buildServer` call. Every lever's tool handler ALSO re-checks scope
 * at call time (belt-and-suspenders — mirrors why companion/factory.ts re-scopes bindings even though the
 * controller already dispatches by session id): a bug in registration-gating alone must not open the door.
 */
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionRole } from "@loom/shared";
import type { Db } from "../db.js";
import { listProjectTasks, type TaskSummary } from "../mcp/tasks.js";
import { listVaultTree, readVaultFile, statVaultFile } from "../vault/browser.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** The lever catalog (Framework §4). Only `session-status` is BUILT by this card — the rest are named here
 *  so the grants REST validator (gateway/server.ts) can reject an unknown/typo'd slug now, before their
 *  own cards land, without a REST change per lever. */
export const COMPANION_CAPABILITY_SLUGS = [
  "session-status", "decisions-relay", "attention-push", "session-steer",
  "board-reach", "vault-read", "media-out",
] as const;
export type CapabilitySlug = (typeof COMPANION_CAPABILITY_SLUGS)[number];

/** One project's resolved {mode, config} within a capability's scope — see {@link ResolvedGrantScope}. */
export interface ProjectGrant {
  mode: "read" | "act";
  config: Record<string, unknown>;
}

/**
 * One capability's resolved scope for ONE companion session — PER-PROJECT, never a cross-project collapsed
 * value. This is load-bearing (CR fix): the design note's invariant is "a read grant NEVER implies act" —
 * a companion granted `read` on project A and `act` on project B must NOT let a lever treat project A as
 * act-eligible. Collapsing to a single scope-wide mode (the pre-CR shape) would let a lever that checks
 * `scope.mode === 'act'` act on EVERY granted project once ANY one of them was act-granted — a per-project
 * privilege escalation, on the most-injection-exposed surface in Loom. So a lever asks about the SPECIFIC
 * project it is acting on (`modeFor`/`mayAct`/`configFor`), never the scope as a whole. `projectIds` is the
 * convenience for a READ-ONLY lever (like `session-status`) that only needs "which projects am I scoped
 * to" and never reads mode/config at all.
 */
export interface ResolvedGrantScope {
  /** Every granted project id for this capability — for a lever that only needs the SET (no mode/config
   *  read), e.g. session-status iterating which projects' sessions to report. */
  projectIds: Set<string>;
  /** This capability's resolved mode for ONE project, or undefined if that project isn't granted at all. */
  modeFor(projectId: string): "read" | "act" | undefined;
  /** True iff `projectId` is granted with mode 'act' (false for 'read', false for ungranted). */
  mayAct(projectId: string): boolean;
  /** This capability's resolved config for ONE project (that project's own row's config_json — never
   *  merged with another project's), or `{}` if that project isn't granted. */
  configFor(projectId: string): Record<string, unknown>;
}

/**
 * THE enforcement gate (Framework §2). Reads `companion_capability_grants` PER-SESSION (never the global
 * table — mirrors the bindings read pattern) filtered to one capability slug, and resolves the rows into a
 * PER-PROJECT {@link ResolvedGrantScope} (see its doc for why per-project, not collapsed). A grant row's
 * `projectId: null` resolves to the companion's OWN bound project (`db.getSession(sessionId).projectId`) —
 * the narrow default (Framework §1). If a NULL-project row and an explicit row for that SAME actual project
 * id both somehow exist (a human REST edge case — the two are distinct natural keys even when they resolve
 * to the same project), the one with the later `created_at`/rowid wins (rows are read in that order) — a
 * deterministic, documented tie-break rather than an undefined one. Returns `null` when there is no grant
 * for this capability (⇒ the caller must not register the lever's tools), or when every resolvable row's
 * project turns out to be unknown (e.g. a NULL-project row on a session with no bound project) — never
 * returns an empty-but-truthy scope.
 *
 * Tolerates a `db` that doesn't implement `listCompanionCapabilityGrantsForSession` (a minimal test double
 * built before this table existed, e.g. a bare `{ getSession }` stub used to unit-test `resolveRole`/MCP
 * tool-surface shape elsewhere in the daemon test suite) by treating it the SAME as "no grant row" — never
 * throwing. That's the semantically correct answer, not just a defensive shim: a store that can't even
 * list grants genuinely has none, so every capability stays OFF, which is exactly the byte-identical
 * default this framework promises for every session it doesn't know about.
 */
export function resolveCompanionGrant(db: Db, sessionId: string, capability: string): ResolvedGrantScope | null {
  if (typeof db.listCompanionCapabilityGrantsForSession !== "function") return null;
  const rows = db.listCompanionCapabilityGrantsForSession(sessionId).filter((g) => g.capability === capability);
  if (rows.length === 0) return null;
  const ownProjectId = db.getSession(sessionId)?.projectId ?? null;
  const perProject = new Map<string, ProjectGrant>();
  for (const row of rows) {
    const pid = row.projectId ?? ownProjectId;
    if (!pid) continue;
    perProject.set(pid, { mode: row.mode, config: row.config });
  }
  if (perProject.size === 0) return null;
  return {
    projectIds: new Set(perProject.keys()),
    modeFor: (projectId) => perProject.get(projectId)?.mode,
    mayAct: (projectId) => perProject.get(projectId)?.mode === "act",
    configFor: (projectId) => perProject.get(projectId)?.config ?? {},
  };
}

/** Per-lever registration context — `sessionId`/`scope` are SERVER-DERIVED (never agent-passed); a lever's
 *  `register()` closes over these to pre-scope every tool it adds. */
export interface GrantContext {
  sessionId: string;
  scope: ResolvedGrantScope;
}

/** One pluggable lever descriptor (Framework §2). `register` adds THIS lever's tools to `server`, already
 *  pre-scoped via `ctx` — the registry loop below is the only place that decides WHETHER a lever mounts. */
export interface CompanionCapability {
  slug: CapabilitySlug;
  supportsMode: readonly ("read" | "act")[];
  register(server: McpServer, ctx: GrantContext, db: Db): void;
}

/**
 * `session-status` (Framework §4, `d12fda07` read half) — the proof-of-pattern READ lever: a read-only
 * `sessions_status` tool reporting which sessions are live (+ status + current task) across the granted
 * projects. Lowest-risk lever in the catalog (no writes, no injection-guard primitives needed) — this is
 * the template every later lever copies.
 */
const SESSION_STATUS: CompanionCapability = {
  slug: "session-status",
  supportsMode: ["read"],
  register(server, ctx, db) {
    server.registerTool(
      "sessions_status",
      {
        description:
          "Read-only view of live sessions in your granted project(s): which are live, their busy/process " +
          "state, and their current task (if any). Optionally pass `project` (a project id) to narrow to " +
          "ONE of your granted projects — passing a project you were NOT granted is rejected with an " +
          "{error}; omitting it returns every granted project's live sessions.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const sessions = db.listAllSessions()
          .filter((s) => s.processState === "live" && !!s.projectId && targetProjects.has(s.projectId))
          .map((s) => ({
            sessionId: s.id, projectId: s.projectId, projectName: s.projectName,
            role: s.role ?? null, busy: s.busy, processState: s.processState,
            taskId: s.taskId ?? null, title: s.title ?? null,
          }));
        return ok({ sessions });
      },
    );
  },
};

/**
 * `decisions-relay` READ half (Framework §4) — a read-only `decisions_list` tool reporting PENDING
 * decision-inbox questions (Framework's manager→human `Question`/`QuestionInboxItem`, db.ts) across the
 * granted projects. Mirrors `SESSION_STATUS` exactly. This card builds ONLY the read tool — the ACT half
 * (`decision_resolve`, letting the companion answer a question) is a LATER card gated on injection-guard
 * primitives + owner sign-off: a companion surface is the most injection-exposed one in Loom, so a
 * write/resolve path must not ship ahead of its guard.
 */
const DECISIONS_RELAY: CompanionCapability = {
  slug: "decisions-relay",
  supportsMode: ["read", "act"],
  register(server, ctx, db) {
    server.registerTool(
      "decisions_list",
      {
        description:
          "Read-only view of PENDING decision-inbox questions (manager asks awaiting a human answer) in " +
          "your granted project(s). Optionally pass `project` (a project id) to narrow to ONE of your " +
          "granted projects — passing a project you were NOT granted is rejected with an {error}; " +
          "omitting it returns every granted project's pending decisions.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const decisions = db.listOpenQuestions()
          .filter((q) => targetProjects.has(q.projectId))
          .map((q) => ({
            questionId: q.id, projectId: q.projectId, projectName: q.projectName,
            sessionId: q.sessionId, title: q.title, body: q.body, options: q.options,
            recommendation: q.recommendation, state: q.state, createdAt: q.createdAt,
          }));
        return ok({ decisions });
      },
    );
  },
};

/**
 * `board-reach` READ half (Framework §4) — a read-only `board_list` tool giving the companion
 * cross-project board visibility over its granted projects' cards. Mirrors SESSION_STATUS/
 * DECISIONS_RELAY exactly. This card builds ONLY the read tool — the ACT half (create card, move
 * column, set priority, set held) is a LATER card gated on injection-guard primitives + owner
 * sign-off: a write path on the most injection-exposed surface in Loom must not ship ahead of its
 * guard.
 */
const BOARD_REACH: CompanionCapability = {
  slug: "board-reach",
  supportsMode: ["read", "act"],
  register(server, ctx, db) {
    server.registerTool(
      "board_list",
      {
        description:
          "Read-only view of board cards (done/terminal cards excluded, mirroring tasks_list's default) " +
          "in your granted project(s): id, title, column, priority, position, last-updated, and which " +
          "project each card belongs to. Optionally pass `project` (a project id) to narrow to ONE of " +
          "your granted projects — passing a project you were NOT granted is rejected with an {error}; " +
          "omitting it returns every granted project's cards.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const cards = [...targetProjects].flatMap((pid) => {
          const projectName = db.getProject(pid)?.name ?? null;
          return (listProjectTasks(db, pid, { excludeDone: true }) as TaskSummary[]).map((t) => ({
            id: t.id, title: t.title, columnKey: t.columnKey, priority: t.priority,
            position: t.position, updatedAt: t.updatedAt, projectId: pid, projectName,
          }));
        });
        return ok({ cards });
      },
    );
  },
};

// --- `vault-read` (Framework §4) — bounds + the security exclusion ------------------------------------

/** Note extensions `vault_lookup` will ever read. Never a binary (image/pdf/etc.) — the vault browser's
 *  content-type map exists for the raw-serving route, not for a text-search tool. */
const VAULT_SEARCH_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** Path SEGMENTS that are NEVER searched/read, regardless of extension — a security FLOOR (err toward
 *  excluding). Checked against every segment of the vault-relative path (case-insensitive), so a note
 *  living at ANY depth under one of these folder names is excluded, not just at the top level. */
const VAULT_DENIED_SEGMENTS = new Set([
  "secrets", ".secrets", "private", "credentials", ".ssh", ".aws", ".gnupg", ".gpg", "keys", "passwords", "password",
]);

/** Basename patterns that are NEVER searched/read, regardless of the extension allow-list above —
 *  belt-and-suspenders (a `.env`/`.pem`/`.key` is excluded BOTH by extension and by this deny-list). */
const VAULT_DENIED_BASENAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, ...
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
];

/**
 * The mandatory security exclusion (Framework §4 `vault-read` DoD): denies any candidate note whose
 * basename or ANY path segment looks like a secret/credential, BEFORE `readVaultFile` is ever called on
 * it. This is a FLOOR, not a substitute for the extension allow-list above — both must agree a note is
 * safe. Checked on the vault-relative path (forward-slash, per `VaultEntry`), never a resolved absolute
 * path (`readVaultFile`'s own traversal/symlink-escape guard is untouched and still runs on top of this).
 */
function isDeniedVaultPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((seg) => VAULT_DENIED_SEGMENTS.has(seg.toLowerCase()))) return true;
  const basename = segments[segments.length - 1] ?? "";
  return VAULT_DENIED_BASENAMES.some((rx) => rx.test(basename));
}

/**
 * Per-note opt-out: a leading `---\n…\n---` frontmatter block setting `companion-read: false` (or
 * `no`/`off`, quoted or bare, case-insensitive) excludes that note from `vault_lookup` even though it
 * isn't otherwise secret-shaped. NOTE: no existing vault sensitivity/exclusion marker was found in
 * `vault-lint.mjs` or `vault/browser.ts` (checked before building this) — `companion-read: false` is the
 * convention THIS lever introduces; a future vault sensitivity feature should adopt/rename this rather
 * than add a second, competing marker. Deliberately narrow (a falsy-literal match, not a full YAML
 * parse) — this tool has no other use for frontmatter.
 *
 * CR fix: `readVaultFile` reads utf8 WITHOUT stripping a leading BOM (`﻿`), which is realistic on
 * this Windows-primary host (VSCode/PowerShell commonly write one) — an un-stripped BOM sits before the
 * `---` and silently defeats the `^---` anchor, so a BOM-prefixed opt-out note would get searched anyway.
 * Strip a single leading BOM before matching, here (the only place this content is inspected for
 * frontmatter) rather than at the shared `readVaultFile` reader, which has other callers.
 */
function hasCompanionReadOptOut(content: string): boolean {
  const unbommed = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(unbommed);
  if (!fm) return false;
  return /^\s*companion-read\s*:\s*["']?(false|no|off)["']?\s*$/im.test(fm[1] ?? "");
}

const VAULT_LOOKUP_MAX_RESULTS = 15; // bounded result list — this is an injection-exposed surface
const VAULT_LOOKUP_MAX_SCANNED = 500; // total notes read across ALL target projects, one `vault_lookup` call
const VAULT_LOOKUP_EXCERPT_RADIUS = 130; // chars either side of the match (~260 char excerpt window)
// CR fix: a per-file byte cap, checked via `statVaultFile` BEFORE the full synchronous `readFileSync` +
// `.toLowerCase()` that `readVaultFile`/the match below perform — without this, one pathological huge
// note (a pasted multi-hundred-MB log) read + lowercased synchronously on the event loop can spike
// memory and freeze the daemon (the sync-hot-path hazard this repo's CLAUDE.md flags elsewhere, e.g.
// worktree provisioning). An oversize note is skipped, never read.
const VAULT_LOOKUP_MAX_FILE_BYTES = 512 * 1024;

/**
 * `vault-read` READ lever (Framework §4) — a read-only `vault_lookup` tool letting the companion search a
 * granted project's Obsidian vault notes and answer from real docs, citing a path + excerpt. Read-only —
 * there is no act half for this lever. Mirrors SESSION_STATUS/DECISIONS_RELAY/BOARD_REACH's grant-scoping
 * shape exactly; the part unique to this lever is the mandatory security exclusion above, applied to every
 * candidate note BEFORE it is ever read, on top of `readVaultFile`'s own traversal/symlink guard.
 *
 * RESIDUAL RISK (documented, not fixed here — owner-escalated separately): the deny-list + extension
 * floor above guard secret-SHAPED files (`.env`, keys/certs, a `secrets/`-named folder, …), NOT secret
 * CONTENT — a credential pasted into an ordinary `.md` note is still searchable and returnable in an
 * excerpt. That is an inherent tradeoff of "let the companion read your notes," bounded by three things:
 * this lever is granted per-project (opt-in, default OFF), the whole tool is read-only, and any individual
 * note can opt out via `companion-read: false` frontmatter. This is NOT a content-redaction/secret-
 * scanning heuristic — building one is a deliberate, separate decision, not assumed here.
 */
const VAULT_READ: CompanionCapability = {
  slug: "vault-read",
  supportsMode: ["read"],
  register(server, ctx, db) {
    server.registerTool(
      "vault_lookup",
      {
        description:
          "Search your granted project(s)' Obsidian vault notes for `query` (case-insensitive, matched " +
          "against note text and its path/title) and return matching notes as {projectId, projectName, " +
          "path, excerpt} — `path` is a citable vault-relative note path, `excerpt` a short window around " +
          "the match. Optionally pass `project` (a project id) to narrow to ONE of your granted projects — " +
          "passing a project you were NOT granted is rejected with an {error}; omitting it searches every " +
          `granted project's vault. Read-only, bounded to at most ${VAULT_LOOKUP_MAX_RESULTS} results ` +
          `(oversize notes over ${VAULT_LOOKUP_MAX_FILE_BYTES / 1024} KiB are skipped). Secret/credential-` +
          "shaped notes (.env files, key/cert files, anything under a secrets/private/credentials/keys/" +
          "passwords/.ssh/.aws/.gnupg folder) and any note opting out via a `companion-read: false` " +
          "frontmatter flag are never searched or returned.",
        inputSchema: { query: z.string(), project: z.string().optional() },
      },
      async ({ query, project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const q = query.trim().toLowerCase();
        if (!q) return ok({ error: "query must not be empty" });
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;

        const results: Array<{ projectId: string; projectName: string | null; path: string; excerpt: string }> = [];
        let scanned = 0;
        search: for (const pid of targetProjects) {
          const proj = db.getProject(pid);
          if (!proj?.vaultPath) continue; // no vault bound to this project — skip gracefully, no throw
          const projectName = proj.name ?? null;
          for (const entry of listVaultTree(proj.vaultPath)) {
            if (entry.type !== "file") continue;
            const ext = path.extname(entry.path).toLowerCase();
            if (!VAULT_SEARCH_EXTENSIONS.has(ext)) continue; // never read a binary/non-note file
            if (isDeniedVaultPath(entry.path)) continue; // security floor — checked BEFORE any read
            if (scanned >= VAULT_LOOKUP_MAX_SCANNED) break search;
            const stat = statVaultFile(proj.vaultPath, entry.path); // same guard, size WITHOUT a full read
            if (stat === null) continue;
            if (stat.size > VAULT_LOOKUP_MAX_FILE_BYTES) continue; // oversize note — skip, never read
            scanned++;
            const content = readVaultFile(proj.vaultPath, entry.path); // guarded traversal/symlink read
            if (content === null) continue;
            if (hasCompanionReadOptOut(content)) continue; // per-note companion-read:false opt-out
            const matchIdx = content.toLowerCase().indexOf(q);
            const titleMatch = entry.path.toLowerCase().includes(q);
            if (matchIdx === -1 && !titleMatch) continue;
            const start = matchIdx === -1 ? 0 : Math.max(0, matchIdx - VAULT_LOOKUP_EXCERPT_RADIUS);
            const end = matchIdx === -1
              ? Math.min(content.length, VAULT_LOOKUP_EXCERPT_RADIUS * 2)
              : Math.min(content.length, matchIdx + q.length + VAULT_LOOKUP_EXCERPT_RADIUS);
            const excerpt = content.slice(start, end).trim();
            results.push({ projectId: pid, projectName, path: entry.path, excerpt });
            if (results.length >= VAULT_LOOKUP_MAX_RESULTS) break search;
          }
        }
        return ok({ results });
      },
    );
  },
};

/** The full lever registry (Framework §2). `session-status`, `decisions-relay`'s READ half,
 *  `board-reach`'s READ half, and `vault-read` (read-only, no act half) are built — the sensitive ACT
 *  levers (later cards) append here behind their own injection-guard primitives. */
export const COMPANION_CAPABILITIES: readonly CompanionCapability[] =
  [SESSION_STATUS, DECISIONS_RELAY, BOARD_REACH, VAULT_READ];

/**
 * The single chokepoint (Framework §2): called ONCE per `buildServer`, right after the existing companion
 * gated-tool registrations. For each catalog lever, resolves its grant (`resolveCompanionGrant`) and — iff
 * granted — calls its `register()`, pre-scoped. A lever whose grant is absent is never registered: adding a
 * 7th lever adds a registry entry + a `register()`, not a 7th place to check permission.
 *
 * Defense-in-depth ROLE gate (CR hardening): a grant is only ever meaningful on a companion (`assistant`-
 * role) session — the REST writer already enforces that at write time (`resolveCompanionAgent` requires
 * role==="assistant") and role is immutable once spawned, so this is inert today. It's here anyway to match
 * the sibling `companionSessionIds.has(sessionId)` gate on chat_reply, skill_*, memory_*, and reminder_*:
 * the most injection-exposed surface in Loom should never depend on a SINGLE layer (grant presence alone)
 * staying correct forever — a future bug that leaves a stale grant row on a non-assistant session id must
 * not be enough, by itself, to light up a capability tool there.
 */
export function registerCompanionCapabilities(server: McpServer, sessionId: string, role: SessionRole, db: Db): void {
  if (role !== "assistant") return;
  for (const cap of COMPANION_CAPABILITIES) {
    const scope = resolveCompanionGrant(db, sessionId, cap.slug);
    if (!scope) continue;
    cap.register(server, { sessionId, scope }, db);
  }
}
