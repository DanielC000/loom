import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanionConfigMasked, CompanionBinding, SessionListItem } from "@loom/shared";
import { api, restartCompanionSession, type CompanionProvisionError, type CompanionSkillEntry } from "../lib/api";
import {
  bindingsForDisplay, buildConfigBody, buildTelegramConnect, channelDisplayName, emptyConfigForm,
  emptyTelegramForm, formFromMasked, hasChannelBinding, maskedToken, provisionBody, provisionErrorMessage,
  validateBinding, validatePairing, validateSender, validatePersonaPrompt, COMPANION_PROMPT_MAX, TELEGRAM_CHANNEL,
  type CompanionConfigForm, type CompanionTelegramForm,
} from "../lib/companion";
import { Panel, Button, Input, Select, SectionLabel, Badge, StatusPill, Chip } from "../components/ui";
import { CompanionChat } from "../components/CompanionChat";
import { TerminalPane } from "../components/Terminal";
import { IN_APP_CHANNEL, isArmedInApp } from "../lib/companionChat";
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

// One companion, keyed by its bound assistant session id — the union of a run-config row and/or its
// access bindings (either can exist alone: env-bootstrapped companions may have a binding before a
// REST config; a fresh REST config may exist before its binding is added — a "provisioned, not yet
// reachable" companion, since the gateway routes ONLY off bindings). MULTI-CHANNEL (d23b4e32): a session
// may hold MANY bindings (one per channel — in-app + Telegram at once), so bindings is a list, not one.
interface CompanionRow { sessionId: string; config?: CompanionConfigMasked; bindings: CompanionBinding[]; }

