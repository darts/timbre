import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/ipc";
import {
  DeviceCapabilities,
  ModelInfo,
  ModelStatus,
  PromptStatus,
  SynthesisChunk,
  SynthesisHistoryItem,
  Voice,
} from "@/lib/schema";

export function useBackendStatus() {
  return useQuery({
    queryKey: ["backend-status"],
    queryFn: tauri.backendStatus,
    refetchInterval: false,
  });
}

export function useSidecarStatus() {
  return useQuery({
    queryKey: ["sidecar-status"],
    queryFn: tauri.sidecarStatus,
    refetchInterval: 2000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("list_models");
      return raw.map((m) => ModelInfo.parse(m));
    },
    // The sidecar may not be ready on the very first call after a fresh
    // backend install. Retry briefly so the user doesn't see an empty list.
    retry: 4,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4000),
    refetchOnMount: "always",
  });
}

export function useVoices() {
  return useQuery({
    queryKey: ["voices"],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("voices.list");
      return raw.map((v) => Voice.parse(v));
    },
  });
}

export function useModelStatuses(opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: ["model-statuses"],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("models.list_status");
      return raw.map((s) => ModelStatus.parse(s));
    },
    enabled: opts?.enabled ?? true,
    refetchInterval: opts?.refetchInterval,
    // Always re-query on route mount — local component install state is
    // lost on unmount, so we need fresh disk-backed status to render the
    // right Install / installed affordance immediately.
    refetchOnMount: "always",
    retry: 3,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 3000),
    staleTime: 0,
  });
}

export function useVoicePromptStatuses(modelId: string | undefined) {
  return useQuery({
    queryKey: ["voice-prompts", modelId ?? null],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("voices.prompt_status_all", {
        model_id: modelId,
      });
      return raw.map((s) => PromptStatus.parse(s));
    },
    enabled: !!modelId,
    refetchOnMount: "always",
    staleTime: 0,
  });
}

export function useSynthHistory(opts?: { enabled?: boolean; refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ["synth-history"],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("synth.list_history", { limit: 50 });
      return raw.map((s) => SynthesisHistoryItem.parse(s));
    },
    enabled: opts?.enabled ?? true,
    refetchInterval: opts?.refetchInterval,
    refetchOnMount: "always",
    retry: 4,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4000),
    staleTime: 0,
  });
}

export function useSynthChunks(
  synthesisId: string | undefined,
  opts?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ["synth-chunks", synthesisId ?? null],
    queryFn: async () => {
      const raw = await tauri.rpc<unknown[]>("synth.list_chunks", {
        synthesis_id: synthesisId,
      });
      return raw.map((s) => SynthesisChunk.parse(s));
    },
    enabled: !!synthesisId && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval,
    refetchOnMount: "always",
    staleTime: 0,
  });
}

export function useSynthRunningStatus(opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ["synth-running"],
    queryFn: () => tauri.rpc<{ running: boolean; synthesis_id?: string | null }>("synth.running"),
    refetchInterval: opts?.refetchInterval ?? 1000,
    retry: false,
  });
}

export function useDeviceCapabilities() {
  return useQuery({
    queryKey: ["device-caps"],
    queryFn: async () => DeviceCapabilities.parse(await tauri.rpc("device_capabilities")),
  });
}
