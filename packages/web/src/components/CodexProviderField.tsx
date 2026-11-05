import type { CodexProvider } from "@loom/shared";
import { color, font, radius, fs } from "../theme";
import { Input } from "./ui";

// The codex model-provider endpoint editor (card 2ef54430), shown on the Profiles editor only while the
// harness is codex. HUMAN-only: `codexProvider` is on the daemon's AGENT_FORBIDDEN_PROFILE_KEYS, so this
// control and the loopback REST it drives are the whole grant path. It is a SPEND surface — it bills the key
// stored in the chosen Connection — and the copy says so. The key itself is never entered here: a custom
// endpoint names a stored Connection (Settings → Connections) whose host must equal the URL's host.
const BUILTIN = ["ollama", "lmstudio"] as const;

type Mode = "default" | "ollama" | "lmstudio" | "custom";
const modeOf = (p: CodexProvider | null): Mode =>
  !p ? "default" : (BUILTIN as readonly string[]).includes(p.id) ? (p.id as Mode) : "custom";

export function CodexProviderField({ value, onChange, connections }: {
  value: CodexProvider | null;
  onChange: (p: CodexProvider | null) => void;
  connections: ReadonlyArray<{ id: string; name: string; host: string; authScheme?: string }>;
}) {
  const mode = modeOf(value);
  const usable = connections.filter((c) => c.authScheme === undefined || c.authScheme === "api-key" || c.authScheme === "bearer");
  const label = { fontFamily: font.head as string, fontSize: fs.sm, fontWeight: 700, color: color.textDim };
  const select = { background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "6px 8px", fontFamily: font.mono, fontSize: fs.mono };
  const setMode = (m: Mode) => {
    if (m === "default") return onChange(null);
    if (m === "custom") return onChange({ id: value && modeOf(value) === "custom" ? value.id : "", baseUrl: "", connectionId: "" });
    onChange({ id: m });
  };
  return (
    <div data-testid="codex-provider-field" style={{ display: "flex", flexDirection: "column", gap: 8, border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "9px 11px", background: color.panel2 }}>
      <span style={label}>Codex model provider</span>
      <select aria-label="Codex model provider" data-testid="codex-provider-mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} style={select}>
        <option value="default">codex default (no custom endpoint)</option>
        <option value="ollama">ollama — local, no key</option>
        <option value="lmstudio">lmstudio — local, no key</option>
        <option value="custom">custom endpoint (Responses API)…</option>
      </select>
      {mode === "custom" && value && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={label}>Provider id</span>
            <Input mono data-testid="codex-provider-id" value={value.id} placeholder="e.g. myhost" onChange={(e) => onChange({ ...value, id: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={label}>Base URL</span>
            <Input mono data-testid="codex-provider-url" value={value.baseUrl ?? ""} placeholder="https://api.example.com/v1" onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={label}>API-key connection</span>
            <select aria-label="API-key connection" data-testid="codex-provider-connection" value={value.connectionId ?? ""} onChange={(e) => onChange({ ...value, connectionId: e.target.value })} style={select}>
              <option value="">— choose a stored connection —</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.host}</option>)}
            </select>
          </label>
          <span style={{ fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5, color: color.amber }}>
            Spend surface: sessions under this rig send their work to that endpoint and bill the connection's key.
            https only (http is allowed to a loopback host); the URL host must equal the connection's host.
          </span>
        </>
      )}
    </div>
  );
}
