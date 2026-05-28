//! First-run backend installer.
//!
//! Steps for a chosen `Backend` (cpu / cuda / mps / rocm):
//!   1. Detect platform (macos-arm64, macos-x86_64, windows-x86_64, linux-x86_64).
//!   2. Download python-build-standalone tarball -> extract to <data>/python.
//!   3. Download uv -> place in <data>/bin/uv.
//!   4. uv venv <data>/venv --python <data>/python/python3
//!   5. uv pip install -r requirements/{backend}.txt --index-url <pytorch index>
//!   6. uv pip install -r requirements/base.txt
//!
//! ROCm is Linux- or Windows-only; on macOS the install() guard rejects it
//! since PyTorch ships no macOS ROCm wheels. The ROCm requirements file +
//! torch index URL both branch on the host OS at compile time.
//!
//! Progress is reported via a `BackendProgress` channel that the IPC layer
//! converts into Tauri events.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::paths;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Cpu,
    Cuda,
    Mps,
    Rocm,
}

impl Backend {
    pub fn requirements_filename(self) -> &'static str {
        match self {
            Backend::Cpu => "cpu.txt",
            Backend::Cuda => "cuda.txt",
            Backend::Mps => "mps.txt",
            // ROCm wheels diverge by host OS — Linux uses stable rocm6.4, Windows
            // uses the preview nightly index — so the requirements file (which
            // also pins torch version) is platform-specific.
            Backend::Rocm => {
                if cfg!(target_os = "windows") {
                    "rocm-windows.txt"
                } else {
                    "rocm-linux.txt"
                }
            }
        }
    }

    /// PyTorch wheel index URL. `None` means no `--index-url` flag is passed
    /// to `uv pip install`; uv falls back to the default PyPI index for any
    /// transitive deps the requirements file declares.
    ///
    /// Notable Nones:
    /// - `Mps`: macOS arm64 torch wheels are on the default PyPI index already.
    /// - `Rocm` on Windows: PyTorch's `whl/rocm6.X` and `whl/nightly/rocm6.X`
    ///   indexes are Linux-only. AMD distributes Windows ROCm wheels at
    ///   literal URLs in `rocm-windows.txt`; pointing uv at the PyTorch ROCm
    ///   index would resolve to Linux wheels and break the install.
    pub fn torch_index_url(self) -> Option<&'static str> {
        match self {
            Backend::Cpu => Some("https://download.pytorch.org/whl/cpu"),
            Backend::Cuda => Some("https://download.pytorch.org/whl/cu128"),
            Backend::Mps => None,
            Backend::Rocm => {
                if cfg!(target_os = "windows") {
                    None
                } else {
                    Some("https://download.pytorch.org/whl/rocm6.4")
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackendStatus {
    pub installed: bool,
    pub backend: Option<Backend>,
    pub python_path: Option<PathBuf>,
    pub venv_path: Option<PathBuf>,
}

const STATE_FILE: &str = "backend.state.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct State {
    backend: Option<Backend>,
}

pub struct BackendManager {
    /// Lock to serialize install / uninstall — concurrent installs would
    /// fight over the same venv directory and corrupt it.
    install_lock: Mutex<()>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self {
            install_lock: Mutex::new(()),
        }
    }

    pub fn status(&self) -> BackendStatus {
        let state = read_state().unwrap_or_default();
        let py = paths::venv_python();
        let installed = py.exists() && state.backend.is_some();
        BackendStatus {
            installed,
            backend: state.backend,
            python_path: installed.then(|| py),
            venv_path: installed.then(|| paths::venv_dir()),
        }
    }

    pub async fn install(self: Arc<Self>, app: AppHandle, backend: Backend) -> Result<()> {
        let _g = self.install_lock.lock().await;
        if backend == Backend::Rocm && cfg!(target_os = "macos") {
            bail!("ROCm backend is not supported on macOS — pick MPS or CPU");
        }
        emit_progress(&app, "starting", 0.0, format!("installing {:?}", backend));

        let urls = load_urls(&app)?;
        let plat = current_platform()?;
        let plat_urls = urls
            .get("platforms")
            .and_then(|v| v.get(plat))
            .ok_or_else(|| anyhow!("no urls for platform {plat}"))?;
        let py_entry = plat_urls
            .get("python")
            .ok_or_else(|| anyhow!("missing python manifest entry"))?;
        let py_url = py_entry
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing python url"))?;
        let py_sha256 = py_entry
            .get("sha256")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let uv_entry = plat_urls
            .get("uv")
            .ok_or_else(|| anyhow!("missing uv manifest entry"))?;
        let uv_url = uv_entry
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing uv url"))?;
        let uv_sha256 = uv_entry
            .get("sha256")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        // 1. Python interpreter
        emit_progress(&app, "download_python", 0.05, "downloading Python".into());
        let py_dl = paths::data_dir().join("downloads").join("python.tar.gz");
        download_file(
            &app,
            py_url,
            py_sha256,
            &py_dl,
            "download_python",
            0.05,
            0.30,
        )
        .await?;
        emit_progress(&app, "extract_python", 0.30, "extracting Python".into());
        extract_archive(&py_dl, &paths::python_dir())?;

        // 2. uv. Astral wraps the binary in a `uv-{triple}/` directory inside
        //    the archive, so we extract to a scratch dir and then locate the
        //    binary so it ends up at `data_dir/bin/uv` regardless.
        emit_progress(&app, "download_uv", 0.40, "downloading uv".into());
        let uv_dl_name = if uv_url.ends_with(".zip") {
            "uv.zip"
        } else {
            "uv.tar.gz"
        };
        let uv_dl = paths::data_dir().join("downloads").join(uv_dl_name);
        download_file(&app, uv_url, uv_sha256, &uv_dl, "download_uv", 0.40, 0.50).await?;
        emit_progress(&app, "extract_uv", 0.50, "extracting uv".into());
        let uv_extract = paths::data_dir().join("downloads").join("uv-extract");
        if uv_extract.exists() {
            fs::remove_dir_all(&uv_extract).ok();
        }
        extract_archive(&uv_dl, &uv_extract)?;
        install_uv_from(&uv_extract)?;
        ensure_executable(&paths::uv_path())?;

        // 3. venv + dep install
        emit_progress(&app, "create_venv", 0.55, "creating venv".into());
        let py_exe = paths::python_executable();
        if !py_exe.exists() {
            bail!("expected python at {} after extract", py_exe.display());
        }
        run_uv(&[
            "venv",
            paths::venv_dir().to_string_lossy().as_ref(),
            "--python",
            py_exe.to_string_lossy().as_ref(),
        ])
        .await?;

        emit_progress(&app, "install_torch", 0.65, "installing torch".into());
        install_torch(&app, backend).await?;

        emit_progress(&app, "install_base", 0.85, "installing common deps".into());
        install_base(&app).await?;

        write_state(&State {
            backend: Some(backend),
        })?;
        emit_progress(&app, "done", 1.0, "backend ready".into());
        Ok(())
    }

    pub async fn uninstall(self: Arc<Self>) -> Result<()> {
        let _g = self.install_lock.lock().await;
        let venv = paths::venv_dir();
        if venv.exists() {
            fs::remove_dir_all(&venv).ok();
            fs::create_dir_all(&venv).ok();
        }
        write_state(&State::default())?;
        Ok(())
    }

    /// Install the per-adapter requirements (e.g. `qwen-tts`) into the
    /// existing venv. Emits a `model:deps_progress` event with `model_id`,
    /// `stage`, and `message` so the UI can show a per-card spinner.
    pub async fn install_adapter_deps(
        self: Arc<Self>,
        app: AppHandle,
        model_id: String,
        adapter: String,
    ) -> Result<()> {
        // Block while a backend pack install is in flight, since they share
        // the venv and would race over it.
        let _g = self.install_lock.lock().await;
        if !paths::venv_python().exists() {
            bail!("backend not installed");
        }
        let req_name = format!("{adapter}.txt");
        let req = paths::requirements_file(&app, &req_name)
            .with_context(|| format!("requirements file for adapter '{adapter}'"))?;
        if !req.exists() {
            bail!("no requirements file at {}", req.display());
        }

        let venv_python = paths::venv_python();
        if adapter == "chatterbox" {
            emit_model_deps(&app, &model_id, "installing", "installing chatterbox package");
            run_uv(&[
                "pip",
                "install",
                "--python",
                venv_python.to_string_lossy().as_ref(),
                "chatterbox-tts==0.1.7",
                "--no-deps",
            ])
            .await
            .context("install chatterbox-tts without torch dependency overrides")?;
        }

        emit_model_deps(&app, &model_id, "installing", "installing pip dependencies");
        run_uv(&[
            "pip",
            "install",
            "--python",
            venv_python.to_string_lossy().as_ref(),
            "-r",
            req.to_string_lossy().as_ref(),
        ])
        .await
        .with_context(|| format!("install adapter '{adapter}' deps"))?;

        emit_model_deps(&app, &model_id, "ready", "deps installed");
        Ok(())
    }
}

fn emit_model_deps(app: &AppHandle, model_id: &str, stage: &str, message: &str) {
    let _ = app.emit(
        "model:deps_progress",
        serde_json::json!({
            "model_id": model_id,
            "stage": stage,
            "message": message,
        }),
    );
}

fn emit_progress(app: &AppHandle, stage: &str, fraction: f64, message: String) {
    let _ = app.emit(
        "backend:progress",
        serde_json::json!({ "stage": stage, "fraction": fraction, "message": message }),
    );
}

fn current_platform() -> Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        (os, arch) => bail!("unsupported platform: {os}/{arch}"),
    })
}

