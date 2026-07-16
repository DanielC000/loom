/**
 * Companion injection-guard PRIMITIVES (Companion Capability & Permission-Lever Framework §3) — the
 * REUSABLE module every sensitive ACT lever (decision_resolve, session-steer, board-write, …) imports
 * the subset it needs from. `decision_resolve` (card a8ddd6d2, companion/capabilities.ts) is the FIRST
 * consumer, using all three primitives — later levers (session-steer, board-write, …) reuse the SAME
 * `OwnerConfirmStore`, namespacing their own proposals by their own capability slug (see `proposalKey`).
 *
 * WHY: the Companion forms turns from inbound chat — it is Loom's most prompt-injection-exposed agent. An
 * ACT lever may NEVER let the Companion ORIGINATE a privileged action — only RELAY the owner's literal
 * input, structurally enforced, not by prompt discipline. These three primitives make "literal owner
 * input only" a structural property instead of a hope:
 *   A — server-attested owner text (`getActiveTurnOwnerText`/`getRecentOwnerTurns`, pty/host.ts): the
 *       LITERAL authenticated owner inbound bytes forming the CURRENT turn (or null), plus a BOUNDED,
 *       recent-turns window of the same (card 2b26035c — see `isVerbatimOwnerSubstring`'s doc).
 *   B — verbatim-substring enforcement (`isVerbatimOwnerSubstring`): a PURE checker that an owner-words
 *       arg is a normalized-whitespace substring of what the owner actually said — the CURRENT turn by
 *       default, or ANY turn in a caller-supplied recent-turns window.
 *   C — owner-confirm round-trip (`OwnerConfirmStore`): the highest-risk levers don't commit on the tool
 *       call; they propose, and only the owner's own NEXT authenticated turn can commit it.
 *
 * Card 2b26035c ("board_create verbatim-quote guard forces owner repetition") adds two owner-suggested
 * relaxations on top of these, without loosening what "owner-attested" MEANS:
 *   (b) Primitive A/B widen from "the current turn only" to "any of the last N authenticated owner
 *       turns" — still the owner's OWN server-attested words, just a wider TURN SCOPE. See
 *       `Live.recentOwnerTurns`/`getRecentOwnerTurns` (pty/host.ts) and `isVerbatimOwnerText` below.
 *   (a) `AuthoredContentGrantStore` — an EXPLICIT, Primitive-C-gated owner act that lets a lever author
 *       card content for one project instead of quoting the owner verbatim, granted inline from chat
 *       (not just the pre-existing per-project settings toggle). It reuses Primitive C's propose/confirm
 *       round-trip verbatim (see its doc below) — the Companion can never grant this to itself.
 * `createOwnerAttestation` wires all of this into the ONE `OwnerAttestation` object threaded through
 * `GrantContext.attest` (capabilities.ts) — the shape a lever's `register()` closes over.
 */
import { randomInt } from "node:crypto";
import type { CompanionRoute } from "@loom/shared";

// --- Primitive B — verbatim-substring enforcement ("relay, don't author") --------------------------------

const WHITESPACE_RUN = /\s+/g;

/** trim + collapse internal whitespace — deliberately conservative, CASE-SENSITIVE on content (Framework §3). */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(WHITESPACE_RUN, " ");
}

/**
 * Primitive B: is `candidate` a normalized-whitespace VERBATIM substring of `ownerText` (the CURRENT
 * turn's literal owner bytes, per Primitive A)? PURE — no session/db/pty access, so a lever (or a test)
 * can call it with a plain string. `ownerText === null` (no owner text this turn — a proactive/heartbeat/
 * reminder turn) and an empty `candidate` (never a meaningful verbatim quote) both REJECT — "reject on
 * ambiguity" per the design note, since a false reject only costs a re-phrase while a false accept is an
 * injection.
 */
export function isVerbatimOwnerSubstring(candidate: string, ownerText: string | null): boolean {
  if (ownerText === null) return false;
  const normCandidate = normalizeWhitespace(candidate);
  // A whitespace-only candidate (" ", "\t", "\n", …) normalizes to "" — and "".includes("") is always
  // true, which would let a whitespace-only "owner-words" arg match ANY owner text. Reject on the
  // NORMALIZED emptiness, not the raw length, so this can't be bypassed by padding with whitespace.
  if (normCandidate.length === 0) return false;
  return normalizeWhitespace(ownerText).includes(normCandidate);
}

