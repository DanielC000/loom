/**
 * Card d34dd208 — the "structured field that lies" class: a Profile field the validator accepts (and
 * the UI shows as set) that has NO real consumer on some supported harness's spawn/runtime path. Three
 * instances (`cb7d6998`, `6d5a6280`, and codex silently dropping `model`/`restrictedTools`) were each
 * caught by a HUMAN reading the artifact, none by CI. This registry is the machine-readable declaration
 * `test/profile-field-consumer-guard.mjs` reads to decide, PER FIELD × PER HARNESS, whether a real
 * consumer exists, a legitimate exemption, or an already-tracked open gap — so a fourth instance can no
 * longer ship as silence. See that guard's own header for the exact mechanism and the current bound.
 *
 * ⚠️ THE DEFECT THIS CLOSES IS SILENCE, NOT ASYMMETRY (the card's own DoD-4 hardening). A field that is
 * genuinely claude-only (or codex-only) is fine — but the "it's fine" judgment must live HERE, in code
 * the guard can read, never only in a doc comment a human might or might not act on (a doc comment's
 * correctness and whether a reader acts on it are independent variables — see project memory
 * `shipping-a-detector-is-not-someone-reading-it`). A field with neither a `proofs` entry covering a
 * harness, NOR an `exempt` entry, NOR a `gaps` entry naming it is an UNEXPLAINED absence, and the guard
 * FAILS on it — hard, not just loudly.
 *
 * ⛔ A `proofs`/`exempt`/`gaps` entry is a CLAIM, not a decoration — the guard re-verifies every
 * `proofs[].pattern` actually appears in `proofs[].file` (scoped to the named region for a `pty/host.ts`
 * proof), so a future refactor that silently drops a real consumption line fails here even if this file
 * is never touched.
 *
 * THREE DIFFERENT THINGS CAN EXPLAIN A HARNESS NOT COVERED BY `proofs`, AND THEY ARE NOT INTERCHANGEABLE:
 *  - `exempt` — LEGITIMATE, PERMANENT, benign: the harness genuinely has no analogous concept for what
 *    this field controls, and its absence costs only a missing FEATURE (a capability the profile can't
 *    grant there), never a missing SAFETY property. Passes the guard silently, forever — nothing to fix.
 *  - `gaps` — TEMPORARY, TRACKED, open: a real, currently-unfixed defect with a live Loom board card id.
 *    The guard reports these as passing (so the fleet isn't blocked on already-known debt) but LOUDLY,
 *    naming the card — this is a declared-baseline, not a debt baseline: it becomes load-bearing again
 *    the moment a NEW, undeclared gap appears, and it disappears the moment the card lands and the entry
 *    is deleted. A `gaps` entry's own `remedy` further splits into two shapes (see `DeclaredGap` below) —
 *    do not treat "gap" as meaning "just wire it up"; for some fields there is nothing to wire.
 *  - Neither ⇒ UNDECLARED ⇒ hard FAIL, exit 1. This is the only shape that should ever gate a merge.
 */

export type ProfileHarness = "claude" | "codex";

/** Every harness a Profile's `harness` field can currently select (validate.ts `z.enum(["claude","codex"])`).
 *  Kept as its own constant (not re-derived from the zod enum) so the guard's harness loop is legible on
 *  its own — if a third harness is ever added, `profiles/validate.ts`'s own enum grows first and this
 *  constant is the deliberate, reviewable second step that widens what the guard checks. */
export const SUPPORTED_PROFILE_HARNESSES: readonly ProfileHarness[] = ["claude", "codex"];

/** A real Loom board card id — the shape every card id in this codebase's history actually takes (8
 *  lowercase hex chars, e.g. "0770d916", "d34dd208"). Checked mechanically by the guard so a placeholder
 *  like "TBD"/"todo"/a fabricated id can never satisfy a `gaps[].cardId` — per this project's own standing
 *  rule (CLAUDE.md / worker doctrine): never write an id you were not handed by the tool that minted it.
 *  This regex check can't verify the card still EXISTS or is still OPEN (this guard is a hermetic static
 *  test, no DB access) — that's a human obligation the guard can't discharge, stated here so it's never
 *  assumed discharged: a `gaps` entry is only ever added with an id actually returned by tasks_get/
 *  tasks_create for a live card, never invented to satisfy this shape check. */
