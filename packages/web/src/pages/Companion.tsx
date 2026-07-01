import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { CompanionConfigMasked, CompanionBinding, SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import {
  bindingFromCreateForm, buildConfigBody, emptyConfigForm, formFromMasked, maskedToken,
  validateBinding, validatePairing, validateSender, type CompanionConfigForm,
} from "../lib/companion";
import { Panel, Button, Input, Select, SectionLabel, Badge, StatusPill, Chip } from "../components/ui";
import { CompanionChat } from "../components/CompanionChat";
import { IN_APP_CHANNEL } from "../lib/companionChat";
import { color, font, radius } from "../theme";

// Loom Companion management (Companion epic Phase 3). The HUMAN-only cockpit surface over the loopback
// companion REST: create/configure a companion (masked bot token, cadence, home, enabled), manage its
// access (session↔chat bindings + the group sender allowlist), and mint one-time DM-pairing codes. The
// bot token is WRITE-ONLY end to end — a read never carries it; the form only ever SENDS a typed token,
// and a blank "replace" field keeps the daemon's stored (encrypted) one. Config applies on the next
// daemon (re)start (hot-reconfigure is a separate backend card); the UI states that plainly.

const fieldLabel: CSSProperties = {
  fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: color.textDim,
};
const hint: CSSProperties = { fontSize: 11, color: color.textMuted, fontFamily: font.mono, lineHeight: 1.5 };
const errStyle: CSSProperties = { color: color.red, fontSize: 12, fontFamily: font.mono };

function Field({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>
        {label}
        {sub && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}> · {sub}</span>}
      </span>
      {children}
    </label>
  );
}

// One companion, keyed by its bound assistant session id — the union of a run-config row and/or an
// access binding (either can exist alone: env-bootstrapped companions may have a binding before a
// REST config; a fresh REST config may exist before its binding is added — a "provisioned, not yet
// reachable" companion, since the gateway routes ONLY off bindings).
interface CompanionRow { sessionId: string; config?: CompanionConfigMasked; binding?: CompanionBinding; }

