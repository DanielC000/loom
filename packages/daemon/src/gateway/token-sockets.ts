import type { WebSocket } from "ws";

/**
 * Card 3c205fb5 — tracks every open WebSocket that was authenticated onto one of the three Tier-1 WS
 * routes (`/ws/term`, `/ws/fleet`, `/ws/companion`) via a REMOTE gateway token, keyed by that token's
 * id. A token's status change (revoke, pause, rotate, delete) previously closed nothing: the token was
 * only ever checked at upgrade, so a socket opened before the change kept streaming indefinitely. The
 * gateway-token REST writers (`gateway/server.ts`) call `closeAll` right after the DB write so every
 * socket that owes its authority to the old status/secret is terminated in the same request, not left
 * to drop on its own.
 *
 * Registration happens in each WS route handler (the only place the real `WebSocket` instance exists);
 * the token id reaching that handler is resolved earlier, in the trust-tier `onRequest` hook, and
 * threaded through via a request-keyed WeakMap (see `gateway/server.ts`). A loopback/human session is
 * never token-authenticated, so it never registers here and is entirely unaffected.
 */
export class GatewayTokenSocketRegistry {
  private readonly byToken = new Map<string, Set<WebSocket>>();

  /** Register a newly-authenticated socket under its token id. */
  register(tokenId: string, socket: WebSocket): void {
    let sockets = this.byToken.get(tokenId);
    if (!sockets) { sockets = new Set(); this.byToken.set(tokenId, sockets); }
    sockets.add(socket);
  }

  /** Drop a socket (on normal close) — idempotent, a no-op if already removed. */
  unregister(tokenId: string, socket: WebSocket): void {
    const sockets = this.byToken.get(tokenId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.byToken.delete(tokenId);
  }

  /**
   * Terminate every socket currently open for this token id — its status just changed (revoked,
   * paused, rotated, or deleted), so every socket that was authenticated under the OLD status/secret
   * must go, not just future requests. Removes the whole entry up front so a close handler racing this
   * call never re-reads a half-cleared set; each socket's own `close` listener still fires `unregister`
   * too, which is a harmless no-op by then.
   *
   * @decision 3c205fb5 — `close()` alone leaves a non-cooperative peer up to ws's own closeTimeout
   * (~30s) to keep sending frames; `terminate()` right behind it closes that window to one tick.
   */
  closeAll(tokenId: string, code: number, reason: string): void {
    const sockets = this.byToken.get(tokenId);
    if (!sockets) return;
    this.byToken.delete(tokenId);
    for (const socket of sockets) {
      try { socket.close(code, reason); } catch { /* already closing/closed */ }
      try { socket.terminate(); } catch { /* already closed */ }
    }
  }

  /** Count of currently-registered sockets for a token id — test/diagnostic use only. */
  countFor(tokenId: string): number {
    return this.byToken.get(tokenId)?.size ?? 0;
  }
}
