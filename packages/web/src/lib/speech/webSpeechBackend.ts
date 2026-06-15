// v1 SpeechBackend: wraps the browser's (webkit)SpeechRecognition.
//
// Privacy note: the Web Speech API ships captured audio to the browser vendor's speech service
// (it is NOT on-device for Chrome) — accepted for v1, surfaced to the user in the composer. A future
// daemon/Whisper backend would implement this same seam to keep audio local.

import type {
  SpeechBackend,
  SpeechErrorKind,
  SpeechSession,
} from "./types";

function getCtor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

const ERROR_KINDS: ReadonlySet<string> = new Set<SpeechErrorKind>([
  "not-allowed",
  "service-not-allowed",
  "no-speech",
  "audio-capture",
  "network",
  "aborted",
]);

export const webSpeechBackend: SpeechBackend = {
  isSupported() {
    return getCtor() !== undefined;
  },

  start(opts, handlers): SpeechSession {
    const Ctor = getCtor();
    if (!Ctor) throw new Error("SpeechRecognition is not supported in this browser");

    const recognition = new Ctor();
    recognition.lang = opts.lang;
    recognition.interimResults = opts.interimResults;
    recognition.continuous = opts.continuous;
    recognition.maxAlternatives = 1;

    // Guard against late events after we've torn the session down (abort nulls handlers, but be
    // defensive about a callback already in flight): one terminal callback at most.
    let live = true;

    const detach = () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    };

    recognition.onstart = () => {
      if (live) handlers.onStart();
    };

    recognition.onresult = (event) => {
      if (!live) return;
      // resultIndex points at the first changed result, so iterating from there never re-emits an
      // already-finalized segment (no double-append). Coalesce this event into final + interim text.
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) final += alt.transcript;
        else interim += alt.transcript;
      }
      handlers.onResult({ final, interim });
    };

    recognition.onerror = (event) => {
      if (!live) return;
      const kind: SpeechErrorKind = ERROR_KINDS.has(event.error)
        ? (event.error as SpeechErrorKind)
        : "unknown";
      handlers.onError({ kind, message: event.message || event.error || "speech recognition error" });
    };

    recognition.onend = () => {
      if (!live) return;
      live = false;
      detach();
      handlers.onEnd();
    };

    recognition.start();

    return {
      stop() {
        // Graceful: keep handlers attached so the final result flushes and onEnd fires normally.
        if (!live) return;
        try {
          recognition.stop();
        } catch {
          /* already stopped */
        }
      },
      abort() {
        // Immediate teardown: silence ALL further callbacks, then abort the device.
        if (!live) return;
        live = false;
        detach();
        try {
          recognition.abort();
        } catch {
          /* already gone */
        }
      },
    };
  },
};
