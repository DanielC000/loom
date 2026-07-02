// `pnpm --filter @loom/daemon test:daemon` — run the daemon's HERMETIC, claude-free test suite,
// isolated BY CONSTRUCTION: every test runs in its OWN fresh temp LOOM_HOME, on a non-4317 LOOM_PORT,
// with LOOM_TEST=1 set. So "run the daemon tests" can NEVER touch the prod db (~/.loom/loom.db) or the
// prod daemon on :4317 — the failure mode that wiped prod on 2026-06-04 (see test/_guard.mjs + the
// db.ts prod-guard). Each test ALSO arms its own guard (import "./_guard.mjs"), so this envelope is
// belt-and-suspenders, not the only line of defence.
//
// Run after a build (the tests import dist/):  pnpm --filter @loom/daemon build && pnpm --filter @loom/daemon test:daemon
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "..", "test");

// The stable hermetic suite: every test below boots NO external daemon and spawns NO real `claude`
// (in-process Db/SessionService against a fake pty, or self-contained fs/git). Each is verified green.
const HERMETIC = [
  "prod-guard",               // the guard itself
  "orch-model", "dead-id", "boot-reconcile", "boot-reconcile-keep-work", "merge-done-crash-recovery", "restart-intent", "restart-fleet", "build-gate-integrity",
  "scheduler-auditor-budget", // auditors lifted out of the manager cap → their own small budget (hermetic, daemon-free)
  "scheduler-fire-failed",    // a thrown scheduled spawn records a durable schedule_fire_failed event (not just stderr)
  "restart-resume-coherence", // PL Auditor finding #11: resume nudges NOTE the file-read tracking reset; ONE coherent resume turn, no bare-"Continue" disclaimer (card 5d8dea5f)
  "restart-wake-classification", // card 5907b71e: cheap no-op wake for an unaffected bystander + completion-escalation de-dup (one completion = one turn)

  "manager-context-block", // PL Auditor finding #8: managers get the "Where things live" absolute repo+vault block; workers stay byte-identical
  "worker-prompt", // card af902717: workers get their agent base brief composed ahead of the kickoff (spawn) / handoff (recycle); empty brief degrades to dynamic-only
  "profiles", "profiles-crud", "profile-customization", "profile-spawn", "setup-profile", "setup-home", "browser-testing-spawn", "document-conversion-spawn", "restricted-tools-spawn", "markitdown-provision-nonblocking", "markitdown-prewarm", "markitdown-provision-diagnostic", "platform-dev-flag", "platform-home", "platform-home-rest", "platform-lead-multi", "platform-lead-recycle", "platform-mgmt-surface", "platform-elevated-surface", "platform-agent-update", "platform-config", "platform-messaging", "platform-cross-project-task", "project-rebind", "audit-surface", "setup-surface", "setup-bind-identity", "setup-singleton", "setup-first-run", "workspace-auditor-role", "user-audit-surface", "user-audit-handoff", "surface-subset", "workspace-auditor-start",
  "platform-prompt-migration",
  "envelope", // card 5ed5be7e: recoverable-secret AES-256-GCM envelope helper — round-trip, GCM tamper-detect, distinct-ciphertext-per-encrypt, lazy 0600 key file + reuse, wrong-key auth-tag failure
  "agent-runs-keys", "agent-runs-primitive", "agent-runs-profile-attrs", "agent-runs-rest", "agent-runs-idempotency", "agent-runs-caps", "agent-runs-spend", "agent-runs-hardening", "agent-runs-audit",
  "usage-history", // read-only historical token/cost aggregation over the runs table (totals + byProject/byAgent + projectId filter + since cutoff) and the GET /api/usage/history clamp/echo
  "usage-samples", // session usage telemetry DATA layer (epic c9924bcd card A): insert/aggregate/prune over session_usage_samples (totals + byProject/byAgent + byDay buckets + filter + cutoff) and GET /api/usage/sessions/history clamp/echo
  "usage-sampler", // session usage telemetry COLLECTION ENGINE (epic c9924bcd card B): the daemon sampler — tick delta (first-sight/incremental/zero) + reset (never negative) + teardown tail + tick-driven prune + one-time boot backfill, over a fake transcript (zero agent tokens)
  "audit-log", // replayable + diffable session/run audit log over the existing orchestration_events + sessions store (timeline + LCS/kind-delta diff + human-only REST)
  "tasks-filter", "tasks-priority", "task-delete", "task-column-guard", "kanban-columns-schema", "column-lifecycle", "column-presets", "preset-prompts", "preset-prompt-suggestions", "config-bounds", "config-rewire", "project-config-patch", "agent-override-host-exec-guard", "kanban-defaults", "transcript-encode", "alert-webhook",
  "ensure-obsidian", // card ab67eba3: Obsidian auto-start — config plumbing + human-only path gating + the vault preflight's gate/probe/fallback/launch-command construction (no real GUI launch)
  "session-archive", "session-list-summary", "all-archived-sessions", "periodic-snapshot", "shutdown-snapshot", "shutdown-endpoint", "csrf-rebind", "gateway-hardening", "mgmt-project-agent", "mgr-own-project-scope", "web-static-serve", "version", "cli-args", "cli-direct-invocation", "cli-service", "cli-channel", "update-check", "update-endpoint",
  "mcp-list-budget", // PL Auditor finding #5: default list_all_agents + audit list_sessions fit the token budget

  "claude-config", "trust-lock", "spawn-args", "disallow-prompt-tools",
  "context-watcher", "context-watcher-escalate", "context-stats", "recycle-handoff", "recycle-pending-carry", "spawn-allow-baseline", "fork-allow-baseline", "wake", "worker-reported-state", "crash-recovery-watcher", "busy-worker-watcher",
  "idle-watch-foundation", "idle-watcher", "idle-report", "inbox-pull", "usage-status", "rate-limit-clear", "rate-limit-cascade", "usage-limit-spawn-wake",
  "skills-inject", "skills-conditional", "skills-inject-durability", "skills-subset-spawn", "respawn-profile-attrs", "skills-store-durability", "skills-publish-drift", "skills-customization", "skills-adopt-fastforward", "skills-autoff-boot", "vault-lint", "vault-browser", "vault-raw", "vault-writer", "vault-versioner-wiring", "git-writer", "git-identity-warning",
  "worker-diff", "worktrees", "worktree-provision", "spawn-recut-stale-branch", "merge-finalize-resilient", "merge-confirm-idempotent", "merge-review-diffstat", "merge-stranded-backstop", "worker-report-precheck", "worker-report-pending-guard", "worker-report-orphan-wake", "worker-exited-without-report", "worker-spawn-agent-gate", "worker-spawn-task-gate", "worker-spawn-live-task-guard", "worker-spawn-toctou-race", "worker-spawn-cap-toctou-race", "worker-spawn-held-guard", "sibling-session-sweep", "project-config-column-orphan",
  "humanhold-migration", // Board Hold Model: the one-shot migrateHumanHoldToHeld boot migration — humanHold card promotion + idempotent column drop
  "worker-spawn-agent-name", // PL Auditor finding #10 (card 03615ee0): worker_spawn agentId by NAME/slug + "did you mean" nearest-match + lowest-position collision rule
  "agent-id-prefix", // card f9412b5e: unambiguous agent id-PREFIX resolves in worker_spawn + agent_get; ambiguous errors w/ candidates; id-shaped miss never names a wrong agent
  "worker-report-delivery-status", // card fc9a27d5: worker_report/platform_escalate DeliveryStatus enum + parked-parent wake
  "no-commit-reviewer", // card 14434d6b: a declared no-commit worker (Profile noCommit) auto-retires on 0-commit done (frees the cap slot, no worker_stop) + the forgot-to-commit warning is suppressed; a normal 0-commit worker still warns + stays live
  "merge-orphaned-to-main",

  "pty-busy-drain", "pty-coalesce-drain", "pty-route-coalesce", "pty-rate-limit-park-drain", "pty-composer-dirty", "pty-queue-mutations", "pty-queue-rest", "pty-resume-readiness", "pty-stop-queue", "pty-interrupt-redirect", "redirect-worker", "spawn-env", "queued-message-durability", "queued-message-liveflip-redrive", "graceful-stop", "resume-mode-cycles", "resume-mode-detect", "resume-mode-feedback", "resume-already-live-guard", "shell-terminal",
  "db-backup",
  "crashlog", // card c00be6e8: top-level fatal-exit handler writes a diagnosable crashlog under .loom; clean/restart exits don't
  "my-context-gate", // PL Auditor finding #9: my_context folds in the RESOLVED project gateCommand, READ-ONLY (no set/propose surface)
  "companion-loop", // Loom Companion: the end-to-end chat loop over the ChatGateway (inbound turn-submit + allowlist + chat_reply routed back to the bound chat, gated to the companion session)
  "companion-gateway", // Loom Companion Phase 1: adapter-interface CONFORMANCE — a fake adapter drives the gateway (inbound route/allowlist, busy≠dead, dead-session ack, multi-adapter chat_reply routing, >4096 chunking, transport-failure structured result)
  "companion-authz", // Loom Companion Phase 1 (SECURITY): per-binding sender authz — GROUP requires an allowlisted sender (missing/unlisted → hard reject, never submitted), DM single-owner, durable binding/allowlist round-trip + unique route index, default-OFF byte-identical, and no binding/allowlist/home tool on the orchestration MCP surface
  "companion-pairing", // Loom Companion (SECURITY): DM-pairing enrollment — owner-minted, single-use, TTL + rate-limited codes bind the AUTHENTICATED chat.id (dm-bind) or allowlist the AUTHENTICATED sender (group-sender); mint is human-only REST (plaintext once, salted hash at rest); no pairing oracle; the code text never reaches submitTurn; anti-spoof + cross-session guard
  "companion-telegram", // Loom Companion Phase 1: the Telegram adapter — grammY update normalization + send routing via an injected fake bot + inbound error boundary + reconnect-on-drop wiring
  "companion-in-app", // Loom Companion: the IN-APP channel (DEFAULT transport, no token/pairing) — inbound routes to the bound session via the bindings gate (config never consulted; unbound rejected — no self-provisioned route), outbound chat_reply reaches adapter.send framed for the web client, and the controller's stable handleInAppInbound indirection (off-safe, not cross-wired)
  "companion-skills", // Loom Companion Phase 2: SELF-AUTHORED skills — isolated per-companion store (never the global SKILLS_DIR / never injected), on-demand list/read, refine-in-place, redundancy guard against near-dup NEW names, path-traversal confinement, and the tools gated to the single bound companion session
  "companion-memory-store", // Loom Companion: SELF-AUTHORED memory storage layer — the generic per-companion store core shared with companion-skills, parameterized to MEMORY.md (name+description+pinned) under companionMemoryDir; CRUD, refine-in-place, redundancy guard, confinement against path traversal / absolute / percent-encoded names, PLUS the memory_write/memory_list/memory_read/memory_remove agent MCP tools gated to the single bound companion session (recall/turn-formation injection lands in companion-memory-recall)
  "companion-memory-recall", // Loom Companion: memory RECALL — the two-tier [loom:memory] digest (pinned entries in full, name-sorted; the rest as a compact name+description index, name-sorted) is byte-bounded EXACTLY (section headers + the "\n\n" join counted, not just raw content — verified at a mixed pinned+index boundary) with DETERMINISTIC truncation, framed as DATA/CONTEXT never instructions AND explicitly SILENT (never a reason to chat_reply on its own — mirrors DEFAULT_HEARTBEAT_PROMPT's stay-quiet-unless-worth-surfacing); a FRESH assistant spawn gets it appended to the composed startup prompt (empty memory ⇒ byte-identical), a RESUME gets it enqueued via the ordinary enqueueStdin turn primitive (a documented exception to "resume injects nothing" — resume() only reaches that code once per activation, so no separate once-flag is needed), and a non-assistant resume/spawn is entirely untouched
  "companion-config", // Loom Companion Phase 3 (SECURITY): DB-backed RUN config — bot token ENCRYPTED at rest (envelope), masked reads (configured + last-4 only, plaintext never returned/logged), env bootstrap + OVERRIDE precedence, enabled-row-alone boot, disabled/corrupt ⇒ OFF, default-OFF byte-identical, REST CRUD round-trip, no config/token tool on the companion MCP surface
  "companion-heartbeat", // Loom Companion (card 9488951e): proactive HEARTBEAT watcher — due/live-fire (framed [loom:heartbeat] + lastFiredAt + fired-event), cadence not-due, rate-limit PARK defer, not-live skip (never resumes), no pending-heartbeat stacking, DEFAULT-OFF (0 cadence + config default), and the deliverReply HOME fallback (unbound→home, bound→binding)
  "companion-reminders", // Loom Companion (Memory & Reminders Design, Surface 2 s3): the RECURRING reminders engine — N named cron reminders in their own companion_reminders table, generalizing the heartbeat's live/park-defer/no-stacking/restart-seed/route-carry disciplines per-row (framed [loom:reminder]:<id> + fired-event carrying reminderId), a fresh reminder waiting for its real cron boundary (not firing on creation), per-reminder no-stacking (two reminders never cross-suppress), enabled=false never firing, and DEFAULT-OFF byte-identical with zero rows
  "companion-lifecycle", // Loom Companion Phase 3: HOT lifecycle controller — a REST config write starts/re-arms/restarts/tears-down the RUNNING adapter+heartbeat with NO daemon restart (create-live starts adapter+binding+chat_reply+heartbeat, cadence change re-arms/disarms, token change restarts the adapter with no leaked long-poll, disable/delete → OFF byte-identical, toggle idempotency, and the REAL buildServer REST drives the same live controller)
  "companion-seed", // Loom Companion: the shipped default 'Companion' RIG — CORE seed-if-absent (ungated) of a role=assistant restrictedTools profile + a Companion agent bound to it into the reserved 'Platform' home with a light persona prompt; idempotent, never clobbers user edits, and (load-bearing) spawns NO session + writes NO companion_config (template only)
  "companion-provision", // Loom Companion (card cbc9fa68): the human-only one-shot POST /api/companion/provision — spawns an assistant session on the chosen rig (default Companion), writes a provisioned config + the in-app binding (+ a Telegram dm binding when a token is given), arms via reconcile (Telegram adapter ONLY with a token), rolls the spawned session back on a post-spawn write failure (no orphan), and retires a PROVISIONED session on delete but not a manually-bound one; token encrypted/masked, no MCP surface
  "companion-prompt-skills-rest", // Loom Companion: human-only REST for the companion's "brain" — GET/PUT /api/companion/prompt/:sessionId reads/writes the agent's own startupPrompt while ASSISTANT_BASE_BRIEF stays a read-only code constant (a request-body baseBrief can never override it), and GET (list+single) + DELETE /api/companion/skills/:sessionId serve/curate the SAME isolated per-companion skill store the companion authors over MCP; both resolve "the companion" by sessionId — 404 unknown session, 400 a non-assistant-role session; no MCP path, no author/write surface
  "companion-memory-rest", // Loom Companion: human-only REST for the companion's SELF-AUTHORED memory store — GET (list+single) + DELETE /api/companion/memory/:sessionId serve/curate the SAME isolated per-companion MEMORY.md store the companion authors over MCP (companion-memory-store.ts); resolves "the companion" by sessionId — 404 unknown session, 400 a non-assistant-role session, 404 an unknown/other-session memory name; no MCP path, no author/write surface, per-session isolated
  "companion-reminders-rest", // Loom Companion Reminders s5a: human-only REST to view/prune the companion's RECURRING reminders — GET (list) + DELETE /api/companion/reminders/:sessionId serve/curate the SAME `companion_reminders` rows the s3 watcher fires and the s4 MCP tool authors; resolves "the companion" by sessionId — 404 unknown session, 400 a non-assistant-role session, 404 an unknown/other-session reminder id; DELETE needs no controller rearm (the watcher re-reads listEnabledCompanionReminders fresh every tick); no MCP path, no author/write surface, per-session isolated
  "companion-restricted-tools-rest", // Loom Companion (live-apply fix): human-only GET/PUT /api/companion/restricted-tools/:sessionId re-pins the SESSION ROW's restrictedTools (the spawn-time --disallowedTools source, re-read on every resume) — NOT the shared assistant-role Profile, which only a fresh spawn ever re-resolves; resolved by sessionId (never "the first assistant-role profile"), isolated per companion session, 404 unknown session, 400 a non-assistant-role session or non-boolean body; no MCP path
  "companion-multichannel", // Loom Companion (SECURITY): MULTI-CHANNEL bindings — one session reachable on in-app + Telegram at once (companion_bindings keyed on (session_id, channel), route index unchanged), reply-on-inbound-channel with NO cross-wire, proactive→home, per-channel sender authz, and the lossless+idempotent table-rebuild migration off the legacy single-PK schema
  "companion-unbind-cascade", // Loom Companion (SECURITY): unbind CASCADE-clears companion_allowed_senders (least-privilege on an auth boundary) — per-channel unbind clears ONLY that channel's allowlist rows (other channel untouched), a re-bind of the SAME (session, channel) starts EMPTY, and delete-ALL clears every allowlist row for the session
  "companion-unbind-pairing-codes", // Loom Companion (SECURITY): unbind ALSO cascade-clears unconsumed companion_pairing_codes (two-path asymmetry fix vs deleteCompanionConfig) — an outstanding code for the unbound (session, channel) can no longer be redeemed and a re-bind's allowlist stays empty despite it, delete-ALL clears every code for the session (other channels/sessions untouched), and a companion_pairing_attempts lockout row SURVIVES unbind (deliberately left, unlike pairing_codes)

  "assistant-role", // Loom Companion Phase 1: the long-lived `assistant` SessionRole — non-worktree spawn+persist, resume carrying the role, base brief injection, human-prompt disallow (others byte-identical), and the minimal resolveRole surface (my_context + companion-gated chat_reply)
  "companion-reminders-brief", // Loom Companion Reminders s2: ASSISTANT_BASE_BRIEF teaches wake_me/wake_list/wake_cancel + the act-on-it [loom:reminder] framing, kept distinct from the silent [loom:memory] recall framing — doc-only, no MCP/allowlist change
];

