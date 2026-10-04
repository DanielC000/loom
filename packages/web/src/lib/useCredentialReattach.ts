/**
 * The RE-ATTACH signal: a nonce that increments every time one of this app's two credential locks
 * CLEARS. A socket client puts it in its attach effect's deps, so the effect is torn down and rebuilt
 * exactly once per unlock — rebuilding the socket with the credential the page holds NOW.
 *
 * It watches BOTH locks (the loopback write secret and the gateway token) because a pane's recovery is
 * the same either way, and watching only one is how the gap this exists to close was left open: card
 * 093981dd gave Terminal.tsx a re-attach nonce on the LOOPBACK lock, and nothing in the app ever
 * subscribed to the GATEWAY lock except the banner that raises it. So a remote pane killed by a dead
 * gateway token could only be revived by a full page reload.
 *
 * It is also what let the gateway banner stop reloading the whole page on a successful re-entry. Be exact
 * about what that buys, because it is less than it sounds: the react-query cache and every piece of
 * component state OUTSIDE the effects this nonce keys survive (the route, scroll positions, open panels,
 * an unsent composer draft). A terminal pane's SCROLLBACK does not — the nonce sits in the deps of the
 * effect that constructs the XTerm, so a bump disposes it and the daemon's bounded attach replay is what
 * repaints the pane. Nor do the companion panel's live-only rows (a media push, an STT transcript echo);
 * its transcript is re-seeded from durable history by the same effect. And the banner's own "Retry the
 * link's token", plus a `?gwtoken=` capture, both still reload (`retryPendingGatewayToken` /
 * `captureGatewayTokenFromUrl`) — only the PASTE path re-attaches in place.
 *
 * @decision a6d7bf36 — never bound a guaranteed-401 retry ladder (`createRefusalEpisode`,
 * lib/socketReconnect) in a client that does not also hold this nonce in its attach-effect deps: capping
 * the loop without it turns a noisy self-healing pane into a silently dead one, fixable only by reloading.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { credentialLock, subscribeCredentialLock } from "./loopbackCredential";
import { gatewayLock, subscribeGatewayLock } from "./gatewayCredential";

export function useCredentialReattachNonce(): number {
  const loopback = useSyncExternalStore(subscribeCredentialLock, credentialLock, () => null);
  const gateway = useSyncExternalStore(subscribeGatewayLock, gatewayLock, () => false);
  const locked = loopback !== null || gateway;
  // Seeded from the FIRST observed value, so a client that mounted while already locked still gets its
  // bump on the unlock — and one that mounted unlocked is never bumped by its own first render.
  const wasLocked = useRef(locked);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    // The clearing edge only. Bumping on the lock being SET would tear a pane down mid-failure for no
    // benefit, and bumping on every render would re-attach forever.
    if (wasLocked.current && !locked) setNonce((n) => n + 1);
    wasLocked.current = locked;
  }, [locked]);
  return nonce;
}
