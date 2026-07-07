import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolveConfig, type CompanionConfigMasked, type CompanionBinding } from "@loom/shared";
import { api, restartCompanionSession, type CompanionProvisionError, type CompanionSkillEntry, type CompanionMemoryEntry, type CompanionReminderEntry } from "../lib/api";
import {
  bindingsForDisplay, buildConfigBody, buildTelegramConnect, channelDisplayName, companionDisplayName, COMPANION_DEFAULT_NAME, emptyConfigForm,
  emptyTelegramForm, formFromMasked, hasChannelBinding, maskedToken, provisionBody, provisionErrorMessage,
  validateBinding, validatePairing, validateSender, validatePersonaPrompt, COMPANION_PROMPT_MAX, TELEGRAM_CHANNEL,
  reminderTitle, humanCron, reminderNextFireAt,
  type CompanionConfigForm, type CompanionTelegramForm,
} from "../lib/companion";
import { Panel, Button, Input, Select, SectionLabel, Badge, StatusPill, Chip, Dot } from "../components/ui";
import { CompanionChatPanel } from "../components/CompanionChat";
import { TerminalCard } from "../components/TerminalCard";
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

  const configs = useQuery({ queryKey: ["companionConfigs"], queryFn: api.companionConfigs });
  const bindings = useQuery({ queryKey: ["companionBindings"], queryFn: api.companionBindings });

  // Merge configs + bindings into companions, keyed by session id. A session may hold MANY bindings
  // (one per channel), so collect them into a list. MULTI-COMPANION (55f1b62): the daemon now arms EVERY
  // enabled config concurrently, so this list can hold 2+ — the switcher below picks which one is in focus.
  const companions = useMemo<CompanionRow[]>(() => {
    const byId = new Map<string, CompanionRow>();
    for (const c of configs.data ?? []) byId.set(c.sessionId, { sessionId: c.sessionId, config: c, bindings: [] });
    for (const b of bindings.data ?? []) {
      const cur = byId.get(b.sessionId) ?? { sessionId: b.sessionId, bindings: [] };
      byId.set(b.sessionId, { ...cur, bindings: [...cur.bindings, b] });
    }
    return [...byId.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }, [configs.data, bindings.data]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["companionConfigs"] });
    qc.invalidateQueries({ queryKey: ["companionBindings"] });
  };

  // Which companion is in focus, and whether the "New companion" create form is open OVER the current one.
  // `selectedId` defaults to the first companion (see `selected` below) until the owner picks another;
  // provisioning focuses the new companion. `creating` lets an owner who ALREADY has a companion open the
  // create flow without losing their place — Cancel returns to the selected companion.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Provisioning mints an IN-APP companion (spawns the assistant session, writes the in-app binding, arms it —
  // ZERO external config). The old single-companion 409 is GONE (multi-companion runtime, 55f1b62), so this
  // always creates an ADDITIONAL companion. On success we refresh, focus the new companion (Chat is its
  // default face, so the owner can talk to it at once), and close the create form.
  const provision = useMutation({
    mutationFn: (name: string) => api.provisionCompanion(provisionBody(name)),
    onSuccess: (created: CompanionConfigMasked) => { invalidateAll(); setSelectedId(created.sessionId); setCreating(false); },
    meta: { inlineError: true },
  });

  // Resolve the focused companion, tolerating a stale/absent selection (e.g. the selected companion was just
  // deleted) by falling back to the first. None yet → the create box IS the page.
  const selected = companions.find((c) => c.sessionId === selectedId) ?? companions[0] ?? null;
  const loading = configs.isLoading || bindings.isLoading;
  // Show the create form when the owner opted in (creating) OR there's simply no companion to show yet.
  const showCreate = creating || (!selected && !loading);

  return (
    <div style={{ maxWidth: 1180 }}>
      <Panel style={{ display: "flex", flexDirection: "column", minHeight: "72vh", padding: 14 }}>
        {showCreate ? (
          <CompanionCreate
            onCreate={(name) => provision.mutate(name)}
            pending={provision.isPending}
            error={provision.error as CompanionProvisionError | null}
            // Cancel is offered only when there's a companion to return to (the additional-companion flow); when
            // the create box IS the page (no companion yet) there's nothing to cancel back to.
            onCancel={selected ? () => { setCreating(false); provision.reset(); } : undefined}
          />
        ) : selected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
            <CompanionSwitcher
              companions={companions}
              selectedId={selected.sessionId}
              onSelect={setSelectedId}
              onNew={() => { setCreating(true); provision.reset(); }}
            />
            <CompanionDetail
              key={selected.sessionId}
              companion={selected}
              label={companionDisplayName(selected.config)}
              onChanged={invalidateAll}
              // A delete drops the focus back to the first remaining companion (or the create box if it was the last).
              onDeleted={() => { setSelectedId(null); invalidateAll(); }}
            />
          </div>
        ) : (
          <p style={{ color: color.textMuted, padding: 12 }}>Loading…</p>
        )}
      </Panel>
    </div>
  );
}

