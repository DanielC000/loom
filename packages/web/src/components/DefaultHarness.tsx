import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HARNESS_FLEET_ROLES, harnessFleetScopeAvailable } from "@loom/shared";
import { api } from "../lib/api";
import { HARNESS_TITLE, type Harness, type HarnessDrainStatus } from "../lib/harnessFields";
import { Button } from "./ui";
import { color, font, radius, fs } from "../theme";

// The shared pieces behind the two "Default Harness" Settings panels (platform + per-project): the scope
// vocabulary, the roles-affected copy, the switch-to-codex confirm dialog, and the drain banner. The
// SELECTS themselves live in Settings.tsx beside every other field, so they keep that page's own
// Field/Hint/label idiom rather than growing a parallel one here.

/** "" = inherit. The two stored values mirror `HarnessDefaultScope` in @loom/shared. */
export type ScopeValue = "" | "workers" | "fleet";
export type DefaultValue = "" | Harness;

/**
 * `scope:"fleet"` is FAIL-CLOSED at BOTH write validators until the shared `HARNESS_FLEET_ROLES`
 * allowlist reaches beyond `worker` (card 4c4eb9af). So the option is rendered DISABLED with the reason
 * rather than hidden: a silently-absent option reads as a UI that forgot it, and the owner would have no
 * way to learn that the fleet-wide switch exists but is gated. Driven by the shared predicate, so it
 * re-enables itself the moment that allowlist widens — there is no second copy of the gate to update.
 */
export const fleetScopeAvailable = harnessFleetScopeAvailable();

export const FLEET_SCOPE_DISABLED_REASON =
  "Fleet scope is not accepted yet — codex has no doctrine or parity for non-worker roles, so both config validators reject it (card 4c4eb9af).";

/** Which roles a scope actually reaches, as owner-facing copy — read off the same allowlist the daemon resolves with. */
export function rolesAffected(scope: ScopeValue, inherited: "workers" | "fleet"): string {
  const effective = scope === "" ? inherited : scope;
  if (effective === "workers") return "worker sessions only";
  const roles = [...HARNESS_FLEET_ROLES];
  return roles.length === 1 ? `${roles[0]} sessions only` : `${roles.join(", ")} sessions`;
}

/**
 * Whether THIS save newly makes codex the default at this layer — the trigger for the confirm below.
 * Compares EFFECTIVE values (a blank field inherits), so blanking a codex override back onto a codex
 * platform default is correctly NOT a switch, and it never re-asks on a save that leaves codex alone.
 */
export function switchesToCodex(storedEffective: Harness, builtEffective: Harness): boolean {
  return builtEffective === "codex" && storedEffective !== "codex";
}

/**
 * The gate on switching a DEFAULT to codex. Deliberately a confirm and not a passive warning banner: this
 * setting silently changes which binary every future spawn in scope runs, and the two caveats below are
 * things the owner cannot discover from the setting itself. The copy stays short — a wall of text is read
 * past, and these two facts are the whole decision.
 */
export function CodexDefaultConfirm({ layer, scopeNote, onCancel, onConfirm }: {
  layer: "platform" | "project";
  scopeNote: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div onClick={onCancel} role="dialog" aria-modal aria-label="Confirm the codex default"
      data-testid="codex-default-confirm"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 60, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "12vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", background: color.surface, border: `1px solid ${color.attn}`,
          borderRadius: radius.base, padding: 16, display: "flex", flexDirection: "column", gap: 12,
          boxSizing: "border-box" }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.body, fontWeight: 600, color: color.text }}>
          Make Codex CLI the {layer === "platform" ? "fleet-wide" : "project"} default?
        </span>
        <span style={{ fontSize: fs.sm, lineHeight: 1.6, color: color.text2 }}>
          This applies to {scopeNote}: they will spawn the codex binary instead of claude, unless their own
          profile pins a harness. Two things are not settled yet:
        </span>
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
          <li style={{ fontSize: fs.sm, lineHeight: 1.6, color: color.attnText }}>
            A codex branch has never been through a real merge gate (card <code>d991fefd</code>).
          </li>
          <li style={{ fontSize: fs.sm, lineHeight: 1.6, color: color.attnText }}>
            A codex submit can report success off the spinner when nothing was sent (card <code>dc254a2a</code>).
          </li>
        </ul>
        <span style={{ fontSize: fs.sm, lineHeight: 1.6, color: color.text3 }}>
          Sessions already running keep the harness pinned on their row. Switching back is a one-field edit,
          so this setting is reversible — but any work a codex session lands meanwhile is not.
        </span>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onCancel} data-testid="codex-default-cancel">Keep Claude Code</Button>
          <Button variant="primary" onClick={onConfirm} data-testid="codex-default-accept">Use Codex CLI</Button>
        </div>
      </div>
    </div>
  );
}

/** One off-target session line — short id + role + the harness it is actually running. */
function DrainRow({ s, accent }: { s: { sessionId: string; role: string | null; harness: Harness }; accent: string }) {
  return (
    <span data-testid="harness-drain-row" data-session={s.sessionId}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: fs.mono, color: color.text2 }}>
      <span style={{ color: accent }}>{s.sessionId.slice(0, 8)}</span>
      <span style={{ color: color.text3 }}>{s.role ?? "plain"}</span>
      <span style={{ color: color.text3 }}>runs {s.harness}</span>
    </span>
  );
}

