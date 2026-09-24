import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dot, Input } from "./ui";
import { color, font, radius } from "../theme";
import {
  clearCredentialLock, credentialLock, setLoopbackToken, subscribeCredentialLock,
  type CredentialLockReason,
} from "../lib/loopbackCredential";

/**
 * "Writes are locked in this browser" — shown ONLY after the daemon has actually refused us for want of
 * the local access credential (a guard 401, or a rejected WebSocket upgrade on a browser holding no
 * token). A healthy host browser captured its token from `loom open`'s URL and never reaches this state.
 *
 * @decision 093981dd — the copy names the credential's FILE PATH for the user to read on the host; it
 * must never print or embed the secret value itself.
 */
export function CredentialBanner() {
  const reason = useSyncExternalStore(subscribeCredentialLock, credentialLock, () => null);
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);

  // A fresh lock re-arms the field: clear whatever the user typed against the previous one, so a second
  // refusal never presents a stale half-typed value as if it were still pending.
  useEffect(() => { if (reason) { setValue(""); setRejected(false); } }, [reason]);

  if (!reason) return null;

  const unlock = () => {
    if (!setLoopbackToken(value)) { setRejected(true); return; }
    clearCredentialLock();
    // Re-run the reads so anything that failed while locked settles, and so a still-wrong credential
    // surfaces its own fresh 401 (which re-arms this banner) instead of looking silently accepted.
    void qc.invalidateQueries();
  };

  return (
    <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 20px",
      background: "rgba(228,90,90,0.07)", borderBottom: `1px solid ${color.red}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="red" glow style={{ marginTop: 4, flex: "0 0 auto" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
        <span style={{ color: color.text }}>
          <strong style={{ color: color.red, fontWeight: 600 }}>Writes are locked in this browser.</strong>{" "}
          {reason === "write"
            ? "The daemon refused a write because this browser has no local access credential."
            : "A live terminal could not connect. If you reached this daemon through a tunnel, this browser has no local access credential."}{" "}
          Reading works; writes and live terminals do not.
        </span>
        <span style={{ color: color.textDim }}>
          On the machine running the daemon, print the credential and paste it here —{" "}
          <code style={{ color: color.cyan, background: color.panel2, border: `1px solid ${color.border}`,
            borderRadius: radius.sm, padding: "1px 5px" }}>
            cat ~/.loom/gateway-loopback.key
          </code>{" "}
          <span style={{ color: color.textMuted }}>(or {"<LOOM_HOME>"}/gateway-loopback.key if you set LOOM_HOME).</span>
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Input
            type="password"
            value={value}
            onChange={(e) => { setValue(e.target.value); setRejected(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") unlock(); }}
            placeholder="paste the local access credential"
            aria-label="Local access credential"
            autoComplete="off"
            spellCheck={false}
            style={{ width: 340, maxWidth: "100%" }}
          />
          <Button variant="primary" onClick={unlock} disabled={!value.trim()}>Unlock writes</Button>
          {rejected ? <span style={{ color: color.red }}>That looked empty — paste the file's contents.</span> : null}
        </div>
        <span style={{ color: color.textMuted }}>
          This credential carries full local API authority. It is stored only in this browser, and only on
          this origin.
        </span>
      </div>
    </div>
  );
}

export type { CredentialLockReason };