// ── Companion switcher: pick among companions + a "New companion" affordance ──────────────────────────────
// With MULTIPLE companions this renders a segmented selector (one entry per companion) so the owner can switch
// which one the Chat/Manage/Terminal panes below are scoped to; with exactly ONE it stays out of the way — just
// the "New companion" button, right-aligned — so the single-companion page reads essentially as it did before
// multi-companion (no picker where there's nothing to pick). Selection is client-only (the panes key off the
// selected sessionId); "New companion" routes up to the parent's provision flow. Each entry carries an
// enabled/disabled dot; an unnamed companion shows a short session-id tail so two default-named ones stay
// distinguishable.
function CompanionSwitcher({ companions, selectedId, onSelect, onNew }: {
  companions: CompanionRow[];
  selectedId: string;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}) {
  const many = companions.length > 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {many && (
        <div role="group" aria-label="Select companion" style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
          {companions.map((c) => {
            const on = c.sessionId === selectedId;
            const enabled = c.config ? c.config.enabled : true;
            const named = (c.config?.name ?? "").trim();
            return (
              <button
                key={c.sessionId}
                type="button"
                aria-pressed={on}
                title={enabled ? "enabled" : "disabled"}
                onClick={() => onSelect(c.sessionId)}
                className="loom-toggle"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  background: on ? color.phosphorDim : "transparent",
                  color: on ? color.text : color.textDim,
                  border: `1px solid ${on ? color.phosphor : color.border}`,
                  borderRadius: radius.base, padding: "5px 12px",
                  fontFamily: font.mono, fontSize: 12, cursor: "pointer",
                }}
              >
                {/* Decorative — the enabled state is also in the button's title tooltip; keep it out of the
                    accessible name so that stays just the companion's name. */}
                <Dot tone={enabled ? "phosphor" : "muted"} />
                <span>{named || COMPANION_DEFAULT_NAME}</span>
                {!named && <span style={{ color: color.textMuted, fontSize: 11 }}>{c.sessionId.slice(0, 4)}</span>}
              </button>
            );
          })}
        </div>
      )}
      <span style={{ flex: 1 }} />
      <Button onClick={onNew} title="Provision an additional companion">+ New companion</Button>
    </div>
  );
}

