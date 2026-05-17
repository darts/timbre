//! Manages the long-running Python sidecar process.
//!
//! IPC is LSP-style length-prefixed JSON-RPC 2.0 over stdio:
//!
//!     Content-Length: <N>\r\n
//!     \r\n
//!     <N bytes of JSON>
//!
//! - The Rust side sends `request` objects (with an `id`) and awaits a
//!   matching `response`.
//! - The sidecar may emit unsolicited `notification` objects (no `id`),
//!   which we forward to the frontend as Tauri events.
//!
//! A single tokio task owns stdin (writes); a second owns stdout (reads).
//! Pending requests live in a Mutex<HashMap<id, oneshot::Sender<...>>>.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::paths;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidecarStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RpcErrorPayload {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Default)]
struct Pending {
    map: HashMap<u64, oneshot::Sender<Result<Value, RpcErrorPayload>>>,
}

pub struct Sidecar {
    inner: Mutex<Option<SidecarHandle>>,
    next_id: AtomicU64,
    next_launch_id: AtomicU64,
    pending: Arc<Mutex<Pending>>,
}

struct SidecarHandle {
    child: Child,
    pid: Option<u32>,
    launch_id: u64,
    write_tx: mpsc::Sender<Vec<u8>>,
}

impl Sidecar {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            next_id: AtomicU64::new(1),
            next_launch_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(Pending::default())),
        }
    }

    pub async fn status(&self) -> SidecarStatus {
        let g = self.inner.lock().await;
        match &*g {
            Some(h) => SidecarStatus {
                running: true,
                pid: h.pid,
            },
            None => SidecarStatus {
                running: false,
                pid: None,
            },
        }
    }

    pub async fn start(self: Arc<Self>, app: AppHandle) -> Result<SidecarStatus> {
        // Keep this lock through spawn so concurrent `start_sidecar` calls
        // cannot launch competing children and then drop each other's pipes.
        let mut g = self.inner.lock().await;
        if let Some(h) = g.as_ref() {
            return Ok(SidecarStatus {
                running: true,
                pid: h.pid,
            });
        }

        let py = paths::venv_python();
        if !py.exists() {
            bail!("backend not installed: {}", py.display());
        }
        let module_dir = paths::sidecar_module_dir(&app)?;
        if !module_dir.exists() {
            bail!("sidecar module not found at {}", module_dir.display());
        }
        let manifest_path = paths::models_manifest(&app)?;
        let cache_root = paths::cache_dir();
        let numba_cache = cache_root.join("numba");
        std::fs::create_dir_all(&numba_cache).ok();

        let mut cmd = tokio::process::Command::new(&py);
        cmd.arg("-u")
            .arg("-m")
            .arg("timbre")
            .env("PYTHONPATH", &module_dir)
            .env("TIMBRE_DATA_DIR", paths::data_dir())
            .env("TIMBRE_CACHE_DIR", &cache_root)
            .env("TIMBRE_MANIFEST", &manifest_path)
            .env("NUMBA_CACHE_DIR", numba_cache)
            // Allow PyTorch's built-in MPS kernel fallback from the first
            // import. The Python sidecar also has explicit CPU retry policy
            // for selected accelerator failures.
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // No `windows_subsystem = "console"` parent in release means any
        // console-subsystem child (python.exe) pops its own window unless
        // CREATE_NO_WINDOW (0x08000000) is set.
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn {}", py.display()))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take();

        let launch_id = self.next_launch_id.fetch_add(1, Ordering::SeqCst);
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(64);
        spawn_writer(stdin, write_rx);
        spawn_reader(
            stdout,
            app.clone(),
            self.pending.clone(),
            self.clone(),
            launch_id,
        );
        if let Some(err) = stderr {
            spawn_stderr_logger(err, app.clone());
        }

        *g = Some(SidecarHandle {
            child,
            pid,
            launch_id,
            write_tx,
        });
        Ok(SidecarStatus { running: true, pid })
    }

    pub async fn stop(&self) -> Result<()> {
        // Try a graceful shutdown first; fall back to kill if unresponsive.
        let _ = self.call("shutdown", json!({})).await;
        let mut g = self.inner.lock().await;
        if let Some(mut h) = g.take() {
            let _ = h.child.kill().await;
        }
        Ok(())
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcErrorPayload> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body = serde_json::to_vec(&req).map_err(|e| RpcErrorPayload {
            code: -32700,
            message: format!("encode: {e}"),
            data: None,
        })?;
        let frame = framed(&body);

        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().await;
            p.map.insert(id, tx);
        }

        let send_res = {
            let g = self.inner.lock().await;
            match &*g {
                Some(h) => h.write_tx.send(frame).await.map_err(|e| e.to_string()),
                None => Err("sidecar not running".to_string()),
            }
        };
        if let Err(e) = send_res {
            let mut p = self.pending.lock().await;
            p.map.remove(&id);
            return Err(RpcErrorPayload {
                code: -32000,
                message: e,
                data: None,
            });
        }

        rx.await.unwrap_or(Err(RpcErrorPayload {
            code: -32001,
            message: "sidecar dropped before reply".into(),
            data: None,
        }))
    }
}

fn framed(body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}