export default function Companion() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const configs = useQuery({ queryKey: ["companionConfigs"], queryFn: api.companionConfigs });
  const bindings = useQuery({ queryKey: ["companionBindings"], queryFn: api.companionBindings });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });

  // Merge configs + bindings into the companion list, keyed by session id.
  const companions = useMemo<CompanionRow[]>(() => {
    const byId = new Map<string, CompanionRow>();
    for (const c of configs.data ?? []) byId.set(c.sessionId, { sessionId: c.sessionId, config: c });
    for (const b of bindings.data ?? []) {
      const cur = byId.get(b.sessionId) ?? { sessionId: b.sessionId };
      byId.set(b.sessionId, { ...cur, binding: b });
    }
    return [...byId.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }, [configs.data, bindings.data]);

  const sessionLabel = useMemo(() => {
    const m = new Map<string, SessionListItem>();
    for (const s of sessions.data ?? []) m.set(s.id, s);
    return (id: string) => {
      const s = m.get(id);
      if (!s) return id.slice(0, 8);
      const bits = [s.agentName, s.title].filter(Boolean).join(" · ");
      return bits || id.slice(0, 8);
    };
  }, [sessions.data]);

  // Assistant-role sessions not yet configured — the create form's session picker.
  const assistantSessions = useMemo(
    () => (sessions.data ?? []).filter((s) => s.role === "assistant" && !companions.some((c) => c.sessionId === s.id)),
    [sessions.data, companions],
  );

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["companionConfigs"] });
    qc.invalidateQueries({ queryKey: ["companionBindings"] });
  };

  // Create = TWO writes (PL bindings-authoritative ruling): the config row arms transport, and — when a DM
  // chat id was supplied — a binding via the existing human-only POST arms ROUTING (the gateway routes
  // ONLY off bindings). One form, both stores. If the config lands but the binding fails, the companion is
  // a valid "provisioned, not yet reachable" row; we surface the reason and keep it in the list so the human
  // can add the binding under Access.
  const createConfig = useMutation({
    mutationFn: async ({ configBody, binding }: {
      configBody: Record<string, unknown>;
      binding: ReturnType<typeof bindingFromCreateForm>;
    }) => {
      const row = await api.createCompanionConfig(configBody);
      if (binding) {
        try {
          await api.createCompanionBinding({ ...binding, sessionId: row.sessionId });
        } catch (e) {
          throw new Error(`Companion saved, but arming its DM routing failed: ${(e as Error).message} — open it and add a binding under Access.`);
        }
      }
      return row;
    },
    onSuccess: (row) => { invalidateAll(); setSelected(row.sessionId); setCreating(false); },
    // The config may have been written even though the binding failed — refresh so the new (not-yet-reachable)
    // companion still shows up while the create form keeps the error visible.
    onError: () => { invalidateAll(); },
  });

  const current = companions.find((c) => c.sessionId === selected) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, maxWidth: 1180 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, alignSelf: "start" }}>
      <Panel>
        <SectionLabel>Companions</SectionLabel>
        <p style={{ ...hint, margin: "0 0 10px" }}>
          Chat-native personal agents reachable over Telegram. Each is a real <code>claude</code> session
          bound to a chat. Human-managed; the bot token is stored encrypted and never shown.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {companions.map((c) => {
            const on = c.config?.enabled ?? false;
            return (
              <Button key={c.sessionId} variant={c.sessionId === selected ? "primary" : "default"}
                style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setSelected(c.sessionId); setCreating(false); }}
                title={c.sessionId}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sessionLabel(c.sessionId)}
                </span>
                {c.config && !c.binding && (
                  <span style={{ fontSize: 9, color: color.amber, fontFamily: font.mono }} title="provisioned but no chat binding — not reachable yet">NO ROUTE</span>
                )}
                {c.config
                  ? <span style={{ fontSize: 9, color: on ? color.phosphor : color.textMuted, fontFamily: font.mono }}>{on ? "ON" : "OFF"}</span>
                  : <span style={{ fontSize: 9, color: color.cyan, fontFamily: font.mono }} title="access binding only — no run config yet">BIND</span>}
              </Button>
            );
          })}
          {companions.length === 0 && !configs.isLoading && (
            <span style={{ color: color.textMuted, fontSize: 12 }}>No companions yet.</span>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" style={{ width: "100%" }} onClick={() => { setCreating(true); setSelected(null); }}>+ New companion</Button>
        </div>
      </Panel>
      <GlobalHome />
      </div>

      <Panel style={{ minHeight: "72vh", padding: 14 }}>
        {creating ? (
          <ConfigCreate
            assistantSessions={assistantSessions}
            onCreate={(p) => createConfig.mutate(p)}
            pending={createConfig.isPending}
            error={createConfig.error ? (createConfig.error as Error).message : null}
            onCancel={() => { setCreating(false); createConfig.reset(); }}
          />
        ) : current ? (
          <CompanionDetail
            key={current.sessionId}
            companion={current}
            label={sessionLabel(current.sessionId)}
            onChanged={invalidateAll}
            onDeleted={() => { invalidateAll(); setSelected(null); }}
          />
        ) : (
          <p style={{ color: color.textMuted, padding: 12 }}>Select a companion to manage it, or create a new one.</p>
        )}
      </Panel>
    </div>
  );
}

// ── Global proactive home ───────────────────────────────────────────────────────
// The proactive HOME is a daemon-GLOBAL value (app_meta), NOT per-companion — so it lives here in the
// sidebar, managed on its own, rather than buried in a per-companion form where editing one companion
// would silently redirect every companion's heartbeats (the footgun this control removes).
function GlobalHome() {
  const qc = useQueryClient();
  const home = useQuery({ queryKey: ["companionHome"], queryFn: api.companionHome });
  const [editing, setEditing] = useState(false);
  const [channel, setChannel] = useState("");
  const [chatId, setChatId] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  // A masked config echoes the global home, so refresh the config list too when it changes.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["companionHome"] });
    qc.invalidateQueries({ queryKey: ["companionConfigs"] });
  };
  const save = useMutation({
    mutationFn: (b: { channel: string; chatId: string }) => api.setCompanionHome(b),
    onSuccess: () => { invalidate(); setEditing(false); },
  });
  const clear = useMutation({
    mutationFn: () => api.clearCompanionHome(),
    onSuccess: invalidate,
  });

  const beginEdit = () => {
    setChannel(home.data?.channel ?? "telegram");
    setChatId(home.data?.chatId ?? "");
    setLocalErr(null);
    setEditing(true);
  };
  const submit = () => {
    setLocalErr(null);
    if (!channel.trim() || !chatId.trim()) { setLocalErr("Set both a channel and a chat id."); return; }
    save.mutate({ channel: channel.trim(), chatId: chatId.trim() });
  };

  return (
    <Panel>
      <SectionLabel>Proactive home</SectionLabel>
      <p style={{ ...hint, margin: "0 0 10px" }}>
        Daemon-<strong style={{ color: color.text }}>global</strong> — the one chat every companion's
        heartbeats post to. Not per companion; changing it here moves them all.
      </p>
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Field label="Channel"><Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="telegram" spellCheck={false} /></Field>
          <Field label="Chat id"><Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="home chat id" spellCheck={false} /></Field>
          {(localErr || save.error) && <span style={errStyle}>{localErr ?? (save.error as Error).message}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save home"}</Button>
            <Button variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); save.reset(); setLocalErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Chip label="home" value={home.data ? `${home.data.channel}:${home.data.chatId}` : "unset"} tone={home.data ? undefined : "muted"} />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={beginEdit}>{home.data ? "Change home" : "Set home"}</Button>
            {home.data && <Button variant="danger" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear</Button>}
          </div>
          {clear.error && <span style={errStyle}>{(clear.error as Error).message}</span>}
        </div>
      )}
    </Panel>
  );
}

