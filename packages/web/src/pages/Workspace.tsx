import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { card, btn, input } from "../ui";

// Per-project working view: create project/topic, spawn or resume sessions, attach a terminal.
export default function Workspace() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

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

      <div style={{ ...card, height: "72vh", padding: 6 }}>
        {sessionId
          ? <TerminalPane sessionId={sessionId} />
          : <p style={{ color: "#777", padding: 12 }}>Select or spawn a session to attach a live terminal.</p>}
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
      <input style={{ ...input, width: 200 }} placeholder="startup prompt (e.g. /pickup)" value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <button style={btn} disabled={!name} onClick={() => { onCreate({ name, startupPrompt }); setName(""); setPrompt(""); }}>Create</button>
    </div>
  );
}
