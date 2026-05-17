use std::sync::Arc;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

mod backend_pack;
mod ipc;
mod paths;
mod sidecar;

pub fn run() {
    init_logging();

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

/// Send tracing output to stderr (for dev / terminal launches) and to a
/// daily-rotated file under the OS cache dir. The file sink is the only
/// way to see sidecar diagnostics in the release Windows build, which has
/// `windows_subsystem = "windows"` and therefore no attached console.
///
/// We deliberately leak the `WorkerGuard` so the non-blocking writer keeps
/// flushing for the lifetime of the process; dropping it would drop log
/// lines mid-shutdown.
fn init_logging() {
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
    };

    let log_dir = paths::cache_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "timbre.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(filter()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .with_ansi(false)
                .with_filter(filter()),
        )
        .init();

    tracing::info!(
        "timbre starting; log dir = {}",
        log_dir.display()
    );
}