export const CARD_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Closed set of reasons a field may legitimately, PERMANENTLY lack a consumer on a given harness (or on
 *  every harness, for `cosmetic-identity`). Closed deliberately — an open free-text reason would let a
 *  future author write a plausible-sounding sentence for what is actually an unfixed bug; a closed enum
 *  forces the choice to be one of these two honest, permanent shapes. NEVER use this for a temporary,
 *  fixable gap — that's what `gaps` (below) is for. */
export type ProfileFieldExemptReason =
  /** Pure display/identity metadata (a name, a free-text description, an emoji icon) — stored and shown
   *  in the UI, never read on any spawn or MCP-tool-gating path, on EITHER harness. */
  | "cosmetic-identity"
  /** The harness has no mechanism this field could even bind to (verified by reading that harness's own
   *  spawn code, not assumed) — not a bug to fix, nothing to wire, and losing this field costs only a
   *  FEATURE (capability), never a SAFETY property, on that harness. */
  | "harness-lacks-equivalent-mechanism";

/** One real, grep-verifiable site proving a field is actually read on the named harness(es)' spawn or
 *  runtime path. `region` names which bounded source region the guard scans `pattern` against — `"whole
 *  file"` for a runtime path that isn't harness-scoped at all (e.g. a value read live from the session
 *  row at MCP-request time, which applies the same regardless of which harness spawned the pty). */
export interface FieldConsumptionProof {
  harnesses: ProfileHarness[];
  file: string;
  region: "claude-create-pty" | "codex-spawn" | "whole file";
  /** An exact, literal substring (never a regex) — kept literal so the proof is provably about the real
   *  source text, not a pattern loose enough to match something else. */
  pattern: string;
  note: string;
}

/**
 * A TEMPORARY, TRACKED, currently-open instance of the "structured field that lies" defect on one
 * harness — the whole point of this shape is that it can never be silent (a live `cardId`) and can
 * never masquerade as fixed (it's a distinct kind from `proofs`/`exempt`).
 */
export interface DeclaredGap {
  /** The real Loom board card tracking the fix. REQUIRED, checked against {@link CARD_ID_PATTERN} — see
   *  that constant's own doc for why a placeholder can't satisfy this. */
  cardId: string;
  /**
   * `"connect"` — the field IS mechanically wirable on this harness; the fix is to thread the existing
   * value through (e.g. the codex spawn path's own `buildMcpServers()` call already accepts this exact
   * param generically for the claude path — the codex call site just omits it). A straightforward,
   * bounded fix.
   *
   * `"no-mechanism-reject-or-warn"` — ⛔ THIS HARNESS HAS NO LEVER AT ALL FOR WHAT THIS FIELD CONTROLS.
   * "Wire it up" is not a coherent fix — there is nothing on the receiving end to connect to (verified by
   * reading that harness's own permission/capability model, not assumed). The correct remedy is to
   * REJECT the field+harness combination at profile validation/resolve time, or surface a loud, durable
   * warning — never a silent connection (there's nothing to connect), and never folding this into
   * `exempt` either: for a SAFETY-scoped field (e.g. a blast-radius control), a harness quietly having no
   * equivalent is FAIL-OPEN — the UI reads the toggle as ON while it removes nothing — which is exactly
   * the silence this whole registry exists to prevent. `exempt` is reserved for a field whose absence
   * costs only a FEATURE; a `no-mechanism-reject-or-warn` gap is one whose absence can cost a SAFETY
   * property, so it must stay visibly OPEN (via a live card) until validation/UX actually closes it,
   * never be marked "fine" by omission.
   */
  remedy: "connect" | "no-mechanism-reject-or-warn";
  note: string;
}

export interface FieldNotSpawnRelevant {
  kind: "not-spawn-relevant";
  reason: Extract<ProfileFieldExemptReason, "cosmetic-identity">;
  note: string;
}