// ── Create form ────────────────────────────────────────────────────────────────
function ConfigCreate({ assistantSessions, onCreate, pending, error, onCancel }: {
  assistantSessions: SessionListItem[];
  onCreate: (p: { configBody: Record<string, unknown>; binding: ReturnType<typeof bindingFromCreateForm> }) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CompanionConfigForm>(emptyConfigForm());
  const [manualId, setManualId] = useState(assistantSessions.length === 0);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const set = <K extends keyof CompanionConfigForm>(k: K, v: CompanionConfigForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    setLocalErr(null);
    const built = buildConfigBody(form, "create");
    if ("error" in built) { setLocalErr(built.error); return; }
    // The create flow also arms routing: derive the DM binding from the same form and validate it before
    // the round-trip (the gateway routes only off bindings — see bindingFromCreateForm).
    const binding = bindingFromCreateForm(form);
    if (binding) {
      const bErr = validateBinding(binding);
      if (bErr) { setLocalErr(bErr); return; }
    }
    onCreate({ configBody: built.body, binding });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>New companion</strong>
      <p style={hint}>
        Bind a run configuration to an <strong style={{ color: color.text }}>assistant</strong>-role session. The
        session is the companion's brain; this config tells the daemon which bot to run it as. The{" "}
        <strong style={{ color: color.text }}>chat id</strong> you give below both boot-seeds the config and
        arms routing — it writes a DM binding so the companion is reachable straight away. Change where it's
        reachable later under Access.
      </p>

      <Field label="Companion session" sub={manualId ? "paste an assistant session id" : "assistant-role sessions"}>
        {manualId ? (
          <Input value={form.sessionId} onChange={(e) => set("sessionId", e.target.value)}
            placeholder="session id" spellCheck={false} />
        ) : (
          <Select value={form.sessionId} onChange={(e) => set("sessionId", e.target.value)}>
            <option value="">— select a session —</option>
            {assistantSessions.map((s) => (
              <option key={s.id} value={s.id}>{[s.agentName, s.title].filter(Boolean).join(" · ") || s.id.slice(0, 8)}</option>
            ))}
          </Select>
        )}
        <button type="button" onClick={() => { setManualId((m) => !m); set("sessionId", ""); }}
          style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: color.cyan, cursor: "pointer", fontFamily: font.mono, fontSize: 11, padding: "2px 0" }}>
          {manualId ? "pick from sessions" : "paste an id instead"}
        </button>
      </Field>

      <ConfigFields form={form} set={set} mode="create" />

      {(localErr || error) && <span style={errStyle}>{localErr ?? error}</span>}

      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <Button variant="primary" disabled={pending} onClick={submit}>{pending ? "Creating…" : "Create companion"}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

// ── Shared config fields (channel / token / chat / cadence / home / enabled) ─────
function ConfigFields({ form, set, mode, currentToken }: {
  form: CompanionConfigForm;
  set: <K extends keyof CompanionConfigForm>(k: K, v: CompanionConfigForm[K]) => void;
  mode: "create" | "edit";
  currentToken?: string; // the masked "••••1234" for the edit-mode read-only display
}) {
  return (
    <>
      <Field label="Bot token" sub={mode === "edit" ? "write-only · leave blank to keep the stored token" : "from BotFather"}>
        {mode === "edit" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ ...hint, color: color.textDim }}>stored</span>
            <code style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>{currentToken}</code>
          </div>
        )}
        <Input type="password" autoComplete="new-password" value={form.botToken}
          onChange={(e) => set("botToken", e.target.value)}
          placeholder={mode === "edit" ? "replace token…" : "123456:ABC-DEF…"} spellCheck={false} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Channel">
          <Input value={form.channel} onChange={(e) => set("channel", e.target.value)} placeholder="telegram" spellCheck={false} />
        </Field>
        <Field label="Chat scope" sub={mode === "create" ? "dm = private · group = allowlisted senders" : "boot-seed default · routing lives in Access"}>
          <Select value={form.chatScope} onChange={(e) => set("chatScope", e.target.value as "dm" | "group")}>
            <option value="dm">dm</option>
            <option value="group">group</option>
          </Select>
        </Field>
      </div>

      <Field label="Allowed chat id" sub={mode === "create" ? "the owner DM chat — arms routing (writes a binding)" : "boot-seed only · edit routing under Access"}>
        <Input value={form.allowedChatId} onChange={(e) => set("allowedChatId", e.target.value)} placeholder="e.g. 123456789" spellCheck={false} />
        {mode === "edit" && (
          <span style={hint}>
            Live inbound routing is owned by the binding under <strong style={{ color: color.text }}>Access</strong> —
            editing this only changes the boot-seed default the daemon reads on a cold start.
          </span>
        )}
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Heartbeat cadence" sub="minutes · 0 = off">
          <Input type="number" min={0} value={form.heartbeatIntervalMinutes}
            onChange={(e) => set("heartbeatIntervalMinutes", e.target.value)} placeholder="0" />
        </Field>
        <div />
      </div>

      <Field label="Heartbeat prompt" sub="proactive turn text · blank = default">
        <textarea value={form.heartbeatPrompt} onChange={(e) => set("heartbeatPrompt", e.target.value)}
          placeholder="Check in — anything worth surfacing?" rows={2} spellCheck={false}
          style={{
            background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`,
            borderRadius: radius.base, padding: "6px 8px", fontFamily: font.mono, fontSize: 13, resize: "vertical",
          }} />
      </Field>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text, cursor: "pointer" }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Enabled
      </label>
    </>
  );
}

// ── Detail: chat surface (default face) + config editor + access + pairing ───────
function CompanionDetail({ companion, label, onChanged, onDeleted }: {
  companion: CompanionRow; label: string; onChanged: () => void; onDeleted: () => void;
}) {
  // Chat is the companion's DEFAULT face in the app (not the raw terminal); Manage is a click away.
  const [mode, setMode] = useState<"chat" | "manage">("chat");
  // In-app reachability: an in-app reply frame only comes back when a binding on the in-app channel exists
  // for this session (chatId == sessionId — the loopback self-address). Anything else ⇒ chat shows the
  // gentle "not wired" notice instead of implying a message was delivered.
  const armed = companion.binding?.channel === IN_APP_CHANNEL && companion.binding.chatId === companion.sessionId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{label}</strong>
        {companion.config
          ? <Badge tone={companion.config.enabled ? "phosphor" : "muted"}>{companion.config.enabled ? "enabled" : "disabled"}</Badge>
          : <Badge tone="cyan">binding only</Badge>}
        {companion.config?.envPinned && <Badge tone="amber">pinned by env</Badge>}
        {companion.config && !companion.binding && <Badge tone="amber">not reachable — no binding</Badge>}
        <span style={{ flex: 1 }} />
        <ModeToggle mode={mode} onMode={setMode} />
      </div>

      {mode === "chat" ? (
        <div role="tabpanel" id="companion-panel-chat" aria-labelledby="companion-tab-chat"
          style={{ flex: 1, minHeight: "62vh", display: "flex", flexDirection: "column" }}>
          <CompanionChat sessionId={companion.sessionId} title={label} armed={armed} />
        </div>
      ) : (
        <div role="tabpanel" id="companion-panel-manage" aria-labelledby="companion-tab-manage"
          style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <ConfigSection companion={companion} onChanged={onChanged} onDeleted={onDeleted} />
          <AccessSection companion={companion} onChanged={onChanged} />
          <PairingSection sessionId={companion.sessionId} />

          <Panel style={{ padding: 12, background: color.panel2 }}>
            <SectionLabel style={{ margin: "0 0 6px" }}>Restrict this companion's tools</SectionLabel>
            <p style={{ ...hint, margin: 0 }}>
              A chat-reachable agent is high blast-radius. Confine what it can do with the{" "}
              <strong style={{ color: color.text }}>restricted / confirm-gated</strong> tool toggle on its Profile —{" "}
              <Link to="/profiles" style={{ color: color.cyan }}>open Profiles →</Link>
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}

// Segmented Chat / Manage switch — a companion's chat is the default view; management is one click away.
function ModeToggle({ mode, onMode }: { mode: "chat" | "manage"; onMode: (m: "chat" | "manage") => void }) {
  const opts: { key: "chat" | "manage"; label: string }[] = [{ key: "chat", label: "Chat" }, { key: "manage", label: "Manage" }];
  return (
    <div role="tablist" aria-label="Companion view" style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: radius.base, overflow: "hidden" }}>
      {opts.map((o) => {
        const on = o.key === mode;
        return (
          <button
            key={o.key}
            id={`companion-tab-${o.key}`}
            role="tab"
            aria-selected={on}
            aria-controls={`companion-panel-${o.key}`}
            onClick={() => onMode(o.key)}
            className="loom-toggle"
            style={{
              background: on ? color.phosphorDim : "transparent",
              color: on ? color.text : color.textDim,
              border: "none", padding: "5px 14px", fontFamily: font.mono, fontSize: 12, cursor: "pointer",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ConfigSection({ companion, onChanged, onDeleted }: { companion: CompanionRow; onChanged: () => void; onDeleted: () => void }) {
  const cfg = companion.config;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CompanionConfigForm>(() => (cfg ? formFromMasked(cfg) : emptyConfigForm(companion.sessionId)));
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = <K extends keyof CompanionConfigForm>(k: K, v: CompanionConfigForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      cfg ? api.updateCompanionConfig(companion.sessionId, b) : api.createCompanionConfig({ ...b, sessionId: companion.sessionId }),
    onSuccess: () => { onChanged(); setEditing(false); },
  });
  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.updateCompanionConfig(companion.sessionId, { enabled }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCompanionConfig(companion.sessionId),
    onSuccess: onDeleted,
  });

  const beginEdit = () => { setForm(cfg ? formFromMasked(cfg) : emptyConfigForm(companion.sessionId)); setLocalErr(null); setEditing(true); };
  const submit = () => {
    setLocalErr(null);
    const built = buildConfigBody(form, cfg ? "edit" : "create");
    if ("error" in built) { setLocalErr(built.error); return; }
    save.mutate(built.body);
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Run configuration</SectionLabel>
        <span style={{ flex: 1 }} />
        {cfg && !editing && (
          <Button disabled={toggleEnabled.isPending} onClick={() => toggleEnabled.mutate(!cfg.enabled)}
            title={cfg.enabled ? "Disable — treated as OFF at next boot" : "Enable"}>
            {cfg.enabled ? "Disable" : "Enable"}
          </Button>
        )}
        {!editing && <Button variant="primary" onClick={beginEdit}>{cfg ? "Edit" : "Configure"}</Button>}
      </div>

      {cfg?.envPinned && (
        <Callout tone="amber">
          <code>LOOM_COMPANION_*</code> env is set for this session — it will <strong>override</strong> these
          values on the next daemon restart. Edit the env (or unset it) to make a REST change stick.
        </Callout>
      )}

      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ConfigFields form={form} set={set} mode={cfg ? "edit" : "create"} currentToken={cfg ? maskedToken(cfg) : undefined} />
          {(localErr || save.error) && <span style={errStyle}>{localErr ?? (save.error as Error).message}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save"}</Button>
            <Button variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); save.reset(); }}>Cancel</Button>
          </div>
        </div>
      ) : cfg ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Chip label="token" value={maskedToken(cfg)} />
            <Chip label="channel" value={cfg.channel} tone="cyan" />
            <Chip label="scope" value={cfg.chatScope} />
            <Chip label="chat" value={cfg.allowedChatId} />
            <Chip label="heartbeat" value={cfg.heartbeatIntervalMinutes ? `${cfg.heartbeatIntervalMinutes}m` : "off"} tone={cfg.heartbeatIntervalMinutes ? "phosphor" : "muted"} />
            <Chip label="home (global)" value={cfg.home ? `${cfg.home.channel}:${cfg.home.chatId}` : "unset"} tone={cfg.home ? undefined : "muted"} />
          </div>
          <p style={{ ...hint, margin: 0 }}>Changes apply on the next daemon restart.</p>
          <p style={{ ...hint, margin: 0 }}>
            The proactive <strong style={{ color: color.text }}>home</strong> is daemon-global (shared by every
            companion) — manage it under <strong style={{ color: color.text }}>Proactive home</strong> in the sidebar.
          </p>
          <div>
            {confirmDel ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={errStyle}>Delete this run config? The token is erased.</span>
                <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Confirm</Button>
                <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
              </div>
            ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete config</Button>}
          </div>
        </>
      ) : (
        <p style={hint}>No run config for this session yet — <strong style={{ color: color.text }}>Configure</strong> to set a bot token and cadence.</p>
      )}
    </section>
  );
}

// ── Access: the session↔chat binding + the group sender allowlist ───────────────
function AccessSection({ companion, onChanged }: { companion: CompanionRow; onChanged: () => void }) {
  const { sessionId } = companion;
  const binding = companion.binding ?? null;
  const [adding, setAdding] = useState(false);
  const [chatId, setChatId] = useState("");
  const [channel, setChannel] = useState(companion.config?.channel ?? "telegram");
  const [scope, setScope] = useState<"dm" | "group">(companion.config?.chatScope ?? "dm");
  const [localErr, setLocalErr] = useState<string | null>(null);

  const createBinding = useMutation({
    mutationFn: (b: { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" }) => api.createCompanionBinding(b),
    onSuccess: () => { onChanged(); setAdding(false); setChatId(""); },
  });
  const removeBinding = useMutation({
    mutationFn: () => api.deleteCompanionBinding(sessionId),
    onSuccess: onChanged,
  });

  const submit = () => {
    setLocalErr(null);
    const b = { sessionId, channel: channel.trim(), chatId: chatId.trim(), scope };
    const err = validateBinding(b);
    if (err) { setLocalErr(err); return; }
    createBinding.mutate(b);
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Access</SectionLabel>
        <span style={{ flex: 1 }} />
        {!binding && !adding && <Button variant="primary" onClick={() => setAdding(true)}>Add binding</Button>}
      </div>
      <p style={{ ...hint, margin: 0 }}>
        Which chat is wired to this companion. A <strong style={{ color: color.text }}>dm</strong> binding
        trusts the private chat; a <strong style={{ color: color.text }}>group</strong> binding trusts only
        the allowlisted senders below — an unlisted speaker is hard-rejected.
      </p>

      {binding ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill tone={binding.scope === "group" ? "amber" : "cyan"} label={binding.scope} />
          <Chip label="channel" value={binding.channel} />
          <Chip label="chat" value={binding.chatId} />
          <span style={{ flex: 1 }} />
          <Button variant="danger" disabled={removeBinding.isPending} onClick={() => removeBinding.mutate()}>Unbind</Button>
        </div>
      ) : adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 10, border: `1px solid ${color.border}`, borderRadius: radius.base }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 10 }}>
            <Field label="Channel"><Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="telegram" spellCheck={false} /></Field>
            <Field label="Chat id"><Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. -1001234" spellCheck={false} /></Field>
            <Field label="Scope">
              <Select value={scope} onChange={(e) => setScope(e.target.value as "dm" | "group")}>
                <option value="dm">dm</option>
                <option value="group">group</option>
              </Select>
            </Field>
          </div>
          {(localErr || createBinding.error) && <span style={errStyle}>{localErr ?? (createBinding.error as Error).message}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={createBinding.isPending} onClick={submit}>{createBinding.isPending ? "Binding…" : "Bind"}</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); createBinding.reset(); setLocalErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p style={hint}>No binding yet — this companion isn't reachable until a chat is bound.</p>
      )}

      {binding?.scope === "group" && <AllowedSenders sessionId={sessionId} channel={binding.channel} />}
    </section>
  );
}

function AllowedSenders({ sessionId, channel }: { sessionId: string; channel: string }) {
  const qc = useQueryClient();
  const [senderId, setSenderId] = useState("");
  const [label, setLabel] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const senders = useQuery({ queryKey: ["companionSenders", sessionId], queryFn: () => api.companionAllowedSenders(sessionId) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["companionSenders", sessionId] });

  const add = useMutation({
    mutationFn: (b: { sessionId: string; channel: string; senderId: string; label?: string | null }) => api.addCompanionAllowedSender(b),
    onSuccess: () => { invalidate(); setSenderId(""); setLabel(""); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeCompanionAllowedSender(id), onSuccess: invalidate });

  const submit = () => {
    setLocalErr(null);
    const err = validateSender({ senderId, label });
    if (err) { setLocalErr(err); return; }
    add.mutate({ sessionId, channel, senderId: senderId.trim(), label: label.trim() || null });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${color.border}`, borderRadius: radius.base }}>
      <SectionLabel style={{ margin: 0 }}>Allowed senders</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(senders.data ?? []).map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Chip label="id" value={s.senderId} tone="cyan" />
            {s.label && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>{s.label}</span>}
            <span style={{ flex: 1 }} />
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>Remove</Button>
          </div>
        ))}
        {senders.data?.length === 0 && <span style={hint}>No senders allowlisted — every group message is rejected until one is added.</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "end" }}>
        <Field label="Sender id"><Input value={senderId} onChange={(e) => setSenderId(e.target.value)} placeholder="platform user id" spellCheck={false} /></Field>
        <Field label="Label" sub="optional"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="who this is" spellCheck={false} /></Field>
        <Button variant="primary" disabled={add.isPending} onClick={submit}>Add</Button>
      </div>
      {(localErr || add.error) && <span style={errStyle}>{localErr ?? (add.error as Error).message}</span>}
    </div>
  );
}

