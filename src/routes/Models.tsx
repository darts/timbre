import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Download,
  HardDrive,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { tauri } from "@/lib/ipc";
import { useModels, useModelStatuses, useSynthRunningStatus } from "@/lib/queries";
import { GettingStarted, ModelInfo, ModelStatus } from "@/lib/schema";
import { useUiSettings } from "@/lib/settings";
import { cn, formatBytes } from "@/lib/utils";

interface DepsEvent {
  model_id: string;
  stage: "installing" | "ready";
  message: string;
}

interface DownloadEvent {
  model_id: string;
  phase?: Phase;
  message?: string;
  bytes?: number | null;
  total_bytes?: number | null;
  expected_bytes?: number | null;
  downloaded_bytes?: number | null;
  installed_bytes?: number | null;
  fraction?: number | null;
  bytes_per_second?: number | null;
  eta_seconds?: number | null;
  files_done?: number | null;
  files_total?: number | null;
  size_source?: string | null;
  error?: string;
}

type Phase = "idle" | "deps" | "resolving" | "weights" | "finalizing" | "ready" | "removing" | "removed" | "error";

interface InstallState {
  phase: Phase;
  message: string;
  bytes?: number;
  totalBytes?: number;
  expectedBytes?: number;
  downloadedBytes?: number;
  installedBytes?: number;
  fraction?: number | null;
  bytesPerSecond?: number;
  etaSeconds?: number;
  filesDone?: number;
  filesTotal?: number;
  sizeSource?: string;
  error?: string;
}

const initialState: InstallState = { phase: "idle", message: "" };

