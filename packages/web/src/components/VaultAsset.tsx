import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import { isRemoteOrigin } from "../lib/gatewayCredential";
import { DOWNLOAD_BLOB_TYPE, assetFileName, vaultAssetMode, viewSource } from "../lib/vaultAsset";
import { color, font, radius } from "../theme";

/**
 * The React half of the vault raw-asset story — see `lib/vaultAsset.ts` for the mode decision and
 * `docs/decisions/f7525818-vault-raw-remote-auth.md` for why it is a blob fetch and not a signed URL.
 *
 * Every consumer of `/vault/raw` in the app goes through this file, so the credential question is answered
 * in ONE place: on loopback these resolve to the plain raw URL (byte-identical to before), and on a remote
 * origin they fetch the bytes with the gateway token `withGatewayAuth` attaches and hand back a URL the
 * browser can load — an object URL (revoked when the component unmounts or the path changes) for every type
 * that is safe to carry on the app's own origin, and a `data:` URL for the scriptable image types that are
 * not. `lib/vaultAsset.ts`'s `viewSource` is the single place that decides which.
 */

/** A `data:` URL for these bytes, carrying the blob's own type. Used only where a same-origin object URL
 *  would be a scriptable document (`viewSource`); unlike an object URL there is no handle to revoke. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the asset"));
    reader.readAsDataURL(blob);
  });
}

type AssetState =
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null; message: string };

/**
 * Resolve a vault path to something a browser can load, via `viewSource` — a renderable object URL for
 * `<img>`/`<object>`, or a `data:` URL for the scriptable image types that must not get one.
 *
 * (There is no `"download"` purpose here: `VaultDownloadLink` below mints its own inert
 * `application/octet-stream` blob directly rather than going through this hook — a download is a one-shot
 * action on click, not a reactive resource a render needs to hold, fetch on mount, and revoke on unmount.)
 *
 * On a `direct` mode (loopback) this never fetches at all — it resolves synchronously to the raw URL on the
 * first render, so the loopback path keeps the browser's own streaming/range-request behaviour.
 */
export function useVaultAsset(projectId: string, path: string, purpose: "view" = "view"): AssetState {
  const mode = vaultAssetMode(isRemoteOrigin());
  const direct = mode === "direct" ? api.vaultRawUrl(projectId, path) : null;
  const [state, setState] = useState<AssetState>(
    direct ? { status: "ready", url: direct } : { status: "loading", url: null },
  );
  // The object URL this hook currently owns, so the cleanup below revokes exactly what it minted (and
  // never the `direct` URL, which is not an object URL and must not be revoked).
  const owned = useRef<string | null>(null);

  useEffect(() => {
    if (mode === "direct") {
      setState({ status: "ready", url: api.vaultRawUrl(projectId, path) });
      return;
    }
    let live = true;
    setState({ status: "loading", url: null });
    void api.vaultRawBlob(projectId, path)
      .then(async ({ blob, contentType }) => {
        const source = viewSource(contentType);
        const typed = new Blob([blob], { type: source.type });
        if (source.kind === "data") {
          // A `data:` URL rather than a same-origin object URL, because these bytes ARE a scriptable
          // document when navigated to — see lib/vaultAsset.ts's `viewSource`. There is nothing to own or
          // revoke: a data: URL is a value, not a handle into this document.
          const url = await blobToDataUrl(typed);
          if (!live) return;
          setState({ status: "ready", url });
          return;
        }
        const url = URL.createObjectURL(typed);
        // The effect may have been torn down while the fetch was in flight — mint-then-revoke immediately
        // rather than leaking the URL for the lifetime of the document.
        if (!live) { URL.revokeObjectURL(url); return; }
        owned.current = url;
        setState({ status: "ready", url });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({ status: "error", url: null, message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
      if (owned.current) { URL.revokeObjectURL(owned.current); owned.current = null; }
    };
  }, [mode, projectId, path]);

  return state;
}

/** An `<img>` pointed at a vault asset, authenticated on a remote origin. A failed load renders a quiet
 *  inline note rather than the browser's broken-image glyph. */
export function VaultImage({ projectId, path, alt, className, style }: {
  projectId: string; path: string; alt: string; className?: string; style?: CSSProperties;
}) {
  const asset = useVaultAsset(projectId, path, "view");
  if (asset.status === "error") {
    return <span className="md-broken" title={asset.message} style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>{alt || assetFileName(path)}</span>;
  }
  if (asset.status === "loading") return <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>…</span>;
  return <img className={className} src={asset.url} alt={alt} style={style} loading="lazy" />;
}

/**
 * "Download file". On loopback this is the same plain `<a download>` as before — the browser streams it
 * straight to disk. On a remote origin the bytes have to be fetched with the credential first, so the
 * blob is fetched on demand (never eagerly — a binary can be 50 MB and the card renders long before anyone
 * clicks) and a synthetic anchor saves it before the object URL is revoked.
 *
 * @decision f7525818 — on a remote origin this is a `<button>`, never an `<a>` with its click intercepted:
 * an intercepted `href` still loads credential-less on a middle-click / ⌘-click / "open in new tab" / a
 * same-tick second click, and `download=` then saves the 401 JSON body under the real file's name.
 */
export function VaultDownloadLink({ projectId, path, children, style }: {
  projectId: string; path: string; children: React.ReactNode; style?: CSSProperties;
}) {
  const name = assetFileName(path);
  const needsFetch = vaultAssetMode(isRemoteOrigin()) === "blob";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A REF, not the `busy` state, guards re-entry: `setBusy(true)` does not take effect until React
  // re-renders, so two clicks in one tick both read `busy === false` and would both fetch 50 MB and save
  // the file twice. A ref is updated synchronously, so the second click sees it.
  const inFlight = useRef(false);

  const save = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void api.vaultRawBlob(projectId, path)
      .then(({ blob }) => {
        // Always the inert type, never the response's own — see lib/vaultAsset.ts's DOWNLOAD_BLOB_TYPE.
        const url = URL.createObjectURL(new Blob([blob], { type: DOWNLOAD_BLOB_TYPE }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // The save is already queued by the time click() returns; revoking on the next frame keeps the
        // URL alive long enough for the browser to read it without leaking it for the document's life.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };

  const shared: CSSProperties = {
    display: "inline-block", textDecoration: "none", color: color.phosphor,
    border: `1px solid ${color.phosphor}`, borderRadius: radius.base, padding: "6px 14px",
    fontFamily: font.mono, fontSize: 12, ...style,
  };

  return (
    <>
      {needsFetch ? (
        <button type="button" onClick={save} disabled={busy} aria-busy={busy} className="loom-btn loom-btn-primary"
          style={{ ...shared, background: "transparent", cursor: busy ? "progress" : "pointer" }}>
          {busy ? "Preparing…" : children}
        </button>
      ) : (
        <a href={api.vaultRawUrl(projectId, path)} download={name} className="loom-btn loom-btn-primary" style={shared}>
          {children}
        </a>
      )}
      {error && <div style={{ marginTop: 8, fontFamily: font.mono, fontSize: 11.5, color: color.red, wordBreak: "break-word" }}>{error}</div>}
    </>
  );
}