export default function Companion() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const configs = useQuery({ queryKey: ["companionConfigs"], queryFn: api.companionConfigs });
  const bindings = useQuery({ queryKey: ["companionBindings"], queryFn: api.companionBindings });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });

  // Merge configs + bindings into the companion list, keyed by session id. A session may have MANY bindings
  // (one per channel), so we collect them into a list per companion rather than overwriting a single slot.
  const companions = useMemo<CompanionRow[]>(() => {
    const byId = new Map<string, CompanionRow>();
    for (const c of configs.data ?? []) byId.set(c.sessionId, { sessionId: c.sessionId, config: c, bindings: [] });
    for (const b of bindings.data ?? []) {
      const cur = byId.get(b.sessionId) ?? { sessionId: b.sessionId, bindings: [] };
      byId.set(b.sessionId, { ...cur, bindings: [...cur.bindings, b] });
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

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["companionConfigs"] });
    qc.invalidateQueries({ queryKey: ["companionBindings"] });
  };

  // The simple, in-app-first create: POST /api/companion/provision { name } mints a working IN-APP-ONLY
  // companion — one call spawns the assistant session, writes the in-app binding, and arms it, with ZERO
  // external config. On success we select the new companion; its detail defaults to the Chat surface, so
  // the user can talk to it immediately. The single-companion guard (409) is surfaced in the create card as
  // a calm precondition (see provisionErrorMessage), not a raw error.
  const provision = useMutation({
    mutationFn: (name: string) => api.provisionCompanion(provisionBody(name)),
    onSuccess: (row) => { invalidateAll(); setSelected(row.sessionId); setCreating(false); },
    // The create card renders its OWN inline error (the 409 single-companion guard as a calm Callout), so
    // opt out of the global blocking window.alert (main.tsx) — a raw modal is exactly the alarming surface
    // this flow avoids.
    meta: { inlineError: true },
  });

  const current = companions.find((c) => c.sessionId === selected) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, maxWidth: 1180 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, alignSelf: "start" }}>
      <Panel>
        <SectionLabel>Companions</SectionLabel>
        <p style={{ ...hint, margin: "0 0 10px" }}>
          Personal <code>claude</code> agents you talk to right here in the app — in-app chat is a
          companion's default face. Human-managed; connect Telegram optionally (its bot token is stored
          encrypted and never shown).
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
                {c.config && c.bindings.length === 0 && (
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
          <CompanionCreate
            onCreate={(name) => provision.mutate(name)}
            pending={provision.isPending}
            error={provision.error as CompanionProvisionError | null}
            onCancel={() => { setCreating(false); provision.reset(); }}
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

// ── Create: the simple, in-app-first "New companion" flow ────────────────────────
// One field (a friendly name) + Create. POST /api/companion/provision { name } mints a working IN-APP-ONLY
// companion — ZERO external config, no session id, no bot token, no chat binding. On success the parent
// selects it and opens its Chat surface (its default face), so the user can talk to it straight away.
//
// Connecting Telegram to an EXISTING companion lives in the Manage view (ChannelsSection › ConnectTelegram):
// with the multi-binding schema (d23b4e32) it ADDS a Telegram route ALONGSIDE the in-app one (both channels
// coexist, unified context) rather than replacing it — so the create flow stays deliberately in-app-only and
// points the user to Manage for Telegram.
function CompanionCreate({ onCreate, pending, error, onCancel }: {
  onCreate: (name: string) => void;
  pending: boolean;
  error: CompanionProvisionError | null;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => { if (!pending) onCreate(name); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };

  // The single-companion guard (409) is a calm precondition, not a failure — render it in an amber notice
  // with a pointer, distinct from the red style a genuine error uses.
  const isGuard = error?.status === 409;
  const message = error ? provisionErrorMessage(error.status ?? 0, error.message) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 460 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>New companion</strong>
        <p style={{ ...hint, margin: 0 }}>
          Give it a name and you're set — a personal assistant you can talk to right here, no setup. Connect
          Telegram later under <strong style={{ color: color.text }}>Manage</strong>.
        </p>
      </div>

      <Field label="Name" sub="optional">
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown}
          placeholder="e.g. Ada" spellCheck={false} autoFocus />
      </Field>

      {message && (
        isGuard ? (
          <Callout tone="amber">{message}</Callout>
        ) : (
          <span style={errStyle}>{message}</span>
        )
      )}

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
type CompanionMode = "chat" | "manage" | "terminal";

function CompanionDetail({ companion, label, onChanged, onDeleted }: {
  companion: CompanionRow; label: string; onChanged: () => void; onDeleted: () => void;
}) {
  // Chat is the companion's DEFAULT face in the app (not the raw terminal); Manage + Terminal are a click away.
  const [mode, setMode] = useState<CompanionMode>("chat");
  // In-app reachability: an in-app reply frame only comes back when a binding on the in-app channel exists
  // for this session (chatId == sessionId — the loopback self-address). MULTI-CHANNEL: scan ALL bindings so
  // a Telegram binding never hides the in-app one; anything else ⇒ chat shows the gentle "not wired" notice
  // instead of implying a message was delivered.
  const armed = isArmedInApp(companion.bindings, companion.sessionId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{label}</strong>
        {companion.config
          ? <Badge tone={companion.config.enabled ? "phosphor" : "muted"}>{companion.config.enabled ? "enabled" : "disabled"}</Badge>
          : <Badge tone="cyan">binding only</Badge>}
        {companion.config?.envPinned && <Badge tone="amber">pinned by env</Badge>}
        {companion.config && companion.bindings.length === 0 && <Badge tone="amber">not reachable — no binding</Badge>}
        <span style={{ flex: 1 }} />
        <ModeToggle mode={mode} onMode={setMode} />
      </div>

      {mode === "chat" ? (
        <div role="tabpanel" id="companion-panel-chat" aria-labelledby="companion-tab-chat"
          style={{ flex: 1, minHeight: "62vh", display: "flex", flexDirection: "column" }}>
          <CompanionChat sessionId={companion.sessionId} title={label} armed={armed} />
        </div>
      ) : mode === "terminal" ? (
        <div role="tabpanel" id="companion-panel-terminal" aria-labelledby="companion-tab-terminal"
          style={{ flex: 1, minHeight: "62vh", display: "flex", flexDirection: "column", gap: 8 }}>
          <CompanionTerminal sessionId={companion.sessionId} />
        </div>
      ) : (
        <div role="tabpanel" id="companion-panel-manage" aria-labelledby="companion-tab-manage"
          style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <ConfigSection companion={companion} onChanged={onChanged} onDeleted={onDeleted} />
          <ChannelsSection companion={companion} onChanged={onChanged} />
          <PersonaSection sessionId={companion.sessionId} />
          <SkillsSection sessionId={companion.sessionId} />
          <RestrictToolsSection sessionId={companion.sessionId} />
          <PairingSection sessionId={companion.sessionId} />
        </div>
      )}
    </div>
  );
}

// Segmented Chat / Manage / Terminal switch — a companion's chat is the default view; management and the
// read-only terminal window onto its own session are each one click away.
function ModeToggle({ mode, onMode }: { mode: CompanionMode; onMode: (m: CompanionMode) => void }) {
  const opts: { key: CompanionMode; label: string }[] = [
    { key: "chat", label: "Chat" }, { key: "manage", label: "Manage" }, { key: "terminal", label: "Terminal" },
  ];
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

// ── Terminal: a READ-ONLY window onto the companion's OWN pty session ──────────────
// Companions are DELIBERATELY hidden from the Terminals page + project grids (they're driven through
// chat, never a raw stdin composer — the load-bearing filter in lib/sessions.ts groupSessionRows). This
// view is the one sanctioned exception, scoped to a single companion: it reuses the same xterm attach
// component (TerminalPane over /ws/term/:sessionId) but in `readOnly` mode, so you can watch the agent's
// real Claude TUI stream without a way to type into it. It never un-hides companions anywhere else.
function CompanionTerminal({ sessionId }: { sessionId: string }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill tone="cyan" label="read-only" />
        <span style={{ ...hint, margin: 0 }}>
          A live window onto this companion's own <code>claude</code> session — watch it work. Talk to it
          under <strong style={{ color: color.text }}>Chat</strong>; typing here is disabled.
        </span>
      </div>
      {/* overflow:hidden clips xterm's canvas to the framed box; the pane scales the pinned grid to fill it. */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "hidden", background: "#0b0b0c",
        border: `1px solid ${color.border}`, borderRadius: radius.base,
      }}>
        <TerminalPane sessionId={sessionId} readOnly />
      </div>
    </>
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

// ── Channels: the per-channel bindings a companion is reachable on + guided Telegram connect ──────────
// A companion may hold MANY bindings now (one per channel — d23b4e32). This section lists each channel as
// its own row with a per-channel remove (unroutes ONLY that channel, keeping the others), offers a guided
// Telegram connect when Telegram isn't wired yet, and keeps a manual advanced add for custom channels /
// group scope. Every write is the human-only REST — the companion never binds or configures itself.
function ChannelsSection({ companion, onChanged }: { companion: CompanionRow; onChanged: () => void }) {
  const { sessionId } = companion;
  const rows = bindingsForDisplay(companion.bindings);
  const telegramConnected = hasChannelBinding(companion.bindings, TELEGRAM_CHANNEL);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Channels</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        Where this companion is reachable. <strong style={{ color: color.text }}>In-app</strong> is its
        default face; connect <strong style={{ color: color.text }}>Telegram</strong> to also reach it there —
        both share one context. Removing a channel unroutes only that channel; the others stay.
      </p>

      {rows.length === 0 ? (
        <p style={hint}>No channels yet — this companion isn't reachable until a channel is connected.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((b) => (
            <ChannelRow key={b.channel} sessionId={sessionId} binding={b} onChanged={onChanged} />
          ))}
        </div>
      )}

      {!telegramConnected && <ConnectTelegram companion={companion} onChanged={onChanged} />}

      <AdvancedAddBinding companion={companion} onChanged={onChanged} />
    </section>
  );
}