export function Models() {
  const { data: models } = useModels();
  const statuses = useModelStatuses({ refetchInterval: 4000 });
  const synthRunning = useSynthRunningStatus({ refetchInterval: 1000 });
  const studioModelId = useUiSettings((s) => s.studioModelId);
  const qc = useQueryClient();
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});
  const requestInProgress = synthRunning.data?.running ?? false;
  const activeModelId = useMemo(() => {
    if (!models?.length) return studioModelId;
    if (studioModelId && models.some((m) => m.id === studioModelId)) return studioModelId;
    return models.find((m) => m.is_default)?.id ?? models[0]?.id ?? "";
  }, [models, studioModelId]);

  const mergeDownloadState = useCallback((payloads: DownloadEvent[]) => {
    setInstalls((s) => {
      const next = { ...s };
      for (const payload of payloads) {
        const state = stateFromDownload(payload);
        if (state) next[payload.model_id] = state;
      }
      return next;
    });
  }, []);

  // Listen once for the two event channels and route by model_id.
  useEffect(() => {
    const offs: UnlistenFn[] = [];
    listen<DepsEvent>("model:deps_progress", (e) => {
      const { model_id, stage, message } = e.payload;
      setInstalls((s) => ({
        ...s,
        [model_id]: {
          ...(s[model_id] ?? initialState),
          phase: stage === "ready" ? "weights" : "deps",
          message,
        },
      }));
    }).then((u) => offs.push(u));

    listen<DownloadEvent>("sidecar:models.download.started", (e) => {
      const { model_id } = e.payload;
      setInstalls((s) => ({
        ...s,
        [model_id]: stateFromDownload(e.payload) ?? {
          ...(s[model_id] ?? initialState),
          phase: "weights",
          message: "downloading weights",
        },
      }));
    }).then((u) => offs.push(u));

    listen<DownloadEvent>("sidecar:models.download.progress", (e) => {
      const { model_id } = e.payload;
      setInstalls((s) => {
        // Don't downgrade out of `finalizing` once we've entered it.
        const prev = s[model_id] ?? initialState;
        if (prev.phase === "finalizing" || prev.phase === "ready") return s;
        const next = stateFromDownload(e.payload);
        return {
          ...s,
          [model_id]: next ? { ...prev, ...next, phase: "weights" } : prev,
        };
      });
    }).then((u) => offs.push(u));

    listen<DownloadEvent>("sidecar:models.download.finalizing", (e) => {
      const { model_id } = e.payload;
      setInstalls((s) => ({
        ...s,
        [model_id]: stateFromDownload(e.payload) ?? {
          ...(s[model_id] ?? initialState),
          phase: "finalizing",
          message: "finalising — linking files into the cache",
        },
      }));
    }).then((u) => offs.push(u));

    listen<DownloadEvent>("sidecar:models.download.complete", (e) => {
      const { model_id } = e.payload;
      const next = stateFromDownload(e.payload);
      setInstalls((s) => ({
        ...s,
        [model_id]: next
          ? { ...next, phase: "ready", message: "ready", fraction: 1 }
          : { phase: "ready", message: "ready", fraction: 1 },
      }));
      qc.invalidateQueries({ queryKey: ["model-statuses"] });
      qc.invalidateQueries({ queryKey: ["synth-history"] });
    }).then((u) => offs.push(u));

    listen<DownloadEvent>("sidecar:models.download.error", (e) => {
      const { model_id } = e.payload;
      setInstalls((s) => ({
        ...s,
        [model_id]: stateFromDownload(e.payload) ?? {
          phase: "error",
          message: "download failed",
          error: e.payload.error,
        },
      }));
    }).then((u) => offs.push(u));

    return () => offs.forEach((u) => u());
  }, [qc]);

  useEffect(() => {
    let cancelled = false;
    const refreshDownloadStatus = async () => {
      try {
        const payloads = await tauri.rpc<DownloadEvent[]>("models.download_status");
        if (!cancelled) mergeDownloadState(payloads);
      } catch {
        return;
      }
    };

    void refreshDownloadStatus();
    const id = window.setInterval(() => void refreshDownloadStatus(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mergeDownloadState]);

  const startInstall = useCallback(
    async (model: ModelInfo, status: ModelStatus | undefined) => {
      const id = model.id;
      setInstalls((s) => ({
        ...s,
        [id]: { phase: "deps", message: "installing pip dependencies" },
      }));
      try {
        if (!status?.deps_installed) {
          await tauri.installModelDeps(id, model.adapter);
          // Adapter installs can upgrade packages already imported by the
          // long-running sidecar. Restart before status checks/downloads so
          // Python sees the fresh venv instead of stale sys.modules entries.
          await tauri.stopSidecar().catch(() => undefined);
          await tauri.startSidecar();
        }
        if (!status?.weights_downloaded) {
          await tauri.rpc("models.download_weights", { model_id: id });
        }
        // Promise resolution is the authoritative "done" signal — the
        // download.complete notification might still be in flight.
        setInstalls((s) => ({
          ...s,
          [id]: { phase: "ready", message: "ready", fraction: 1 },
        }));
        qc.invalidateQueries({ queryKey: ["model-statuses"] });
        qc.invalidateQueries({ queryKey: ["synth-history"] });
      } catch (e) {
        setInstalls((s) => ({
          ...s,
          [id]: {
            phase: "error",
            message: "install failed",
            error: (e as Error).message ?? String(e),
          },
        }));
      }
    },
    [qc],
  );

  const removeWeights = useCallback(
    async (model: ModelInfo) => {
      if (requestInProgress && model.id === activeModelId) return;
      const ok = window.confirm(
        `Remove downloaded weights for ${model.name}? Python dependencies will stay installed.`,
      );
      if (!ok) return;
      const id = model.id;
      setInstalls((s) => ({
        ...s,
        [id]: { phase: "removing", message: "removing downloaded weights" },
      }));
      try {
        await tauri.rpc("models.remove_weights", { model_id: id });
        setInstalls((s) => ({
          ...s,
          [id]: { phase: "removed", message: "weights removed" },
        }));
        qc.invalidateQueries({ queryKey: ["model-statuses"] });
        qc.invalidateQueries({ queryKey: ["synth-history"] });
      } catch (e) {
        setInstalls((s) => ({
          ...s,
          [id]: {
            phase: "error",
            message: "remove failed",
            error: (e as Error).message ?? String(e),
          },
        }));
      }
    },
    [activeModelId, qc, requestInProgress],
  );

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-zinc-400">
            Install models on demand. Each install grabs the adapter&apos;s pip
            dependencies, then downloads the model weights to your local
            HuggingFace cache.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Speed and quality ratings are approximate and relative to the
            models currently bundled with this app.
          </p>
        </div>
        <button
          className="btn-ghost text-xs shrink-0"
          title="Re-check installed status"
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["models"] });
            qc.invalidateQueries({ queryKey: ["model-statuses"] });
            qc.invalidateQueries({ queryKey: ["synth-history"] });
          }}
          disabled={statuses.isFetching}
        >
          <RefreshCw className={cn("w-3.5 h-3.5", statuses.isFetching && "animate-spin")} />
          Refresh
        </button>
      </header>

      <div className="space-y-3">
        {models?.map((m) => {
          const status = statuses.data?.find((s) => s.model_id === m.id);
          const install = installs[m.id];
          const effectiveStatus =
            install?.phase === "removed" && status
              ? { ...status, weights_downloaded: false }
              : status;
          const removeDisabled = requestInProgress && m.id === activeModelId;
          return (
            <ModelCard
              key={m.id}
              model={m}
              status={effectiveStatus}
              install={install}
              onInstall={() => startInstall(m, effectiveStatus)}
              onRemove={() => void removeWeights(m)}
              removeDisabled={removeDisabled}
              removeTitle={
                removeDisabled
                  ? "Cannot remove the active model while synthesis is running"
                  : "Remove downloaded weights"
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function ModelCard({
  model,
  status,
  install,
  onInstall,
  onRemove,
  removeDisabled,
  removeTitle,
}: {
  model: ModelInfo;
  status: ModelStatus | undefined;
  install: InstallState | undefined;
  onInstall: () => void;
  onRemove: () => void;
  removeDisabled: boolean;
  removeTitle: string;
}) {
  const ready = Boolean(
    install?.phase === "ready" ||
    (install?.phase !== "removed" && status?.deps_installed && status.weights_downloaded),
  );
  const busy =
    install?.phase === "deps" ||
    install?.phase === "resolving" ||
    install?.phase === "weights" ||
    install?.phase === "finalizing" ||
    install?.phase === "removing";
  const error = install?.phase === "error";
  const depsNeedRepair = !!status && !status.deps_installed && status.weights_downloaded;
  const installLabel = depsNeedRepair ? "Repair deps" : "Install";
  const sizeDisplay = modelSizeDisplay(model, status, install, ready);

  return (
    <div className="card p-4">
      <div className="flex items-start gap-4">
        <div className="grid place-items-center w-10 h-10 rounded-md bg-zinc-800/80 text-zinc-200 shrink-0">
          <Package className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{model.name}</span>
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">
              {model.license}
            </span>
            {model.is_default && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200">
                default
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5 truncate">
            {model.vendor} · {model.hf_repo}
          </div>
          {model.description && (
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              {model.description}
            </p>
          )}
          {model.ratings && (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <Rating label="Speed" value={model.ratings.speed} />
              <Rating label="Quality" value={model.ratings.quality} />
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <HardDrive className="w-3 h-3" />
              {sizeDisplay}
            </span>
            <span>{languageCountLabel(model.languages)}</span>
            <span>{model.hardware.join(" / ")}</span>
          </div>
          {depsNeedRepair && status?.deps_error && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200/90">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="break-words">
                Python deps need repair: {status.deps_error}
              </span>
            </div>
          )}
        </div>

        <div className="shrink-0 self-center">
          {ready && !busy ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                <Check className="w-3.5 h-3.5" />
                installed
              </span>
              <button
                className="btn-ghost px-2 py-1 text-xs text-red-300 hover:text-red-200"
                onClick={onRemove}
                disabled={removeDisabled}
                title={removeTitle}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </button>
            </div>
          ) : (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={onInstall}
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {busy ? (install?.phase === "removing" ? "Removing…" : "Installing…") : installLabel}
            </button>
          )}
        </div>
      </div>

      {(busy || error) && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className={cn("truncate", error ? "text-red-300" : "text-zinc-400")}>
              {error ? install?.message : phaseLabel(install)}
              {install?.bytes !== undefined && install.bytes > 0 ? (
                <span className="text-zinc-500">
                  {" "}— {downloadedLabel(install)}
                </span>
              ) : null}
            </span>
            {typeof install?.fraction === "number" && install.totalBytes ? (
              <span className="tabular-nums text-zinc-300 ml-2">
                {Math.round(install.fraction * 100)}%
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            {typeof install?.fraction === "number" && install.totalBytes ? (
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-[width] duration-300"
                style={{ width: `${Math.round(Math.max(0, Math.min(1, install.fraction)) * 100)}%` }}
              />
            ) : (
              <div className="h-full w-1/3 bg-gradient-to-r from-indigo-500 to-fuchsia-500 animate-indeterminate" />
            )}
          </div>
          {(install?.filesTotal || install?.bytesPerSecond || install?.etaSeconds) && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              {install.filesTotal ? (
                <span>
                  files:{" "}
                  <span className="text-zinc-300 tabular-nums">
                    {install.filesDone ?? 0}/{install.filesTotal}
                  </span>
                </span>
              ) : null}
              {install.bytesPerSecond ? (
                <span>
                  speed:{" "}
                  <span className="text-zinc-300 tabular-nums">
                    {formatByteRate(install.bytesPerSecond)}
                  </span>
                </span>
              ) : null}
              {install.etaSeconds ? (
                <span>
                  eta:{" "}
                  <span className="text-zinc-300 tabular-nums">
                    {formatEta(install.etaSeconds)}
                  </span>
                </span>
              ) : null}
            </div>
          )}
          {error && install?.error && (
            <pre className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200/90 whitespace-pre-wrap break-words font-mono">
              <AlertCircle className="inline-block w-3 h-3 mr-1" />
              {install.error}
            </pre>
          )}
        </div>
      )}

      {model.getting_started && (
        <GettingStartedSection model={model} guide={model.getting_started} />
      )}
    </div>
  );
}

function GettingStartedSection({ model, guide }: { model: ModelInfo; guide: GettingStarted }) {
  const params = model.params ?? [];
  const paramLabel = (key: string): string =>
    params.find((p) => p.key === key)?.label ?? key;
  const tagGroups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const t of guide.tags ?? []) {
      const group = t.group ?? "Tags";
      const arr = out.get(group) ?? [];
      arr.push(t.tag);
      out.set(group, arr);
    }
    return Array.from(out.entries());
  }, [guide.tags]);

  return (
    <details className="group mt-3 border-t border-zinc-800/80 pt-3 text-xs">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-zinc-300 hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        <span className="font-medium">Getting started</span>
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed text-zinc-400">
        {guide.ref_clip_tips && (
          <GuideSection title="Reference clip">{guide.ref_clip_tips}</GuideSection>
        )}
        {guide.text_tips && (
          <GuideSection title="Text input">{guide.text_tips}</GuideSection>
        )}
        {guide.audio_length_tips && (
          <GuideSection title="Audio length">{guide.audio_length_tips}</GuideSection>
        )}
        {tagGroups.length > 0 && (
          <GuideSection title="Paralinguistic tags">
            <div className="space-y-1.5">
              {tagGroups.map(([group, tags]) => (
                <div key={group} className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                    {group}
                  </span>
                  {tags.map((tag) => (
                    <CopyChip key={tag} value={tag} />
                  ))}
                </div>
              ))}
              {guide.tags_note && (
                <p className="text-[11px] text-zinc-500">{guide.tags_note}</p>
              )}
            </div>
          </GuideSection>
        )}
        {(guide.param_guidance ?? []).map((pg) => (
          <GuideSection key={pg.key} title={`${paramLabel(pg.key)} guide`}>
            <table className="w-full table-fixed border-collapse text-[11px]">
              <tbody>
                {pg.values.map((row) => (
                  <tr key={row.setting} className="align-top">
                    <td className="w-24 py-0.5 pr-3 font-mono text-zinc-300">
                      {row.setting}
                    </td>
                    <td className="py-0.5 text-zinc-400">{row.effect}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GuideSection>
        ))}
        {(guide.sample_prompts ?? []).length > 0 && (
          <GuideSection title="Sample prompts">
            <div className="space-y-2">
              {guide.sample_prompts!.map((p, i) => (
                <SamplePrompt key={i} label={p.label} text={p.text} />
              ))}
            </div>
          </GuideSection>
        )}
        {(guide.gotchas ?? []).length > 0 && (
          <GuideSection title="Watch out for">
            <ul className="space-y-1.5">
              {guide.gotchas!.map((g, i) => (
                <li key={i} className="flex items-start gap-1.5 text-amber-200/85">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </GuideSection>
        )}
      </div>
    </details>
  );
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
        copied
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
      )}
      title={copied ? "Copied" : `Copy ${value}`}
    >
      {value}
    </button>
  );
}

function SamplePrompt({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-2 py-1">
        <span className="truncate text-[11px] text-zinc-400">{label}</span>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
            copied
              ? "text-emerald-300"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
          )}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words px-2 py-1.5 text-[11.5px] text-zinc-300">
        {text}
      </p>
    </div>
  );
}

function Rating({ label, value }: { label: string; value: number }) {
  const exactScore = Math.max(1, Math.min(10, value));
  const score = Math.max(1, Math.min(5, Math.round(exactScore / 2)));
  const exactLabel = `${formatRating(exactScore)}/10`;
  return (
    <div
      className="flex items-center gap-2 text-[11px] text-zinc-500"
      title={`${label}: ${exactLabel}`}
    >
      <span className="w-12 shrink-0 text-zinc-400">{label}</span>
      <div
        className="flex gap-1"
        aria-label={`${label}: ${exactLabel}, shown as ${score} out of 5`}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 w-5 rounded-full",
              i < score ? "bg-indigo-400" : "bg-zinc-800",
            )}
          />
        ))}
      </div>
      <span className="tabular-nums text-zinc-500">{score}/5</span>
    </div>
  );
}