// ── Proactive home (Manage-tab section) ──────────────────────────────────────────
// The proactive HOME is a PER-COMPANION value (app_meta, keyed by sessionId — the multi-companion
// cross-delivery fix): each companion's Manage tab edits its OWN home, never a value shared with a
// sibling companion. Styled as a Manage `<section>` to match its siblings (no nested card).
function ProactiveHomeSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const home = useQuery({ queryKey: ["companionHome", sessionId], queryFn: () => api.companionHome(sessionId) });
  const [editing, setEditing] = useState(false);
  const [channel, setChannel] = useState("");
  const [chatId, setChatId] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  // A masked config echoes this companion's home, so refresh the config list too when it changes.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["companionHome", sessionId] });
    qc.invalidateQueries({ queryKey: ["companionConfigs"] });
  };
  const save = useMutation({
    mutationFn: (b: { channel: string; chatId: string }) => api.setCompanionHome(sessionId, b),
    onSuccess: () => { invalidate(); setEditing(false); },
  });
  const clear = useMutation({
    mutationFn: () => api.clearCompanionHome(sessionId),
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
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Proactive home</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        The chat <strong style={{ color: color.text }}>this companion's own</strong> heartbeats post to.
        Unset turns its proactive heartbeat off; other companions are never affected.
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
    </section>
  );
}

