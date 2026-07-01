/**
 * Loom Companion — the IN-APP channel adapter + its transport hub.
 *
 * Unlike Telegram (an external-network long-poll behind a bot token), the in-app channel's transport is the
 * Loom WEB CLIENT talking to the daemon over a dedicated session WebSocket (/ws/companion/:sessionId, see
 * gateway/server.ts). The loopback cockpit IS the authenticated local user, so there is NO bot token, NO
 * pairing, and NO external authz. The in-app binding is loopback-authenticated. This adapter only CARRIES
 * traffic for a companion that ALREADY has an in-app binding (provisioned elsewhere — the human-triggered
 * provision endpoint, card cbc9fa68); it NEVER creates a companion or a binding itself.
 *
 * Separation from the terminal stream (LOAD-BEARING, PL-flagged): the in-app chat WS is a SEPARATE route
 * (/ws/companion/:sessionId) and a SEPARATE JSON message channel from the terminal-attach path
 * (/ws/term/:sessionId, which streams raw pty bytes + JSON control events). The two multiplex cleanly
 * ALONGSIDE each other on the SAME session — the chat WS never touches pty bytes, and terminal-attach never
 * sees a chat frame. There is no shared socket to hijack.
 *
 * Address convention: an in-app "chat id" IS the bound companion SESSION id — a loopback self-address. A web
 * client attaches to /ws/companion/:sessionId; inbound normalizes to { channel:"in-app", chatId:sessionId },
 * which the bindings-authoritative gateway routes back to the SAME session. The in-app binding is therefore
 * { sessionId:S, channel:"in-app", chatId:S, scope:"dm" } (minted by the provision endpoint, not here).
 *
 * The hub (InAppChannel) is STABLE across gateway rebuilds — a Telegram token change (which rebuilds the
 * gateway) must not drop live chat clients: it owns the connected-client registry and IS the outbound sink.
 * Its `.adapter` is registered on every ChatGateway the factory builds; outbound chat_reply → deliverReply →
 * adapter.send → the hub pushes a framed message to every web client attached to that chat id. INBOUND does
 * NOT flow through an adapter-constructor handler (there is no long-poll): it enters via the controller's
 * stable `handleInAppInbound` indirection (symmetric with deliverReply) so it always targets the CURRENT
 * gateway and never a torn-down one — see controller.ts.
 */
import type { ChannelAdapter, InboundMessage } from "./types.js";

/** The stable channel name — the key in the gateway registry and the `channel` on every in-app binding. */
export const IN_APP_CHANNEL = "in-app";

/**
 * A framed OUTBOUND message pushed to a connected in-app web client. `type:"chat"` is DELIBERATELY distinct
 * from the terminal stream (raw pty bytes / `{type:"data"|"exit"|…}` control events), so the two multiplex
 * on the same session without collision — a terminal viewer ignores a `chat` frame and vice versa.
 */
export interface InAppServerFrame {
  type: "chat";
  /** The in-app chat id this reply is for (== the bound companion session id). */
  chatId: string;
  text: string;
}

/** The minimal surface of a connected web client the hub pushes outbound frames to. The WS route wraps the
 *  real socket; a test injects a fake recorder. */
export interface InAppClient {
  deliver(frame: InAppServerFrame): void;
}

/**
 * Normalize an in-app inbound (a message typed in the cockpit companion chat panel) into the
 * platform-agnostic InboundMessage. `chatId` is the bound session id (the loopback self-address). There is
 * NO sender — the loopback cockpit is the single authenticated owner, so the binding's "dm" scope authorizes
 * on the route match alone (no per-sender allowlist, no pairing). Returns null for a non-string / empty body
 * (nothing to submit — mirrors the Telegram normalizer's empty-text guard).
 */
export function normalizeInAppMessage(chatId: string, body: unknown): InboundMessage | null {
  if (typeof body !== "string" || body.length === 0) return null;
  return { channel: IN_APP_CHANNEL, chatId, body };
}

/**
 * The stable in-app transport hub. Constructed ONCE (index.ts) and threaded into BOTH the gateway factory
 * (its `.adapter` is registered on every ChatGateway build) and buildServer (the /ws/companion route attaches
 * clients here). No bot token, no network — constructing it touches nothing, and with no attached client +
 * no in-app binding every path is a no-op (default-OFF byte-identical).
 */
export class InAppChannel {
  /** chatId → the set of web clients currently attached to that in-app chat. */
  private readonly clients = new Map<string, Set<InAppClient>>();

  /**
   * The ChannelAdapter registered on each gateway. OUTBOUND-only here: `send` pushes to the attached web
   * clients; `start`/`stop` are no-ops (there is no long-poll — the /ws/companion route owns connection
   * lifecycle). No `maxMessageLength`: the web client renders arbitrary-length replies, so the gateway does
   * not chunk (a reply is delivered as a single frame).
   */
  readonly adapter: ChannelAdapter = {
    name: IN_APP_CHANNEL,
    start() {
      /* no long-poll — the /ws/companion route drives the transport */
    },
    async stop() {
      /* no long-poll to stop */
    },
    send: async (chatId: string, text: string) => {
      this.deliver(chatId, text);
    },
  };

  /**
   * WS route: attach a connected web client to an in-app chat (chatId == the companion session id). Returns
   * an unsubscribe to call on socket close. Multiple viewers of the same companion chat are allowed (each
   * gets the reply).
   */
  attach(chatId: string, client: InAppClient): () => void {
    let set = this.clients.get(chatId);
    if (!set) {
      set = new Set();
      this.clients.set(chatId, set);
    }
    set.add(client);
    return () => {
      const s = this.clients.get(chatId);
      if (!s) return;
      s.delete(client);
      if (s.size === 0) this.clients.delete(chatId);
    };
  }

  /** Whether any web client is currently attached to a chat (introspection / tests). */
  hasClients(chatId: string): boolean {
    return (this.clients.get(chatId)?.size ?? 0) > 0;
  }

  /**
   * OUTBOUND sink: frame `text` and push it to every client attached to `chatId`. A client `deliver` that
   * throws is CONTAINED (one bad socket can't drop the others or bubble out of the reply path). With no
   * attached client the reply is dropped — in-app has no store-and-forward, so a PROACTIVE reply (heartbeat)
   * to a session nobody is viewing is not persisted here; the owner sees it in the session transcript on
   * attach. A reply-to-inbound always has an attached client (they just sent the message).
   */
  private deliver(chatId: string, text: string): void {
    const set = this.clients.get(chatId);
    if (!set || set.size === 0) return;
    const frame: InAppServerFrame = { type: "chat", chatId, text };
    for (const client of set) {
      try {
        client.deliver(frame);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] in-app deliver failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