function formatRating(value: number): string {
  return value.toFixed(1);
}

function phaseLabel(s: InstallState | undefined): string {
  switch (s?.phase) {
    case "deps":
      return s.message || "installing pip dependencies";
    case "resolving":
      return s.message || "resolving model files";
    case "weights":
      return s.message || "downloading weights";
    case "finalizing":
      return s.message || "finalising";
    case "removing":
      return s.message || "removing downloaded weights";
    case "ready":
      return "ready";
    case "removed":
      return "weights removed";
    default:
      return "";
  }
}

function stateFromDownload(payload: DownloadEvent): InstallState | null {
  if (!payload.phase) return null;
  const totalBytes = coercePositive(payload.total_bytes ?? payload.expected_bytes);
  const bytes = coercePositive(payload.bytes ?? payload.downloaded_bytes);
  const fraction =
    payload.fraction !== undefined
      ? payload.fraction
      : payload.phase === "ready"
        ? 1
        : totalBytes
          ? (bytes ?? 0) / totalBytes
          : undefined;
  return {
    phase: payload.phase,
    message: payload.message ?? downloadPhaseMessage(payload.phase),
    bytes,
    totalBytes,
    expectedBytes: totalBytes,
    downloadedBytes: coercePositive(payload.downloaded_bytes ?? bytes),
    installedBytes: coercePositive(payload.installed_bytes),
    fraction,
    bytesPerSecond: coercePositive(payload.bytes_per_second),
    etaSeconds: coercePositive(payload.eta_seconds),
    filesDone: coercePositive(payload.files_done),
    filesTotal: coercePositive(payload.files_total),
    sizeSource: payload.size_source ?? undefined,
    error: payload.error,
  };
}