fn load_urls(app: &AppHandle) -> Result<serde_json::Value> {
    let path = paths::python_urls_manifest(app)?;
    let txt = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    Ok(serde_json::from_str(&txt)?)
}

async fn download_file(
    app: &AppHandle,
    url: &str,
    expected_sha256: Option<&str>,
    dst: &Path,
    stage: &str,
    base: f64,
    span: f64,
) -> Result<()> {
    fs::create_dir_all(dst.parent().unwrap_or(Path::new(".")))?;
    let resp = reqwest::get(url).await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dst).await?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut hasher = expected_sha256.map(|_| Sha256::new());
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        if let Some(h) = hasher.as_mut() {
            h.update(&bytes);
        }
        received += bytes.len() as u64;
        if total > 0 {
            let f = base + span * (received as f64 / total as f64);
            emit_progress(
                app,
                stage,
                f.min(base + span),
                format!("{} / {} bytes", received, total),
            );
        }
    }
    file.flush().await?;
    if let (Some(expected), Some(h)) = (expected_sha256, hasher) {
        let actual = hex::encode(h.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            bail!("sha256 mismatch for {url}: expected {expected}, got {actual}");
        }
    }
    Ok(())
}

fn extract_archive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let f = fs::File::open(src)?;
        let gz = flate2::read::GzDecoder::new(f);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(dst).context("untar")?;
    } else if name.ends_with(".zip") {
        let f = fs::File::open(src)?;
        let mut zip = zip::ZipArchive::new(f)?;
        zip.extract(dst).context("unzip")?;
    } else {
        bail!("unknown archive format: {}", src.display());
    }
    Ok(())
}