// ── Pairing: mint a one-time enrollment code ────────────────────────────────────
function PairingSection({ sessionId }: { sessionId: string }) {
  const [grantType, setGrantType] = useState<"dm-bind" | "group-sender">("dm-bind");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ code: string; expiresAt: string } | null>(null);

  const mint = useMutation({
    mutationFn: (b: { sessionId: string; grantType: "dm-bind" | "group-sender" }) => api.mintCompanionPairing(b),
    onSuccess: (res) => setMinted({ code: res.code, expiresAt: res.expiresAt }),
  });

  const submit = () => {
    setLocalErr(null);
    const err = validatePairing(grantType);
    if (err) { setLocalErr(err); return; }
    setMinted(null);
    mint.mutate({ sessionId, grantType });
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>DM pairing</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        Mint a short-lived, single-use code instead of hand-entering a numeric chat id. Relay it to the
        person enrolling; they send it to the companion, which captures their <em>authenticated</em> id.
      </p>
      <div style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
        <Field label="Grant type">
          <Select value={grantType} onChange={(e) => setGrantType(e.target.value as "dm-bind" | "group-sender")}>
            <option value="dm-bind">dm-bind</option>
            <option value="group-sender">group-sender</option>
          </Select>
        </Field>
        <Button variant="primary" disabled={mint.isPending} onClick={submit}>{mint.isPending ? "Minting…" : "Mint code"}</Button>
      </div>
      {(localErr || mint.error) && <span style={errStyle}>{localErr ?? (mint.error as Error).message}</span>}
      {minted && <PairingCode code={minted.code} expiresAt={minted.expiresAt} onDismiss={() => setMinted(null)} />}
    </section>
  );
}