// One channel a companion is reachable on: its name + scope + chat, a per-channel remove (with an inline
// confirm), and — for a GROUP-scoped binding — the sender allowlist that gates it. Remove targets ONLY this
// channel via the `?channel=` daemon contract, so the session's other channels are untouched.
function ChannelRow({ sessionId, binding, onChanged }: { sessionId: string; binding: CompanionBinding; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const inApp = binding.channel === IN_APP_CHANNEL;
  const remove = useMutation({
    mutationFn: () => api.deleteCompanionBinding(sessionId, binding.channel),
    onSuccess: () => { setConfirm(false); onChanged(); },
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12, color: color.text }}>
          {channelDisplayName(binding.channel)}
        </strong>
        <StatusPill tone={binding.scope === "group" ? "amber" : inApp ? "phosphor" : "cyan"} label={inApp ? "default" : binding.scope} />
        {!inApp && <Chip label="chat" value={binding.chatId} />}
        <span style={{ flex: 1 }} />
        {confirm ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={errStyle}>{inApp ? "Remove in-app? Chat here stops working." : "Remove this channel?"}</span>
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "Removing…" : "Confirm"}</Button>
            <Button variant="ghost" onClick={() => { setConfirm(false); remove.reset(); }}>Cancel</Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirm(true)}>Remove</Button>
        )}
      </div>
      {inApp && <span style={hint}>The cockpit chat panel — always this companion's own loopback route.</span>}
      {remove.error && <span style={errStyle}>{(remove.error as Error).message}</span>}
      {binding.scope === "group" && <AllowedSenders sessionId={sessionId} channel={binding.channel} />}
    </div>
  );
}

