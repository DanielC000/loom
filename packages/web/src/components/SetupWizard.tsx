import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { Profile } from "@loom/shared";
import { api, type SetupTemplate, type TemplateApplyResult } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { color, font, radius } from "../theme";
import { Button, Input } from "./ui";
import { LogoMark } from "./Logo";
import { roleDisplay, roleColor } from "../lib/roleDisplay";

// ── Guided onboarding WIZARD (onboarding C5, visual direction B · Guided Flow) ────────────────────────
//
// A full-bleed, 4-screen guided flow — Template → Project → Review → Done — that stands up a ready-to-run
// project from a bundled workflow template, wired end-to-end to the setup REST:
//   1. Template gallery  → GET /api/setup/templates (+ GET /api/profiles to resolve each agent's role /
//      browser / no-commit rig for its roster chip). "Start empty" skips the template apply entirely.
//   2. Project step      → a "Bind existing / Create new" segmented toggle picks between two DISTINCT
//      backend calls: "Bind existing" → api.createProject (registers a project at a repoPath/vaultPath
//      already on disk, exactly like the Projects "New project" form); "Create new" → api.projectInit
//      (the host-write REST mirror of the setup-MCP project_init tool — Loom creates + `git init`s a
//      BRAND-NEW directory under its sanctioned workspace base; only a name is needed, no path).
//   3. Review & confirm  → nothing is applied until the primary "Apply template" — the mode-appropriate
//      project call THEN, for a real template, applyTemplate. Shows the full roster + the exact starter
//      card(s) (from the templates response's boardSeed) + the browser-rig one-time-install advisory.
//   4. Done              → the AUTHORITATIVE created counts from the apply response. The wizard itself
//      spawns NO agent — "Go to the board" / "Spawn the Orchestrator" are navigation, not spawns.
//
// Reached from two entry points (both mount THIS component with their own open state): a launcher on the
// /platform page, and the first-run welcome overlay (App.tsx › FirstRunWelcome). Rendered in Loom's real
// "Terminal Cockpit" tokens + role sigils — no new color system, reusing Button/Input + roleDisplay.

type Step = 1 | 2 | 3 | 4;
type TemplateChoice = string | "empty" | null;
type ProjectMode = "bind" | "new";

const STEP_CAPS = ["Template", "Project", "Review", "Done"] as const;

// Track a narrow (phone-width) viewport so the top stepper can go compact rather than overflow the
// dialog — a 4-step stepper at desktop sizing is wider than a phone, and an oversized centered stepper
// would push a horizontal scrollbar. Threshold 560px; SSR-safe default (false).
function useNarrowViewport(threshold = 560): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => typeof window !== "undefined" && window.innerWidth < threshold);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < threshold);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [threshold]);
  return narrow;
}

export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Remount the body on each open so all step/field state resets cleanly (no stale draft on reopen).
  if (!open) return null;
  return <WizardBody onClose={onClose} />;
}

