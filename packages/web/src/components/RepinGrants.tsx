// Re-pin grants — card 158cb01a. A live session's connections/capabilities are PINNED on its row at spawn and
// stay frozen across resume/fork/recycle (owner ruling 298b826e — never change that). So a grant added to the
// agent afterwards is invisible to the session until a human re-pins it: `POST /api/sessions/:id/repin-grants`
// (human-only REST, no MCP surface), which had no UI until this component.
//
// ONE control for every mount (the shared action cluster, the Atlas session node, the Atlas agent actions),
// following the `EndSessionButton` / `canEndSession` pattern: the predicate and the control live here, so no
// surface keeps its own copy of "who can be re-pinned".
//
// @decision 158cb01a — the badge reads the daemon's counts-only dry-run, never a client-side agent-vs-session compare.
// Do not widen that response past counts (no connection id, name or host), and keep this control human-only REST.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session, SessionGrantDrift } from "@loom/shared";
import { api } from "../lib/api";
import { errorText } from "../lib/loopbackCredential";
import { Badge, Button, Panel } from "./ui";
import { color, font, fs } from "../theme";

/**
 * WHETHER a session can be re-pinned at all — the role + liveness half, as ONE predicate.
 *
 * Mirrors the daemon's refusals (`repinSessionGrants`): manager / worker / platform only (a companion has its own
 * `/upgrade` route), and a live, non-archived row. A recycle-superseded row is not knowable from the row alone, so
 * the drift read's 409 covers that case and the control simply renders nothing.
 */
