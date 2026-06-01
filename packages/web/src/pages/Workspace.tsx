import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Topic, Session } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { TranscriptPane } from "../components/TranscriptPane";
import { Composer } from "../components/Composer";
import { Panel, Button, Input, SectionLabel, StatusPill } from "../components/ui";
import { color, font } from "../theme";

// Per-project working view: create project/topic, spawn or resume sessions, attach a terminal.
export default function Workspace() {
  const qc = useQueryClient();
  // Restore the last project/topic across reloads (session is ephemeral).
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem("loom.projectId"));
  const [topicId, setTopicId] = useState<string | null>(() => localStorage.getItem("loom.topicId"));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"terminal" | "transcript">("terminal");
  useEffect(() => { projectId ? localStorage.setItem("loom.projectId", projectId) : localStorage.removeItem("loom.projectId"); }, [projectId]);
  useEffect(() => { topicId ? localStorage.setItem("loom.topicId", topicId) : localStorage.removeItem("loom.topicId"); }, [topicId]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const topics = useQuery({ queryKey: ["topics", projectId], queryFn: () => api.topics(projectId!), enabled: !!projectId });
  const sessions = useQuery({ queryKey: ["sessions", topicId], queryFn: () => api.sessions(topicId!), enabled: !!topicId });

  const createProject = useMutation({
    mutationFn: api.createProject, onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const createTopic = useMutation({
    mutationFn: (b: { name: string; startupPrompt: string }) => api.createTopic(projectId!, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topics", projectId] }),
  });
  const updateTopic = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; startupPrompt?: string } }) => api.updateTopic(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topics", projectId] }),
  });
  const selectedTopic = topics.data?.find((t) => t.id === topicId) ?? null;
  const spawn = useMutation({
    mutationFn: (role?: "manager") => api.startSession(topicId!, role),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", topicId] }); },
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.resumeSession(id),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", topicId] }); },
  });
  // Manager first, then platform, then workers — so the orchestrator isn't lost among its workers.
  const roleRank = (r?: string | null) => (r === "manager" ? 0 : r === "platform" ? 1 : r === "worker" ? 2 : 3);
  const orderedSessions = [...(sessions.data ?? [])].sort((a, b) => roleRank(a.role) - roleRank(b.role));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel>
          <SectionLabel>Projects</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {projects.data?.map((p) => (
              <Button key={p.id} variant={p.id === projectId ? "primary" : "default"} style={{ textAlign: "left" }}
                onClick={() => { setProjectId(p.id); setTopicId(null); setSessionId(null); }}>{p.name}</Button>
            ))}
          </div>
          <ProjectForm onCreate={(b) => createProject.mutate(b)} />
        </Panel>

        {projectId && (
          <Panel>
            <SectionLabel>Topics</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {topics.data?.map((t) => (
                <Button key={t.id} variant={t.id === topicId ? "primary" : "default"} style={{ textAlign: "left" }}
                  onClick={() => { setTopicId(t.id); setSessionId(null); }}>{t.name}</Button>
              ))}
            </div>
            <TopicForm onCreate={(b) => createTopic.mutate(b)} />
          </Panel>
        )}

        {topicId && (
          <Panel>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <SectionLabel style={{ margin: 0, flex: 1 }}>Sessions</SectionLabel>
              <Button onClick={() => spawn.mutate(undefined)} disabled={spawn.isPending}>+ New</Button>
              <Button variant="primary" onClick={() => spawn.mutate("manager")} disabled={spawn.isPending}
                title="Spawn as orchestrator: role=manager + worker-spawning MCP surface">+ Manager</Button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {orderedSessions.map((s) => (
                <SessionRow key={s.id} s={s} selected={s.id === sessionId}
                  onSelect={() => setSessionId(s.id)} onResume={() => resume.mutate(s.id)} resuming={resume.isPending} />
              ))}
            </div>
          </Panel>
        )}
      </div>

      <Panel style={{ height: "72vh", padding: 6, display: "flex", flexDirection: "column" }}>
        {sessionId ? (
          <>
            <div style={{ marginBottom: 6, display: "flex", gap: 6 }}>
              {(["terminal", "transcript"] as const).map((t) => (
                <Button key={t} variant={rightTab === t ? "primary" : "default"} onClick={() => setRightTab(t)}>
                  {t === "terminal" ? "Terminal" : "Transcript"}
                </Button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              {rightTab === "terminal"
                ? <TerminalPane sessionId={sessionId} />
                : <TranscriptPane sessionId={sessionId} />}
            </div>
            <Composer sessionId={sessionId} />
          </>
        ) : selectedTopic ? (
          <TopicPresetEditor key={selectedTopic.id} topic={selectedTopic}
            onSave={(startupPrompt) => updateTopic.mutate({ id: selectedTopic.id, patch: { startupPrompt } })}
            saving={updateTopic.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a topic to view/edit its startup prompt, or spawn a session to attach a live terminal.</p>}
      </Panel>
    </div>
  );
}

function SessionRow({ s, selected, onSelect, onResume, resuming }:
  { s: Session; selected: boolean; onSelect: () => void; onResume: () => void; resuming: boolean }) {
  const isManager = s.role === "manager";
  const canResume = s.processState === "exited" && s.resumability !== "dead";
  const live = s.processState === "live";
  const st = live
    ? (s.busy ? { tone: "amber" as const, label: "busy", glow: true } : { tone: "phosphor" as const, label: "live" })
    : { tone: "muted" as const, label: s.processState };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Panel selected={selected} onClick={onSelect}
        style={{ flex: 1, padding: "6px 8px", borderColor: isManager && !selected ? color.phosphor : undefined }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: isManager ? color.phosphor : color.text, fontWeight: isManager ? 700 : 400 }}>
            {isManager ? "★ " : ""}{s.id.slice(0, 8)} · {s.role ?? "session"}
          </span>
          <span style={{ flex: 1 }} />
          <StatusPill tone={st.tone} label={st.label} glow={"glow" in st ? st.glow : undefined} />
        </div>
      </Panel>
      {canResume && <Button disabled={resuming} title="Resume this session and attach its terminal" onClick={onResume}>Resume</Button>}
      {s.resumability === "dead" && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>dead</span>}
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (b: { name: string; repoPath: string; vaultPath: string }) => void }) {
  const [name, setName] = useState(""), [repoPath, setRepo] = useState(""), [vaultPath, setVault] = useState("");
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="repo path" value={repoPath} onChange={(e) => setRepo(e.target.value)} />
      <Input placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
      <Button variant="primary" disabled={!name || !repoPath || !vaultPath}
        onClick={() => { onCreate({ name, repoPath, vaultPath }); setName(""); setRepo(""); setVault(""); }}>Create</Button>
    </div>
  );
}