/**
 * Primitive A/B widening (card 2b26035c, "recent-turns verbatim acceptance"): is `candidate` a verbatim
 * substring (per {@link isVerbatimOwnerSubstring}) of ANY entry in `recentOwnerTexts`? Each entry is
 * checked INDEPENDENTLY — never concatenated — so a match can never be manufactured by stitching two
 * unrelated turns together at their boundary; every accepted candidate is still something the owner said
 * CONTIGUOUSLY in one authenticated turn, just not necessarily the one currently in flight. An empty
 * `recentOwnerTexts` (no owner-authored turn yet this session) REJECTS, matching Primitive B's own
 * reject-on-ambiguity default.
 */
export function isVerbatimOwnerSubstringRecent(candidate: string, recentOwnerTexts: string[]): boolean {
  return recentOwnerTexts.some((text) => isVerbatimOwnerSubstring(candidate, text));
}

// --- Primitive C — owner-confirm round-trip (for privileged commits) --------------------------------------

/** Confirm tokens avoid visually-ambiguous chars (0/O, 1/I/L) — this is typed back by a human in a chat box. */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 6;
const DEFAULT_CONFIRM_TTL_MS = 5 * 60_000;

export interface ProposeConfirmationInput {
  sessionId: string;
  /** Scopes the proposal to the owner's OWN route — a confirm from a different chat/session never matches. */
  route?: CompanionRoute | null;
  /** The proposing LEVER's slug (e.g. "decisions-relay") — namespaces the confirm key (see `proposalKey`)
   *  so two DIFFERENT sensitive levers proposing on the SAME (session, route) at once can never clobber
   *  each other's pending token. */
  capability: string;
  /** Human-readable description of the pending action, rendered back to the owner's chat. */
  summary: string;
  /** Defaults to {@link DEFAULT_CONFIRM_TTL_MS} (5 min). */
  ttlMs?: number;
}

export interface ProposedConfirmation {
  /** The single-use confirm token — the owner's next reply must contain it verbatim (Primitive B). */
  token: string;
  /** Render THIS back to the owner's chat verbatim — it carries the token they must reply with. */
  promptText: string;
  expiresAt: number;
}

export interface ConfirmInput {
  sessionId: string;
  route?: CompanionRoute | null;
  /** MUST match the `capability` the pending proposal was minted under (see `ProposeConfirmationInput`) —
   *  a confirm attempt under a DIFFERENT lever's slug is `"no-pending"` even if some OTHER capability has
   *  a live proposal for this exact (session, route). */
  capability: string;
  /** The confirming turn's literal owner text (Primitive A) — the caller attests this, this store never re-derives it. */
  ownerText: string;
}

export type ConfirmOutcome =
  | { committed: true; summary: string }
  | { committed: false; reason: "no-pending" | "expired" | "token-mismatch" };

interface PendingProposal {
  token: string;
  summary: string;
  expiresAt: number;
}

/** `sessionId` alone is NOT the key — a proposal must be confirmed from the SAME owner route it was
 *  proposed to (Framework §3: "keyed to session + owner route"), mirroring `companion_pairing_codes`'
 *  (channel, chatId) scoping. `capability` NAMESPACES the key too (CR hardening, card a8ddd6d2): two
 *  different sensitive ACT levers (e.g. `decisions-relay` and a future `board-write`) proposing on the
 *  SAME (session, route) concurrently must never clobber each other's pending token — without this, the
 *  second lever's `propose` would silently overwrite the first's entry in this single shared Map. */
function proposalKey(sessionId: string, route: CompanionRoute | null | undefined, capability: string): string {
  return `${sessionId}::${route ? `${route.channel}:${route.chatId}` : ""}::${capability}`;
}

function mintToken(random: () => number): string {
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[Math.floor(random() * TOKEN_ALPHABET.length)];
  return out;
}

/**
 * Primitive C: a pending-proposal store. `propose` never commits anything — it mints a short-TTL,
 * single-use token and hands back the text a caller renders into the chat ("Resolve decision X as
 * approve? Reply CONFIRM <token> to proceed."). `confirm` commits ONLY when called with the SAME
 * (sessionId, route) and an `ownerText` (attested via Primitive A) that contains the token verbatim
 * (Primitive B) before the TTL elapses — reusing B rather than re-implementing a second text match.
 * Single-use: a committed or expired proposal is removed; a token-mismatch is left standing so a
 * legitimate retry (a typo) still works within the TTL. IN-MEMORY (no lever consumes this yet — a durable
 * table is a later, additive decision once a real lever needs cross-restart survival, per the card).
 */
