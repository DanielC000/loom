/**
 * Companion injection-guard PRIMITIVES (Companion Capability & Permission-Lever Framework §3) — the
 * REUSABLE module every sensitive ACT lever (decision_resolve, session-steer, board-write, …) imports
 * the subset it needs from. NO lever consumes this module yet (card 8e511951 ships the primitives +
 * their tests + threads `attest` into `GrantContext` — the levers are later cards).
 *
 * WHY: the Companion forms turns from inbound chat — it is Loom's most prompt-injection-exposed agent. An
 * ACT lever may NEVER let the Companion ORIGINATE a privileged action — only RELAY the owner's literal
 * input, structurally enforced, not by prompt discipline. These three primitives make "literal owner
 * input only" a structural property instead of a hope:
 *   A — server-attested owner text (`getActiveTurnOwnerText`, pty/host.ts): the LITERAL authenticated
 *       owner inbound bytes forming the CURRENT turn, or null when the turn wasn't owner-authored.
 *   B — verbatim-substring enforcement (`isVerbatimOwnerSubstring`): a PURE checker that an owner-words
 *       arg is a normalized-whitespace substring of what the owner actually said this turn.
 *   C — owner-confirm round-trip (`OwnerConfirmStore`): the highest-risk levers don't commit on the tool
 *       call; they propose, and only the owner's own NEXT authenticated turn can commit it.
 * `createOwnerAttestation` wires all three into the ONE `OwnerAttestation` object threaded through
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

// --- Primitive C — owner-confirm round-trip (for privileged commits) --------------------------------------

/** Confirm tokens avoid visually-ambiguous chars (0/O, 1/I/L) — this is typed back by a human in a chat box. */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 6;
const DEFAULT_CONFIRM_TTL_MS = 5 * 60_000;

export interface ProposeConfirmationInput {
  sessionId: string;
  /** Scopes the proposal to the owner's OWN route — a confirm from a different chat/session never matches. */
  route?: CompanionRoute | null;
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
 *  (channel, chatId) scoping. */
function proposalKey(sessionId: string, route?: CompanionRoute | null): string {
  return `${sessionId}::${route ? `${route.channel}:${route.chatId}` : ""}`;
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
    this.pending.set(proposalKey(input.sessionId, input.route), { token, summary: input.summary, expiresAt });
    return { token, promptText: `${input.summary} Reply CONFIRM ${token} to proceed.`, expiresAt };
  }

  confirm(input: ConfirmInput): ConfirmOutcome {
    const key = proposalKey(input.sessionId, input.route);
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

// --- Wiring: the ONE object a lever's register() closes over ----------------------------------------------

/**
 * The three primitives, bundled for injection into `GrantContext.attest` (capabilities.ts). Built ONCE per
 * router (mirrors the router's other injected server-derived resolvers, e.g. `getActiveTurnOrigin`) —
 * `confirmPending`/`proposeConfirmation` share ONE `OwnerConfirmStore` across requests (a stateless
 * per-request McpServer would otherwise lose a pending proposal before the owner's confirming reply
 * arrives), while `getActiveTurnOwnerText`/`isVerbatimOwnerText` are per-call reads with no state of
 * their own.
 */
export interface OwnerAttestation {
  /** Primitive A. */
  getActiveTurnOwnerText(sessionId: string): string | null;
  /** Primitive B, scoped to THIS session's current-turn owner text (Primitive A) — the ergonomic form a
   *  lever's tool handler calls directly on its free-text arg. */
  isVerbatimOwnerText(sessionId: string, candidate: string): boolean;
  /** Primitive C propose — never commits; returns the token + text to render back to the owner's chat. */
  proposeConfirmation(input: ProposeConfirmationInput): ProposedConfirmation;
  /**
   * Primitive C confirm — reads the CURRENT turn's owner text via Primitive A itself (a lever never
   * supplies `ownerText` directly, so it can't forge an attestation). `"no-owner-text"` (widening
   * {@link ConfirmOutcome}) covers the structural case where this fires on a turn that isn't owner-
   * authored at all (nothing to attest).
   */
  confirmPending(sessionId: string, route?: CompanionRoute | null): ConfirmOutcome | { committed: false; reason: "no-owner-text" };
}

export function createOwnerAttestation(
  deps: { getActiveTurnOwnerText: (sessionId: string) => string | null },
  store: OwnerConfirmStore = new OwnerConfirmStore(),
): OwnerAttestation {
  return {
    getActiveTurnOwnerText: deps.getActiveTurnOwnerText,
    isVerbatimOwnerText: (sessionId, candidate) =>
      isVerbatimOwnerSubstring(candidate, deps.getActiveTurnOwnerText(sessionId)),
    proposeConfirmation: (input) => store.propose(input),
    confirmPending: (sessionId, route) => {
      const ownerText = deps.getActiveTurnOwnerText(sessionId);
      if (ownerText === null) return { committed: false, reason: "no-owner-text" };
      return store.confirm({ sessionId, route, ownerText });
    },
  };
}