function DrainNote({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span data-testid="harness-drain" style={{ fontSize: fs.sm, lineHeight: 1.6, color: tone ?? color.text3 }}>
      {children}
    </span>
  );
}

/**
 * The drain banner over GET /api/harness/drain — which LIVE sessions still run a harness a spawn made
 * right now would not pick. A DERIVED read: there is no stored drain state and nothing to start or stop
 * here, so this is a status readout, never a control.
 *
 * Not polled. It refetches on mount and on window focus (react-query defaults), and each Default Harness
 * save invalidates it — a background poller on a Settings page would re-add steady-state load for a panel
 * nobody is watching change.
 */
export function HarnessDrainBanner({ projectId }: { projectId?: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["harnessDrain", projectId ?? "fleet"],
    queryFn: () => api.harnessDrain(projectId),
  });

  if (isLoading) return <DrainNote>reading harness drain status…</DrainNote>;
  if (isError || !data) {
    return <DrainNote tone={color.danger}>{(error as Error)?.message ?? "failed to load /api/harness/drain"}</DrainNote>;
  }
  return <DrainReadout data={data} scoped={projectId !== undefined} />;
}

/**
 * `pending` and `blocked` are shown as separate groups on purpose. A pending session lands on the target
 * by itself at its next spawn/recycle — it is a matter of waiting. A BLOCKED one never will, however long
 * you wait: its row carries fields codex cannot honour, so the recycle keeps its old harness deliberately.
 * Folding the two into one count would tell the owner to wait for something that is never going to happen.
 */
function DrainReadout({ data, scoped }: { data: HarnessDrainStatus; scoped: boolean }) {
  // 🔴 `target` IS NOT EVERY LISTED ROW'S DESTINATION, and saying so was this banner's first real defect
  // (caught by eyeballing, not by a test — the project-scoped case the e2e covers has the two agreeing).
  // The endpoint's own doc is explicit: `target` is the worker-role default THIS SCOPE resolves to and is
  // informational, while `pending` is decided PER SESSION by re-resolving each one through the real spawn
  // path. In FLEET scope those diverge the moment any project carries its own override — a project-level
  // codex default makes its claude worker pending while the fleet target is still claude, which read as
  // "Draining to Claude Code … runs claude". So the headline names the POPULATION, never a destination,
  // and the scope default is stated separately with its caveat.
  const scopeLine = scoped
    ? `Target: ${HARNESS_TITLE[data.target]} — this project's default.`
    : `Fleet default: ${HARNESS_TITLE[data.target]}. A project can override it, so a session listed here may be heading somewhere else.`;
  // `done` is the endpoint's OWN verdict (pending AND blocked both empty) — read it rather than
  // re-deriving it from the two arrays, so this banner can never disagree with the daemon about it.
  if (data.done) {
    return (
      <div data-testid="harness-drain" data-done="true" role="status"
        style={{ border: `1px solid ${color.line}`, borderRadius: radius.base, padding: "8px 10px",
          background: color.inset, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: fs.sm, color: color.text, lineHeight: 1.6 }}>
          Drained — every live session in scope already runs the harness a fresh spawn would pick for it.
        </span>
        <span style={{ fontSize: fs.sm, color: color.text3, lineHeight: 1.6 }}>{scopeLine}</span>
      </div>
    );
  }
  const accent = data.blocked.length > 0 ? color.danger : color.workText;
  return (
    <div data-testid="harness-drain" data-done="false" role="status"
      style={{ border: `1px solid ${accent}`, borderRadius: radius.base, padding: "8px 10px",
        background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: fs.sm, color: accent, lineHeight: 1.6 }}>
        {data.pending.length} session{data.pending.length === 1 ? "" : "s"} still to move onto the harness a
        fresh spawn would pick{data.blocked.length > 0 ? `, ${data.blocked.length} that never will` : ""}.
      </span>
      <span data-testid="harness-drain-scope"
        style={{ fontSize: fs.sm, color: color.text3, lineHeight: 1.6 }}>{scopeLine}</span>
      {data.pending.length > 0 && (
        <div data-testid="harness-drain-pending" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: fs.sm, color: color.workText }}>
            moves on its next spawn or recycle
          </span>
          {data.pending.map((s) => <DrainRow key={s.sessionId} s={s} accent={color.workText} />)}
        </div>
      )}
      {data.blocked.length > 0 && (
        <div data-testid="harness-drain-blocked" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: fs.sm, color: color.danger }}>
            will never move — the row carries fields codex cannot honour
          </span>
          {data.blocked.map((s) => (
            <span key={s.sessionId} style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: `2px solid ${color.danger}`, paddingLeft: 8 }}>
              <DrainRow s={s} accent={color.danger} />
              {s.reasons.map((r) => (
                <span key={r.id} data-testid={`harness-drain-reason-${r.id}`}
                  style={{ fontSize: fs.sm, lineHeight: 1.5, color: color.text3 }}>
                  <span style={{ fontFamily: font.mono }}>{r.id}</span>: {r.reason}
                </span>
              ))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
