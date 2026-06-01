import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Cpu as Gpu, Apple, Flame, Loader2, Check, AlertCircle } from "lucide-react";
import { BackendKind, tauri } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface ProgressEvent {
  stage: string;
  fraction: number;
  message: string;
}

const STAGE_LABELS: Record<string, string> = {
  starting: "Preparing",
  download_python: "Downloading Python",
  extract_python: "Extracting Python",
  download_uv: "Downloading uv",
  extract_uv: "Extracting uv",
  create_venv: "Creating environment",
  install_torch: "Installing PyTorch",
  install_base: "Installing common libraries",
  done: "Ready",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function FirstRun() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const host = useQuery({ queryKey: ["host-info"], queryFn: tauri.hostInfo });
  // Probe for an NVIDIA / AMD GPU to recommend a backend. Skipped on macOS:
  // we ship only the arm64 build, which always means MPS — nothing to detect.
  const detection = useQuery({
    queryKey: ["backend-detection"],
    queryFn: tauri.detectBackends,
    enabled: !!host.data && !host.data.is_macos,
  });
  // `null` = follow the recommendation; set once the user picks a card.
  const [choice, setChoice] = useState<BackendKind | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    let off: UnlistenFn | undefined;
    listen<ProgressEvent>("backend:progress", (e) => setProgress(e.payload))
      .then((u) => (off = u));
    return () => off?.();
  }, []);

  const install = useMutation({
    mutationFn: (b: BackendKind) => tauri.installBackendPack(b),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["backend-status"] });
      try { await tauri.startSidecar(); } catch { /* ignore */ }
      void qc.invalidateQueries({ queryKey: ["sidecar-status"] });
      void qc.invalidateQueries({ queryKey: ["device-caps"] });
      void qc.invalidateQueries({ queryKey: ["model-statuses"] });
      void qc.invalidateQueries({ queryKey: ["synth-history"] });
      nav("/studio", { replace: true });
    },
    onError: () => setProgress(null),
  });

  const installing = install.isPending;
  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  // Every backend installable on this platform, before detection filtering.
  const applicable = useMemo<BackendOption[]>(() => {
    const isMac = host.data?.is_macos ??
      (typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac"));
    const isWindows = host.data?.is_windows ?? false;
    const opts: BackendOption[] = [
      {
        kind: "cpu",
        title: "CPU",
        subtitle: "Smallest install. Works everywhere; slow.",
        icon: <Cpu className="w-5 h-5" />,
      },
    ];
    if (host.data?.is_apple_silicon) {
      opts.unshift({
        kind: "mps",
        title: "Apple Silicon (MPS + CPU)",
        subtitle: "Hardware-accelerated on M-series, with CPU available for fallback.",
        icon: <Apple className="w-5 h-5" />,
      });
    } else if (!isMac) {
      // Non-Mac (Linux or Windows) gets both CUDA and ROCm options. ROCm
      // uses AMD's ROCm 7.2.1 wheels on both platforms.
      opts.unshift({
        kind: "rocm",
        title: "AMD GPU/APU (ROCm + CPU)",
        subtitle: isWindows
          ? "ROCm 7.2.1 preview. Requires AMD Adrenalin 26.2.2."
          : "ROCm 7.2.1. Requires AMDGPU/ROCm 7.2.1 drivers.",
        icon: <Flame className="w-5 h-5" />,
      });
      opts.unshift({
        kind: "cuda",
        title: "NVIDIA GPU (CUDA + CPU)",
        subtitle: "PyTorch 2.9.1 cu128. RTX 20 / GTX 16+ recommended; Maxwell/Pascal run on CPU.",
        icon: <Gpu className="w-5 h-5" />,
      });
    }
    return opts;
  }, [host.data?.is_apple_silicon, host.data?.is_macos, host.data?.is_windows]);

  // GPU backends actually detected on this machine (Apple Silicon implies MPS).
  const det = detection.data;
  const detectedKinds = useMemo<BackendKind[]>(() => {
    if (host.data?.is_apple_silicon) return ["mps"];
    const ks: BackendKind[] = [];
    if (det?.has_nvidia) ks.push("cuda");
    if (det?.has_amd) ks.push("rocm");
    return ks;
  }, [host.data?.is_apple_silicon, det?.has_nvidia, det?.has_amd]);

  // Recommendation priority: MPS > CUDA > ROCm > CPU (NVIDIA wins ties).
  const recommended: BackendKind = host.data?.is_apple_silicon
    ? "mps"
    : det?.has_nvidia
      ? "cuda"
      : det?.has_amd
        ? "rocm"
        : "cpu";

  // Collapse to the detected hardware only when we actually found a supported
  // GPU and the user hasn't expanded the list. Otherwise (couldn't probe, or
  // no supported GPU) show everything with CPU pre-selected.
  const hasDetectedGpu =
    host.data?.is_apple_silicon || (!!det?.probed && detectedKinds.length > 0);
  const filtered = hasDetectedGpu && !showAll;
  const displayed = useMemo<BackendOption[]>(
    () =>
      filtered
        ? applicable.filter((o) => o.kind === "cpu" || detectedKinds.includes(o.kind))
        : applicable,
    [filtered, applicable, detectedKinds],
  );
  const hiddenCount = applicable.length - displayed.length;

  // Auto-selection: follow the recommendation until the user picks a card.
  const selected = choice ?? recommended;
  const detectionSettled =
    !!host.data && (host.data.is_macos || detection.isSuccess || detection.isError);
  const selectedIsVisible = displayed.some((o) => o.kind === selected);
  const canInstall = detectionSettled && selectedIsVisible && !installing;

  useEffect(() => {
    if (choice && filtered && !displayed.some((o) => o.kind === choice)) {
      setShowAll(true);
    }
  }, [choice, filtered, displayed]);

  return (
    <div className="min-h-full grid place-items-center p-10">
      <div className="card w-[640px] max-w-full p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Set up Timbre</h1>
        <p className="mt-1 text-xs text-zinc-500 italic">From text to timbre.</p>
        <p className="mt-3 text-sm text-zinc-400">
          We&apos;ll download a small Python runtime and the inference libraries for your
          machine. Models themselves are downloaded later, only when you select them.
        </p>

        <fieldset disabled={installing} className="mt-6 space-y-2">
          {displayed.map((o) => (
            <BackendCard
              key={o.kind}
              option={o}
              selected={selected === o.kind}
              recommended={o.kind === recommended}
              disabled={installing}
              onSelect={() => setChoice(o.kind)}
            />
          ))}
          {filtered && hiddenCount > 0 && (
            <button
              type="button"
              className="pt-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
              onClick={() => setShowAll(true)}
            >
              Show all options
            </button>
          )}
        </fieldset>

        <div className="mt-6 flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            {installing && (
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span className="truncate">
                  {progress ? stageLabel(progress.stage) : "Preparing"}
                  {progress?.message && (
                    <span className="text-zinc-500"> — {progress.message}</span>
                  )}
                </span>
                <span className="tabular-nums text-zinc-300 ml-3 shrink-0">{percent}%</span>
              </div>
            )}
          </div>
          <button
            className="btn-primary shrink-0"
            disabled={!canInstall}
            onClick={() => canInstall && install.mutate(selected)}
          >
            {installing && <Loader2 className="w-4 h-4 animate-spin" />}
            {installing ? "Installing…" : "Install"}
          </button>
        </div>

        {!installing && install.error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 flex gap-3">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-red-300">Installation failed</div>
              <pre className="mt-1 text-xs text-red-200/90 whitespace-pre-wrap break-words font-mono">
                {(install.error as Error).message}
              </pre>
            </div>
          </div>
        )}

        {installing && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ? percent : undefined}
            className="mt-3 h-1.5 rounded-full bg-zinc-800 overflow-hidden"
          >
            {progress ? (
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            ) : (
              // No progress event yet — show an indeterminate sweep so the
              // user knows something is happening.
              <div className="h-full w-1/3 bg-gradient-to-r from-indigo-500 to-fuchsia-500 animate-indeterminate" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface BackendOption {
  kind: BackendKind;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}

function BackendCard({
  option, selected, recommended, disabled, onSelect,
}: {
  option: BackendOption;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors",
        selected
          ? "border-indigo-500/70 bg-indigo-500/10"
          : "border-zinc-800 hover:border-zinc-700 bg-zinc-900/40",
        disabled && "opacity-50 cursor-not-allowed pointer-events-none",
      )}
    >
      <div className="grid place-items-center w-9 h-9 rounded-md bg-zinc-800/80 text-zinc-200">
        {option.icon}
      </div>
      <div className="flex-1">
        <div className="font-medium flex items-center gap-2">
          {option.title}
          {recommended && (
            <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-300">
              Recommended
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-400">{option.subtitle}</div>
      </div>
      {selected && <Check className="w-4 h-4 text-indigo-300" />}
    </button>
  );
}
