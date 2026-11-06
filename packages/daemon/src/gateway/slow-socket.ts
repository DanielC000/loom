import type { WebSocket } from "ws";

/** WebSocket close code 1013 "Try Again Later" — sent to a client that stopped reading, or that is refused
 *  because the process is at its connection cap. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/** How long a slow consumer is given to receive its 1013 before the socket is `terminate()`d. In ws 8.x a
 *  close frame is queued BEHIND the unsent backlog, so for a client that never reads the close handshake
 *  never completes and the backlog stays pinned until `closeTimeout` (30 s). A frozen-but-alive tab that
 *  resumes within this window still sees the 1013; past it the memory is released regardless. */
export const SLOW_SOCKET_TERMINATE_GRACE_MS = 3_000;

/** Close a slow-consumer socket with 1013 and arm a terminate() after the grace window. Returns a cancel
 *  function (idempotent) the caller MUST invoke when the socket closes on its own, so no timer outlives it.
 *  The timer is unref'd and never throws; a close()/terminate() fault on a dead socket is swallowed. */
export function closeSlowSocket(socket: WebSocket, reason: string, graceMs: number = SLOW_SOCKET_TERMINATE_GRACE_MS): () => void {
  try { socket.close(WS_CLOSE_TRY_AGAIN_LATER, reason); } catch { /* already dead */ }
  const timer = setTimeout(() => {
    try { socket.terminate(); } catch { /* already dead */ }
  }, graceMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
