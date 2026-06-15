import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpeechBackend, SpeechSession } from "./speech/types";
import { webSpeechBackend } from "./speech/webSpeechBackend";

// Voice-input recording state machine, capability detection, and permission flow — built on the
// SpeechBackend seam (default: the browser's Web Speech recognizer). The hook never sends anything;
// it hands each finalized transcript chunk to `onFinalTranscript` and the composer decides what to do
// (append, never auto-send). v1 is CLICK-ONLY: no global hotkey (xterm + the Enter handler would eat it).
export type SpeechStatus = "idle" | "requesting" | "listening" | "denied" | "error";

// Single-active-recognizer guard. Two Composers can be mounted at once (Workspace + Overview), but
// only one may hold the mic — starting a recognizer aborts any other still in flight.
let activeSession: SpeechSession | null = null;

export interface UseSpeechRecognitionOptions {
  // Called with each freshly-finalized transcript chunk (already de-duplicated by the backend).
  onFinalTranscript: (text: string) => void;
  // Override the backend (tests / a future daemon backend). Defaults to the Web Speech backend.
  backend?: SpeechBackend;
  // BCP-47 language tag. Defaults to navigator.language.
  lang?: string;
}

export interface SpeechRecognitionApi {
  supported: boolean;
  secure: boolean;
  status: SpeechStatus;
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechRecognition(opts: UseSpeechRecognitionOptions): SpeechRecognitionApi {
  const backend = opts.backend ?? webSpeechBackend;
  const supported = useMemo(() => backend.isSupported(), [backend]);
  const secure = typeof window !== "undefined" ? window.isSecureContext : false;

  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<SpeechSession | null>(null);
  const mountedRef = useRef(true);
  // Keep the latest callback in a ref so the backend handlers (set once at start()) never close over
  // a stale onFinalTranscript.
  const onFinalRef = useRef(opts.onFinalTranscript);
  onFinalRef.current = opts.onFinalTranscript;

  const stop = useCallback(() => {
    sessionRef.current?.stop(); // graceful — flush finals; onEnd resets state
  }, []);

  const start = useCallback(() => {
    if (!supported || !secure) return;
    if (sessionRef.current) return; // already running
    if (activeSession) {
      activeSession.abort(); // single-active guard
      activeSession = null;
    }
    setError(null);
    setInterim("");
    setStatus("requesting");

    const lang =
      opts.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");

    const session = backend.start(
      { lang, interimResults: true, continuous: true },
      {
        onStart: () => {
          if (mountedRef.current) setStatus("listening");
        },
        onResult: ({ final, interim: live }) => {
          if (!mountedRef.current) return;
          if (final) onFinalRef.current(final);
          setInterim(live);
        },
        onError: ({ kind, message }) => {
          if (!mountedRef.current) return;
          if (kind === "aborted") return; // our own teardown — not user-facing
          setInterim("");
          if (kind === "not-allowed" || kind === "service-not-allowed") setStatus("denied");
          else {
            setError(message);
            setStatus("error");
          }
        },
        onEnd: () => {
          if (activeSession === sessionRef.current) activeSession = null;
          sessionRef.current = null;
          if (!mountedRef.current) return;
          setInterim("");
          // Preserve a terminal denied/error; otherwise return to idle. NEVER auto-restart.
          setStatus((s) => (s === "denied" || s === "error" ? s : "idle"));
        },
      },
    );
    sessionRef.current = session;
    activeSession = session;
  }, [backend, supported, secure, opts.lang]);

  // Disciplined teardown on unmount: abort the live session (silences any late onresult/onend) and
  // mark unmounted so a callback already in flight no-ops.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const s = sessionRef.current;
      if (s) {
        if (activeSession === s) activeSession = null;
        sessionRef.current = null;
        s.abort();
      }
    };
  }, []);

  return { supported, secure, status, interim, error, start, stop };
}
