use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::sidecar::{RpcErrorPayload, Sidecar, SidecarStatus};

#[tauri::command]
pub async fn start_sidecar(
    app: AppHandle,
    sidecar: State<'_, Arc<Sidecar>>,
) -> Result<SidecarStatus, String> {
    sidecar
        .inner()
        .clone()
        .start(app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_sidecar(sidecar: State<'_, Arc<Sidecar>>) -> Result<(), String> {
    sidecar.stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sidecar_status(sidecar: State<'_, Arc<Sidecar>>) -> Result<SidecarStatus, String> {
    Ok(sidecar.status().await)
}

/// Generic JSON-RPC pass-through. The frontend addresses any sidecar method
/// by name; results and errors round-trip as JSON.
#[tauri::command]
pub async fn rpc_call(
    sidecar: State<'_, Arc<Sidecar>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcErrorPayload> {
    sidecar.call(&method, params.unwrap_or(Value::Null)).await
}
