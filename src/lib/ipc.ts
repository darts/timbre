import { invoke } from "@tauri-apps/api/core";

export type BackendKind = "cpu" | "cuda" | "mps";

export interface BackendStatus {
  installed: boolean;
  backend: BackendKind | null;
  python_path: string | null;
  venv_path: string | null;
}

export interface SidecarStatus {
  running: boolean;
  pid: number | null;
}

export interface HostInfo {
  os: string;
  arch: string;
  is_macos: boolean;
  is_windows: boolean;
  is_apple_silicon: boolean;
}

export const tauri = {
  hostInfo: () => invoke<HostInfo>("host_info"),
  backendStatus: () => invoke<BackendStatus>("backend_status"),
  installBackendPack: (backend: BackendKind) =>
    invoke<BackendStatus>("install_backend_pack", { backend }),
  uninstallBackendPack: () => invoke<BackendStatus>("uninstall_backend_pack"),
  startSidecar: () => invoke<SidecarStatus>("start_sidecar"),
  stopSidecar: () => invoke<void>("stop_sidecar"),
  sidecarStatus: () => invoke<SidecarStatus>("sidecar_status"),
  installModelDeps: (modelId: string, adapter: string) =>
    invoke<void>("install_model_deps", { modelId, adapter }),
  saveVoiceRecording: (wavBytes: number[]) =>
    invoke<string>("save_voice_recording", { wavBytes }),
  exportAudio: (sourcePath: string, destinationPath: string) =>
    invoke<void>("export_audio", { sourcePath, destinationPath }),
  rpc: <T>(method: string, params?: Record<string, unknown>) =>
    invoke<T>("rpc_call", { method, params: params ?? null }),
};
