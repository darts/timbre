import { useCallback, useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { tauri } from "@/lib/ipc";

/** Hook that ensures the sidecar is running and lets components subscribe to
 *  notification events emitted by the Python sidecar. */
export function useSidecar() {
  const startedRef = useRef(false);

  const ensureRunning = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    try {
      const status = await tauri.sidecarStatus();
      if (!status.running) await tauri.startSidecar();
    } catch (e) {
      console.error("sidecar start failed", e);
      startedRef.current = false;
    }
  }, []);

  // If the sidecar dies (model OOM, MPS crash, manual kill), clear the
  // "already started" flag so the next ensureRunning() will respawn it.
  useEffect(() => {
    let off: UnlistenFn | undefined;
    listen<string>("sidecar:died", () => {
      console.warn("sidecar died, will respawn on next call");
      startedRef.current = false;
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  return { ensureRunning };
}

/** Subscribe to a sidecar notification (e.g. "synth.chunk_ready"). */
export function useSidecarEvent<T = unknown>(
  method: string,
  handler: (payload: T) => void,
) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    (async () => {
      unlisten = await listen<T>(`sidecar:${method}`, (e) => handler(e.payload));
    })();
    return () => unlisten?.();
  }, [method, handler]);
}

/** Convert a filesystem path returned by the sidecar into something that the
 *  webview can play. Tauri's `convertFileSrc` handles URL escaping and the
 *  asset protocol. */
export function fileSrc(path: string): string {
  return convertFileSrc(path);
}
