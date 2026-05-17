//! App-data path layout. Single source of truth for where everything lives
//! on the user's machine — keeps Rust and Python in agreement.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const APP_DIR_NAME: &str = "timbre";

pub fn data_dir() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .expect("home dir")
            .join("Library")
            .join("Application Support")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir().expect("config dir")
    } else {
        dirs::data_dir().expect("data dir")
    };
    let p = base.join(APP_DIR_NAME);
    std::fs::create_dir_all(&p).ok();
    p
}

pub fn cache_dir() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .expect("home dir")
            .join("Library")
            .join("Caches")
    } else {
        // Windows: %LOCALAPPDATA% (separate from Roaming data, survives
        // Storage Sense). Linux: $XDG_CACHE_HOME or ~/.cache.
        dirs::cache_dir().expect("cache dir")
    };
    let p = base.join(APP_DIR_NAME);
    std::fs::create_dir_all(&p).ok();
    p
}

pub fn python_dir() -> PathBuf {
    let p = data_dir().join("python");
    std::fs::create_dir_all(&p).ok();
    p
}

pub fn venv_dir() -> PathBuf {
    let p = data_dir().join("venv");
    std::fs::create_dir_all(&p).ok();
    p
}

pub fn uv_path() -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    };
    data_dir().join("bin").join(exe)
}

pub fn python_executable() -> PathBuf {
    let dir = python_dir().join("python");
    if cfg!(target_os = "windows") {
        dir.join("python.exe")
    } else {
        dir.join("bin").join("python3")
    }
}

pub fn venv_python() -> PathBuf {
    if cfg!(target_os = "windows") {
        venv_dir().join("Scripts").join("python.exe")
    } else {
        venv_dir().join("bin").join("python3")
    }
}

pub fn resource_path(app: &AppHandle, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let relative = relative.as_ref();

    // In debug builds, prefer the workspace source over the bundled
    // resource. Tauri only re-copies resources on full rebuilds, so during
    // dev iteration `target/debug/py/...` can lag the actual source files
    // — that's a footgun for sidecar code changes that don't seem to take
    // effect until the user manually rebuilds.
    if cfg!(debug_assertions) {
        if let Some(src) = source_dir_path(relative) {
            if src.exists() {
                return Ok(src);
            }
        }
    }

    let candidates = [
        app.path().resolve(relative, BaseDirectory::Resource).ok(),
        Some(PathBuf::from(relative)),
        Some(PathBuf::from("..").join(relative)),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(relative))),
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|d| d.join(relative))
        }),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .ok_or_else(|| anyhow!("resource not found: {}", relative.display()))
}

/// Resolve a path relative to the workspace source root in debug builds.
/// `CARGO_MANIFEST_DIR` is captured at compile time so this is a no-op in
/// release packages.
fn source_dir_path(relative: &Path) -> Option<PathBuf> {
    option_env!("CARGO_MANIFEST_DIR").map(|d| Path::new(d).join("..").join(relative))
}

pub fn sidecar_module_dir(app: &AppHandle) -> Result<PathBuf> {
    if let Ok(env) = std::env::var("TIMBRE_SIDECAR_DIR") {
        let p = PathBuf::from(env);
        if p.exists() {
            return Ok(p);
        }
        return Err(anyhow!(
            "TIMBRE_SIDECAR_DIR does not exist: {}",
            p.display()
        ));
    }
    resource_path(app, "py")
}

pub fn requirements_file(app: &AppHandle, name: &str) -> Result<PathBuf> {
    Ok(sidecar_module_dir(app)?.join("requirements").join(name))
}

pub fn python_urls_manifest(app: &AppHandle) -> Result<PathBuf> {
    resource_path(
        app,
        Path::new("resources").join("python-build-standalone.urls.json"),
    )
}

pub fn models_manifest(app: &AppHandle) -> Result<PathBuf> {
    resource_path(app, Path::new("resources").join("models.manifest.json"))
}