function WizardBody({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setProjectId } = useActiveProject();

  const [step, setStep] = useState<Step>(1);
  const [choice, setChoice] = useState<TemplateChoice>(null);
  const [mode, setMode] = useState<ProjectMode>("bind");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [vaultPath, setVaultPath] = useState("");
  // Read-only sibling repos to bind at creation (reference-repos epic, Interpretation A). Optional in
  // both modes; trimmed + blanks dropped before submit, so a stray empty row never reaches the server.
  const [referenceRepos, setReferenceRepos] = useState<string[]>([]);
  const cleanRefs = referenceRepos.map((r) => r.trim()).filter(Boolean);
  const [created, setCreated] = useState<{ projectId: string; projectName: string; result: TemplateApplyResult | null } | null>(null);
  const narrow = useNarrowViewport();

  const templatesQ = useQuery({ queryKey: ["setupTemplates"], queryFn: api.setupTemplates });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const profileByName = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const p of profilesQ.data ?? []) m.set(p.name, p);
    return m;
  }, [profilesQ.data]);

  // Escape closes the wizard from any step (except mid-apply, where it would strand the flow).
  const apply = useMutation({
    mutationFn: async (): Promise<{ projectId: string; projectName: string; result: TemplateApplyResult | null }> => {
      // "Create new" inits a real directory (host-write, confined to the sanctioned base); "Bind
      // existing" registers a project at the path the user already has on disk.
      // Bind read-only reference repos in BOTH modes (empty list → omitted, byte-identical to before).
      const refs = cleanRefs.length ? { referenceRepos: cleanRefs } : {};
      const project = mode === "new"
        ? await api.projectInit({ name: name.trim(), ...refs })
        : await api.createProject({ name: name.trim(), repoPath: repoPath.trim(), vaultPath: vaultPath.trim(), ...refs });
      // "Start empty" registers the project only — no template to apply.
      const result = choice && choice !== "empty" ? await api.applyTemplate(project.id, choice) : null;
      return { projectId: project.id, projectName: project.name, result };
    },
    onSuccess: (c) => {
      setCreated(c);
      // The new project (+ its agents) must be visible everywhere the moment we land on the board.
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["agents", c.projectId] });
      qc.invalidateQueries({ queryKey: ["allSessions"] });
      setStep(4);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !apply.isPending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply.isPending, onClose]);

  const templates = templatesQ.data ?? [];
  const chosenTemplate = choice && choice !== "empty" ? templates.find((t) => t.name === choice) ?? null : null;

  // Auto-derive the project name from the repo path's last segment until the user edits it themselves.
  const onRepoPath = (v: string) => {
    setRepoPath(v);
    if (!nameTouched) setName(deriveName(v));
  };

  const canContinueFrom1 = choice !== null;
  const canContinueFrom2 = mode === "new"
    ? !!name.trim()
    : !!name.trim() && !!repoPath.trim(); // vaultPath is optional — a project may have no vault bound

  const goToBoard = () => { setProjectId(created!.projectId); onClose(); navigate("/board"); };
  const goSpawnOrchestrator = () => { setProjectId(created!.projectId); onClose(); navigate("/overview"); };

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Set up a new project"
      style={{
        position: "fixed", inset: 0, zIndex: 1600, display: "flex", flexDirection: "column",
        background: `radial-gradient(1100px 460px at 50% -8%, ${color.phosphorDim}, transparent 60%), ${color.bg}`,
        overflowY: "auto", overflowX: "hidden",
      }}
    >
      {/* Top bar: brand at the left, the horizontal stepper centered, a close affordance at the right. */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 24px 30px" }}>
        <span style={{ position: "absolute", left: 24, top: 20, display: "inline-flex", alignItems: "center", gap: 9, color: color.phosphor }}>
          <LogoMark size={20} />
          <span style={{ fontFamily: font.head, fontWeight: 600, fontSize: 15, letterSpacing: "0.12em", color: color.text }}>loom</span>
        </span>
        <Stepper step={step} compact={narrow} />
        <button
          onClick={() => !apply.isPending && onClose()} disabled={apply.isPending} aria-label="Close setup"
          title="Close setup (Esc)"
          style={{
            position: "absolute", right: 24, top: 18, background: "transparent", border: "none",
            color: color.textMuted, cursor: apply.isPending ? "default" : "pointer", fontFamily: font.mono,
            fontSize: 18, lineHeight: 1, padding: 4,
          }}
        >×</button>
      </div>

      {/* Centered content column. */}
      <div style={{ flex: 1, width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 30px 40px", boxSizing: "border-box" }}>
        {step === 1 && (
          <StepTemplate
            templates={templates} loading={templatesQ.isLoading} error={templatesQ.isError}
            choice={choice} onChoose={setChoice} profileByName={profileByName}
          />
        )}
        {step === 2 && (
          <StepProject
            mode={mode} onMode={setMode}
            name={name} onName={(v) => { setName(v); setNameTouched(true); }}
            repoPath={repoPath} onRepoPath={onRepoPath}
            vaultPath={vaultPath} onVaultPath={setVaultPath}
            referenceRepos={referenceRepos} onReferenceRepos={setReferenceRepos}
          />
        )}
        {step === 3 && (
          <StepReview
            mode={mode} name={name.trim()} repoPath={repoPath.trim()} vaultPath={vaultPath.trim()}
            referenceRepos={cleanRefs}
            template={chosenTemplate} isEmpty={choice === "empty"} profileByName={profileByName}
            error={apply.isError ? (apply.error as Error).message : null}
          />
        )}
        {step === 4 && created && (
          <StepDone
            projectName={created.projectName} result={created.result}
            onBoard={goToBoard} onSpawn={goSpawnOrchestrator}
          />
        )}
      </div>

      {/* Footer nav — hidden on the Done screen (its own actions replace it). */}
      {step !== 4 && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", maxWidth: 880, margin: "0 auto", padding: "18px 30px 26px",
          borderTop: `1px solid ${color.border}`, boxSizing: "border-box",
        }}>
          <div>
            {step > 1 && (
              <Button onClick={() => setStep((s) => (s - 1) as Step)} disabled={apply.isPending}>← Back</Button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Step {step} of 4</span>
            {step === 1 && (
              <Button variant="primary" disabled={!canContinueFrom1} onClick={() => setStep(2)}
                style={{ padding: "6px 14px", fontSize: 13 }}>Continue →</Button>
            )}
            {step === 2 && (
              <Button variant="primary" disabled={!canContinueFrom2} onClick={() => setStep(3)}
                style={{ padding: "6px 14px", fontSize: 13 }}>Continue →</Button>
            )}
            {step === 3 && (
              <Button variant="primary" disabled={apply.isPending} onClick={() => apply.mutate()}
                style={{ padding: "6px 14px", fontSize: 13 }}>
                {apply.isPending ? "Applying…" : "Apply template →"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── The horizontal top stepper ────────────────────────────────────────────────────────────────────────
// `compact` (phone width) shrinks the step columns + connectors so the 4-step rail fits without pushing a
// horizontal scrollbar; the desktop sizing matches direction B.
function Stepper({ step, compact }: { step: Step; compact?: boolean }) {
  const stepW = compact ? 56 : 108;
  const connW = compact ? 10 : 48;
  const bub = compact ? 26 : 30;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      {STEP_CAPS.map((cap, i) => {
        const n = (i + 1) as Step;
        const state: "done" | "current" | "todo" = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <div key={cap} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: stepW }}>
              <span style={{
                width: bub, height: bub, borderRadius: bub, display: "grid", placeItems: "center",
                fontFamily: font.mono, fontSize: compact ? 12 : 13, fontWeight: 700,
                border: `1px solid ${state === "todo" ? color.borderStrong : color.phosphor}`,
                color: state === "current" ? color.bg : state === "done" ? color.phosphor : color.textMuted,
                background: state === "current" ? color.phosphor : color.bg,
                boxShadow: state === "current" ? `0 0 0 5px ${color.phosphorDim}` : undefined,
              }}>{state === "done" ? "✓" : n}</span>
              <span style={{
                fontFamily: font.mono, fontSize: compact ? 9 : 11, letterSpacing: "0.03em", textTransform: "uppercase",
                color: state === "current" ? color.text : state === "done" ? color.textDim : color.textMuted,
              }}>{cap}</span>
            </div>
            {i < STEP_CAPS.length - 1 && (
              <span aria-hidden style={{ width: connW, height: 1, margin: "0 -4px 22px", background: n < step ? color.phosphor : color.borderStrong }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Shared heading (centered h1 + lede) ─────────────────────────────────────────────────────────────────
function Heading({ title, lede }: { title: string; lede: string }) {
  return (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <h1 style={{ fontFamily: font.head, fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "0.01em", color: color.text }}>{title}</h1>
      <p style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, lineHeight: 1.65, margin: "12px auto 0", maxWidth: 600 }}>{lede}</p>
    </div>
  );
}

// ── A single agent→profile roster row (role sigil + browser / no-commit rig badges) ─────────────────────
function RosterRow({ agentName, profile, topBorder }: { agentName: string; profile: Profile | undefined; topBorder?: boolean }) {
  const role = profile?.role ?? null;
  const d = roleDisplay(role);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 0", fontFamily: font.mono, fontSize: 12.5,
      borderTop: topBorder ? `1px solid ${color.border}` : undefined,
    }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 8, flexShrink: 0, background: roleColor(role) }} />
      <span style={{ flex: 1, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agentName}</span>
      {profile?.browserTesting && <RigBadge tone={color.cyan}>browser</RigBadge>}
      {profile?.noCommit && <RigBadge tone={color.textMuted}>no-commit</RigBadge>}
      <span style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: roleColor(role), flexShrink: 0 }}>
        {d.sigil} {d.short}
      </span>
    </div>
  );
}

// A hairline rig-capability tag (browser / no-commit) — quieter than a full role Badge so the role chip
// stays the dominant mark on the row.
function RigBadge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span style={{
      fontFamily: font.mono, fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase",
      color: tone, border: `1px solid ${tone}`, borderRadius: radius.sm, padding: "0 5px", flexShrink: 0, opacity: 0.85,
    }}>{children}</span>
  );
}

// ── Screen 1 — Template gallery ─────────────────────────────────────────────────────────────────────────
function StepTemplate({
  templates, loading, error, choice, onChoose, profileByName,
}: {
  templates: SetupTemplate[]; loading: boolean; error: boolean; choice: TemplateChoice;
  onChoose: (c: TemplateChoice) => void; profileByName: Map<string, Profile>;
}) {
  return (
    <div>
      <Heading title="Choose your team" lede="A workflow template stands up a ready-to-run set of agents and seeds a starter card. Pick the shape that fits — you can always add or remove agents later." />
      {loading && <p style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 13, textAlign: "center" }}>Loading templates…</p>}
      {error && <p style={{ color: color.red, fontFamily: font.mono, fontSize: 13, textAlign: "center" }}>Couldn’t load templates — is the daemon reachable?</p>}
      {!loading && !error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            {templates.map((t) => (
              <TemplateCard key={t.name} template={t} selected={choice === t.name}
                onSelect={() => onChoose(t.name)} profileByName={profileByName} />
            ))}
          </div>
          {/* The subtle "start empty" escape hatch. */}
          <div style={{ textAlign: "center", marginTop: 18, fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>
            Prefer to build your own?{" "}
            <button
              onClick={() => onChoose("empty")} aria-pressed={choice === "empty"}
              style={{
                background: "transparent", border: "none", cursor: "pointer", fontFamily: font.mono, fontSize: 12,
                padding: 0, color: choice === "empty" ? color.phosphor : color.cyan,
                textDecoration: choice === "empty" ? "underline" : "none",
              }}
            >Start with an empty project →</button>
          </div>
        </>
      )}
    </div>
  );
}

function TemplateCard({
  template, selected, onSelect, profileByName,
}: { template: SetupTemplate; selected: boolean; onSelect: () => void; profileByName: Map<string, Profile> }) {
  const n = template.agents.length;
  return (
    <button
      onClick={onSelect} aria-pressed={selected} role="radio" aria-checked={selected}
      style={{
        textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden",
        background: color.panel, borderRadius: radius.base,
        border: `1px solid ${selected ? color.phosphor : color.border}`,
        boxShadow: selected ? `inset 0 0 0 1px ${color.phosphorDim}` : undefined,
      }}
    >
      <div style={{ padding: "18px 20px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span style={{ flex: 1, fontFamily: font.head, fontSize: 17, fontWeight: 600, color: color.text }}>{template.name}</span>
          <span aria-hidden style={{
            width: 18, height: 18, borderRadius: 18, flexShrink: 0, marginTop: 2,
            border: `1px solid ${selected ? color.phosphor : color.borderStrong}`,
            background: selected ? `radial-gradient(circle, ${color.phosphor} 0 4px, transparent 5px)` : "transparent",
          }} />
        </div>
        <p style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textDim, lineHeight: 1.55, margin: "8px 0 0" }}>{template.description}</p>
      </div>
      <div style={{ padding: "0 20px 4px" }}>
        {template.agents.map((a, i) => (
          <RosterRow key={a.name + i} agentName={a.name} profile={profileByName.get(a.profileName)} topBorder={i > 0} />
        ))}
      </div>
      <div style={{
        marginTop: "auto", padding: "12px 20px", borderTop: `1px solid ${color.border}`, background: color.panel2,
        display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: font.mono, fontSize: 11.5, color: color.textDim,
      }}>
        <span>stands up <b style={{ color: color.phosphor }}>{n} agent{n === 1 ? "" : "s"}</b></span>
        <span>+ {template.boardSeed.count} starter card{template.boardSeed.count === 1 ? "" : "s"}</span>
      </div>
    </button>
  );
}

// ── Screen 2 — Project step ─────────────────────────────────────────────────────────────────────────────
function StepProject({
  mode, onMode, name, onName, repoPath, onRepoPath, vaultPath, onVaultPath, referenceRepos, onReferenceRepos,
}: {
  mode: ProjectMode; onMode: (m: ProjectMode) => void;
  name: string; onName: (v: string) => void;
  repoPath: string; onRepoPath: (v: string) => void;
  vaultPath: string; onVaultPath: (v: string) => void;
  referenceRepos: string[]; onReferenceRepos: (r: string[]) => void;
}) {
  return (
    <div>
      <Heading title="Point Loom at a project" lede={mode === "bind"
        ? "Bind an existing local repository. Loom weaves its board, sessions and vault around this path."
        : "Loom creates and git-initializes a brand-new project directory for you — just give it a name."} />
      <div style={{ maxWidth: 620, margin: "0 auto", background: color.panel, border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "24px 26px" }}>
        {/* Segmented Bind / Create toggle. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 22 }} role="tablist" aria-label="Project source">
          <SegButton on={mode === "bind"} onClick={() => onMode("bind")}
            title="Bind existing repo" sub="use a repository already on disk" />
          <SegButton on={mode === "new"} onClick={() => onMode("new")}
            title="Create new project" sub="Loom creates the folder for you" />
        </div>

        {mode === "bind" ? (
          <>
            <Field label="Repository path" hint="The absolute path to a git repo already on disk.">
              <Input value={repoPath} onChange={(e) => onRepoPath(e.target.value)} spellCheck={false}
                placeholder="/Users/you/code/aurora-api"
                aria-label="Repository path" style={{ width: "100%", boxSizing: "border-box" }} />
            </Field>

            <Field label="Project name" hint="Auto-filled from the folder — change it if you like.">
              <Input value={name} onChange={(e) => onName(e.target.value)} spellCheck={false}
                placeholder="aurora-api" aria-label="Project name" style={{ width: "100%", boxSizing: "border-box" }} />
            </Field>

            <Field label="Vault path (optional)" hint="An Obsidian vault folder for this project's design docs — leave blank if you don't use one.">
              <Input value={vaultPath} onChange={(e) => onVaultPath(e.target.value)} spellCheck={false}
                placeholder="/Users/you/vault/aurora-api" aria-label="Vault path" style={{ width: "100%", boxSizing: "border-box" }} />
            </Field>
          </>
        ) : (
          <Field label="Project name" hint="Loom derives a folder name from this and creates a git-initialized directory in a Loom-managed folder — no path to type.">
            <Input value={name} onChange={(e) => onName(e.target.value)} spellCheck={false}
              placeholder="aurora-api" aria-label="Project name" style={{ width: "100%", boxSizing: "border-box" }} />
          </Field>
        )}

        {/* Read-only reference repos — optional in both modes, a distinct field from the primary repo. */}
        <ReferenceReposField repos={referenceRepos} onChange={onReferenceRepos} />
      </div>
    </div>
  );
}

// ── Reference-repos editor (wizard variant) ─────────────────────────────────────────────────────────────
// A repo-list add/remove for the project's read-only sibling repos (reference-repos epic, Interpretation
// A) — the SAME shape as the Projects "Manage project" ReferenceReposEditor, but with NO Save button: the
// wizard collects the rows into its own state and binds them at Apply (createProject / projectInit). The
// primary repoPath stays a DISTINCT field above. A bad entry surfaces its server 400 on the Review screen.
function ReferenceReposField({ repos, onChange }: { repos: string[]; onChange: (r: string[]) => void }) {
  const edit = (i: number, v: string) => onChange(repos.map((r, j) => (j === i ? v : r)));
  const remove = (i: number) => onChange(repos.filter((_, j) => j !== i));
  const add = () => onChange([...repos, ""]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, paddingTop: 16, borderTop: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <label style={{ fontFamily: font.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: color.textDim }}>
          Reference repos <span style={{ color: color.textMuted, textTransform: "none", letterSpacing: 0 }}>· optional</span>
        </label>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
          Read-only sibling repos agents can consult. Absolute git paths — never committed to.
        </span>
      </div>
      {repos.length === 0 ? (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "2px 0" }}>None — this project reads only its primary repo.</span>
      ) : (
        repos.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Input value={r} onChange={(e) => edit(i, e.target.value)} spellCheck={false}
              placeholder="/Users/you/code/shared-lib" aria-label={`Reference repo ${i + 1}`}
              style={{ flex: 1, boxSizing: "border-box" }} />
            <Button variant="ghost" title="Remove this reference repo" aria-label={`Remove reference repo ${i + 1}`}
              onClick={() => remove(i)} style={{ padding: "4px 9px" }}>✕</Button>
          </div>
        ))
      )}
      <div>
        <Button onClick={add}>＋ Add reference repo</Button>
      </div>
    </div>
  );
}