// NOT run here (require a human-started isolated daemon and/or a real `claude` login, or are helpers):
//   • Real-claude / external-daemon (carry the guard; run manually per their header comment):
//     integration-e2e, orchestration-e2e, manager-live, messaging, mgmt-surface, orch-scope,
//     orch-spawn, mcp-scope, platform-scope, recycle, scheduler, scheduler-drain, scheduler-disabled,
//     usage-limit-detect, usage-limit-resume, worker-report, autonomy-rails, busy-flag, merge-gate,
//     board-consistency, skills-e2e, profiles-rest.
//   • Helpers: _trust-writer (child worker for trust-lock).

let pass = 0;
const failed = [];
const tmpRoots = [];

HERMETIC.forEach((name, i) => {
  const file = path.join(TEST_DIR, `${name}.mjs`);
  if (!fs.existsSync(file)) { console.log(`SKIP  ${name} (missing)`); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-td-${name}-`));
  tmpRoots.push(home);
  const port = 4400 + (i % 800); // non-4317, low-collision; tests run sequentially so reuse is fine
  const r = spawnSync(process.execPath, [file], {
    env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const ok = r.status === 0;
  if (ok) pass++; else failed.push({ name, status: r.status, tail: (r.stdout || "").split("\n").filter(Boolean).slice(-1)[0] || (r.stderr || "").split("\n").filter(Boolean).slice(-1)[0] });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (exit ${r.status})`}`);
});

// Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
for (const root of tmpRoots) {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(`\n${pass}/${HERMETIC.length} hermetic daemon tests passed.`);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  - ${f.name} (exit ${f.status}): ${f.tail ?? ""}`);
  process.exit(1);
}
console.log("✅ hermetic daemon suite green — never touched prod.");
