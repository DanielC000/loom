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
import type { CompanionRoute } from "./types.js";

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

/** The one true "does `route` currently have a live binding for `sessionId`" predicate every reconcile
 *  site below shares — never a second, divergent reimplementation of this question. IN_APP_CHANNEL is
 *  always considered live (mirrors ChatGateway.hasLiveBinding's own doc: in-app has no "unbound" state). */
export function hasLiveCompanionBinding(store: CompanionRouteReconcileStore, sessionId: string, route: CompanionRoute): boolean {
  return route.channel === IN_APP_CHANNEL || store.getCompanionBindingsForSession(sessionId).some((b) => b.channel === route.channel && b.chatId === route.chatId);
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
