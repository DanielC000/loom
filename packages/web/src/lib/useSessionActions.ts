import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Shared Stop/Fork session mutations — was copy-pasted across Terminals.tsx, Overview.tsx,
// SessionView.tsx, and PlatformSessionTile.tsx. Both invalidate the live feed on success so a
// stopped/forked session's tile updates on the next render.

// Manual graceful stop (Ctrl-C ×2 — clean + resumable). On success the session leaves the live
// set, so its tile drops out (and its overlay, if maximized, closes with it); refetch confirms.
export function useStopSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
}

// Fork an idle session: branch its conversation into a fresh divergent session (appears as a new
// tile). Idle-only — callers disable the button while the source is busy.
export function useForkSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.forkSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
}

// One-click graceful wrap-up (card f55bd338): inject a turn telling the session to run /loom-session-end
// (log progress, leave it resumable) and then call the `end_me` self-stop tool. The mutation only
// enqueues the turn — the session stays live until the agent runs the skill and self-stops (or end_me
// refuses and it just stays up). Non-worker only — the route (and the button) gate that. Idle-gated
// by callers (disabled while busy), like Fork.
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.endSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
}
