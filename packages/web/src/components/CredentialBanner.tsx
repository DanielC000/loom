import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dot, Input } from "./ui";
import { color, font, radius } from "../theme";
import {
  clearCredentialLock, credentialLock, dismissLoopbackLinkOutcome, getLoopbackToken, loopbackLinkCopy,
  loopbackLinkOutcome, pendingLoopbackToken, retryPendingLoopbackToken, storeVerifiedLoopbackToken,
  subscribeCredentialLock, subscribeLoopbackLinkOutcome, type CredentialLockReason,
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
  // Card a1ec70a6: what a `?token=` link's secret came to. Its own signal, so the banner can say "that
  // LINK was refused, your stored credential is untouched" rather than borrowing a lock reason that claims
  // an observation (a refused write / upgrade) nobody made — and so a candidate the daemon never answered
  // for reads as "could not be checked", never as a refusal.
  const linkOutcome = useSyncExternalStore(subscribeLoopbackLinkOutcome, loopbackLinkOutcome, () => null);
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Whether this browser HOLDS a credential shapes the wording: holding one that the daemon refused is a
  // different situation (a stale/wrong token — e.g. two daemons with different LOOM_HOMEs on one port)
  // from holding none at all. Both get the paste field; only the sentence differs.
  const holdsToken = getLoopbackToken() !== null;
  const visible = reason !== null || linkOutcome !== null;
  // Offered only while a candidate is actually held — i.e. only for the one outcome a retry can change.
  const retryable = linkOutcome === "unverified" && pendingLoopbackToken() !== null;
  // A real lock still wins the headline (it is an OBSERVED refusal of this browser, where a link outcome
  // is a fact about a candidate), so a link outcome that coincides with one is appended as its own line
  // below rather than replacing the stronger statement.
  const linkCopy = linkOutcome === null ? null : loopbackLinkCopy(linkOutcome, holdsToken, retryable);
  const linkLeads = reason === null && linkCopy !== null;

  // A fresh lock re-arms the field: clear whatever the user typed against the previous one, so a second
  // refusal never presents a stale half-typed value as if it were still pending.
  useEffect(() => { if (visible) { setValue(""); setError(null); } }, [visible]);

  if (!visible) return null;

  const unlock = async () => {
    const candidate = value.trim();
    if (!candidate) { setError("That looked empty — paste the file's contents."); return; }
    setChecking(true);
    setError(null);
    // PROVE it before storing — through the ONE shared verify-then-store helper the `?token=` link path
    // uses too. A GET can't do this (the guard exempts reads), and storing first would let a bad paste
    // evict a working credential; only a guarded round-trip settles it.
    const outcome = await storeVerifiedLoopbackToken(candidate);
    setChecking(false);
    if (outcome === "refused") { setError("The daemon refused that credential — check you copied the whole file."); return; }
    // NOT a refusal: nothing answered for the credential either way, so this says exactly that rather than
    // blaming the paste — and rather than blaming the connection, which a 403 or a throttle would belie.
    if (outcome === "unverified") { setError("Didn't get an answer about that credential — nothing was saved. Try again."); return; }
    if (outcome === "unstorable") { setError("This browser refused to store it (private mode?)."); return; }
    setValue(""); // don't leave the secret sitting in component state
    clearCredentialLock();
    void qc.invalidateQueries(); // let anything that failed while locked settle
  };

  // Re-check the candidate from an unreachable-daemon capture. A success stores it and reloads (the helper
  // does both), so there is no post-success state to set here — only the two outcomes that keep us put.
  const retry = async () => {
    setRetrying(true);
    setError(null);
    const outcome = await retryPendingLoopbackToken();
    setRetrying(false);
    if (outcome === "unverified") setError("Still no answer about that credential — the link's one is still held.");
    else if (outcome === "rejected") setError("The daemon refused that link's credential, so it was discarded.");
    else if (outcome === "unstorable") setError("This browser refused to store it (private mode?).");
  };

  return (
    <div role="status" data-testid="credential-banner" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 20px",
      background: "rgba(228,90,90,0.07)", borderBottom: `1px solid ${color.red}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="red" glow style={{ marginTop: 4, flex: "0 0 auto" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
        <span style={{ color: color.text }}>
          <strong style={{ color: color.red, fontWeight: 600 }}>
            {linkLeads && linkCopy ? linkCopy.headline : "Writes are locked in this browser."}
          </strong>{" "}
          {/* A link outcome's wording lives in lib/loopbackCredential (pure, and unit-tested per variant):
              it must never claim a refusal for an unanswered check, nor promise that writes still work —
              the held secret is unproven here, and "Unlock writes" sits right below this line. */}
          {linkLeads && linkCopy
            ? linkCopy.detail
            : reason === "write"
            ? (holdsToken
              ? "The daemon refused a write: the credential this browser holds was refused."
              : "The daemon refused a write because this browser has no local access credential.")
            : "A live terminal could not connect. If you reached this daemon through a tunnel, this browser has no local access credential."}{" "}
          {linkLeads ? "" : "Reading works; writes and live terminals do not."}
        </span>
        {/* Both at once: the lock keeps the headline, and the link outcome still gets said — otherwise a
            held candidate's Retry button would appear below with nothing explaining what it retries. */}
        {!linkLeads && linkCopy
          ? <span style={{ color: color.textDim }}>{linkCopy.headline} {linkCopy.detail}</span>
          : null}
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
          {/* The one-click re-check of a candidate whose first check never reached the daemon. The user
              may have no other copy of that secret, so this is how a transient outage stops costing them
              `loom open`'s link — and it is a guarded round trip they ask for, never a background timer. */}
          {retryable
            ? <Button onClick={() => void retry()} disabled={retrying} data-testid="loopback-link-retry">
                {retrying ? "Checking…" : "Retry the link's credential"}
              </Button>
            : null}
          {/* Dismissable ONLY when a link outcome is the whole reason we're here: nothing is actually
              broken, so the user may just want the notice gone. A real lock has no dismiss. */}
          {reason === null
            ? <Button onClick={() => dismissLoopbackLinkOutcome()} data-testid="loopback-link-dismiss">Dismiss</Button>
            : null}
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
