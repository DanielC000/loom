import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dot, Input } from "./ui";
import { color, font, radius } from "../theme";
import {
  clearGatewayLock, dismissGatewayLinkOutcome, gatewayLinkCopy, gatewayLinkOutcome, gatewayLock, gatewayTokenRevoked,
  getGatewayToken, pendingGatewayToken, retryPendingGatewayToken, storeVerifiedGatewayToken,
  subscribeGatewayLinkOutcome, subscribeGatewayLock, subscribeGatewayTokenRevoked,
} from "../lib/gatewayCredential";

/**
 * "This address needs a gateway token" — shown ONLY after the daemon answered a request with the remote 401 that
 * carries `code: "gateway-token-required"` (a browser reaching Loom through a trusted reverse proxy such as
 * `tailscale serve`, card 4cbbc343). It is NOT the loopback "writes are locked" banner: that credential is the
 * wrong one here and its `loom open` advice is unrunnable on this device.
 *
 * @decision 093981dd — keep this banner separate from the loopback one; never print or embed a token in its copy.
 *
 * Card f8d2684d adds a THIRD headline: the token this browser holds was revoked, paused, rotated or deleted
 * WHILE the page was open (the daemon closed its live sockets with 1008, and `lib/socketReconnect` raised the
 * lock). It reuses this banner rather than minting a second one, because the paste field here already IS the
 * "sign in again" action — but it must not read as "this address needs a gateway token": the user had a
 * working one, so the copy names what changed instead of implying they never supplied one.
 */
