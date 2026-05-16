import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Cpu as Gpu, Apple, Loader2, Check, AlertCircle } from "lucide-react";
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
  const [choice, setChoice] = useState<BackendKind | null>("cpu");
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
      nav("/studio", { replace: true });
    },
    onError: () => setProgress(null),
  });

  const installing = install.isPending;
  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  useEffect(() => {
    if (host.data?.is_apple_silicon) {
      setChoice("mps");
    }
  }, [host.data?.is_apple_silicon]);

  const options = useMemo<BackendOption[]>(() => {
    const isMac = host.data?.is_macos ??
      (typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac"));
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
      opts.unshift({
        kind: "cuda",
        title: "NVIDIA GPU (CUDA + CPU)",
        subtitle: "Fastest with a recent NVIDIA card, with CPU available for fallback.",
        icon: <Gpu className="w-5 h-5" />,
      });
    }
    return opts;
  }, [host.data?.is_apple_silicon, host.data?.is_macos]);

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
          {options.map((o) => (
            <BackendCard
              key={o.kind}
              option={o}
              selected={choice === o.kind}
              disabled={installing}
              onSelect={() => setChoice(o.kind)}
            />
          ))}
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
            disabled={!choice || installing}
            onClick={() => choice && install.mutate(choice)}
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
  option, selected, disabled, onSelect,
}: {
  option: BackendOption;
  selected: boolean;
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
        <div className="font-medium">{option.title}</div>
        <div className="text-xs text-zinc-400">{option.subtitle}</div>
      </div>
      {selected && <Check className="w-4 h-4 text-indigo-300" />}
    </button>
  );
}