export class OwnerConfirmStore {
  private readonly pending = new Map<string, PendingProposal>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(opts: { now?: () => number; random?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    // Default to a CSPRNG (a privileged-confirm token, not just cosmetic) — Math.random is NOT
    // cryptographically secure. Kept as the SAME injectable `() => number` in [0,1) seam (not swapped for
    // an index-returning shape) so existing deterministic tests (`random: () => 0`) stay unchanged.
    this.random = opts.random ?? (() => randomInt(0, 0x100000000) / 0x100000000);
  }

  propose(input: ProposeConfirmationInput): ProposedConfirmation {
    const token = mintToken(this.random);
    const expiresAt = this.now() + (input.ttlMs ?? DEFAULT_CONFIRM_TTL_MS);
    this.pending.set(proposalKey(input.sessionId, input.route, input.capability), { token, summary: input.summary, expiresAt });
    return { token, promptText: `${input.summary} Reply CONFIRM ${token} to proceed.`, expiresAt };
  }

  confirm(input: ConfirmInput): ConfirmOutcome {
    const key = proposalKey(input.sessionId, input.route, input.capability);
    const proposal = this.pending.get(key);
    if (!proposal) return { committed: false, reason: "no-pending" };
    if (this.now() > proposal.expiresAt) {
      this.pending.delete(key); // expired — single-use cleanup, never resurrects on a later confirm
      return { committed: false, reason: "expired" };
    }
    if (!isVerbatimOwnerSubstring(proposal.token, input.ownerText)) {
      return { committed: false, reason: "token-mismatch" }; // left standing — a legitimate retry within TTL
    }
    this.pending.delete(key); // single-use: committed exactly once
    return { committed: true, summary: proposal.summary };
  }
}

// --- Direction (a) — inline authored-content grant (card 2b26035c) ----------------------------------------

export type AuthoredContentGrantScope = "once" | "session";

/**
 * A per-(sessionId, projectId) EXPLICIT grant that lets a board-write lever author card content instead
 * of requiring a verbatim owner quote — the chat-native alternative to hunting the per-project
 * `authoredContent` settings toggle. Committed ONLY via the caller's OWN Primitive-C propose/confirm
 * round-trip (see `authored_content_grant` in capabilities.ts) — this store itself never proposes or
 * confirms anything; it just holds what an already-confirmed owner act granted, so the Companion has no
 * path to write here on its own say-so.
 *
 * `"once"` is consumed by the very next content-committing call (create OR update) on that project;
 * `"session"` persists until explicitly cleared (session end / conversation reset) — mirrors the
 * pre-existing `authoredContent` config toggle's own "stays on until changed" shape, just session-scoped
 * and chat-granted instead of project-scoped and REST-granted. `hasGrant` is a non-mutating PEEK (safe to
 * call while merely checking whether content would be acceptable, e.g. during a propose-only path);
 * `consumeIfOnce` is the caller's explicit signal that a grant-backed commit ACTUALLY happened this call,
 * and is a no-op for a `"session"` grant or when no grant exists.
 */
export class AuthoredContentGrantStore {
  private readonly grants = new Map<string, AuthoredContentGrantScope>();

  private key(sessionId: string, projectId: string): string {
    return `${sessionId}::${projectId}`;
  }

  grant(sessionId: string, projectId: string, scope: AuthoredContentGrantScope): void {
    this.grants.set(this.key(sessionId, projectId), scope);
  }

  hasGrant(sessionId: string, projectId: string): boolean {
    return this.grants.has(this.key(sessionId, projectId));
  }

  consumeIfOnce(sessionId: string, projectId: string): void {
    const k = this.key(sessionId, projectId);
    if (this.grants.get(k) === "once") this.grants.delete(k);
  }

  /** Revoke every grant held for `sessionId` — called from the same session-close paths that clear the
   *  Companion Trust Window (recycle/unbind/re-pair), so a grant never survives past the session it was
   *  granted to. A daemon restart clears it automatically (in-memory, mirrors `OwnerConfirmStore`). */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.grants.keys()) if (k.startsWith(prefix)) this.grants.delete(k);
  }
}

// --- Wiring: the ONE object a lever's register() closes over ----------------------------------------------

/**
 * The primitives, bundled for injection into `GrantContext.attest` (capabilities.ts). Built ONCE per
 * router (mirrors the router's other injected server-derived resolvers, e.g. `getActiveTurnOrigin`) —
 * `confirmPending`/`proposeConfirmation` share ONE `OwnerConfirmStore` across requests (a stateless
 * per-request McpServer would otherwise lose a pending proposal before the owner's confirming reply
 * arrives), `hasAuthoredContentGrant`/`grantAuthoredContent`/`consumeAuthoredContentGrantIfOnce` share ONE
 * `AuthoredContentGrantStore` for the same reason, while `getActiveTurnOwnerText`/`isVerbatimOwnerText`
 * are per-call reads with no state of their own.
 */