export interface FieldConsumed {
  kind: "consumed";
  proofs: FieldConsumptionProof[];
  /** For a harness in {@link SUPPORTED_PROFILE_HARNESSES} not covered by any `proofs[].harnesses` above,
   *  a PERMANENT, legitimate reason it's never required there. Never use this for a temporary bug — see
   *  `gaps` below. */
  exempt?: { harness: ProfileHarness; reason: Extract<ProfileFieldExemptReason, "harness-lacks-equivalent-mechanism">; note: string }[];
  /** For a harness in {@link SUPPORTED_PROFILE_HARNESSES} not covered by any `proofs[].harnesses` above
   *  (and not in `exempt`), a TEMPORARY, carded, currently-open instance of the defect — see
   *  {@link DeclaredGap}. Omitting an entry for such a harness (in EITHER `exempt` or `gaps`) is the
   *  exact "silence" this registry exists to catch — the guard hard-fails on it. */
  gaps?: { harness: ProfileHarness; gap: DeclaredGap }[];
}

export type FieldConsumption = FieldNotSpawnRelevant | FieldConsumed;

/**
 * PER-FIELD declarations. Keyed by the exact field name from `profileSchema` (see
 * `PROFILE_FIELD_NAMES`, validate.ts) — the guard requires every key there to appear here, and every
 * key here to appear there (both directions checked, so this can't silently rot into naming a field
 * that no longer exists either).
 */
