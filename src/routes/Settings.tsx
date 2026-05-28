import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { tauri } from "@/lib/ipc";
import { useBackendStatus, useDeviceCapabilities } from "@/lib/queries";
import { useUiSettings, type DevicePreference } from "@/lib/settings";

export function Settings() {
  const { data: backend } = useBackendStatus();
  const { data: caps } = useDeviceCapabilities();
  const showGenerationDiagnostics = useUiSettings((s) => s.showGenerationDiagnostics);
  const setShowGenerationDiagnostics = useUiSettings((s) => s.setShowGenerationDiagnostics);
  const simpleMode = useUiSettings((s) => s.simpleMode);
  const setSimpleMode = useUiSettings((s) => s.setSimpleMode);
  const devicePreference = useUiSettings((s) => s.devicePreference);
  const setDevicePreference = useUiSettings((s) => s.setDevicePreference);
  const qc = useQueryClient();
  const nav = useNavigate();

  const reset = useMutation({
    mutationFn: () => tauri.uninstallBackendPack(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["backend-status"] });
      nav("/first-run", { replace: true });
    },
  });

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <section className="card p-5">
        <h2 className="font-medium mb-2">Compute backend</h2>
        <div className="text-sm text-zinc-400">
          Currently installed:{" "}
          <span className="text-zinc-100">{backendLabel(backend?.backend)}</span>
        </div>
        {caps && (
          <div className="mt-2 text-xs text-zinc-500 space-y-0.5">
            <div>torch {caps.torch_version ?? "?"}</div>
            <div>cuda available: {String(caps.cuda)}</div>
            <div>mps available: {String(caps.mps)}</div>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            className="btn-soft"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
          >
            {reset.isPending ? "Resetting…" : "Switch backend / reinstall"}
          </button>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-medium mb-2">Generation</h2>
        <div className="mb-5 flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm text-zinc-200">Studio mode</span>
            <span className="mt-1 block text-xs text-zinc-500">
              Simple keeps Studio focused on writing, voice selection, playback,
              and export. Advanced shows reuse, chunks, filters, seeds, and tuning controls.
            </span>
          </span>
          <div className="inline-flex h-9 shrink-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
            <button
              type="button"
              className={`flex h-9 w-10 items-center justify-center border-r border-zinc-800 transition-colors ${
                simpleMode
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
              aria-label="Use simple Studio mode"
              aria-pressed={simpleMode}
              title="Simple Studio mode"
              onClick={() => setSimpleMode(true)}
            >
              <Sparkles className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={`flex h-9 w-10 items-center justify-center transition-colors ${
                !simpleMode
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
              aria-label="Use advanced Studio mode"
              aria-pressed={!simpleMode}
              title="Advanced Studio mode"
              onClick={() => setSimpleMode(false)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
        <label className="mb-5 block">
          <span className="block text-sm text-zinc-200">Compute mode</span>
          <span className="mt-1 block text-xs text-zinc-500">
            Auto prefers CUDA, then MPS, then CPU. Accelerator runs can retry on CPU when
            a recoverable device failure is detected.
          </span>
          <select
            className="input mt-2 max-w-xs"
            value={devicePreference}
            onChange={(e) => setDevicePreference(e.target.value as DevicePreference)}
          >
            <option value="auto">Auto</option>
            <option value="cpu">CPU</option>
            <option value="cuda" disabled={!caps?.cuda}>CUDA</option>
            <option value="mps" disabled={!caps?.mps}>MPS</option>
          </select>
        </label>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm text-zinc-200">
              Show generation diagnostics
            </span>
            <span className="mt-1 block text-xs text-zinc-500">
              Adds phase, chunk, device placement, and memory details to the
              synthesis progress panel. Disabled by default because these
              values can be noisy with long-running model calls.
            </span>
          </span>
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-indigo-500"
            checked={showGenerationDiagnostics}
            onChange={(e) => setShowGenerationDiagnostics(e.target.checked)}
          />
        </label>
      </section>

      <section className="card p-5">
        <h2 className="font-medium mb-2">About</h2>
        <p className="text-xs text-zinc-500 italic mb-2">From text to timbre.</p>
        <p className="text-sm text-zinc-400">
          Timbre runs entirely on your machine. Reference clips, generated audio,
          and downloaded model weights stay in your app data folder.
        </p>
        <p className="text-xs text-zinc-500 mt-2">
          Storage budget per model varies. The Models tab shows the current estimated
          or installed size for each model.
        </p>
      </section>
    </div>
  );
}

function backendLabel(backend?: string | null): string {
  if (backend === "mps") return "MPS + CPU";
  if (backend === "cuda") return "CUDA + CPU";
  if (backend === "rocm") return "ROCm + CPU";
  if (backend === "cpu") return "CPU";
  return "—";
}
