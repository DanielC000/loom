// SSH connections in the Connections UI (card b5565d4c, design record a3d5c7f4).
//
// Three invariants this file holds, each the reason for a shape below:
//   1. The private key and its passphrase are WRITE-ONLY. They live in the create form's draft until the
//      single POST, and nothing in this file ever renders them from a server read (there is no server read
//      that carries them: ConnectionMetadata has no key field). The passphrase is sent once and never stored.
//   2. No silent trust-on-first-use. The host-key fingerprint is either pasted, or FETCHED on an explicit
//      click and then shown for the owner to compare; it reaches the form's pinned value only through a
//      second, explicit "Pin this fingerprint" click. Changing host/port discards an unconfirmed fetch,
//      and clears a fetched-then-pinned one (with a note); a hand-typed pin is left alone.
//   3. Safe defaults: read-only starts ON and the risky-command list starts as the shipped default.
import { useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_SSH_RISKY_COMMAND_PATTERNS, type ConnectionMetadata, type SshCommandRule, type SshCommandRuleKind } from "@loom/shared";
import { api } from "../lib/api";
import { errorText } from "../lib/loopbackCredential";
import { color, font } from "../theme";
import { Badge, Button, Input, Select } from "./ui";

/** The exact form `ssh-keygen -l` prints and the daemon's validator accepts. */
export const SSH_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const RULE_KINDS: SshCommandRuleKind[] = ["prefix", "exact", "regex"];

/** The create form's SSH-specific draft. Owned by the parent ConnectionForm (not this component) so a
 *  connector-preset switch away and back never discards a pasted key (decision 2790ce05's posture). */
export interface SshDraft {
  port: string;
  user: string;
  privateKey: string;
  passphrase: string;
  fingerprint: string;
  /** The host:port a FETCHED fingerprint was pinned for; null when the pin was typed or pasted by hand.
   *  A fetched pin is a statement about one target, so editing host/port clears it (a hand-typed one
   *  stays: nothing ties it to the previous target). Kept in the draft so a preset switch can't drop it. */
  pinnedFor: string | null;
  readOnly: boolean;
  commandAllowlist: SshCommandRule[];
  riskyCommandPatterns: SshCommandRule[];
}

export function emptySshDraft(): SshDraft {
  return {
    port: "22", user: "", privateKey: "", passphrase: "", fingerprint: "", pinnedFor: null, readOnly: true,
    commandAllowlist: [], riskyCommandPatterns: DEFAULT_SSH_RISKY_COMMAND_PATTERNS.map((r) => ({ ...r })),
  };
}

const sameRules = (a: SshCommandRule[], b: readonly SshCommandRule[]) =>
  a.length === b.length && a.every((r, i) => r.kind === b[i]!.kind && r.pattern === b[i]!.pattern);

/** Parse the port field; null when it is not a whole number in range. */
export function parseSshPort(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Client-side pre-check of a rule list (the daemon re-validates authoritatively). Blank rows are dropped,
 *  never trimmed: a trailing space is meaningful in a prefix rule ("rm " vs "rm"). */
export function cleanSshRules(rules: SshCommandRule[], label: string): { ok: true; value: SshCommandRule[] } | { ok: false; error: string } {
  const value = rules.filter((r) => r.pattern !== "");
  for (const r of value) {
    if (r.kind === "regex") {
      try { new RegExp(r.pattern); } catch { return { ok: false, error: `${label}: "${r.pattern}" is not a valid regular expression.` }; }
    }
  }
  return { ok: true, value };
}

const fieldLabel: CSSProperties = {
  fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim,
};
const hintStyle: CSSProperties = { color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 };
const Hint = ({ children }: { children: ReactNode }) => <span style={hintStyle}>{children}</span>;
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={fieldLabel}>{label}</span>
    {children}
  </label>
);

