import type { ServerFleetMessage } from "@loom/shared";
import type { WebSocket } from "ws";

/**
 * C2 of the WS delta-push umbrella (1efde4ba) — the registry backing `/ws/fleet`. Holds every connected
 * fleet socket (one per client/tab, NOT per session — contrast `/ws/term`'s per-sessionId subscribe) and,
 * per socket, the set of manager ids it has subscribed to for orchestration events.
 *
 * TRANSPORT SKELETON ONLY: `broadcast`/`broadcastEvent` are unused until later cards (C3/C5 push session/
 * status deltas via `broadcast`; C7 streams orchestration events via `broadcastEvent`) — this card only
 * wires the registry + connect/sub/unsub bookkeeping, no data feeds yet.
 */
export class FleetHub {
  private readonly sockets = new Map<WebSocket, Map<string, number>>();

  /** Register a newly-connected fleet socket with no subscriptions yet. */
  add(socket: WebSocket): void {
    this.sockets.set(socket, new Map());
  }

  /** Drop a socket (on close) — idempotent, a no-op if already removed. */
  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  /** Record (or update) this socket's subscription to a manager's event stream. Bookkeeping only in this
   *  card — `sinceSeq` is stored for a later card's replay logic (C7), not consumed here. A socket not
   *  currently registered (e.g. a race with `remove`) is a silent no-op. */
  subscribeEvents(socket: WebSocket, managerId: string, sinceSeq: number): void {
    this.sockets.get(socket)?.set(managerId, sinceSeq);
  }

  /** Clear this socket's subscription to a manager's event stream. Silent no-op if not subscribed. */
  unsubscribeEvents(socket: WebSocket, managerId: string): void {
    this.sockets.get(socket)?.delete(managerId);
  }

  /** Fan out a message to every connected fleet socket (used by C3/C5). */
  broadcast(msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const socket of this.sockets.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  /** Fan out a message only to sockets currently subscribed to `managerId`'s events (used by C7). */
  broadcastEvent(managerId: string, msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const [socket, subs] of this.sockets) {
      if (subs.has(managerId) && socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  /** Test/introspection seam: this socket's current subscriptions (managerId → sinceSeq), or `undefined`
   *  if the socket isn't registered. */
  subscriptionsFor(socket: WebSocket): ReadonlyMap<string, number> | undefined {
    return this.sockets.get(socket);
  }

  /** Count of currently-connected fleet sockets. */
  get size(): number {
    return this.sockets.size;
  }
}