function SegButton({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      onClick={onClick} role="tab" aria-selected={on}
      style={{
        display: "flex", flexDirection: "column", gap: 4, textAlign: "left", cursor: "pointer",
        fontFamily: font.mono, fontSize: 13, padding: 12, borderRadius: radius.base,
        background: color.panel2, color: on ? color.text : color.textDim,
        border: `1px solid ${on ? color.phosphor : color.borderStrong}`,
        boxShadow: on ? `inset 0 0 0 1px ${color.phosphorDim}` : undefined,
      }}
    >
      <span>{title}</span>
      <small style={{ fontSize: 11, color: on ? color.textDim : color.textMuted }}>{sub}</small>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
      <label style={{ fontFamily: font.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: color.textDim }}>{label}</label>
      {children}
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{hint}</span>
    </div>
  );
}

// ── Screen 3 — Review & confirm ─────────────────────────────────────────────────────────────────────────
function StepReview({
  mode, name, repoPath, vaultPath, referenceRepos, template, isEmpty, profileByName, error,
}: {
  mode: ProjectMode; name: string; repoPath: string; vaultPath: string; referenceRepos: string[];
  template: SetupTemplate | null; isEmpty: boolean;
  profileByName: Map<string, Profile>; error: string | null;
}) {
  const needsBrowserInstall = !!template?.agents.some((a) => profileByName.get(a.profileName)?.browserTesting);
  const browserRigs = (template?.agents ?? [])
    .filter((a) => profileByName.get(a.profileName)?.browserTesting)
    .map((a) => a.name);
  return (
    <div>
      <Heading title="Review & confirm" lede="Here's everything Loom will create. Nothing is applied until you confirm." />
      <div style={{ maxWidth: 640, margin: "0 auto", background: color.panel, border: `1px solid ${color.border}`, borderRadius: radius.base, overflow: "hidden" }}>
        <ReceiptSection title="Project">
          <ReceiptLine k="name" v={name} />
          {mode === "bind" ? (
            <>
              <ReceiptLine k="repo" v={repoPath} mono />
              {vaultPath && <ReceiptLine k="vault" v={vaultPath} mono />}
            </>
          ) : (
            <p style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textDim, margin: "2px 0 0", lineHeight: 1.5 }}>
              Loom will create and git-initialize a new directory for this project in a Loom-managed folder.
            </p>
          )}
          {referenceRepos.map((r, i) => (
            <ReceiptLine key={r + i} k={i === 0 ? "refs" : ""} v={r} mono />
          ))}
        </ReceiptSection>

        <ReceiptSection title={isEmpty ? "Template · none" : `Template · ${template?.name ?? ""}`}
          note={isEmpty ? "an empty project — add agents later" : `→ ${template?.agents.length ?? 0} agents`}>
          {isEmpty ? (
            <p style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textMuted, margin: "2px 0 0", lineHeight: 1.5 }}>
              No template — a blank project. You can define agents and profiles afterward from the Projects page.
            </p>
          ) : (
            (template?.agents ?? []).map((a, i) => (
              <RosterRow key={a.name + i} agentName={a.name} profile={profileByName.get(a.profileName)} />
            ))
          )}
        </ReceiptSection>

        {!isEmpty && template && template.boardSeed.count > 0 && (
          <ReceiptSection title={`Starter board card${template.boardSeed.count === 1 ? "" : "s"}`}>
            {template.boardSeed.titles.map((title, i) => (
              <p key={title + i} style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textDim, margin: i === 0 ? "2px 0 0" : "4px 0 0", lineHeight: 1.5 }}>
                “{title}”
              </p>
            ))}
          </ReceiptSection>
        )}

        {needsBrowserInstall && (
          <div style={{ padding: "14px 22px", borderTop: `1px solid ${color.border}`, background: "rgba(96,181,255,0.06)" }}>
            <p style={{ fontFamily: font.mono, fontSize: 12, color: color.cyan, margin: 0, lineHeight: 1.55 }}>
              <b>Browser rigs</b> — {browserRigs.join(" + ")} drive a headless browser. They need a one-time{" "}
              <code style={{ background: color.panel2, padding: "1px 5px", borderRadius: radius.sm, color: color.text }}>npx playwright install chromium</code>{" "}
              before their first run.
            </p>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" style={{ maxWidth: 640, margin: "14px auto 0", fontFamily: font.mono, fontSize: 12, color: color.red, textAlign: "center" }}>{error}</p>
      )}
    </div>
  );
}

function ReceiptSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ padding: "16px 22px", borderTop: `1px solid ${color.border}` }}>
      <h4 style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim, margin: "0 0 10px" }}>
        {title}{note && <span style={{ color: color.textMuted, fontWeight: 400, letterSpacing: "0.02em" }}>&nbsp;&nbsp;{note}</span>}
      </h4>
      {children}
    </div>
  );
}

function ReceiptLine({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, fontFamily: font.mono, fontSize: 12.5, padding: "5px 0" }}>
      <span style={{ color: color.textMuted, width: 64, flexShrink: 0 }}>{k}</span>
      <span style={{ color: mono ? color.textDim : color.text, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

// ── Screen 4 — Done ─────────────────────────────────────────────────────────────────────────────────────
function StepDone({
  projectName, result, onBoard, onSpawn,
}: { projectName: string; result: TemplateApplyResult | null; onBoard: () => void; onSpawn: () => void }) {
  const agentCount = result?.agents.length ?? 0;
  const cardCount = result?.tasks.length ?? 0;
  return (
    <div style={{ textAlign: "center", paddingTop: 8 }}>
      <div style={{
        width: 66, height: 66, borderRadius: 66, display: "inline-grid", placeItems: "center", marginBottom: 20,
        border: `1.5px solid ${color.phosphor}`, color: color.phosphor, background: color.phosphorDim, fontSize: 30,
      }}>✓</div>
      <h1 style={{ fontFamily: font.head, fontSize: 26, fontWeight: 700, margin: 0, color: color.text }}>{projectName} is ready</h1>
      <p style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, lineHeight: 1.65, margin: "12px auto 0", maxWidth: 520 }}>
        {agentCount > 0
          ? "Your team is standing by. The Orchestrator can pick up the starter card as soon as you spawn it."
          : "Your empty project is ready. Define its agents and profiles from the Projects page whenever you like."}
      </p>

      <div style={{ display: "flex", justifyContent: "center", gap: 12, margin: "24px 0 26px" }}>
        <Stat n={agentCount} label={`agent${agentCount === 1 ? "" : "s"} created`} />
        <Stat n={cardCount} label={`starter card${cardCount === 1 ? "" : "s"}`} />
        <Stat check label="board ready" />
      </div>

      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <Button variant="primary" onClick={onBoard} style={{ padding: "7px 16px", fontSize: 13 }}>Go to the board →</Button>
        {agentCount > 0 && (
          <Button onClick={onSpawn} style={{ padding: "7px 16px", fontSize: 13 }} title="Open the project's fleet to spawn the Orchestrator">
            Spawn the Orchestrator
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ n, check, label }: { n?: number; check?: boolean; label: string }) {
  return (
    <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "14px 22px", background: color.panel }}>
      <b style={{ display: "block", fontFamily: font.head, fontSize: 24, color: color.phosphor }}>{check ? "✓" : n}</b>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>{label}</span>
    </div>
  );
}

// Derive a project name from a repo path's last path segment (either separator), stripped of a trailing
// slash. "" for an empty/rootish path — the field just stays blank until the user types.
function deriveName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