// ── Voice provisioning (Manage-tab section) ───────────────────────────────────────
// Voice (STT/TTS) is a daemon-GLOBAL opt-in (owner-directed 2026-07-06), NOT per-companion — it gates
// whether the daemon is ALLOWED to install faster-whisper (~500MB) + kokoro-onnx (~197MB) at all. Off
// (the default): voice notes/replies degrade to plain text, exactly as if voice were never configured.
// Styled like ProactiveHomeSection above (which is per-companion) — unlike that section, voice
// provisioning genuinely IS daemon-global: it reads/writes the SAME `/api/platform/config` surface the
// (human-only) daemon tuning uses.
function VoiceProvisioningSection() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["platformConfig"], queryFn: api.getPlatformConfig });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.updatePlatformConfig({ ...(data?.override ?? {}), companionVoiceEnabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platformConfig"] }),
  });

  const def = resolveConfig(undefined).platform.companionVoiceEnabled;
  const enabled = data?.resolved.companionVoiceEnabled ?? def;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Voice provisioning</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        Daemon-<strong style={{ color: color.text }}>global</strong> — gates whether faster-whisper (STT)
        and kokoro-onnx (TTS) are ever installed. Off (default): voice notes and replies degrade to plain
        text. Takes effect on the next daemon restart.
      </p>
      {isLoading && <span style={hint}>loading…</span>}
      {isError && <span style={errStyle}>{(error as Error)?.message ?? "failed to load /api/platform/config"}</span>}
      {data && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Chip label="voice" value={enabled ? "enabled" : "disabled"} tone={enabled ? undefined : "muted"} />
          <Button disabled={save.isPending} onClick={() => save.mutate(!enabled)}>
            {save.isPending ? "Saving…" : enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      )}
      {save.isError && <span style={errStyle}>{(save.error as Error).message}</span>}
    </section>
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
  onCancel?: () => void; // optional — when the create box IS the page (no companion yet), there's nothing to cancel back to
}) {
  const [name, setName] = useState("");
  const submit = () => { if (!pending) onCreate(name); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };

  // A 409 is no longer expected (multi-companion: the single-companion pre-spawn guard was removed) — but if
  // the daemon ever returns one, treat it as a calm precondition in an amber notice, distinct from the red
  // style a genuine error uses. Kept as defensive handling, not a live path.
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
        {onCancel && <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>}
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
      <Field label="Name" sub="optional · applies on the companion's next spawn, not a bare resume">
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Ada" spellCheck={false} />
      </Field>

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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, minHeight: 0 }}>
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
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <CompanionChatPanel sessionId={companion.sessionId} title={label} armed={armed} />
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
          <ProactiveHomeSection sessionId={companion.sessionId} />
          <VoiceProvisioningSection />
          <ChannelsSection companion={companion} onChanged={onChanged} />
          <PersonaSection sessionId={companion.sessionId} />
          <SkillsSection sessionId={companion.sessionId} />
          <MemorySection sessionId={companion.sessionId} />
          <RemindersSection sessionId={companion.sessionId} />
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
// view is the one sanctioned exception, scoped to a single companion: a watch-only window onto the agent's
// real Claude TUI stream with no way to type into it. It never un-hides companions anywhere else.
//
// On the shared <TerminalCard> frame (terminal-unification epic, stage 4): `readOnly` makes the base
// disable stdin (xterm) AND withhold the turn-Composer — exactly the watch-only shape — and it gains
// **Maximize** (was missing). Lifecycle "none" + Fork withheld: the companion is driven through Chat, not
// stopped/forked from here. The base's identity/status title is overridden with the "read-only" pill (a
// companion has no worker busy chrome to surface here); the explanatory hint sits above the card.
function CompanionTerminal({ sessionId }: { sessionId: string }) {
  return (
    <>
      <span style={{ ...hint, margin: 0 }}>
        A live window onto this companion's own <code>claude</code> session — watch it work. Talk to it
        under <strong style={{ color: color.text }}>Chat</strong>; typing here is disabled.
      </span>
      <TerminalCard
        session={{ id: sessionId }}
        height="62vh"
        readOnly
        offerFork={false}
        lifecycle="none"
        maximizable
        title={<StatusPill tone="cyan" label="read-only" />}
      />
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
            <Chip label="name" value={cfg.name || "unnamed"} tone={cfg.name ? undefined : "muted"} />
            <Chip label="token" value={maskedToken(cfg)} />
            <Chip label="channel" value={cfg.channel} tone="cyan" />
            <Chip label="scope" value={cfg.chatScope} />
            <Chip label="chat" value={cfg.allowedChatId} />
            <Chip label="heartbeat" value={cfg.heartbeatIntervalMinutes ? `${cfg.heartbeatIntervalMinutes}m` : "off"} tone={cfg.heartbeatIntervalMinutes ? "phosphor" : "muted"} />
            <Chip label="home" value={cfg.home ? `${cfg.home.channel}:${cfg.home.chatId}` : "unset"} tone={cfg.home ? undefined : "muted"} />
          </div>
          <p style={{ ...hint, margin: 0 }}>Changes apply on the next daemon restart.</p>
          <p style={{ ...hint, margin: 0 }}>
            The proactive <strong style={{ color: color.text }}>home</strong> is per-companion — manage it under{" "}
            <strong style={{ color: color.text }}>Proactive home</strong> below in this Manage tab.
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

// ── Memory: the companion's SELF-AUTHORED memory store (review + prune) ───────────────────────────────
// The sibling of SkillsSection over the companion's OWN isolated MEMORY.md store. The companion writes
// these on its own (the memory_* MCP tools); this human-only surface lists them (a pin indicator for the
// pinned ones), reads one's full MEMORY.md, and DELETES one to curate. Read + prune only — no authoring.
function MemorySection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companionMemories", sessionId], queryFn: () => api.companionMemories(sessionId) });
  const memories = q.data ?? [];

  const del = useMutation({
    mutationFn: (name: string) => api.deleteCompanionMemory(sessionId, name),
    onSuccess: (r) => { qc.setQueryData(["companionMemories", sessionId], r.memories); },
  });

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Memory</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        What this companion remembers across chats. It writes these for itself; here you can read one or
        delete one to keep the set tidy. Pinned entries are always in its context.
      </p>
      {q.isLoading ? (
        <span style={hint}>Loading…</span>
      ) : q.isError ? (
        <span style={errStyle}>{(q.error as Error).message}</span>
      ) : memories.length === 0 ? (
        <p style={hint}>No memories yet — this companion hasn't remembered anything.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {memories.map((m) => (
            <MemoryRow key={m.name} sessionId={sessionId} memory={m}
              onDelete={() => del.mutate(m.name)} deleting={del.isPending && del.variables === m.name} />
          ))}
        </div>
      )}
      {del.error && <span style={errStyle}>{(del.error as Error).message}</span>}
    </section>
  );
}

