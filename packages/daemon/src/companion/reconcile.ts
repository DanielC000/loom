/**
 * Loom Companion — the ONE shared "a binding mutation may have just orphaned the proactive HOME or a
 * recurring reminder's own pinned route" reconcile (card d3f9b4d2, Minor 1 of the fix round). Every write
 * that can change which (channel, chatId) routes are live for a session — the bindings POST upsert
 * (ON CONFLICT replaces the chat_id for that channel), one-shot provision, dm-bind pairing redemption, and
 * DELETE — must call this afterward, rather than each growing its own copy of the same clear-and-file logic.
 *
 * Prefer CLEAR over a silent reroute to a different chat: the owner sees "no home" / the reminder falls
 * back to its own session's always-live in-app route on its next fire, each left as a durable event
 * (companion_home_cleared / companion_reminder_rerouted) rather than silent.
 */
import { randomUUID } from "node:crypto";
import { IN_APP_CHANNEL } from "./in-app.js";
import type { CompanionRoute, SessionBinding } from "./types.js";
import { isLikelyGroupTelegramChatId, isNonNumericTelegramChatId } from "./types.js";

/** The narrow store surface this reconcile needs — satisfied by both the real `Db` (server.ts's REST
 *  writers) and the factory's `CompanionBindingStore` (chat-gateway.ts's dm-bind pairing redemption). */
export interface CompanionRouteReconcileStore {
  getCompanionBindingsForSession(sessionId: string): { channel: string; chatId: string }[];
  getCompanionHome(sessionId: string): CompanionRoute | null;
  clearCompanionHome(sessionId: string): void;
  listCompanionRemindersForSession(sessionId: string): { id: string; route: CompanionRoute | null }[];
  clearCompanionReminderRoute(reminderId: string): void;
  appendEvent(evt: { id: string; ts: string; managerSessionId: string; kind: string; detail?: Record<string, unknown> }): void;
}

/** The minimal surface {@link hasLiveCompanionBinding} needs — deliberately narrower than
 *  `CompanionRouteReconcileStore` (which also needs home/reminder read-writers + appendEvent) so a
 *  READ-ONLY caller that has no business clearing homes/reminders — `store.ts`'s boot-time stale-home
 *  check (card 1b0df437) — can reuse this predicate without widening to the full reconcile surface.
 *  `CompanionRouteReconcileStore` and `store.ts`'s `CompanionConfigStore` both satisfy this structurally. */
export interface CompanionBindingLivenessStore {
  getCompanionBindingsForSession(sessionId: string): { channel: string; chatId: string }[];
}

/** The one true "does `route` currently have a live binding for `sessionId`" predicate every reconcile
 *  site below shares — never a second, divergent reimplementation of this question. IN_APP_CHANNEL is
 *  always considered live (mirrors ChatGateway.hasLiveBinding's own doc: in-app has no "unbound" state).
 *  ⚠️ This is a binding-ROW-EXISTS check ONLY — it does NOT know about a flagged-non-private binding or a
 *  group-shaped id backed by a non-group binding, both of which a real delivery attempt still refuses. It
 *  stays scoped to the binding-MUTATION reconcile below (clear a home/reminder whose route lost its binding
 *  row entirely) on purpose — for "would delivery to this route actually be refused", every other caller
 *  must use {@link companionRouteBlockReason} instead; see its own doc for why these are deliberately two
 *  different questions. */
export function hasLiveCompanionBinding(store: CompanionBindingLivenessStore, sessionId: string, route: CompanionRoute): boolean {
  return route.channel === IN_APP_CHANNEL || store.getCompanionBindingsForSession(sessionId).some((b) => b.channel === route.channel && b.chatId === route.chatId);
}

/** Minimal binding-row shape {@link companionRouteBlockReason} needs — just enough of SessionBinding (the
 *  gateway's own live routing-map objects) / CompanionBinding (a db row) for either to satisfy this
 *  structurally without widening to its full shape. */
export type CompanionRouteBindingLike = Pick<SessionBinding, "scope"> & { flaggedNonPrivate?: boolean };

export type CompanionRouteBlockReason = "route-unbound" | "route-flagged-non-private";