/** Editable list of command rules — kind + pattern per row. Used for both the allowlist and the risky list. */
export function SshRuleList({ rules, onChange, testId, emptyText }: {
  rules: SshCommandRule[]; onChange: (next: SshCommandRule[]) => void; testId: string; emptyText: string;
}) {
  const set = (i: number, patch: Partial<SshCommandRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rules.length === 0 && <span style={{ ...hintStyle, fontSize: 12 }}>{emptyText}</span>}
      {rules.map((r, i) => (
        <div key={i} data-testid={`${testId}-row`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Select aria-label="Match kind" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as SshCommandRuleKind })} style={{ width: 92, flexShrink: 0 }}>
            {RULE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
          <Input aria-label="Pattern" value={r.pattern} onChange={(e) => set(i, { pattern: e.target.value })} spellCheck={false}
            placeholder={r.kind === "regex" ? "^docker (ps|logs)\\b" : "docker ps"} style={{ flex: 1, minWidth: 0 }} />
          <Button variant="ghost" aria-label={`Remove rule ${r.pattern || i + 1}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div>
        <Button variant="ghost" onClick={() => onChange([...rules, { kind: "prefix", pattern: "" }])}>Add rule</Button>
      </div>
    </div>
  );
}

/** The SSH branch of the New-connection form. Name, host and scope stay with the parent (shared with the
 *  other connector presets); everything ssh-specific is the `draft`. */
export function SshConnectionFields({ host, setHost, draft, setDraft }: {
  host: string; setHost: (v: string) => void;
  draft: SshDraft; setDraft: (fn: (d: SshDraft) => SshDraft) => void;
}) {
  const patch = (p: Partial<SshDraft>) => setDraft((d) => ({ ...d, ...p }));
  // The fetched-but-not-yet-pinned fingerprint, and the host:port it was fetched from. Never written into
  // `draft.fingerprint` without the explicit Pin click.
  const [fetched, setFetched] = useState<{ fingerprint: string; target: string } | null>(null);
  const [riskyOpen, setRiskyOpen] = useState(false);
  // Set when a host/port edit cleared a fetched pin, so the empty field explains itself.
  const [pinClearedFor, setPinClearedFor] = useState<string | null>(null);
  const probe = useMutation({ meta: { inlineError: true }, mutationFn: (b: { host: string; port: number }) => api.fetchSshHostFingerprint(b) });
  const port = parseSshPort(draft.port);
  const targetOf = (h: string, rawPort: string) => `${h.trim()}:${parseSshPort(rawPort) ?? rawPort.trim()}`;
  const target = targetOf(host, draft.port);

  const changeTarget = (p: { host?: string; port?: string }) => {
    if (p.host !== undefined) setHost(p.host);
    const next = targetOf(p.host ?? host, p.port ?? draft.port);
    // A fingerprint fetched for one host:port is no evidence about another: an unconfirmed fetch is
    // dropped, and a pinned one is cleared with a note. A hand-typed pin (pinnedFor null) stays.
    const clearPin = draft.pinnedFor !== null && next !== draft.pinnedFor;
    if (clearPin) setPinClearedFor(draft.pinnedFor);
    patch({ ...(p.port !== undefined ? { port: p.port } : {}), ...(clearPin ? { fingerprint: "", pinnedFor: null } : {}) });
    setFetched(null);
    probe.reset();
  };

  const fetchFingerprint = () => {
    if (!host.trim() || port === null) return;
    const at = `${host.trim()}:${port}`;
    setFetched(null);
    probe.mutate({ host: host.trim(), port }, { onSuccess: (r) => setFetched({ fingerprint: r.fingerprint, target: at }) });
  };

  const riskyIsDefault = sameRules(draft.riskyCommandPatterns, DEFAULT_SSH_RISKY_COMMAND_PATTERNS);
  const fpInvalid = draft.fingerprint.trim() !== "" && !SSH_FINGERPRINT_RE.test(draft.fingerprint.trim());

  return (
    <>
      <Hint>
        Let an agent run commands on one host through Loom, without ever holding the key. Loom keeps the key,
        connects itself, and checks the host's identity on every call. Create a dedicated, least-privileged
        user on the host for this, and add the matching public key to its authorized_keys.
      </Hint>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Field label="Host">
            <Input value={host} onChange={(e) => changeTarget({ host: e.target.value })} placeholder="e.g. nas.home.lan or 192.168.1.20" spellCheck={false} />
          </Field>
        </div>
        <div style={{ flex: "0 0 96px" }}>
          <Field label="Port">
            <Input value={draft.port} onChange={(e) => changeTarget({ port: e.target.value })} inputMode="numeric" spellCheck={false} style={{ width: "100%", boxSizing: "border-box" }} />
          </Field>
        </div>
      </div>
      <Field label="User">
        <Input value={draft.user} onChange={(e) => patch({ user: e.target.value })} placeholder="e.g. loom" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Private key">
        <textarea value={draft.privateKey} onChange={(e) => patch({ privateKey: e.target.value })} spellCheck={false} autoComplete="off"
          rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: font.mono, fontSize: 12, lineHeight: 1.45,
            background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 6, padding: 8 }} />
        <Hint>Paste the whole key file (ed25519 recommended) · encrypted at rest when saved · never shown again</Hint>
      </Field>
      <Field label="Key passphrase">
        <Input type="password" value={draft.passphrase} onChange={(e) => patch({ passphrase: e.target.value })} spellCheck={false} autoComplete="off" placeholder="only if the key has one" />
        <Hint>Used once to unlock the key while saving, then discarded. Loom never stores it.</Hint>
      </Field>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Host key fingerprint</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Input aria-label="Host key fingerprint" value={draft.fingerprint}
            onChange={(e) => { patch({ fingerprint: e.target.value, pinnedFor: null }); setPinClearedFor(null); }}
            placeholder="SHA256:…" spellCheck={false} style={{ flex: "1 1 260px", minWidth: 0 }} />
          <Button variant="ghost" onClick={fetchFingerprint} disabled={!host.trim() || port === null || probe.isPending}>
            {probe.isPending ? "Fetching…" : "Fetch from host"}
          </Button>
        </div>
        {fpInvalid
          ? <span style={{ ...hintStyle, color: color.red }}>Expected SHA256: followed by 43 base64 characters, exactly as ssh-keygen -l prints it.</span>
          : <Hint>Paste it from the host itself: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub. Every later connection is refused if the host presents a different key.</Hint>}
        {pinClearedFor && (
          <span data-testid="ssh-pin-cleared" role="status" style={{ ...hintStyle, color: color.amber }}>
            Pin cleared: it was fetched from {pinClearedFor}, and the host has changed. Fetch it again, or paste the fingerprint.
          </span>
        )}
        {probe.error && <span role="alert" style={{ ...hintStyle, color: color.red }}>Could not read the host key from {target}: {errorText(probe.error)}</span>}
        {fetched && (
          <div data-testid="ssh-fingerprint-confirm" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4, padding: "10px 12px",
            border: `1px solid ${color.amber}`, borderRadius: 6, background: color.panel }}>
            <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>{fetched.target} presented this host key:</span>
            <code data-testid="ssh-fingerprint-fetched" style={{ fontFamily: font.mono, fontSize: 13, color: color.amber, overflowWrap: "anywhere" }}>{fetched.fingerprint}</code>
            <span style={hintStyle}>
              Only pin it if it matches what the host itself reports. A fetch over the network cannot tell the real
              host from an impostor in between; comparing it by hand is what makes the pin trustworthy.
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="primary" onClick={() => { patch({ fingerprint: fetched.fingerprint, pinnedFor: fetched.target }); setFetched(null); setPinClearedFor(null); }}>Pin this fingerprint</Button>
              <Button variant="ghost" onClick={() => setFetched(null)}>Discard</Button>
            </div>
          </div>
        )}
      </div>

      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={draft.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })}
          style={{ accentColor: color.phosphor, width: 15, height: 15, marginTop: 2, flexShrink: 0 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>Read-only</span>
          <Hint>On by default. Untick only for a host where agents should deploy or restart things.</Hint>
        </span>
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Command allowlist</span>
        {/* @decision a3d5c7f4 — ssh_exec (card 699fdbd9) refuses a command with shell syntax ALWAYS, allowlist or not, and read-only applies on top of the allowlist; keep this copy in step with that tool. */}
        <Hint>When set, an agent may run only commands matching one of these rules. Read-only mode still applies on top, and a command with shell syntax (; | &amp;&amp; $( ) redirects) is always refused.</Hint>
        <SshRuleList rules={draft.commandAllowlist} onChange={(v) => patch({ commandAllowlist: v })} testId="ssh-allowlist"
          emptyText="No allowlist: any command read-only mode permits. A command with shell syntax is always refused." />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Hold these commands for my approval</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span data-testid="ssh-risky-summary" style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>
            {draft.riskyCommandPatterns.length} pattern{draft.riskyCommandPatterns.length === 1 ? "" : "s"}
            {riskyIsDefault ? " · Loom's default list" : " · edited"}
          </span>
          <Button variant="ghost" aria-expanded={riskyOpen} onClick={() => setRiskyOpen((o) => !o)}>{riskyOpen ? "Hide patterns" : "Review patterns"}</Button>
          {!riskyIsDefault && (
            <Button variant="ghost" onClick={() => patch({ riskyCommandPatterns: DEFAULT_SSH_RISKY_COMMAND_PATTERNS.map((r) => ({ ...r })) })}>Restore default</Button>
          )}
        </div>
        {/* @decision a3d5c7f4 — describes ssh_exec as it is: a match is HELD and waits for the owner's approval of that exact command; keep this copy in step with the tool. */}
        <span data-testid="ssh-risky-hint"><Hint>An agent's command that matches one of these does not run: it waits for your approval in the decision inbox, and runs only if you approve that exact text. This is a word screen to decide when to ask you, not a security boundary.</Hint></span>
        {riskyOpen && (
          <SshRuleList rules={draft.riskyCommandPatterns} onChange={(v) => patch({ riskyCommandPatterns: v })} testId="ssh-risky"
            emptyText="No patterns: no command waits for your approval for matching one." />
        )}
      </div>
    </>
  );
}

/** Validate the draft and build the create body, or say what's missing. */
export function buildSshCreateBody(name: string, host: string, d: SshDraft, projectId: string | null):
  { ok: true; body: Parameters<typeof api.createSshConnection>[0] } | { ok: false; error: string } {
  if (!name.trim()) return { ok: false, error: "A name is required." };
  if (!host.trim()) return { ok: false, error: "A host is required." };
  const port = parseSshPort(d.port);
  if (port === null) return { ok: false, error: "Port must be a whole number from 1 to 65535." };
  if (!d.user.trim()) return { ok: false, error: "A user is required." };
  if (!d.privateKey.trim()) return { ok: false, error: "Paste the private key." };
  if (!SSH_FINGERPRINT_RE.test(d.fingerprint.trim())) return { ok: false, error: "Pin the host key fingerprint: paste it, or fetch it from the host and confirm." };
  const allow = cleanSshRules(d.commandAllowlist, "Command allowlist");
  if (!allow.ok) return allow;
  const risky = cleanSshRules(d.riskyCommandPatterns, "Hold these commands for my approval");
  if (!risky.ok) return risky;
  return {
    ok: true,
    body: {
      name: name.trim(), host: host.trim(), port, user: d.user.trim(), privateKey: d.privateKey,
      passphrase: d.passphrase === "" ? undefined : d.passphrase,
      hostKeyFingerprint: d.fingerprint.trim(), readOnly: d.readOnly,
      commandAllowlist: allow.value, riskyCommandPatterns: risky.value, projectId,
    },
  };
}

/** The SSH-specific part of a saved connection's row: target, mode, rule counts, grant reach, and an
 *  inline editor for the fields that stay editable after create. Never a key field — there is none to show. */
export function SshConnectionRowDetail({ c, grantedTo }: { c: ConnectionMetadata; grantedTo: string[] | null }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [readOnly, setReadOnly] = useState(c.readOnly ?? true);
  const [allow, setAllow] = useState<SshCommandRule[]>(c.commandAllowlist ?? []);
  const [risky, setRisky] = useState<SshCommandRule[]>(c.riskyCommandPatterns ?? []);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: (b: { readOnly: boolean; commandAllowlist: SshCommandRule[]; riskyCommandPatterns: SshCommandRule[] }) => api.updateSshConnection(c.id, b),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ["connections"] }); },
  });
  const open = () => {
    setReadOnly(c.readOnly ?? true); setAllow(c.commandAllowlist ?? []); setRisky(c.riskyCommandPatterns ?? []);
    setLocalErr(null); save.reset(); setEditing(true);
  };
  const submit = () => {
    setLocalErr(null);
    const a = cleanSshRules(allow, "Command allowlist");
    if (!a.ok) { setLocalErr(a.error); return; }
    const r = cleanSshRules(risky, "Hold these commands for my approval");
    if (!r.ok) { setLocalErr(r.error); return; }
    save.mutate({ readOnly, commandAllowlist: a.value, riskyCommandPatterns: r.value });
  };
  const allowN = c.commandAllowlist?.length ?? 0;
  const riskyN = c.riskyCommandPatterns?.length ?? 0;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", width: "100%" }}>
        <span data-testid={`ssh-target-${c.id}`} style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>{c.user}@{c.host}:{c.port}</span>
        {c.readOnly ? <Badge tone="phosphor">Read-only</Badge> : <Badge tone="amber">Read-write</Badge>}
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
          {allowN === 0 ? "no allowlist" : `${allowN} allowed`} · {riskyN} held for approval
        </span>
        <span title={c.hostKeyFingerprint} data-testid={`ssh-fingerprint-${c.id}`} style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
          pinned {c.hostKeyFingerprint ? `${c.hostKeyFingerprint.slice(0, 19)}…` : "—"}
        </span>
        {grantedTo !== null && (
          <span data-testid={`ssh-granted-${c.id}`} title={grantedTo.join(", ")}>
            {grantedTo.length === 0
              ? <Badge tone="amber">Not granted</Badge>
              : <Badge tone="phosphor">{`Granted to ${grantedTo.length} agent${grantedTo.length === 1 ? "" : "s"}`}</Badge>}
          </span>
        )}
        {!editing && <Button variant="ghost" onClick={open}>Edit rules</Button>}
      </div>
      {editing && (
        <div data-testid={`ssh-edit-${c.id}`} style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", paddingTop: 8, borderTop: `1px solid ${color.border}` }}>
          <Hint>Host, port, user, key and fingerprint are fixed once saved. To change them, revoke this connection and create it again.</Hint>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} style={{ accentColor: color.phosphor, width: 15, height: 15 }} />
            <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>Read-only</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Command allowlist</span>
            <SshRuleList rules={allow} onChange={setAllow} testId={`ssh-edit-allowlist-${c.id}`} emptyText="No allowlist: any command read-only mode permits." />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Hold these commands for my approval</span>
            <SshRuleList rules={risky} onChange={setRisky} testId={`ssh-edit-risky-${c.id}`} emptyText="No patterns: no command waits for your approval for matching one." />
          </div>
          {(localErr || save.error) && <span role="alert" style={{ ...hintStyle, color: color.red }}>{localErr ?? errorText(save.error)}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save rules"}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}