function downloadPhaseMessage(phase: Phase): string {
  switch (phase) {
    case "resolving":
      return "resolving model files";
    case "weights":
      return "downloading weights";
    case "finalizing":
      return "finalising — linking files into the cache";
    case "ready":
      return "ready";
    case "removing":
      return "removing downloaded weights";
    case "removed":
      return "weights removed";
    case "error":
      return "download failed";
    case "deps":
      return "installing pip dependencies";
    default:
      return "";
  }
}

function modelSizeDisplay(
  model: ModelInfo,
  status: ModelStatus | undefined,
  install: InstallState | undefined,
  ready: boolean,
): string {
  if (install?.phase === "removed") {
    return `~${formatBytes(model.approx_size_mb)} estimated`;
  }

  const installed = coercePositive(install?.installedBytes ?? status?.installed_bytes);
  if ((ready || status?.weights_downloaded) && installed) {
    return `${formatBytesFromBytes(installed)} installed`;
  }

  const expected = coercePositive(
    install?.totalBytes ??
      install?.expectedBytes ??
      status?.expected_bytes,
  );
  if (expected) {
    const source = install?.sizeSource ?? status?.size_source;
    return source === "installed"
      ? `${formatBytesFromBytes(expected)} installed`
      : `${formatBytesFromBytes(expected)} download`;
  }

  return `~${formatBytes(model.approx_size_mb)} estimated`;
}

function languageCountLabel(languages: string[]): string {
  const count = languages.filter((language) => language.toLowerCase() !== "auto").length;
  return count === 1 ? "1 language" : `${count} languages`;
}

function downloadedLabel(install: InstallState): string {
  const bytes = install.bytes ?? install.downloadedBytes ?? 0;
  return install.totalBytes
    ? `${formatBytesFromBytes(bytes)} / ${formatBytesFromBytes(install.totalBytes)}`
    : formatBytesFromBytes(bytes);
}

function coercePositive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function formatBytesFromBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatByteRate(bytesPerSecond: number): string {
  return `${formatBytesFromBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}