/**
 * THE one pure per-route delivery decision (card ddf08614) — extracted from `ChatGateway`'s own private
 * `deliveryBlockReason`, same semantics, same order, so every caller that needs to know "would a real
 * delivery attempt to this route be refused, and why" shares ONE implementation instead of each growing
 * its own approximation. The gap this closes: `hasLiveCompanionBinding` above only asks "does a binding
 * ROW exist for this route" — a `dm`-scope binding flagged non-private (card 7578dea2), or a negative/
 * non-numeric Telegram id with no matching GROUP binding (card 94754bbe), both pass that row-exists check
 * while `ChatGateway.deliveryBlockReason` would still refuse every delivery to them. A session could set
 * such a route as its home (or boot with one already stored) and see no warning anywhere, while every
 * proactive turn silently burned itself refusing to deliver.
 *
 * `binding` is the ONE binding row (if any) that currently backs `route` — resolved however the caller's
 * own scope demands: `ChatGateway.deliveryBlockReason` resolves it via its existing GLOBAL per-
 * (channel,chatId) lookup (`bindingForInbound`, unchanged by this extraction — a route is unique across
 * every session's bindings, so that global scope is deliberate there, not a bug); a caller scoped to one
 * session's own rows (`warnStaleStoredHomes`, `validateHomeTarget`, the reply status's `homeRouteRefused`)
 * resolves it by scanning THAT session's own `getCompanionBindingsForSession` rows for a channel+chatId
 * match instead — this predicate is agnostic to which scope handed it the binding.
 *
 * @decision ddf08614 — never approximate this with a binding-row-exists check alone (reintroducing the
 * exact gap above); every "would this route's delivery be refused" question routes through this function.
 */
export function companionRouteBlockReason(
  route: CompanionRoute,
  binding: CompanionRouteBindingLike | undefined,
): CompanionRouteBlockReason | undefined {
  if (binding?.flaggedNonPrivate === true) return "route-flagged-non-private"; // card 7578dea2
  if (binding?.scope === "group") return undefined; // an explicit group binding legitimately owns a @handle/negative id
  // @decision 94754bbe — a dm-shape chatId that could never carry a legitimate (non-group) binding is
  // blocked regardless of whether a binding exists at all; never re-gate this on a binding lookup
  // succeeding (that's the "@chan"/negative-id companion-HOME leak the record closes).
  if (isNonNumericTelegramChatId(route.channel, route.chatId) || isLikelyGroupTelegramChatId(route.channel, route.chatId)) return "route-unbound";
  const live = route.channel === IN_APP_CHANNEL || binding !== undefined; // card d3f9b4d2
  if (!live) return "route-unbound";
  return undefined;
}

/**
 * Call after ANY binding mutation for `sessionId`: clears the proactive HOME when it now names a route
 * with no live binding, and clears (reroutes to the session's in-app fallback on next fire) any RECURRING
 * reminder's own pinned route in the same state — each filing its own durable event. `companion`, when
 * given, is re-reconciled scoped to this session so its live `cfgs` cache (homeChannel/homeChatId) never
 * reads stale after a home-clear — mirrors the PUT/DELETE home routes' own existing call. Best-effort: a
 * durable-event append failure is swallowed (never breaks the binding mutation that triggered this).
 */
export async function reconcileCompanionBindingRoutes(
  store: CompanionRouteReconcileStore,
  sessionId: string,
  companion?: { reconcile(sessionId?: string): Promise<void> } | null,
): Promise<void> {
  const live = (route: CompanionRoute) => hasLiveCompanionBinding(store, sessionId, route);

  const home = store.getCompanionHome(sessionId);
  if (home && !live(home)) {
    store.clearCompanionHome(sessionId);
    await companion?.reconcile(sessionId);
    try {
      store.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessionId,
        kind: "companion_home_cleared", detail: { channel: home.channel, chatId: home.chatId },
      });
    } catch { /* best-effort audit trail — never break the binding mutation itself */ }
  }

  for (const reminder of store.listCompanionRemindersForSession(sessionId)) {
    if (!reminder.route || live(reminder.route)) continue;
    store.clearCompanionReminderRoute(reminder.id);
    try {
      store.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessionId,
        kind: "companion_reminder_rerouted",
        detail: { reminderId: reminder.id, channel: reminder.route.channel, chatId: reminder.route.chatId },
      });
    } catch { /* best-effort audit trail — never break the binding mutation itself */ }
  }
}