export interface OwnerAttestation {
  /** Primitive A (current turn only). */
  getActiveTurnOwnerText(sessionId: string): string | null;
  /**
   * Primitive B, widened (card 2b26035c): true when `candidate` is a verbatim quote of the CURRENT
   * turn's owner text (Primitive A, unchanged happy path — checked FIRST, so this stays a strict
   * superset of the pre-widening behavior even when no recent-turns source is wired), OR of ANY turn in
   * the bounded recent-turns window (Primitive A widening) when one is available. The ergonomic form a
   * lever's tool handler calls directly on its free-text arg.
   */
  isVerbatimOwnerText(sessionId: string, candidate: string): boolean;
  /** Primitive C propose — never commits; returns the token + text to render back to the owner's chat. */
  proposeConfirmation(input: ProposeConfirmationInput): ProposedConfirmation;
  /**
   * Primitive C confirm — reads the CURRENT turn's owner text via Primitive A itself (a lever never
   * supplies `ownerText` directly, so it can't forge an attestation). `capability` MUST match the slug the
   * pending proposal was minted under (see `ProposeConfirmationInput.capability`). `"no-owner-text"`
   * (widening {@link ConfirmOutcome}) covers the structural case where this fires on a turn that isn't
   * owner-authored at all (nothing to attest). Deliberately STRICT current-turn only (not widened to the
   * recent-turns window) — this is the highest-risk commit primitive, including for the new
   * `authored_content_grant` lever's own grant confirm, so it keeps the tightest possible scope.
   */
  confirmPending(sessionId: string, route: CompanionRoute | null | undefined, capability: string): ConfirmOutcome | { committed: false; reason: "no-owner-text" };
  /** Direction (a), card 2b26035c: PEEK (non-mutating) whether an inline authored-content grant is live
   *  for (sessionId, projectId) — see {@link AuthoredContentGrantStore}. Safe to call speculatively (e.g.
   *  while just computing whether content would be acceptable) without consuming a "once" grant. */
  hasAuthoredContentGrant(sessionId: string, projectId: string): boolean;
  /** Direction (a): commit a grant — called ONLY after `confirmPending` reports the owner's OWN confirm
   *  for the `authored_content_grant` lever's proposal; never callable from a bare tool argument. */
  grantAuthoredContent(sessionId: string, projectId: string, scope: AuthoredContentGrantScope): void;
  /** Direction (a): the caller's explicit signal that a grant-backed (non-verbatim) commit ACTUALLY
   *  happened this call — consumes a `"once"` grant, no-ops for `"session"` or no grant. Call this AFTER
   *  the real create/update succeeds, never merely after checking `hasAuthoredContentGrant`. */
  consumeAuthoredContentGrantIfOnce(sessionId: string, projectId: string): void;
}

export function createOwnerAttestation(
  deps: {
    getActiveTurnOwnerText: (sessionId: string) => string | null;
    /** Primitive A widening (card 2b26035c) — OPTIONAL so an existing caller/test double that hasn't
     *  wired this up degrades to "no recent-turns window" (an empty array), NOT a thrown error; the
     *  current-turn check in `isVerbatimOwnerText` runs regardless and stays byte-identical either way. */
    getRecentOwnerTurns?: (sessionId: string) => string[];
  },
  store: OwnerConfirmStore = new OwnerConfirmStore(),
  authoredContentGrants: AuthoredContentGrantStore = new AuthoredContentGrantStore(),
): OwnerAttestation {
  const getRecent = deps.getRecentOwnerTurns ?? (() => []);
  return {
    getActiveTurnOwnerText: deps.getActiveTurnOwnerText,
    isVerbatimOwnerText: (sessionId, candidate) =>
      isVerbatimOwnerSubstring(candidate, deps.getActiveTurnOwnerText(sessionId))
      || isVerbatimOwnerSubstringRecent(candidate, getRecent(sessionId)),
    proposeConfirmation: (input) => store.propose(input),
    confirmPending: (sessionId, route, capability) => {
      const ownerText = deps.getActiveTurnOwnerText(sessionId);
      if (ownerText === null) return { committed: false, reason: "no-owner-text" };
      return store.confirm({ sessionId, route, capability, ownerText });
    },
    hasAuthoredContentGrant: (sessionId, projectId) => authoredContentGrants.hasGrant(sessionId, projectId),
    grantAuthoredContent: (sessionId, projectId, scope) => authoredContentGrants.grant(sessionId, projectId, scope),
    consumeAuthoredContentGrantIfOnce: (sessionId, projectId) => authoredContentGrants.consumeIfOnce(sessionId, projectId),
  };
}