export function canRepinGrants(s: Partial<Pick<Session, "role" | "processState" | "archivedAt">>): boolean {
  return s.processState === "live" && !s.archivedAt && (s.role === "manager" || s.role === "worker" || s.role === "platform");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface DriftChange {
  key: string;
  text: string;
  /** True for a change that REMOVES a restriction (tool restriction off, commit block off): shown prominently. */
  loosening: boolean;
}

const skillsText = (n: number | null) => (n == null ? "all skills" : plural(n, "skill"));

/** One entry per field the re-pin would change, in the dialog's order. Counts / booleans / field names only. */
export function driftChanges(d: SessionGrantDrift): DriftChange[] {
  const out: DriftChange[] = [];
  if (d.connections.pinned !== d.connections.current) {
    out.push({
      key: "connections", loosening: false,
      text: d.connections.pinned === 0
        ? `pinned to 0 of ${plural(d.connections.current, "connection grant")}`
        : `${plural(d.connections.pinned, "connection")} pinned → ${d.connections.current} granted`,
    });
  }
  if (d.capabilities.pinned !== d.capabilities.current) {
    out.push({ key: "capabilities", loosening: false, text: `${d.capabilities.pinned} → ${d.capabilities.current} capabilities` });
  }
  if (d.vaultWrite.pinned !== d.vaultWrite.current) {
    out.push({ key: "vaultWrite", loosening: false, text: d.vaultWrite.current ? "vault write newly granted" : "vault write revoked" });
  }
  if (d.restrictedTools.pinned !== d.restrictedTools.current) {
    out.push(d.restrictedTools.current
      ? { key: "restrictedTools", loosening: false, text: "tool restriction turned ON" }
      : { key: "restrictedTools", loosening: true, text: "tool restriction REMOVED — the session would resume with its restricted tools unrestricted" });
  }
  if (d.noCommit.pinned !== d.noCommit.current) {
    out.push(d.noCommit.current
      ? { key: "noCommit", loosening: false, text: "commit block turned ON" }
      : { key: "noCommit", loosening: true, text: "commit block REMOVED — the session would be allowed to commit" });
  }
  if (d.browserTesting.pinned !== d.browserTesting.current) {
    out.push({ key: "browserTesting", loosening: false, text: d.browserTesting.current ? "browser testing enabled" : "browser testing disabled" });
  }
  if (d.documentConversion.pinned !== d.documentConversion.current) {
    out.push({ key: "documentConversion", loosening: false, text: d.documentConversion.current ? "document conversion enabled" : "document conversion disabled" });
  }
  if (d.skills.pinned !== d.skills.current) {
    out.push({ key: "skills", loosening: false, text: `skills: ${skillsText(d.skills.pinned)} → ${skillsText(d.skills.current)}` });
  }
  // Drift the counts above cannot show (an equal-count swap of connections or capabilities).
  if (out.length === 0 && d.drifted) {
    out.push({ key: "membership", loosening: false, text: "the granted connections or capabilities differ (same counts)" });
  }
  return out;
}

/** The badge line: only the parts that actually differ. */
export function driftSummary(d: SessionGrantDrift): string {
  return driftChanges(d).map((c) => c.text).join(" · ");
}

export const FIRST_TIME_GRANT_NOTE =
  "A first-time grant only becomes callable after this session is resumed — re-pinning updates the row, it does not restart the session or re-list its tools.";

export const SPAWN_TIME_NOTE =
  "Capabilities, browser testing, document conversion, tool restriction and skills are mounted only when the session starts: those changes (adds and revocations alike) take effect on its next resume.";

export function RepinGrantsControl({ session }: { session: Partial<Pick<Session, "id" | "role" | "processState" | "archivedAt">> & { id: string } }) {
  const qc = useQueryClient();
  const eligible = canRepinGrants(session);
  const [confirming, setConfirming] = useState(false);
  const drift = useQuery({
    queryKey: ["grantDrift", session.id],
    queryFn: () => api.sessionGrantDrift(session.id),
    enabled: eligible,
    retry: false,
    staleTime: 15_000,
  });
  const repin = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.repinSessionGrants(session.id),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["grantDrift", session.id] });
      qc.invalidateQueries({ queryKey: ["allSessions"] });
    },
  });

  // Nothing renders until the dry-run answers AND reports drift. A 409 (superseded / archived) or a failed read
  // is "no badge", never an error banner on a surface that did not ask for one.
  const d = drift.data;
  if (!eligible || !d || !d.drifted) return null;

  const summary = driftSummary(d);
  const changes = driftChanges(d);
  const showResumeNote = d.firstTimeGrant || d.spawnTimeChanged;
  return (
    <span data-testid={`repin-grants-${session.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Badge tone="attn" data-testid={`repin-drift-badge-${session.id}`}
        title={d.firstTimeGrant ? `${summary}. ${FIRST_TIME_GRANT_NOTE}` : summary}>
        grants out of date
      </Badge>
      <Button disabled={repin.isPending} data-testid={`repin-grants-button-${session.id}`}
        title={`Re-pin this session's grants from its agent's current grants (${summary}). Updates the stored grants only; does not restart the session.`}
        onClick={(ev) => { ev.stopPropagation(); setConfirming(true); void drift.refetch(); }}>Re-pin grants</Button>
      {confirming && (
        <Panel role="alertdialog" aria-label="Confirm re-pin grants" data-testid={`repin-confirm-${session.id}`}
          onClick={(ev) => ev.stopPropagation()}
          style={{
            position: "fixed", top: "20%", left: "50%", transform: "translateX(-50%)", zIndex: 1000, width: "min(460px, 92vw)",
            boxShadow: `inset 0 0 0 1px ${color.attn}`, display: "flex", flexDirection: "column", gap: 10,
          }}>
          <strong style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text }}>Re-pin grants for this session?</strong>
          <p data-testid="repin-confirm-counts" style={{ margin: 0, fontSize: fs.sm, lineHeight: 1.6, color: color.text }}>
            This session is pinned to {plural(d.connections.pinned, "connection")} and {plural(d.capabilities.pinned, "capability grant")}.
            Its agent currently grants {plural(d.connections.current, "connection")} and {plural(d.capabilities.current, "capability grant")}.
            Re-pinning updates the session's stored grants to match its agent. It does not restart the session.
          </p>
          <ul data-testid="repin-confirm-changes" style={{ margin: 0, paddingLeft: 18, fontSize: fs.sm, lineHeight: 1.6, color: color.text }}>
            {changes.map((c) => (
              <li key={c.key} data-testid={`repin-confirm-change-${c.key}`} data-loosening={c.loosening ? "true" : undefined}
                style={c.loosening ? { color: color.dangerText, fontWeight: 700 } : undefined}>
                {c.loosening ? "⚠ " : ""}{c.text}
              </li>
            ))}
          </ul>
          {showResumeNote && (
            <p data-testid="repin-confirm-resume-note" style={{ margin: 0, fontSize: fs.sm, lineHeight: 1.6, color: color.attnText }}>
              {SPAWN_TIME_NOTE} Connection and vault-write changes apply to the session's next tool call.
            </p>
          )}
          {d.firstTimeGrant && (
            <p data-testid="repin-confirm-first-time" style={{ margin: 0, fontSize: fs.sm, lineHeight: 1.6, color: color.attnText }}>
              {d.connections.pinned === 0 && d.connections.current > 0
                ? `Pinned 0 of ${plural(d.connections.current, "connection grant")}. Re-pin, then resume this session: `
                : "Re-pin, then resume this session: "}
              a first-time grant's tool (e.g. ssh_exec / authenticated_request / vault_write) only appears after a resume.
            </p>
          )}
          {repin.isError && <span role="alert" style={{ color: color.danger, fontSize: fs.sm }}>{errorText(repin.error)}</span>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" disabled={repin.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" disabled={repin.isPending || drift.isFetching} data-testid={`repin-confirm-apply-${session.id}`}
              onClick={() => repin.mutate()}>{repin.isPending ? "Re-pinning…" : "Re-pin grants"}</Button>
          </div>
        </Panel>
      )}
    </span>
  );
}
