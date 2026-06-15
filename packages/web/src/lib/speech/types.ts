// The SpeechBackend seam.
//
// v1 wraps the browser's (webkit)SpeechRecognition (see webSpeechBackend.ts), but the recording
// hook (useSpeechRecognition) depends ONLY on this interface — so a future daemon/Whisper backend
// can swap in without touching the hook or the UI. Keep this surface UI-agnostic: no React, no DOM
// rendering, just "start a recognition session, get final/interim text + lifecycle callbacks back".

// One native recognition update, coalesced into the freshly-finalized text and the current interim
// best-guess. `final` is appended to the composer; `interim` is the greyed live preview. Either may
// be empty on any given update.
export interface SpeechResult {
  final: string;
  interim: string;
}

// Normalized error kinds (a superset of the Web Speech `error` codes the hook special-cases).
export type SpeechErrorKind =
  | "not-allowed"
  | "service-not-allowed"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "aborted"
  | "unknown";

export interface SpeechErrorEvent {
  kind: SpeechErrorKind;
  message: string;
}

// Lifecycle callbacks a backend invokes while a session is live.
export interface SpeechSessionHandlers {
  // The recognizer has acquired the mic and is now listening (permission granted).
  onStart: () => void;
  onResult: (result: SpeechResult) => void;
  onError: (error: SpeechErrorEvent) => void;
  // The recognizer has fully stopped (graceful stop, error, or end-of-speech). Terminal.
  onEnd: () => void;
}

export interface SpeechStartOptions {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
}

// A live recognition session handle.
export interface SpeechSession {
  // Graceful: flush any pending final result, then fire onEnd.
  stop: () => void;
  // Immediate teardown: detach handlers and abort with NO further callbacks (used on unmount).
  abort: () => void;
}

export interface SpeechBackend {
  // Capability detection — is this backend usable in the current environment?
  isSupported: () => boolean;
  // Begin a recognition session. Throws if unsupported (callers gate on isSupported first).
  start: (opts: SpeechStartOptions, handlers: SpeechSessionHandlers) => SpeechSession;
}
