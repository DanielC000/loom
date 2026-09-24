import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dot, Input } from "./ui";
import { color, font, radius } from "../theme";
import {
  clearCredentialLock, credentialLock, getLoopbackToken, setLoopbackToken, subscribeCredentialLock,
  verifyLoopbackToken, type CredentialLockReason,
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
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Whether this browser HOLDS a credential shapes the wording: holding one that the daemon refused is a
  // different situation (a stale/wrong token — e.g. two daemons with different LOOM_HOMEs on one port)
  // from holding none at all. Both get the paste field; only the sentence differs.
  const holdsToken = getLoopbackToken() !== null;

  // A fresh lock re-arms the field: clear whatever the user typed against the previous one, so a second
  // refusal never presents a stale half-typed value as if it were still pending.
  useEffect(() => { if (reason) { setValue(""); setError(null); } }, [reason]);

  if (!reason) return null;

  const unlock = async () => {
    const candidate = value.trim();
    if (!candidate) { setError("That looked empty — paste the file's contents."); return; }
    setChecking(true);
    setError(null);
    // PROVE it before storing. A GET can't do this (the guard exempts reads), and storing first would
    // let a bad paste evict a working credential. Only a guarded round-trip settles it.
    const ok = await verifyLoopbackToken(candidate);
    setChecking(false);
    if (!ok) { setError("The daemon refused that credential — check you copied the whole file."); return; }
    if (!setLoopbackToken(candidate)) { setError("This browser refused to store it (private mode?)."); return; }
    setValue(""); // don't leave the secret sitting in component state
    clearCredentialLock();
    void qc.invalidateQueries(); // let anything that failed while locked settle
  };

  return (
    <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 20px",
      background: "rgba(228,90,90,0.07)", borderBottom: `1px solid ${color.red}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="red" glow style={{ marginTop: 4, flex: "0 0 auto" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
        <span style={{ color: color.text }}>
          <strong style={{ color: color.red, fontWeight: 600 }}>Writes are locked in this browser.</strong>{" "}
          {reason === "write"
            ? (holdsToken
              ? "The daemon refused a write: the credential this browser holds was refused."
              : "The daemon refused a write because this browser has no local access credential.")
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
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }}
            placeholder="paste the local access credential"
            aria-label="Local access credential"
            autoComplete="off"
            spellCheck={false}
            disabled={checking}
            style={{ width: 340, maxWidth: "100%" }}
          />
          <Button variant="primary" onClick={() => void unlock()} disabled={checking || !value.trim()}>
            {checking ? "Checking…" : "Unlock writes"}
          </Button>
          {error ? <span style={{ color: color.red }}>{error}</span> : null}
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