function PairingCode({ code, expiresAt, onDismiss }: { code: string; expiresAt: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => {});
  return (
    <Panel style={{ padding: 14, border: `1px solid ${color.amber}`, boxShadow: `inset 0 0 0 1px ${color.amber}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <StatusPill tone="amber" label="One-time pairing code" glow />
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: color.amber }}>
        Shown once. Relay it now — it is single-use and expires {new Date(expiresAt).toLocaleTimeString()}.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <code style={{
          flex: 1, fontFamily: font.mono, fontSize: 15, color: color.text, background: color.panel2,
          border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "8px 10px", letterSpacing: "0.08em", userSelect: "all",
        }}>{code}</code>
        <Button variant="primary" onClick={copy} style={{ whiteSpace: "nowrap" }}>{copied ? "Copied ✓" : "Copy"}</Button>
      </div>
    </Panel>
  );
}

function Callout({ tone, children }: { tone: "amber"; children: ReactNode }) {
  const c = tone === "amber" ? color.amber : color.cyan;
  return (
    <div style={{ display: "flex", gap: 8, padding: "8px 10px", border: `1px solid ${c}`, borderRadius: radius.base, background: "rgba(232,168,68,0.06)" }}>
      <span aria-hidden style={{ color: c }}>▲</span>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}