/// Find `uv` (and `uvx` if present) anywhere under `extracted_root` and
/// copy them next to each other in the project's `bin/` dir. We can't rely
/// on the archive layout staying the same across releases — astral ships
/// the binaries inside a `uv-{triple}/` wrapper today, but flatten just in
/// case that changes.
fn install_uv_from(extracted_root: &Path) -> Result<()> {
    let bin_dir = paths::data_dir().join("bin");
    fs::create_dir_all(&bin_dir)?;
    let uv_name = if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    };
    let uvx_name = if cfg!(target_os = "windows") {
        "uvx.exe"
    } else {
        "uvx"
    };
    let uv_src = find_file(extracted_root, uv_name, 4)?
        .ok_or_else(|| anyhow!("did not find {uv_name} under {}", extracted_root.display()))?;
    fs::copy(&uv_src, bin_dir.join(uv_name))
        .with_context(|| format!("install uv from {}", uv_src.display()))?;
    if let Some(uvx_src) = find_file(extracted_root, uvx_name, 4)? {
        fs::copy(&uvx_src, bin_dir.join(uvx_name)).ok();
    }
    Ok(())
}

fn find_file(root: &Path, name: &str, max_depth: usize) -> Result<Option<PathBuf>> {
    fn walk(dir: &Path, name: &str, depth: usize, max: usize) -> Result<Option<PathBuf>> {
        if depth > max {
            return Ok(None);
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let ftype = entry.file_type()?;
            let path = entry.path();
            if ftype.is_dir() {
                if let Some(hit) = walk(&path, name, depth + 1, max)? {
                    return Ok(Some(hit));
                }
            } else if entry.file_name() == name {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }
    walk(root, name, 0, max_depth)
}

#[cfg(unix)]
fn ensure_executable(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if !p.exists() {
        return Ok(());
    }
    let mut perms = fs::metadata(p)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(p, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_p: &Path) -> Result<()> {
    Ok(())
}

async fn run_uv(args: &[&str]) -> Result<()> {
    let uv = paths::uv_path();
    if !uv.exists() {
        bail!("uv binary missing at {}", uv.display());
    }
    let mut cmd = Command::new(&uv);
    cmd.args(args);
    // Hide the console window every short-lived uv invocation would
    // otherwise allocate (release Windows builds have no parent console).
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .output()
        .await
        .with_context(|| format!("spawn uv {:?}", args))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let tail = stderr.lines().rev().take(8).collect::<Vec<_>>();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        bail!("uv {:?} failed ({}):\n{}", args, output.status, tail);
    }
    Ok(())
}

async fn install_torch(app: &AppHandle, backend: Backend) -> Result<()> {
    let req = req_path(app, backend.requirements_filename())?;
    let venv_python = paths::venv_python();
    let mut args: Vec<String> = vec![
        "pip".into(),
        "install".into(),
        "--python".into(),
        venv_python.to_string_lossy().into(),
        "-r".into(),
        req.to_string_lossy().into(),
    ];
    if let Some(idx) = backend.torch_index_url() {
        args.push("--index-url".into());
        args.push(idx.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_uv(&arg_refs).await
}

async fn install_base(app: &AppHandle) -> Result<()> {
    let req = req_path(app, "base.txt")?;
    let venv_python = paths::venv_python();
    run_uv(&[
        "pip",
        "install",
        "--python",
        venv_python.to_string_lossy().as_ref(),
        "-r",
        req.to_string_lossy().as_ref(),
    ])
    .await
}

fn req_path(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let p = paths::requirements_file(app, name)?;
    if !p.exists() {
        bail!("requirements file not found: {}", p.display());
    }
    Ok(p)
}

fn state_path() -> PathBuf {
    paths::data_dir().join(STATE_FILE)
}

fn read_state() -> Result<State> {
    let p = state_path();
    if !p.exists() {
        return Ok(State::default());
    }
    let txt = fs::read_to_string(&p)?;
    Ok(serde_json::from_str(&txt)?)
}

fn write_state(s: &State) -> Result<()> {
    let p = state_path();
    fs::create_dir_all(p.parent().unwrap())?;
    fs::write(&p, serde_json::to_string_pretty(s)?)?;
    Ok(())
}
