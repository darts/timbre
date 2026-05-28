use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::backend_pack::{Backend, BackendManager, BackendStatus};

#[derive(serde::Serialize)]
pub struct HostInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub is_macos: bool,
    pub is_windows: bool,
    pub is_linux: bool,
    pub is_apple_silicon: bool,
}

#[tauri::command]
pub fn host_info() -> HostInfo {
    HostInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        is_macos: cfg!(target_os = "macos"),
        is_windows: cfg!(target_os = "windows"),
        is_linux: cfg!(target_os = "linux"),
        is_apple_silicon: cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"),
    }
}

/// Probe for NVIDIA / AMD GPUs so FirstRun can recommend a backend pack.
/// Runs before the venv exists, so this is OS-level detection (see `crate::gpu`).
/// Returns `{ has_nvidia, has_amd, probed }`; `probed: false` means we couldn't
/// tell, and the UI falls back to showing every applicable backend.
#[tauri::command]
pub fn detect_backends() -> crate::gpu::GpuVendors {
    crate::gpu::detect()
}

#[tauri::command]
pub fn backend_status(mgr: State<'_, Arc<BackendManager>>) -> BackendStatus {
    mgr.status()
}

#[tauri::command]
pub async fn install_backend_pack(
    app: AppHandle,
    mgr: State<'_, Arc<BackendManager>>,
    backend: Backend,
) -> Result<BackendStatus, String> {
    let mgr = mgr.inner().clone();
    mgr.clone()
        .install(app, backend)
        .await
        .map_err(|e| e.to_string())?;
    Ok(mgr.status())
}

#[tauri::command]
pub async fn install_model_deps(
    app: AppHandle,
    mgr: State<'_, Arc<BackendManager>>,
    model_id: String,
    adapter: String,
) -> Result<(), String> {
    let mgr = mgr.inner().clone();
    mgr.install_adapter_deps(app, model_id, adapter)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_backend_pack(
    mgr: State<'_, Arc<BackendManager>>,
) -> Result<BackendStatus, String> {
    let mgr = mgr.inner().clone();
    mgr.clone().uninstall().await.map_err(|e| e.to_string())?;
    Ok(mgr.status())
}
