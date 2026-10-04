import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dot, Input } from "./ui";
import { color, font, radius } from "../theme";
import {
  clearGatewayLock, dismissGatewayLinkRejected, gatewayLinkRejected, gatewayLock, gatewayTokenRevoked, getGatewayToken, setGatewayToken,
  subscribeGatewayLinkRejected, subscribeGatewayLock, subscribeGatewayTokenRevoked, verifyGatewayTokenAgainstDaemon,
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
  const linkRejected = useSyncExternalStore(subscribeGatewayLinkRejected, gatewayLinkRejected, () => false);
  const revoked = useSyncExternalStore(subscribeGatewayTokenRevoked, gatewayTokenRevoked, () => null);
  const locked = lockedNow || linkRejected;
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const holdsToken = getGatewayToken() !== null;

  useEffect(() => { if (locked) { setValue(""); setError(null); } }, [locked]);

  if (!locked) return null;

  const unlock = async () => {
    const candidate = value.trim();
    if (!candidate) { setError("That looked empty — paste the token."); return; }
    setChecking(true);
    setError(null);
    // PROVE it before storing: a remote-class read must authenticate, so 200 ⇔ the token verified.
    const ok = await verifyGatewayTokenAgainstDaemon(candidate);
    setChecking(false);
    if (!ok) { setError("The daemon refused that token — check you copied all of it."); return; }
    if (!setGatewayToken(candidate)) { setError("This browser refused to store it (private mode?)."); return; }
    setValue(""); // don't leave the secret sitting in component state
    clearGatewayLock();
    void qc.invalidateQueries(); // let anything that failed while locked settle
    // The live panes hold sockets opened without a token; a reload is the simplest correct way to reconnect them.
    window.location.reload();
  };

  return (
    <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 20px",
      background: "rgba(228,90,90,0.07)", borderBottom: `1px solid ${color.red}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="red" glow style={{ marginTop: 4, flex: "0 0 auto" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
        <span style={{ color: color.text }}>
          <strong style={{ color: color.red, fontWeight: 600 }}>
            {revoked ? `This access token was ${revoked}.` : lockedNow ? "This address needs a gateway token." : "A link's gateway token was refused."}
          </strong>{" "}
          {revoked
            ? `Loom closed this browser's live connections because the gateway token it holds was ${revoked} on the daemon. Paste a current token to sign in again.`
            : !lockedNow
            ? "The token in the ?gwtoken= link you opened was not accepted, so it was NOT saved; the token this browser already holds is unchanged."
            : holdsToken
            ? "The daemon refused the token this browser holds (revoked, paused or mistyped)."
            : "You reached Loom through a reverse proxy, so every request must present a gateway token."}{" "}
          {lockedNow && !revoked ? "Nothing loads until it does. " : ""}This address serves reads, answering requests and steering sessions only.
        </span>
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
          {!lockedNow ? <Button onClick={() => dismissGatewayLinkRejected()}>Dismiss</Button> : null}
          {error ? <span style={{ color: color.red }}>{error}</span> : null}
        </div>
        <span style={{ color: color.textMuted }}>
          The token is stored only in this browser, and only on this origin.
        </span>
      </div>
    </div>
  );
}