function TopicForm({ onCreate }: { onCreate: (b: { name: string; startupPrompt: string }) => void }) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <Input placeholder="topic name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        style={{ width: "100%", height: 64, boxSizing: "border-box", resize: "vertical", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: 8, fontFamily: font.mono, fontSize: 13 }}
        placeholder="startup prompt (injected as the first turn of each new session)"
        value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <Button variant="primary" disabled={!name} onClick={() => { onCreate({ name, startupPrompt }); setName(""); setPrompt(""); }}>Create</Button>
    </div>
  );
}

// View + edit a topic's startup-prompt preset. Remounted per topic (key=topic.id) so the
// textarea state resets on switch; after Save the query refetches and `dirty` clears.
function TopicPresetEditor(
  { topic, onSave, saving }: { topic: Topic; onSave: (startupPrompt: string) => void; saving: boolean },
) {
  const [prompt, setPrompt] = useState(topic.startupPrompt);
  const dirty = prompt !== topic.startupPrompt;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 8 }}>
      <div style={{ marginBottom: 6 }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Startup prompt — {topic.name}</strong>
        <span style={{ color: color.textMuted, fontSize: 12 }}>{" "}· injected as the first turn of each new session in this topic</span>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
        }} />
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(prompt)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setPrompt(topic.startupPrompt)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
      </div>
    </div>
  );
}