export function GatewayTokenBanner() {
  const lockedNow = useSyncExternalStore(subscribeGatewayLock, gatewayLock, () => false);
  // Card a1ec70a6: three-state, so a check that never reached the daemon is not reported as a refusal.
  const linkOutcome = useSyncExternalStore(subscribeGatewayLinkOutcome, gatewayLinkOutcome, () => null);
  const revoked = useSyncExternalStore(subscribeGatewayTokenRevoked, gatewayTokenRevoked, () => null);
  const locked = lockedNow || linkOutcome !== null;
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const holdsToken = getGatewayToken() !== null;
  // Offered only while a candidate is actually held — the one outcome a retry can change.
  const retryable = linkOutcome === "unverified" && pendingGatewayToken() !== null;
  // Card a1ec70a6: the link wording is a PURE helper (`gatewayLinkCopy`), the twin of the loopback banner's
  // `loopbackLinkCopy`, so every variant is readable by a unit test instead of being trapped in this JSX.
  // `retryable` is passed in for the same reason it is there: the copy must not name a Retry that is not
  // being rendered beside it.
  const linkCopy = linkOutcome === null ? null : gatewayLinkCopy(linkOutcome, holdsToken, retryable);
  // A real lock (or a revocation) is an OBSERVED refusal of this browser, so it keeps the headline; a link
  // outcome that coincides with one is appended as its own line below rather than replacing it.
  const linkLeads = !lockedNow && revoked === null && linkCopy !== null;

  useEffect(() => { if (locked) { setValue(""); setError(null); } }, [locked]);

  if (!locked) return null;

  const unlock = async () => {
    const candidate = value.trim();
    if (!candidate) { setError("That looked empty — paste the token."); return; }
    setChecking(true);
    setError(null);
    // PROVE it before storing, through the shared verify-then-store chokepoint: a remote-class read must
    // authenticate, so a 2xx ⇔ the token verified.
    const outcome = await storeVerifiedGatewayToken(candidate);
    setChecking(false);
    if (outcome === "refused") { setError("The daemon refused that token — check you copied all of it."); return; }
    // NOT a refusal: nothing answered for the token either way, so this says exactly that rather than
    // blaming the paste — and rather than blaming the connection, which a 403 or a throttle would belie.
    if (outcome === "unverified") { setError("Didn't get an answer about that token — nothing was saved. Try again."); return; }
    if (outcome === "unstorable") { setError("This browser refused to store it (private mode?)."); return; }
    setValue(""); // don't leave the secret sitting in component state
    clearGatewayLock();
    void qc.invalidateQueries(); // let anything that failed while locked settle
    // The live panes hold sockets opened without a token; a reload is the simplest correct way to reconnect them.
    window.location.reload();
  };

  // Re-check a candidate whose first check never reached the daemon (the helper stores + reloads on a
  // success, so only the outcomes that keep us here need wording).
  const retry = async () => {
    setRetrying(true);
    setError(null);
    const outcome = await retryPendingGatewayToken();
    setRetrying(false);
    if (outcome === "unverified") setError("Still no answer about that token — the link's one is still held.");
    else if (outcome === "rejected") setError("The daemon refused that link's token, so it was discarded.");
    else if (outcome === "unstorable") setError("This browser refused to store it (private mode?).");
  };

  return (
    <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 20px",
      background: "rgba(228,90,90,0.07)", borderBottom: `1px solid ${color.red}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="red" glow style={{ marginTop: 4, flex: "0 0 auto" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
        <span style={{ color: color.text }}>
          <strong style={{ color: color.red, fontWeight: 600 }}>
            {linkLeads && linkCopy
              ? linkCopy.headline
              : revoked
              ? `This access token was ${revoked}.`
              : "This address needs a gateway token."}
          </strong>{" "}
          {/* A link outcome's wording lives in lib/gatewayCredential (pure, and unit-tested per variant):
              it must never claim a refusal for an unanswered check, never claim the daemon was unreachable
              (a 403 or a coded throttle came FROM it), and never name a Retry that is not rendered below. */}
          {linkLeads && linkCopy
            ? linkCopy.detail
            : revoked
            ? `Loom closed this browser's live connections because the gateway token it holds was ${revoked} on the daemon. Paste a current token to sign in again.`
            : holdsToken
            ? "The daemon refused the token this browser holds (revoked, paused or mistyped)."
            : "You reached Loom through a reverse proxy, so every request must present a gateway token."}{" "}
          {lockedNow && !revoked ? "Nothing loads until it does. " : ""}This address serves reads, answering requests and steering sessions only.
        </span>
        {/* Both at once: the lock (or the revocation) keeps the headline, and the link outcome still gets
            said — otherwise a held candidate's Retry button would appear below with nothing explaining what
            it retries, which is exactly what the round-3 review found here. */}
        {!linkLeads && linkCopy
          ? <span style={{ color: color.textDim }} data-testid="gateway-link-note">{linkCopy.headline} {linkCopy.detail}</span>
          : null}
        <span style={{ color: color.textDim }}>
          On the machine running the daemon, mint one over loopback (see <code style={{ color: color.cyan, background: color.panel2,
            border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "1px 5px" }}>POST /api/gateway-tokens</code> in
          the remote-access docs), then paste it here — or open this page once as{" "}
          <code style={{ color: color.cyan, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "1px 5px" }}>
            ?gwtoken=&lt;token&gt;
          </code>.
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Input
            type="password"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }}
            placeholder="paste the gateway token"
            aria-label="Gateway token"
            autoComplete="off"
            spellCheck={false}
            disabled={checking}
            style={{ width: 340, maxWidth: "100%" }}
          />
          <Button variant="primary" onClick={() => void unlock()} disabled={checking || !value.trim()}>
            {checking ? "Checking…" : "Use token"}
          </Button>
          {retryable
            ? <Button onClick={() => void retry()} disabled={retrying} data-testid="gateway-link-retry">
                {retrying ? "Checking…" : "Retry the link's token"}
              </Button>
            : null}
          {!lockedNow ? <Button onClick={() => dismissGatewayLinkOutcome()}>Dismiss</Button> : null}
          {error ? <span style={{ color: color.red }}>{error}</span> : null}
        </div>
        <span style={{ color: color.textMuted }}>
          The token is stored only in this browser, and only on this origin.
        </span>
      </div>
    </div>
  );
}