fn spawn_writer(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = stdin.write_all(&msg).await {
                tracing::error!("sidecar stdin write: {e}");
                return;
            }
            let _ = stdin.flush().await;
        }
    });
}

fn spawn_reader(
    stdout: ChildStdout,
    app: AppHandle,
    pending: Arc<Mutex<Pending>>,
    sidecar: Arc<Sidecar>,
    launch_id: u64,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let exit_reason = loop {
            match read_one_frame(&mut reader).await {
                Ok(Some(payload)) => handle_inbound(payload, &app, &pending).await,
                Ok(None) => break "stdout EOF".to_string(),
                Err(FrameError::Recoverable(e)) => {
                    // Stray text on stdout (a stray print, tqdm bar, etc.).
                    // Drop the rest of the bogus "header block" and keep
                    // reading. The Python side quarantines stdout, so this
                    // really shouldn't fire in practice.
                    tracing::warn!("sidecar framing skipped: {e}");
                    continue;
                }
                Err(FrameError::Fatal(e)) => break format!("read error: {e}"),
            }
        };
        tracing::info!("sidecar reader exiting: {exit_reason}");
        // Sidecar is gone (process died, panicked, or was killed). Drop
        // the handle so the next `call()` or `start()` triggers a fresh
        // spawn instead of writing into a broken pipe forever. Also fail
        // any pending requests so the UI sees a clean error rather than
        // hanging. A reader from an older launch may exit after a newer
        // process is current, so only the current launch owns teardown.
        let mut cleared_current = false;
        {
            let mut g = sidecar.inner.lock().await;
            if g.as_ref().is_some_and(|h| h.launch_id == launch_id) {
                *g = None;
                cleared_current = true;
            }
        }
        if cleared_current {
            let mut p = pending.lock().await;
            for (_, tx) in p.map.drain() {
                let _ = tx.send(Err(RpcErrorPayload {
                    code: -32002,
                    message: format!("sidecar exited: {exit_reason}"),
                    data: None,
                }));
            }
            let _ = app.emit("sidecar:died", &exit_reason);
        }
    });
}

#[derive(Debug)]
enum FrameError {
    Recoverable(String),
    Fatal(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for FrameError {
    fn from(e: E) -> Self {
        FrameError::Fatal(e.into())
    }
}

async fn read_one_frame(reader: &mut BufReader<ChildStdout>) -> Result<Option<Value>, FrameError> {
    let mut content_length: Option<usize> = None;
    let mut header = Vec::new();
    loop {
        header.clear();
        let n = read_until(reader, b'\n', &mut header)
            .await
            .map_err(|e| FrameError::Fatal(e.into()))?;
        if n == 0 {
            // Clean EOF on a header boundary — sidecar exited.
            return Ok(None);
        }
        let line = String::from_utf8_lossy(&header);
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = match v.trim().parse() {
                    Ok(n) => Some(n),
                    Err(_) => {
                        return Err(FrameError::Recoverable(format!(
                            "bad Content-Length value: {trimmed}"
                        )))
                    }
                };
            }
        }
    }
    let len = content_length.ok_or_else(|| {
        FrameError::Recoverable("header block without Content-Length — stray stdout?".into())
    })?;
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|e| FrameError::Fatal(e.into()))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| FrameError::Recoverable(format!("json parse: {e}")))
}

async fn read_until(
    reader: &mut BufReader<ChildStdout>,
    delim: u8,
    buf: &mut Vec<u8>,
) -> Result<usize> {
    let mut total = 0;
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return Ok(total);
        }
        total += 1;
        buf.push(byte[0]);
        if byte[0] == delim {
            return Ok(total);
        }
    }
}

async fn handle_inbound(payload: Value, app: &AppHandle, pending: &Arc<Mutex<Pending>>) {
    if let Some(id_val) = payload.get("id") {
        // Response to an outgoing request.
        let id = match id_val.as_u64() {
            Some(n) => n,
            None => {
                tracing::warn!("response with non-numeric id: {id_val}");
                return;
            }
        };
        let mut p = pending.lock().await;
        if let Some(tx) = p.map.remove(&id) {
            if let Some(err) = payload.get("error") {
                let payload: RpcErrorPayload =
                    serde_json::from_value(err.clone()).unwrap_or(RpcErrorPayload {
                        code: -32603,
                        message: "malformed error".into(),
                        data: None,
                    });
                let _ = tx.send(Err(payload));
            } else {
                let result = payload.get("result").cloned().unwrap_or(Value::Null);
                let _ = tx.send(Ok(result));
            }
        }
        return;
    }

    // Notification: forward to the frontend.
    let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let _ = app.emit(&format!("sidecar:{method}"), params);
}

fn spawn_stderr_logger(err: tokio::process::ChildStderr, app: AppHandle) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(err);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let mut line = [0u8; 1];
            loop {
                match reader.read(&mut line).await {
                    Ok(0) => return,
                    Ok(_) => {
                        buf.push(line[0]);
                        if line[0] == b'\n' {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::error!("sidecar stderr: {e}");
                        return;
                    }
                }
            }
            let s = String::from_utf8_lossy(&buf).trim_end().to_string();
            if !s.is_empty() {
                tracing::info!(target: "sidecar.stderr", "{s}");
                let _ = app.emit("sidecar:log", &s);
            }
        }
    });
}
