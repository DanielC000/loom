import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, ApiKey, ApiKeyCaps, ApiKeyStatus } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, SectionLabel, StatusPill, Chip, Input, Select } from "./ui";
import { color, font, radius, type Tone } from "../theme";

// Agent Runs key & endpoint admin — the per-project trust-boundary WRITE surface, the second view of the
// Runs page ("Keys & Endpoints", beside the read-only "Runs" observability). Wires the human/loopback key
// REST (R1 list/create/edit/rotate/delete + R4a kill) and the endpoint flag (POST /api/agents/:id). The
// plaintext token is returned EXACTLY ONCE on create + rotate — it lives ONLY in transient component state
// here (the OneTimeSecret panel), never in the query cache and never refetched; it's cleared on dismiss.

const statusTone: Record<ApiKeyStatus, Tone> = { active: "phosphor", paused: "amber", revoked: "red" };
const ts = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const capStr = (n: number | null | undefined) => (n == null ? "" : String(n));

// A cap input is blank (= uncapped → null) or a non-negative finite number; anything else is a client-side
// error surfaced inline (the REST also 400s, but we catch it before the round-trip).
function parseCap(s: string): { ok: true; value: number | null } | { ok: false } {
  const t = s.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

export function KeyAdmin({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  // The one-time plaintext from a create/rotate — transient, NEVER cached/refetched, cleared on dismiss.
  const [secret, setSecret] = useState<{ name: string; plaintext: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const keys = useQuery({ queryKey: ["keys", projectId], queryFn: () => api.keys(projectId), enabled: !!projectId });

  const endpointAgents = useMemo(() => (agents.data ?? []).filter((a) => a.endpoint), [agents.data]);
  const agentName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) m.set(a.id, a.name);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [agents.data]);

  const invalidateKeys = () => qc.invalidateQueries({ queryKey: ["keys", projectId] });
  const invalidateAgents = () => qc.invalidateQueries({ queryKey: ["agents", projectId] });

  const toggleEndpoint = useMutation({
    mutationFn: (v: { id: string; endpoint: boolean }) => api.updateAgent(v.id, { endpoint: v.endpoint }),
    onSuccess: () => { invalidateAgents(); invalidateKeys(); },
    onError: (e) => window.alert((e as Error).message),
  });

  const create = useMutation({
    mutationFn: (b: { name: string; endpointAgentIds: string[]; caps: ApiKeyCaps; status?: ApiKeyStatus }) => api.createKey(projectId, b),
    onSuccess: (res) => { setSecret({ name: res.key.name, plaintext: res.plaintext }); setCreating(false); invalidateKeys(); },
  });
  const update = useMutation({
    mutationFn: (v: { keyId: string; patch: { name?: string; endpointAgentIds?: string[]; caps?: ApiKeyCaps; status?: ApiKeyStatus } }) => api.updateKey(v.keyId, v.patch),
    onSuccess: () => { setEditId(null); invalidateKeys(); },
  });
  const rotate = useMutation({
    mutationFn: (keyId: string) => api.rotateKey(keyId),
    onSuccess: (res) => { setSecret({ name: res.key.name, plaintext: res.plaintext }); invalidateKeys(); },
    onError: (e) => window.alert((e as Error).message),
  });
  const kill = useMutation({
    mutationFn: (keyId: string) => api.killKey(keyId),
    onSuccess: (res) => { window.alert(`Kill-switch fired — ${res.cancelled} in-flight run${res.cancelled === 1 ? "" : "s"} cancelled, key paused.`); invalidateKeys(); },
    onError: (e) => window.alert((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (keyId: string) => api.deleteKey(keyId),
    onSuccess: () => invalidateKeys(),
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = keys.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 920 }}>
      {/* The one-time plaintext — shown ONCE on create/rotate, then gone forever. */}
      {secret && <OneTimeSecret name={secret.name} plaintext={secret.plaintext} onDismiss={() => setSecret(null)} />}

      {/* ── Endpoints: flag which agents are API-exposable (allowlistable on a key) ── */}
      <div>
        <SectionLabel>Endpoints</SectionLabel>
        <Panel style={{ padding: 12 }}>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: color.textMuted }}>
            An agent must be flagged an <strong style={{ color: color.text }}>endpoint</strong> before it can be put on a key's
            allowlist below. This is a trust-boundary flag (human-only) — it changes no spawn behavior, only run-API eligibility.
          </p>
          {(agents.data ?? []).length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No agents in this project.</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(agents.data ?? []).map((a) => (
              <EndpointRow key={a.id} agent={a} pending={toggleEndpoint.isPending}
                onToggle={() => toggleEndpoint.mutate({ id: a.id, endpoint: !a.endpoint })} />
            ))}
          </div>
        </Panel>
      </div>

      {/* ── Keys ── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Keys ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          {!creating && <Button variant="primary" onClick={() => { setCreating(true); setEditId(null); }}>New key</Button>}
        </div>

        {creating && (
          <Panel style={{ padding: 12, marginBottom: 10 }}>
            <SectionLabel style={{ margin: "0 0 8px" }}>New key</SectionLabel>
            <KeyForm endpointAgents={endpointAgents} submitLabel="Create key"
              pending={create.isPending} error={create.error ? (create.error as Error).message : null}
              onSubmit={(p) => create.mutate(p)} onCancel={() => { setCreating(false); create.reset(); }} />
          </Panel>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.length === 0 && !creating && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>
              No keys yet. A key authenticates the public Run API and binds to an allowlist of this project's endpoint agents.
            </p>
          )}
          {rows.map((k) =>
            editId === k.id ? (
              <Panel key={k.id} style={{ padding: 12 }}>
                <SectionLabel style={{ margin: "0 0 8px" }}>Edit · {k.name || k.id.slice(0, 8)}</SectionLabel>
                <KeyForm endpointAgents={endpointAgents} initial={k} showStatus submitLabel="Save"
                  pending={update.isPending} error={update.error ? (update.error as Error).message : null}
                  onSubmit={(p) => update.mutate({ keyId: k.id, patch: p })}
                  onCancel={() => { setEditId(null); update.reset(); }} />
              </Panel>
            ) : (
              <KeyRow key={k.id} k={k} agentName={agentName}
                onEdit={() => { setEditId(k.id); setCreating(false); update.reset(); }}
                onRotate={() => { if (window.confirm(`Rotate the secret for "${k.name}"? The current token stops working immediately and a new one is shown ONCE.`)) rotate.mutate(k.id); }}
                onKill={() => { if (window.confirm(`Kill-switch "${k.name}"? This pauses the key AND cancels every in-flight run for it. Destructive.`)) kill.mutate(k.id); }}
                onDelete={() => { if (window.confirm(`Permanently delete "${k.name}"? This cannot be undone.`)) remove.mutate(k.id); }}
                onRevoke={() => { if (window.confirm(`Revoke "${k.name}"? It can no longer authenticate (kept for audit; delete to remove entirely).`)) update.mutate({ keyId: k.id, patch: { status: "revoked" } }); }}
                onPauseToggle={() => update.mutate({ keyId: k.id, patch: { status: k.status === "paused" ? "active" : "paused" } })}
                busy={rotate.isPending || kill.isPending || remove.isPending || update.isPending} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// The single most security-sensitive surface: the plaintext token, shown exactly once.
function OneTimeSecret({ name, plaintext, onDismiss }: { name: string; plaintext: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(plaintext).then(() => setCopied(true)).catch(() => {}); };
  return (
    <Panel style={{ padding: 14, border: `1px solid ${color.amber}`, boxShadow: `inset 0 0 0 1px ${color.amber}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <StatusPill tone="amber" label="New secret · store it now" glow />
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onDismiss} title="Dismiss — the secret is cleared and can never be shown again">Dismiss</Button>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: color.amber }}>
        This is the ONLY time the token for <strong>{name}</strong> is shown. Copy it now — it is never stored in plaintext and
        can never be retrieved again. If you lose it, rotate the key for a new one.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <code style={{
          flex: 1, fontFamily: font.mono, fontSize: 13, color: color.text, background: color.panel2,
          border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "8px 10px", wordBreak: "break-all", userSelect: "all",
        }}>{plaintext}</code>
        <Button variant="primary" onClick={copy} style={{ whiteSpace: "nowrap" }}>{copied ? "Copied ✓" : "Copy"}</Button>
      </div>
    </Panel>
  );
}

function EndpointRow({ agent, onToggle, pending }: { agent: Agent; onToggle: () => void; pending: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <StatusPill tone={agent.endpoint ? "cyan" : "muted"} label={agent.endpoint ? "endpoint" : "off"} />
      <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</span>
      <span style={{ flex: 1 }} />
      <Button variant={agent.endpoint ? "default" : "primary"} disabled={pending} onClick={onToggle}>
        {agent.endpoint ? "Disable" : "Enable"}
      </Button>
    </div>
  );
}

function KeyRow({ k, agentName, onEdit, onRotate, onKill, onDelete, onRevoke, onPauseToggle, busy }: {
  k: ApiKey; agentName: (id: string) => string; onEdit: () => void; onRotate: () => void; onKill: () => void;
  onDelete: () => void; onRevoke: () => void; onPauseToggle: () => void; busy: boolean;
}) {
  const cap = (n: number | null, suffix = "") => (n == null ? "∞" : `${n}${suffix}`);
  return (
    <Panel style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill tone={statusTone[k.status]} label={k.status} glow={k.status === "active"} />
        <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{k.name || "(unnamed)"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{k.id.slice(0, 8)}</span>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="concurrency" value={cap(k.caps.maxConcurrentRuns)} />
        <Chip label="daily tokens" value={cap(k.caps.dailyTokenCap)} />
        <Chip label="daily spend" value={k.caps.dailySpendCap == null ? "∞" : `$${k.caps.dailySpendCap}`} />
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: color.textMuted, fontFamily: font.mono }}>endpoints:</span>
        {k.endpointAgentIds.length === 0 && <span style={{ fontSize: 11, color: color.textMuted }}>none</span>}
        {k.endpointAgentIds.map((id) => <Chip key={id} value={agentName(id)} tone="cyan" />)}
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="created" value={ts(k.createdAt)} />
        <Chip label="rotated" value={ts(k.rotatedAt)} />
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button onClick={onEdit} disabled={busy}>Edit</Button>
        {k.status !== "revoked" && (
          <Button onClick={onPauseToggle} disabled={busy}>{k.status === "paused" ? "Activate" : "Pause"}</Button>
        )}
        <Button onClick={onRotate} disabled={busy}>Rotate</Button>
        <Button variant="danger" onClick={onKill} disabled={busy} title="Pause + cancel all in-flight runs">Kill</Button>
        {k.status !== "revoked" && <Button variant="danger" onClick={onRevoke} disabled={busy}>Revoke</Button>}
        <Button variant="danger" onClick={onDelete} disabled={busy}>Delete</Button>
      </div>
    </Panel>
  );
}

// Shared create/edit form. `showStatus` adds the status select (edit only). Caps are validated client-side
// (blank = uncapped) before submit; server errors come back via `error`.
function KeyForm({ endpointAgents, initial, showStatus, submitLabel, pending, error, onSubmit, onCancel }: {
  endpointAgents: Agent[];
  initial?: ApiKey;
  showStatus?: boolean;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (p: { name: string; endpointAgentIds: string[]; caps: ApiKeyCaps; status?: ApiKeyStatus }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [allow, setAllow] = useState<Set<string>>(new Set(initial?.endpointAgentIds ?? []));
  const [maxConcurrentRuns, setMax] = useState(capStr(initial?.caps.maxConcurrentRuns));
  const [dailyTokenCap, setTok] = useState(capStr(initial?.caps.dailyTokenCap));
  const [dailySpendCap, setSpend] = useState(capStr(initial?.caps.dailySpendCap));
  const [status, setStatus] = useState<ApiKeyStatus>(initial?.status ?? "active");
  const [localErr, setLocalErr] = useState<string | null>(null);

  const toggle = (id: string) => setAllow((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const submit = () => {
    setLocalErr(null);
    if (!name.trim()) { setLocalErr("Name is required."); return; }
    const c = { max: parseCap(maxConcurrentRuns), tok: parseCap(dailyTokenCap), spend: parseCap(dailySpendCap) };
    if (!c.max.ok || !c.tok.ok || !c.spend.ok) { setLocalErr("Caps must be a non-negative number, or left blank for uncapped."); return; }
    onSubmit({
      name: name.trim(),
      endpointAgentIds: [...allow],
      caps: { maxConcurrentRuns: c.max.value, dailyTokenCap: c.tok.value, dailySpendCap: c.spend.value },
      ...(showStatus ? { status } : null),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Labeled label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Invest app — prod" style={{ width: "100%" }} />
      </Labeled>

      <Labeled label="Allowlist — endpoint agents this key may invoke">
        {endpointAgents.length === 0
          ? <span style={{ fontSize: 12, color: color.textMuted }}>No endpoint agents yet — flag one above first.</span>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {endpointAgents.map((a) => (
                <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text, cursor: "pointer" }}>
                  <input type="checkbox" checked={allow.has(a.id)} onChange={() => toggle(a.id)} />
                  {a.name}
                </label>
              ))}
            </div>
          )}
      </Labeled>

      <Labeled label="Caps — blank = uncapped">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <CapInput label="max concurrent runs" value={maxConcurrentRuns} onChange={setMax} />
          <CapInput label="daily token cap" value={dailyTokenCap} onChange={setTok} />
          <CapInput label="daily spend cap ($)" value={dailySpendCap} onChange={setSpend} />
        </div>
      </Labeled>

      {showStatus && (
        <Labeled label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ApiKeyStatus)}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="revoked">revoked</option>
          </Select>
        </Labeled>
      )}

      {(localErr || error) && <div style={{ fontSize: 12, color: color.red, fontFamily: font.mono }}>{localErr ?? error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={submit} disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

function CapInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: color.textMuted, fontFamily: font.mono }}>{label}</span>
      <Input type="number" min={0} value={value} onChange={(e) => onChange(e.target.value)} placeholder="∞" style={{ width: 140 }} />
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <SectionLabel style={{ margin: "0 0 4px" }}>{label}</SectionLabel>
      {children}
    </div>
  );
}