// Guided "Connect Telegram" to an EXISTING companion. BotFather steps → paste the bot token → enter the chat
// id → Connect. Runs the TWO human-only REST writes in order: the companion config (stores the ENCRYPTED,
// write-only token + telegram target) then the bindings POST (adds the telegram route alongside in-app). The
// companion never performs either write. Collapsed to a single affordance until the user opts in.
function ConnectTelegram({ companion, onChanged }: { companion: CompanionRow; onChanged: () => void }) {
  const { sessionId } = companion;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CompanionTelegramForm>(emptyTelegramForm);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const set = <K extends keyof CompanionTelegramForm>(k: K, v: CompanionTelegramForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const connect = useMutation({
    // Two ordered writes: config first (token at rest), then the authoritative binding. If the binding POST
    // fails the token is already stored (masked) — the user can retry Connect; we never leave a half state
    // silently (the error surfaces). The config uses PUT when a row exists (the common in-app case), else POST.
    mutationFn: async (b: { configBody: Record<string, unknown>; bindingBody: { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" } }) => {
      if (companion.config) await api.updateCompanionConfig(sessionId, b.configBody);
      else await api.createCompanionConfig({ ...b.configBody, sessionId });
      await api.createCompanionBinding(b.bindingBody);
    },
    onSuccess: () => { onChanged(); setOpen(false); setForm(emptyTelegramForm()); setLocalErr(null); },
  });

  const submit = () => {
    setLocalErr(null);
    const built = buildTelegramConnect(sessionId, form);
    if ("error" in built) { setLocalErr(built.error); return; }
    connect.mutate(built);
  };

  if (!open) {
    return (
      <div>
        <Button variant="primary" onClick={() => setOpen(true)}>Connect Telegram</Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, border: `1px solid ${color.cyan}`, borderRadius: radius.base, background: color.panel2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12, color: color.text }}>Connect Telegram</strong>
        <StatusPill tone="cyan" label="adds a channel" />
      </div>
      <ol style={{ ...hint, margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        <li>In Telegram, message <code style={{ color: color.text }}>@BotFather</code> and send <code style={{ color: color.text }}>/newbot</code>; follow the prompts to name it.</li>
        <li>BotFather replies with a <strong style={{ color: color.text }}>bot token</strong> (like <code>123456:ABC-DEF…</code>). Paste it below.</li>
        <li>Message your new bot once, then get the <strong style={{ color: color.text }}>chat id</strong> of that DM (e.g. via <code style={{ color: color.text }}>@userinfobot</code>).</li>
      </ol>
      <Field label="Bot token" sub="from BotFather · stored encrypted, never shown again">
        <Input type="password" autoComplete="new-password" value={form.botToken}
          onChange={(e) => set("botToken", e.target.value)} placeholder="123456:ABC-DEF…" spellCheck={false} />
      </Field>
      <Field label="Chat id" sub="the DM this bot messages">
        <Input value={form.chatId} onChange={(e) => set("chatId", e.target.value)} placeholder="e.g. 123456789" spellCheck={false} />
      </Field>
      {(localErr || connect.error) && <span style={errStyle}>{localErr ?? (connect.error as Error).message}</span>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={connect.isPending} onClick={submit}>{connect.isPending ? "Connecting…" : "Connect"}</Button>
        <Button variant="ghost" disabled={connect.isPending} onClick={() => { setOpen(false); connect.reset(); setForm(emptyTelegramForm()); setLocalErr(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

// Advanced manual add-binding — the escape hatch for a CUSTOM channel or a GROUP-scoped binding (which must
// consciously declare group scope + an allowlist). Collapsed by default so the common path (guided Telegram)
// stays front and center. Same human-only bindings POST; validated inline before the round-trip.
function AdvancedAddBinding({ companion, onChanged }: { companion: CompanionRow; onChanged: () => void }) {
  const { sessionId } = companion;
  const [open, setOpen] = useState(false);
  const [chatId, setChatId] = useState("");
  const [channel, setChannel] = useState(companion.config?.channel ?? TELEGRAM_CHANNEL);
  const [scope, setScope] = useState<"dm" | "group">("dm");
  const [localErr, setLocalErr] = useState<string | null>(null);

  const createBinding = useMutation({
    mutationFn: (b: { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" }) => api.createCompanionBinding(b),
    onSuccess: () => { onChanged(); setOpen(false); setChatId(""); },
  });

  const submit = () => {
    setLocalErr(null);
    const b = { sessionId, channel: channel.trim(), chatId: chatId.trim(), scope };
    const err = validateBinding(b);
    if (err) { setLocalErr(err); return; }
    createBinding.mutate(b);
  };

  if (!open) {
    return (
      <div>
        <Button variant="ghost" onClick={() => setOpen(true)}>Advanced: add a custom binding</Button>
      </div>
    );
  }

  return (
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
      <span style={hint}>
        A <strong style={{ color: color.text }}>group</strong> binding trusts only the allowlisted senders on
        its row — an unlisted speaker is hard-rejected. A bare bot token is set under Run configuration.
      </span>
      {(localErr || createBinding.error) && <span style={errStyle}>{localErr ?? (createBinding.error as Error).message}</span>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={createBinding.isPending} onClick={submit}>{createBinding.isPending ? "Binding…" : "Bind"}</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); createBinding.reset(); setLocalErr(null); }}>Cancel</Button>
      </div>
    </div>
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

// A read-only content block (the persona prompt, the base brief, a skill's SKILL.md) — a bounded,
// scrollable, wrap-preserving mono panel. `dim` softens it for the read-only base brief.
function ReadonlyBlock({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <pre style={{
      margin: 0, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
      fontFamily: font.mono, fontSize: 12, lineHeight: 1.6, color: dim ? color.textMuted : color.text,
      background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "10px 12px",
    }}>
      {children}
    </pre>
  );
}

// ── Persona / prompt: the companion's editable startupPrompt + the read-only base brief ──────────────
// The persona PROMPT is the agent's OWN `startupPrompt` — the editable half that layers UNDER the
// server-owned ASSISTANT_BASE_BRIEF (shown read-only for context; a request body can never change it).
// Human-only REST, resolved by sessionId. Edits apply on the companion's next (re)start.
function PersonaSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companionPrompt", sessionId], queryFn: () => api.companionPrompt(sessionId) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [showBrief, setShowBrief] = useState(false);

  const save = useMutation({
    mutationFn: (startupPrompt: string) => api.updateCompanionPrompt(sessionId, startupPrompt),
    onSuccess: (r) => { qc.setQueryData(["companionPrompt", sessionId], r); setEditing(false); setLocalErr(null); },
  });

  const beginEdit = () => { setDraft(q.data?.startupPrompt ?? ""); setLocalErr(null); setEditing(true); };
  const submit = () => {
    const err = validatePersonaPrompt(draft);
    if (err) { setLocalErr(err); return; }
    save.mutate(draft);
  };

  const promptText = (q.data?.startupPrompt ?? "").trim();
  const over = draft.length > COMPANION_PROMPT_MAX;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Persona / prompt</SectionLabel>
        <span style={{ flex: 1 }} />
        {!editing && q.data && <Button variant="primary" onClick={beginEdit}>Edit</Button>}
      </div>
      <p style={{ ...hint, margin: 0 }}>
        The companion's own persona — layered UNDER Loom's read-only base brief (its identity + safety
        posture). Edits apply on the companion's next restart.
      </p>

      {q.isLoading ? (
        <span style={hint}>Loading…</span>
      ) : q.isError ? (
        <span style={errStyle}>{(q.error as Error).message}</span>
      ) : editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} spellCheck={false}
            data-testid="companion-persona-input"
            style={{
              background: color.panel2, color: color.text, border: `1px solid ${over ? color.red : color.borderStrong}`,
              borderRadius: radius.base, padding: "8px 10px", fontFamily: font.mono, fontSize: 13, lineHeight: 1.5, resize: "vertical",
            }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...hint, color: over ? color.red : color.textMuted }}>
              {draft.length.toLocaleString()} / {COMPANION_PROMPT_MAX.toLocaleString()}
            </span>
            <span style={{ flex: 1 }} />
            <Button variant="primary" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save prompt"}</Button>
            <Button variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); save.reset(); setLocalErr(null); }}>Cancel</Button>
          </div>
          {(localErr || save.error) && <span style={errStyle}>{localErr ?? (save.error as Error).message}</span>}
        </div>
      ) : (
        <>
          {promptText
            ? <ReadonlyBlock>{promptText}</ReadonlyBlock>
            : <p style={hint}>No persona prompt set — <strong style={{ color: color.text }}>Edit</strong> to give this companion its own voice.</p>}
          <div>
            <Button onClick={() => setShowBrief((v) => !v)}>{showBrief ? "Hide base brief" : "Show base brief"}</Button>
          </div>
          {showBrief && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ ...hint, color: color.textDim }}>Loom's base brief — read-only, prepended to every companion.</span>
              <ReadonlyBlock dim>{q.data?.baseBrief ?? ""}</ReadonlyBlock>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Skills: the companion's SELF-AUTHORED skill store (review + prune) ────────────────────────────────
// The companion authors these on demand over MCP (skill_author); this human-only surface lists them, reads
// one's full SKILL.md, and DELETES one for curation/dedup. There is deliberately NO create/edit here.
function SkillsSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companionSkills", sessionId], queryFn: () => api.companionSkills(sessionId) });
  const skills = q.data ?? [];

  const del = useMutation({
    mutationFn: (name: string) => api.deleteCompanionSkill(sessionId, name),
    onSuccess: (r) => { qc.setQueryData(["companionSkills", sessionId], r.skills); },
  });

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Skills</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        Skills this companion wrote for itself. It authors them on its own; here you can read one or delete
        one to keep the set tidy.
      </p>
      {q.isLoading ? (
        <span style={hint}>Loading…</span>
      ) : q.isError ? (
        <span style={errStyle}>{(q.error as Error).message}</span>
      ) : skills.length === 0 ? (
        <p style={hint}>No skills yet — this companion hasn't authored any.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {skills.map((s) => (
            <SkillRow key={s.name} sessionId={sessionId} skill={s}
              onDelete={() => del.mutate(s.name)} deleting={del.isPending && del.variables === s.name} />
          ))}
        </div>
      )}
      {del.error && <span style={errStyle}>{(del.error as Error).message}</span>}
    </section>
  );
}

// One skill row: its name + description, a Read toggle (lazily fetches the SKILL.md), and a Delete with an
// inline confirm (mirrors ChannelRow's remove pattern).
function SkillRow({ sessionId, skill, onDelete, deleting }: { sessionId: string; skill: CompanionSkillEntry; onDelete: () => void; deleting: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const content = useQuery({ queryKey: ["companionSkill", sessionId, skill.name], queryFn: () => api.companionSkill(sessionId, skill.name), enabled: open });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <code style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{skill.name}</code>
        {skill.description && <span style={{ ...hint, margin: 0 }}>{skill.description}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Read"}</Button>
        {confirm ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={errStyle}>Delete this skill?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : "Confirm"}</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button>
        )}
      </div>
      {open && (
        content.isLoading ? <span style={hint}>Loading…</span>
        : content.isError ? <span style={errStyle}>{(content.error as Error).message}</span>
        : <ReadonlyBlock>{content.data?.content ?? ""}</ReadonlyBlock>
      )}
    </div>
  );
}

// ── Restrict tools: the blast-radius toggle, INLINE (was a link-out to Profiles) ──────────────────────
// A chat-reachable companion driven by untrusted input is high blast-radius. This toggles `restrictedTools`
// on the SESSION ROW of the SPECIFIC companion being viewed (resolved by sessionId, not "the first
// assistant-role profile" — a stale Profile-wide edit did nothing for an already-running companion, since
// restrictedTools is a spawn-time property re-read from the row on every resume, never from the Profile).
// HUMAN-only, matching the other Manage writers. restrictedTools feeds `--disallowedTools` at SPAWN time,
// so a toggle here has NO live effect until the companion is restarted — the restart affordance below is
// CONFIRM-GATED and never fires on its own (it would interrupt the owner's live companion).
function RestrictToolsSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companionRestrictedTools", sessionId], queryFn: () => api.companionRestrictedTools(sessionId) });
  const [needsRestart, setNeedsRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const save = useMutation({
    mutationFn: (restrictedTools: boolean) => api.updateCompanionRestrictedTools(sessionId, restrictedTools),
    onSuccess: (r) => {
      qc.setQueryData(["companionRestrictedTools", sessionId], r);
      setNeedsRestart(true);
    },
  });

  const restart = useMutation({
    mutationFn: () => restartCompanionSession(sessionId),
    onSuccess: () => {
      setNeedsRestart(false);
      setConfirmRestart(false);
      qc.invalidateQueries({ queryKey: ["allSessions"] });
    },
  });

  // Optimistic display: reflect the in-flight value immediately, else the persisted row value.
  const on = save.isPending ? !!save.variables : (q.data?.restrictedTools ?? false);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Restrict tools</SectionLabel>
      {q.isLoading ? (
        <span style={hint}>Loading…</span>
      ) : q.isError ? (
        <span style={errStyle}>{(q.error as Error).message}</span>
      ) : (
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: save.isPending ? "default" : "pointer" }}>
          <input type="checkbox" checked={on} disabled={save.isPending}
            onChange={(e) => save.mutate(e.target.checked)} style={{ marginTop: 3 }} data-testid="companion-restricted-tools" />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ ...fieldLabel, color: color.text }}>
              Restricted tools <span style={{ fontWeight: 400, letterSpacing: 0, color: on ? color.phosphor : color.textMuted }}>· {on ? "on" : "off"}</span>
            </span>
            <span style={{ ...hint, margin: 0 }}>
              Remove the dangerous native tools — shell (Bash), host writes (Edit / Write / NotebookEdit /
              MultiEdit), subagent delegation (Task / Agent), and network egress (WebFetch / WebSearch) —
              from this companion's tool list. Read / Glob / Grep and the Loom tools stay. Keep it ON for a
              companion reachable from untrusted chat.
            </span>
          </span>
        </label>
      )}
      {save.error && <span style={errStyle}>{(save.error as Error).message}</span>}
      <p style={{ ...hint, margin: 0 }}>
        A spawn-time setting — it's re-applied every time this companion (re)starts, but a change here has{" "}
        <strong style={{ color: color.text }}>no effect on the currently running session</strong> until it's
        restarted.
      </p>
      {needsRestart && (
        confirmRestart ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={errStyle}>Restart now to apply — this interrupts the companion's live session.</span>
            <Button variant="danger" disabled={restart.isPending} onClick={() => restart.mutate()}>
              {restart.isPending ? "Restarting…" : "Confirm restart"}
            </Button>
            <Button variant="ghost" disabled={restart.isPending} onClick={() => setConfirmRestart(false)}>Cancel</Button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Badge tone="amber">restart to apply</Badge>
            <Button onClick={() => setConfirmRestart(true)} data-testid="companion-restart-to-apply">
              Restart this companion to apply
            </Button>
          </div>
        )
      )}
      {restart.error && <span style={errStyle}>{(restart.error as Error).message}</span>}
    </section>
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
