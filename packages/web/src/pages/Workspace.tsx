import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Topic } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { TranscriptPane } from "../components/TranscriptPane";
import { card, btn, input } from "../ui";

// Per-project working view: create project/topic, spawn or resume sessions, attach a terminal.
export default function Workspace() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"terminal" | "transcript">("terminal");

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
    mutationFn: () => api.startSession(topicId!),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", topicId] }); },
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
      <div>
        <div style={card}>
          <strong>Projects</strong>
          <ul style={{ paddingLeft: 16 }}>
            {projects.data?.map((p) => (
              <li key={p.id}>
                <button style={{ ...btn, background: p.id === projectId ? "#3a3a40" : "#26262b" }}
                  onClick={() => { setProjectId(p.id); setTopicId(null); setSessionId(null); }}>{p.name}</button>
              </li>
            ))}
          </ul>
          <ProjectForm onCreate={(b) => createProject.mutate(b)} />
        </div>

        {projectId && (
          <div style={card}>
            <strong>Topics</strong>
            <ul style={{ paddingLeft: 16 }}>
              {topics.data?.map((t) => (
                <li key={t.id}>
                  <button style={{ ...btn, background: t.id === topicId ? "#3a3a40" : "#26262b" }}
                    onClick={() => { setTopicId(t.id); setSessionId(null); }}>{t.name}</button>
                </li>
              ))}
            </ul>
            <TopicForm onCreate={(b) => createTopic.mutate(b)} />
          </div>
        )}

        {topicId && (
          <div style={card}>
            <strong>Sessions</strong>{" "}
            <button style={btn} onClick={() => spawn.mutate()} disabled={spawn.isPending}>+ New (warm)</button>
            <ul style={{ paddingLeft: 16 }}>
              {sessions.data?.map((s) => (
                <li key={s.id}>
                  <button style={{ ...btn, background: s.id === sessionId ? "#3a3a40" : "#26262b" }}
                    onClick={() => setSessionId(s.id)}>{s.id.slice(0, 8)} · {s.processState}</button>
                  {s.resumability === "dead" && <span style={{ color: "#e88" }}> dead</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div style={{ ...card, height: "72vh", padding: 6, display: "flex", flexDirection: "column" }}>
        {sessionId ? (
          <>
            <div style={{ marginBottom: 6 }}>
              {(["terminal", "transcript"] as const).map((t) => (
                <button key={t} style={{ ...btn, marginRight: 6, background: rightTab === t ? "#3a3a40" : "#26262b" }}
                  onClick={() => setRightTab(t)}>{t === "terminal" ? "Terminal" : "Transcript"}</button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              {rightTab === "terminal"
                ? <TerminalPane sessionId={sessionId} />
                : <TranscriptPane sessionId={sessionId} />}
            </div>
          </>
        ) : selectedTopic ? (
          <TopicPresetEditor key={selectedTopic.id} topic={selectedTopic}
            onSave={(startupPrompt) => updateTopic.mutate({ id: selectedTopic.id, patch: { startupPrompt } })}
            saving={updateTopic.isPending} />
        ) : <p style={{ color: "#777", padding: 12 }}>Select a topic to view/edit its startup prompt, or spawn a session to attach a live terminal.</p>}
      </div>
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (b: { name: string; repoPath: string; vaultPath: string }) => void }) {
  const [name, setName] = useState(""), [repoPath, setRepo] = useState(""), [vaultPath, setVault] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <input style={input} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={input} placeholder="repo path" value={repoPath} onChange={(e) => setRepo(e.target.value)} />
      <input style={input} placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
      <button style={btn} disabled={!name || !repoPath || !vaultPath}
        onClick={() => { onCreate({ name, repoPath, vaultPath }); setName(""); setRepo(""); setVault(""); }}>Create</button>
    </div>
  );
}

function TopicForm({ onCreate }: { onCreate: (b: { name: string; startupPrompt: string }) => void }) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <input style={input} placeholder="topic name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea style={{ ...input, width: "100%", height: 64, fontFamily: "monospace", resize: "vertical" }}
        placeholder="startup prompt (injected as the first turn of each new session)"
        value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <button style={btn} disabled={!name} onClick={() => { onCreate({ name, startupPrompt }); setName(""); setPrompt(""); }}>Create</button>
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
        <strong>Startup prompt — {topic.name}</strong>
        <span style={{ color: "#777", fontSize: 12 }}>{" "}· injected as the first turn of each new session in this topic</span>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: "monospace", fontSize: 13, lineHeight: 1.5,
          background: "#1b1b1f", color: "#ddd", border: "1px solid #333", borderRadius: 6, padding: 8,
        }} />
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <button style={btn} disabled={!dirty || saving} onClick={() => onSave(prompt)}>{saving ? "Saving…" : "Save"}</button>
        {dirty
          ? <button style={btn} onClick={() => setPrompt(topic.startupPrompt)}>Reset</button>
          : <span style={{ color: "#6a6", fontSize: 12 }}>saved</span>}
      </div>
    </div>
  );
}
