/**
 * Loom Companion — the per-ROUTE VOICE preference store (Companion Voice epic, VOICE-P1 foundation).
 *
 * Mirrors the bindings / `companion_reminders` DB-row-plus-in-memory pattern (`companion/store.ts`,
 * `companion/reminders.ts`): a small durable record keyed by (sessionId, channel, chatId[, senderId]),
 * injected into the ChatGateway exactly like `auth`/`pairing` so the gateway stays db-UNAWARE. Resolved
 * SERVER-SIDE from the authenticated inbound route — never a body-supplied field (same posture as "the
 * agent never passes projectId"). NO STT/TTS model work here: P2 (inbound STT) reads `sttLang` at inbound
 * time to force the decode language; P3 (outbound TTS) reads `ttsLang`/`ttsVoice`/`voiceReplies` at
 * outbound time. This card only ships the store + the resolve + the "/lang"/"/voice" writer surface
 * (companion/commands.ts).
 */
import type { CompanionVoicePref } from "@loom/shared";
import type { SessionBinding } from "./types.js";

/** The resolved fields a route's voice pref carries — the DB row minus its identity/timestamp columns. */
export type ResolvedVoicePref = Pick<CompanionVoicePref, "sttLang" | "ttsLang" | "ttsVoice" | "voiceReplies">;

/** The effective pref for a route with no stored row: auto-detect STT, no TTS override, voice replies off. */
export const DEFAULT_VOICE_PREF: ResolvedVoicePref = { sttLang: null, ttsLang: null, ttsVoice: null, voiceReplies: "off" };

/**
 * The route a voice pref is keyed on. `senderId` is present ONLY for a GROUP-scoped binding (a shared
 * chat's users each get their own setting); a DM's chatId already IS the user, so senderId stays null
 * there (mirrors {@link SessionBinding}'s scope rule).
 */
export interface VoicePrefRoute {
  sessionId: string;
  channel: string;
  chatId: string;
  senderId: string | null;
}

/** Derive the voice-pref route for an already-authorized inbound: group scope keys additionally by the
 *  authenticated sender id; DM scope does not (the chatId alone identifies the single owner). */
export function voicePrefRoute(binding: SessionBinding, sender?: { id?: string }): VoicePrefRoute {
  return {
    sessionId: binding.sessionId,
    channel: binding.channel,
    chatId: binding.chatId,
    senderId: binding.scope === "group" ? (sender?.id ?? null) : null,
  };
}

/** The injected voice-pref store (pure interface — no db knowledge in the gateway), mirroring how
 *  CompanionAuth/CompanionPairing are injected. Never throws. */
export interface CompanionVoicePrefs {
  /** Resolve the EFFECTIVE pref for `route` — {@link DEFAULT_VOICE_PREF} when none has been set. */
  resolve(route: VoicePrefRoute): ResolvedVoicePref;
  /** Set BOTH sttLang and ttsLang for `route` (one "/lang" command covers both directions). */
  setLang(route: VoicePrefRoute, code: string): ResolvedVoicePref;
  /** Set the voice-reply MODE for `route` ("on" | "off" | "auto" — VOICE-P4 tri-state). */
  setVoiceReplies(route: VoicePrefRoute, mode: "on" | "off" | "auto"): ResolvedVoicePref;
}

// ASCII Unit Separator — a control char that can never appear in a route component (sessionId/channel/
// chatId/senderId are all human/platform-supplied printable text), so two distinct routes can never
// collide by their joined key containing this delimiter. An escape sequence (not a literal control
// character typed into the source) so it can't be mangled by a lossy edit/encoding pass.
const ROUTE_KEY_SEP = "\x1f";

function routeKey(route: VoicePrefRoute): string {
  return [route.sessionId, route.channel, route.chatId, route.senderId ?? ""].join(ROUTE_KEY_SEP);
}

/**
 * The DEFAULT store (used when the ChatGateway is constructed without one — keeps every existing/test
 * bare `new ChatGateway(submit, [...])` construction green): a real in-memory map, NOT a no-op — "/lang"
 * and "/voice" work out of the box, just without durability across a restart. The daemon always injects
 * the db-backed store (`createDbCompanionVoicePrefs`) in production via `factory.ts`.
 */
export function inMemoryVoicePrefs(): CompanionVoicePrefs {
  const map = new Map<string, ResolvedVoicePref>();
  return {
    resolve(route) {
      return map.get(routeKey(route)) ?? DEFAULT_VOICE_PREF;
    },
    setLang(route, code) {
      const next: ResolvedVoicePref = { ...(map.get(routeKey(route)) ?? DEFAULT_VOICE_PREF), sttLang: code, ttsLang: code };
      map.set(routeKey(route), next);
      return next;
    },
    setVoiceReplies(route, mode) {
      const next: ResolvedVoicePref = { ...(map.get(routeKey(route)) ?? DEFAULT_VOICE_PREF), voiceReplies: mode };
      map.set(routeKey(route), next);
      return next;
    },
  };
}

/** The narrow db surface the db-backed store needs (satisfied by `Db`). */
export interface VoicePrefStore {
  getCompanionVoicePref(sessionId: string, channel: string, chatId: string, senderId: string | null): CompanionVoicePref | undefined;
  upsertCompanionVoicePref(input: {
    sessionId: string; channel: string; chatId: string; senderId: string | null;
    sttLang?: string | null; ttsLang?: string | null; ttsVoice?: string | null; voiceReplies?: "on" | "off" | "auto";
  }): CompanionVoicePref;
}

/** The production db-backed store: reads/writes the durable `companion_voice_prefs` row for the route. */
export function createDbCompanionVoicePrefs(db: VoicePrefStore): CompanionVoicePrefs {
  const toResolved = (row: CompanionVoicePref): ResolvedVoicePref =>
    ({ sttLang: row.sttLang, ttsLang: row.ttsLang, ttsVoice: row.ttsVoice, voiceReplies: row.voiceReplies });
  return {
    resolve(route) {
      const row = db.getCompanionVoicePref(route.sessionId, route.channel, route.chatId, route.senderId);
      return row ? toResolved(row) : DEFAULT_VOICE_PREF;
    },
    setLang(route, code) {
      return toResolved(db.upsertCompanionVoicePref({ ...route, sttLang: code, ttsLang: code }));
    },
    setVoiceReplies(route, mode) {
      return toResolved(db.upsertCompanionVoicePref({ ...route, voiceReplies: mode }));
    },
  };
}
