use std::sync::Arc;

mod backend_pack;
mod ipc;
mod paths;
mod sidecar;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let sidecar = Arc::new(sidecar::Sidecar::new());
    let backend = Arc::new(backend_pack::BackendManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sidecar.clone())
        .manage(backend.clone())
        .invoke_handler(tauri::generate_handler![
            ipc::backend::host_info,
            ipc::backend::backend_status,
            ipc::backend::install_backend_pack,
            ipc::backend::uninstall_backend_pack,
            ipc::backend::install_model_deps,
            ipc::files::save_voice_recording,
            ipc::files::export_audio,
            ipc::sidecar_cmd::start_sidecar,
            ipc::sidecar_cmd::stop_sidecar,
            ipc::sidecar_cmd::sidecar_status,
            ipc::sidecar_cmd::rpc_call,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