export const PROFILE_FIELD_CONSUMERS: Record<string, FieldConsumption> = {
  name: {
    kind: "not-spawn-relevant",
    reason: "cosmetic-identity",
    note: "Profile display name — DB-stored, UI/API passthrough only (profiles/customization.ts, db.ts). No spawn/runtime read anywhere in packages/daemon/src outside storage+validation.",
  },
  description: {
    kind: "not-spawn-relevant",
    reason: "cosmetic-identity",
    note: "Free-text profile description — DB-stored, UI/API passthrough only. No spawn/runtime read anywhere in packages/daemon/src outside storage+validation.",
  },
  icon: {
    kind: "not-spawn-relevant",
    reason: "cosmetic-identity",
    note: "Emoji icon — DB-stored, UI/API passthrough only. No spawn/runtime read anywhere in packages/daemon/src outside storage+validation.",
  },

  role: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `opts.role === "manager" || opts.role === "worker" || opts.role === "assistant"`,
        note: "createPty derives the MCP-surface wants (loom-orchestration/platform/audit/setup/run/operator) from opts.role.",
      },
      {
        harnesses: ["codex"],
        file: "packages/daemon/src/pty/host.ts",
        region: "codex-spawn",
        pattern: `buildMcpServers({ sessionId: opts.sessionId, port: PORT, role: opts.role });`,
        note: "createCodexPty passes opts.role into buildMcpServers, which mounts the same role-gated MCP surface for codex sessions.",
      },
    ],
  },

  harness: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude", "codex"],
        file: "packages/daemon/src/pty/host.ts",
        region: "whole file",
        pattern: `if (opts.harness === "codex") { this.spawnCodexProcess(opts); return; }`,
        note: "spawn() dispatches on opts.harness — this field IS the harness selector, so a single dispatch site necessarily covers both.",
      },
    ],
  },

  skills: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `injectSkills(opts.cwd, opts.sessionId, opts.skills ?? null, opts.role, obsidianEnabled)`,
        note: "createPty injects the profile-resolved skill subset via injectSkills.",
      },
    ],
    // codex-host.ts has zero references to skills at all — codex has no analogous skill-file-delivery
    // mechanism (verified: `grep -i skill packages/daemon/src/pty/codex-host.ts` → 0 hits). Not a bug to
    // fix; nothing exists on the codex side for this field to bind to.
    exempt: [
      { harness: "codex", reason: "harness-lacks-equivalent-mechanism", note: "codex-host.ts has no skill-injection mechanism at all (0 references) — there is nothing for this field to wire into on the codex path." },
    ],
  },

  allowDelta: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `{ ...opts.permission, allow: [...opts.permission.allow, ...extraAllow] }`,
        note: "createPty layers the resolved allowlist (config allow + profile allowDelta, already merged into opts.permission upstream) onto the spawn's settings.json/--permission-mode.",
      },
    ],
    // createCodexPty's fixed argv (`-a never -s workspace-write --no-alt-screen`) has no per-tool
    // allowlist concept at all — codex's whole permission model is the two blanket sandbox/approval
    // flags, never a granular tool-pattern allow list. Verified: opts.permission does not appear
    // anywhere in createCodexPty/spawnCodexProcess's combined body.
    exempt: [
      { harness: "codex", reason: "harness-lacks-equivalent-mechanism", note: "codex's fixed `-a never -s workspace-write` argv has no granular per-tool-pattern allowlist concept for allowDelta to bind to." },
    ],
  },

  model: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `model: opts.model, disallowedTools, sessionName`,
        note: "createPty threads opts.model into buildSpawnArgs, which emits --model <id>.",
      },
    ],
    // The seed defect this whole card was filed over (host.ts's codex region: 0 occurrences of
    // `opts.model`, verified with a 50-hit `codex` positive control in the same range). `model` IS
    // mechanically connectable on codex (the CLI has its own model-override lever — `-c model=<id>` /
    // config.toml `model`, per docs/investigations/049e4a7b-codex-cli-capability-probe/findings.md) —
    // there is just nothing threading `opts.model` to it yet. remedy: "connect".
    gaps: [
      { harness: "codex", gap: { cardId: "0770d916", remedy: "connect", note: "createCodexPty never threads opts.model into codex's own model-override lever (-c model=<id> / config.toml). Falls back to codex's configured default model, not a safety issue — just an ignored pin." } },
    ],
  },

  restrictedTools: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        // Deliberately trimmed short of the real call's full argument list, which also names a DEV-ONLY,
        // never-shipped internal MCP feature — a repo-privacy guard (test/*-privacy-guard.mjs) scans
        // compiled dist/ output, comments included (tsc keeps them by default), for that feature's name
        // outside its own accepted baseline, and even a comment quoting it here would compile straight
        // into the shipped npm package. This shorter prefix is still unique within the claude-create-pty
        // region and still proves the real thing: restrictedTools feeds disallowedToolsForSpawn.
        pattern: `disallowedToolsForSpawn(opts.role, opts.restrictedTools,`,
        note: "createPty unions RESTRICTED_NATIVE_TOOLS into --disallowedTools when opts.restrictedTools is set.",
      },
    ],
    // The card's other seed defect (0 occurrences of `opts.restrictedTools` in the codex region) — but
    // this one is a DIFFERENT SHAPE from the other four gaps in this file, verified against
    // docs/investigations/049e4a7b-codex-cli-capability-probe/findings.md (the OBSERVED, real-pty probe,
    // not assumed from docs): codex's ENTIRE permission model is exactly two coarse, session-wide levers
    // — `sandbox_mode` (read-only/workspace-write/danger-full-access) and `approval_policy`
    // (on-request/never, per the installed 0.153.4's own --help) — with NO per-native-tool
    // allow/disallow concept anywhere codex exposes (checked: findings.md has zero mentions of a
    // per-tool/granular/disallow mechanism). `restrictedTools`'s whole job on claude is to UNION
    // RESTRICTED_NATIVE_TOOLS (Bash/Edit/Write/NotebookEdit/MultiEdit — Claude Code's own native tool
    // names) into --disallowedTools; codex has no analogous "native tool" concept to disallow a subset
    // of at all — `workspace-write` is all-or-nothing shell+file-write access. remedy:
    // "no-mechanism-reject-or-warn", NOT "connect" — there is nothing to wire up. And unlike the other
    // four (mere capability gaps), this one is FAIL-OPEN: a companion (role:"assistant") profile pinning
    // harness:"codex" + restrictedTools:true today reads as blast-radius-restricted in the UI while
    // running with codex's full default shell/file-write access — the exact "reads ON, does nothing"
    // state the no-mechanism/exempt split above exists to keep out of `exempt`.
    gaps: [
      { harness: "codex", gap: { cardId: "0770d916", remedy: "no-mechanism-reject-or-warn", note: "codex has no per-native-tool disallow concept at all (only coarse sandbox_mode/approval_policy) — the correct fix is to reject harness:\"codex\"+restrictedTools:true at profile validation/resolve time (or a loud, durable warning), never a silent connection or a silent exempt." } },
    ],
  },

  browserTesting: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `role: opts.role, browserTesting: opts.browserTesting, documentConversion: opts.documentConversion,`,
        note: "createPty passes opts.browserTesting into buildMcpServers, which mounts the per-session Playwright MCP when set.",
      },
    ],
    // NEW FINDING from this card's sweep (not in the original two-field seed evidence): createCodexPty's
    // own buildMcpServers({ sessionId, port, role }) call omits browserTesting entirely, so
    // resolveProfileCapabilities(o) sees it as undefined/false for every codex session regardless of
    // what the profile actually has set — the Playwright MCP silently never mounts on codex. remedy:
    // "connect" — buildMcpServers() already accepts `browserTesting` generically (the claude call site
    // passes it); the codex call site just needs to pass opts.browserTesting through too. A missing
    // CAPABILITY (the browser tool doesn't mount), not a safety hole.
    gaps: [
      { harness: "codex", gap: { cardId: "0770d916", remedy: "connect", note: "createCodexPty's buildMcpServers({ sessionId, port, role }) call omits browserTesting — buildMcpServers already accepts it generically, just thread opts.browserTesting through." } },
    ],
  },

  documentConversion: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `browserTesting: opts.browserTesting, documentConversion: opts.documentConversion,`,
        note: "createPty passes opts.documentConversion into buildMcpServers, which mounts the per-session markitdown MCP when set.",
      },
    ],
    // Same NEW FINDING as browserTesting above: createCodexPty's buildMcpServers call omits
    // documentConversion too. remedy: "connect" — same fix shape, same non-safety (capability-only) gap.
    gaps: [
      { harness: "codex", gap: { cardId: "0770d916", remedy: "connect", note: "createCodexPty's buildMcpServers({ sessionId, port, role }) call omits documentConversion — buildMcpServers already accepts it generically, just thread opts.documentConversion through." } },
    ],
  },

  capabilities: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude"],
        file: "packages/daemon/src/pty/host.ts",
        region: "claude-create-pty",
        pattern: `capabilities: opts.capabilities, capabilityCatalog, resolveConnectionSecret: this.resolveConnectionSecret,`,
        note: "createPty passes opts.capabilities into buildMcpServers, which mounts every resolved registry-capability grant.",
      },
    ],
    // Same NEW FINDING: createCodexPty's buildMcpServers call omits capabilities too, so an owner-added
    // capability grant (agent-tooling P4) silently never mounts on codex either. remedy: "connect" — same
    // fix shape as browserTesting/documentConversion above.
    gaps: [
      { harness: "codex", gap: { cardId: "0770d916", remedy: "connect", note: "createCodexPty's buildMcpServers({ sessionId, port, role }) call omits capabilities — buildMcpServers already accepts it generically, just thread opts.capabilities (+ capabilityCatalog/resolveConnectionSecret) through." } },
    ],
  },

  vaultWrite: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude", "codex"],
        file: "packages/daemon/src/mcp/server.ts",
        region: "whole file",
        pattern: `if (session?.vaultWrite) {`,
        note: "The loom-tasks MCP router (mounted for every role/harness alike) reads session.vaultWrite LIVE at request time to gate the vault_write tool — not baked into spawn argv, so harness-agnostic by construction.",
      },
    ],
  },

  connections: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude", "codex"],
        file: "packages/daemon/src/mcp/server.ts",
        region: "whole file",
        pattern: `const sessionConnections = session?.connections ?? [];`,
        note: "The loom-tasks MCP router reads session.connections LIVE at request time to gate authenticated_request's allowlist — harness-agnostic, same as vaultWrite above.",
      },
    ],
  },

  noCommit: {
    kind: "consumed",
    proofs: [
      {
        harnesses: ["claude", "codex"],
        file: "packages/daemon/src/sessions/service.ts",
        region: "whole file",
        pattern: `runBuild: !noCommit`,
        note: "Worker provisioning (createWorktree) skips the build gate for a noCommit rig — a session-lifecycle read, not spawn argv, so it applies identically regardless of harness.",
      },
    ],
  },
};