// One memory row: its name (with a pin indicator when pinned) + description, a Read toggle (lazily fetches
// the full MEMORY.md), and a Delete with an inline confirm — mirrors SkillRow's structure exactly.
function MemoryRow({ sessionId, memory, onDelete, deleting }: { sessionId: string; memory: CompanionMemoryEntry; onDelete: () => void; deleting: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const content = useQuery({ queryKey: ["companionMemory", sessionId, memory.name], queryFn: () => api.companionMemory(sessionId, memory.name), enabled: open });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <code style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{memory.name}</code>
        {memory.pinned && <span title="pinned — always in this companion's context"><Badge tone="amber">pinned</Badge></span>}
        {memory.description && <span style={{ ...hint, margin: 0 }}>{memory.description}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Read"}</Button>
        {confirm ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={errStyle}>Delete this memory?</span>
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

// ── Reminders: the companion's SELF-AUTHORED recurring reminders (review + prune) ─────────────────────
// The sibling of MemorySection over the companion's OWN `companion_reminders` rows. The companion authors
// these on its own (a reminder_* MCP tool); this human-only surface lists them (label / cron / prompt /
// enabled state / next fire) and DELETES one to curate. Read + prune only — no authoring, no create/edit.
function RemindersSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companionReminders", sessionId], queryFn: () => api.companionReminders(sessionId) });
  const reminders = q.data ?? [];

  const del = useMutation({
    mutationFn: (id: string) => api.deleteCompanionReminder(sessionId, id),
    onSuccess: (r) => { qc.setQueryData(["companionReminders", sessionId], r.reminders); },
  });

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>Reminders</SectionLabel>
      <p style={{ ...hint, margin: 0 }}>
        Recurring nudges this companion set for itself — each fires a proactive check-in on its own schedule.
        It authors them on its own; here you can review one or delete one to keep the set tidy.
      </p>
      {q.isLoading ? (
        <span style={hint}>Loading…</span>
      ) : q.isError ? (
        <span style={errStyle}>{(q.error as Error).message}</span>
      ) : reminders.length === 0 ? (
        <p style={hint}>No reminders yet — this companion hasn't scheduled any.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reminders.map((rem) => (
            <ReminderRow key={rem.id} reminder={rem}
              onDelete={() => del.mutate(rem.id)} deleting={del.isPending && del.variables === rem.id} />
          ))}
        </div>
      )}
      {del.error && <span style={errStyle}>{(del.error as Error).message}</span>}
    </section>
  );
}

// One reminder row: its label (or a prompt-derived fallback) + a human cron, the enabled/disabled state (a
// disabled row is dimmed and badged), the next-fire time (shown ONLY when enabled — nextFireAt is populated
// even for a disabled row), the prompt in a read-only block, and a Delete with an inline confirm — mirrors
// MemoryRow's structure exactly (no create/edit; prune curates the companion's own set).
function ReminderRow({ reminder, onDelete, deleting }: { reminder: CompanionReminderEntry; onDelete: () => void; deleting: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const nextFire = reminderNextFireAt(reminder);
  const disabled = !reminder.enabled;

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: 10,
      border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2,
      opacity: disabled ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, fontSize: 13, color: color.text }}>{reminderTitle(reminder)}</strong>
        <Badge tone={reminder.enabled ? "phosphor" : "muted"}>{reminder.enabled ? "enabled" : "disabled"}</Badge>
        <span style={{ flex: 1 }} />
        {confirm ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={errStyle}>Delete this reminder?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : "Confirm"}</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Chip label="schedule" value={humanCron(reminder.cron)} tone="cyan" />
        {nextFire
          ? <Chip label="next fire" value={new Date(nextFire).toLocaleString()} tone="phosphor" />
          : <Chip label="next fire" value={disabled ? "paused" : "—"} tone="muted" />}
      </div>
      <ReadonlyBlock>{reminder.prompt}</ReadonlyBlock>
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
