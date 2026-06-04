import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Star,
  Square,
  Trash2,
} from "lucide-react";
import { tauri, type BackendKind } from "@/lib/ipc";
import {
  computeModeLabel,
  deviceTransitionLabel,
  displayDeviceLabel,
} from "@/lib/deviceLabels";
import {
  useModels,
  useModelStatuses,
  useVoices,
  useVoicePromptStatuses,
  useSidecarStatus,
  useDeviceCapabilities,
  useBackendStatus,
  useSynthHistory,
  useSynthChunks,
} from "@/lib/queries";
import { useSidecarEvent } from "@/lib/sidecar";
import { SynthesisChunk, SynthesisHistoryItem, type ModelInfo } from "@/lib/schema";
import { useUiSettings, type DevicePreference } from "@/lib/settings";
import { Waveform } from "@/components/Waveform";
import { VoiceCreateDialog } from "@/components/VoiceCreateDialog";
import { ParamControls } from "@/components/ParamControls";
import { Dialog } from "@/components/Dialog";
import { cn, formatDateTime, formatDuration } from "@/lib/utils";

const MIN_SYNTH_RUN_COUNT = 1;
const MAX_SYNTH_RUN_COUNT = 10;

interface SynthProgress {
  synthesis_id: string;
  model_id: string;
  requested_device: string;
  resolved_device?: string | null;
  device_detail?: string | null;
  fallback_device?: string | null;
  fallback_reason?: string | null;
  warnings?: string[];
  phase: string;
  message: string;
  chunk_idx?: number | null;
  chunk_count: number;
  fraction?: number | null;
  elapsed_ms: number;
  memory?: Record<string, number>;
}

interface SynthStartedEvent {
  synthesis_id: string;
  chunk_count: number;
}

interface SynthModelLoadedEvent {
  model_id: string;
  device?: string;
  requested_device?: string;
  resolved_device?: string | null;
  device_detail?: string | null;
  warnings?: string[];
  memory?: Record<string, number>;
}

interface SynthPromptEvent {
  error?: string;
}

interface SynthChunkReadyEvent {
  idx: number;
}

interface SynthFinishedEvent {
  synthesis_id: string;
}

interface SynthRunningStatus {
  running: boolean;
  synthesis_id?: string | null;
  progress?: SynthProgress | null;
}

interface SynthRunResult {
  synthesis_id: string;
  final_audio_path: string;
  duration_ms: number;
}

interface SynthCancelResult {
  ok: boolean;
  synthesis_id: string;
  status?: string | null;
}

interface SynthDeleteResult {
  ok: boolean;
  deleted: string[];
}

export function Studio() {
  const qc = useQueryClient();
  const { data: models } = useModels();
  const { data: voices } = useVoices();
  const { data: sidecar } = useSidecarStatus();
  const { data: caps } = useDeviceCapabilities();
  const { data: backend } = useBackendStatus();
  const { data: modelStatuses } = useModelStatuses({ refetchInterval: 4000 });
  const simpleMode = useUiSettings((s) => s.simpleMode);
  const showGenerationDiagnostics = useUiSettings((s) => s.showGenerationDiagnostics);
  const devicePreference = useUiSettings((s) => s.devicePreference);
  const synthParamsAll = useUiSettings((s) => s.synthParams);
  const setSynthParam = useUiSettings((s) => s.setSynthParam);
  const resetSynthParams = useUiSettings((s) => s.resetSynthParams);
  const text = useUiSettings((s) => s.studioText);
  const setText = useUiSettings((s) => s.setStudioText);
  const modelId = useUiSettings((s) => s.studioModelId);
  const setModelId = useUiSettings((s) => s.setStudioModelId);
  const voiceId = useUiSettings((s) => s.studioVoiceId);
  const setVoiceId = useUiSettings((s) => s.setStudioVoiceId);
  const studioLanguages = useUiSettings((s) => s.studioLanguages);
  const setStudioLanguage = useUiSettings((s) => s.setStudioLanguage);
  const seedInput = useUiSettings((s) => s.seed);
  const setSeed = useUiSettings((s) => s.setSeed);
  const runCount = useUiSettings((s) => s.runCount);
  const setRunCount = useUiSettings((s) => s.setRunCount);
  const promptDrafts = useUiSettings((s) => s.promptDrafts);
  const addPromptDraft = useUiSettings((s) => s.addPromptDraft);
  const renamePromptDraft = useUiSettings((s) => s.renamePromptDraft);
  const deletePromptDraft = useUiSettings((s) => s.deletePromptDraft);
  const history = useSynthHistory();
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyVoiceFilter, setHistoryVoiceFilter] = useState("all");
  const [historyModelFilter, setHistoryModelFilter] = useState("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState("all");

  const defaultModel = useMemo(
    () => models?.find((m) => m.is_default)?.id ?? models?.[0]?.id ?? "",
    [models],
  );
  const selectedModelIsValid = !models || !modelId || models.some((m) => m.id === modelId);
  const activeModel = selectedModelIsValid ? (modelId || defaultModel) : defaultModel;
  const activeModelStatus = modelStatuses?.find((s) => s.model_id === activeModel);
  const modelReady = Boolean(
    activeModelStatus?.deps_installed && activeModelStatus.weights_downloaded,
  );
  const promptStatuses = useVoicePromptStatuses(modelReady ? activeModel : undefined);
  const promptReady = useMemo(
    () => new Set(promptStatuses.data?.filter((p) => p.ready).map((p) => p.voice_id) ?? []),
    [promptStatuses.data],
  );
  const selectableVoices = useMemo(
    () =>
      modelReady
        ? (voices ?? []).filter((v) => !v.prompt_only || promptReady.has(v.id))
        : [],
    [modelReady, promptReady, voices],
  );
  const totalVoices = voices?.length ?? 0;
  const [running, setRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [progress, setProgress] = useState<SynthProgress | null>(null);
  const [uiElapsedMs, setUiElapsedMs] = useState(0);
  const uiTimerStartedAtRef = useRef<number | null>(null);
  const activeSynthesisIdRef = useRef<string | null>(null);
  const activeBatchRemainingRef = useRef(0);
  const cancelRequestedRef = useRef(false);

  useEffect(() => {
    if (!voiceId) return;
    if (voices && !voices.some((v) => v.id === voiceId)) {
      setVoiceId("");
    }
  }, [voiceId, voices]);

  useEffect(() => {
    if (!voiceId || !modelReady || !promptStatuses.isSuccess) return;
    const selected = voices?.find((v) => v.id === voiceId);
    if (selected?.prompt_only && !promptReady.has(voiceId)) {
      setVoiceId("");
    }
  }, [modelReady, promptReady, promptStatuses.isSuccess, setVoiceId, voiceId, voices]);

  const device = useMemo<"cpu" | "cuda" | "mps">(
    () => resolveDevicePreference(devicePreference, caps),
    [caps, devicePreference],
  );

  const activeModelMeta = useMemo(
    () => models?.find((m) => m.id === activeModel),
    [models, activeModel],
  );
  const modelLanguages = useMemo(
    () => sortModelLanguages(activeModelMeta?.languages ?? []),
    [activeModelMeta],
  );
  const activeLanguage = resolveModelLanguage(
    modelLanguages,
    activeModel ? studioLanguages[activeModel] : undefined,
  );
  const modelHasLanguageChoice = modelLanguages.length > 1;
  const paramSchema = activeModelMeta?.params ?? [];
  const storedParams = synthParamsAll[activeModel] ?? {};
  const isTurbo = activeModelMeta?.variant === "turbo";
  const hasAdvancedControls = paramSchema.length > 0 || isTurbo;

  useEffect(() => {
    if (!activeModel || modelLanguages.length === 0) return;
    if (studioLanguages[activeModel] !== activeLanguage) {
      setStudioLanguage(activeModel, activeLanguage);
    }
  }, [
    activeLanguage,
    activeModel,
    modelLanguages.length,
    setStudioLanguage,
    studioLanguages,
  ]);

  const startUiTimer = useCallback((initialElapsedMs = 0) => {
    const clamped = Math.max(0, initialElapsedMs);
    uiTimerStartedAtRef.current = performance.now() - clamped;
    setUiElapsedMs(clamped);
  }, []);

  const stopUiTimer = useCallback(() => {
    const startedAt = uiTimerStartedAtRef.current;
    if (startedAt === null) return;
    setUiElapsedMs(Math.max(0, performance.now() - startedAt));
    uiTimerStartedAtRef.current = null;
  }, []);

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const startedAt = uiTimerStartedAtRef.current;
      if (startedAt !== null) {
        setUiElapsedMs(Math.max(0, performance.now() - startedAt));
      }
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [running]);

  const mergeProgress = useCallback((patch: Partial<SynthProgress>) => {
    if (patch.synthesis_id && patch.synthesis_id !== "pending") {
      activeSynthesisIdRef.current = patch.synthesis_id;
    }
    setProgress((prev) => {
      return {
        synthesis_id:
          patch.synthesis_id ?? prev?.synthesis_id ?? activeSynthesisIdRef.current ?? "pending",
        model_id: patch.model_id ?? prev?.model_id ?? activeModel,
        requested_device: patch.requested_device ?? prev?.requested_device ?? device,
        resolved_device:
          patch.resolved_device !== undefined
            ? patch.resolved_device
            : prev?.resolved_device ?? null,
        device_detail:
          patch.device_detail !== undefined
            ? patch.device_detail
            : prev?.device_detail ?? null,
        fallback_device:
          patch.fallback_device !== undefined
            ? patch.fallback_device
            : prev?.fallback_device ?? null,
        fallback_reason:
          patch.fallback_reason !== undefined
            ? patch.fallback_reason
            : prev?.fallback_reason ?? null,
        warnings: patch.warnings ?? prev?.warnings ?? [],
        phase: patch.phase ?? prev?.phase ?? "starting",
        message: patch.message ?? prev?.message ?? "starting synthesis",
        chunk_idx:
          patch.chunk_idx !== undefined
            ? patch.chunk_idx
            : prev?.chunk_idx ?? null,
        chunk_count: patch.chunk_count ?? prev?.chunk_count ?? 0,
        fraction:
          patch.fraction !== undefined
            ? patch.fraction
            : prev?.fraction ?? null,
        elapsed_ms: Math.max(patch.elapsed_ms ?? 0, prev?.elapsed_ms ?? 0),
        memory: patch.memory ?? prev?.memory ?? {},
      };
    });
  }, [activeModel, device]);

  const handleSynthProgress = useCallback((p: SynthProgress) => {
    activeSynthesisIdRef.current = p.synthesis_id;
    setProgress(p);
    if (p.phase === "failed" || p.phase === "cancelled") {
      activeBatchRemainingRef.current = 0;
      stopUiTimer();
      setRunning(false);
    } else if (p.phase === "complete" && activeBatchRemainingRef.current <= 0) {
      stopUiTimer();
      setRunning(false);
    }
  }, [stopUiTimer]);

  useSidecarEvent<SynthProgress>("synth.progress", handleSynthProgress);

  useEffect(() => {
    if (!sidecar?.running) return;
    let cancelled = false;
    const refreshRunningState = async () => {
      try {
        const status = await tauri.rpc<SynthRunningStatus>("synth.running");
        if (cancelled || !status.running) return;
        startUiTimer(status.progress?.elapsed_ms ?? 0);
        setRunning(true);
        if (status.progress) {
          handleSynthProgress(status.progress);
        } else {
          mergeProgress({
            synthesis_id: status.synthesis_id ?? "pending",
            phase: "starting",
            message: "synthesis already running",
            fraction: null,
          });
        }
      } catch {
        return;
      }
    };
    void refreshRunningState();
    return () => {
      cancelled = true;
    };
  }, [handleSynthProgress, mergeProgress, sidecar?.running, startUiTimer]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const synthesisId = activeSynthesisIdRef.current;
        const p = await tauri.rpc<SynthProgress | null>(
          "synth.progress_latest",
          synthesisId ? { synthesis_id: synthesisId } : {},
        );
        if (cancelled || !p) return;
        if (!synthesisId && (p.phase === "complete" || p.phase === "failed" || p.phase === "cancelled")) {
          return;
        }
        handleSynthProgress(p);
      } catch {
        return;
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [handleSynthProgress, running]);

  useSidecarEvent<SynthStartedEvent>("synth.started", useCallback((p) => {
    mergeProgress({
      synthesis_id: p.synthesis_id,
      chunk_count: p.chunk_count,
      phase: "starting",
      message: "synthesis started",
      fraction: 0.02,
    });
  }, [mergeProgress]));
  useSidecarEvent<SynthModelLoadedEvent>("synth.model_loaded", useCallback((p) => {
    const resolved = p.resolved_device ?? p.device ?? null;
    mergeProgress({
      model_id: p.model_id,
      requested_device: p.requested_device ?? p.device ?? device,
      resolved_device: resolved,
      device_detail: p.device_detail ?? (resolved ? `reported_${resolved}` : null),
      warnings: p.warnings ?? [],
      memory: p.memory,
      phase: "loading_model",
      message: "model ready",
      fraction: 0.15,
    });
  }, [device, mergeProgress]));
  useSidecarEvent<SynthPromptEvent>("synth.prompt_loaded", useCallback(() => {
    mergeProgress({
      phase: "loading_prompt",
      message: "cached voice prompt ready",
      fraction: 0.25,
    });
  }, [mergeProgress]));
  useSidecarEvent<SynthPromptEvent>("synth.prompt_saved", useCallback(() => {
    mergeProgress({
      phase: "encoding_prompt",
      message: "voice prompt cached",
      fraction: 0.34,
    });
  }, [mergeProgress]));
  useSidecarEvent<SynthPromptEvent>("synth.prompt_warning", useCallback((p) => {
    mergeProgress({
      phase: "encoding_prompt",
      message: "voice prompt warning",
      warnings: p.error ? [p.error] : undefined,
      fraction: 0.34,
    });
  }, [mergeProgress]));
  useSidecarEvent<SynthPromptEvent>("synth.clone_warning", useCallback((p) => {
    mergeProgress({
      phase: "encoding_prompt",
      message: "voice prompt encode failed; generating from reference",
      warnings: p.error ? [p.error] : undefined,
      fraction: 0.34,
    });
  }, [mergeProgress]));
  useSidecarEvent<SynthChunkReadyEvent>("synth.chunk_ready", useCallback((p) => {
    setProgress((prev) => {
      const chunkCount = prev?.chunk_count ?? 0;
      const fraction = chunkCount > 0
        ? 0.35 + 0.55 * ((p.idx + 1) / chunkCount)
        : prev?.fraction ?? null;
      return {
        synthesis_id: prev?.synthesis_id ?? activeSynthesisIdRef.current ?? "pending",
        model_id: prev?.model_id ?? activeModel,
        requested_device: prev?.requested_device ?? device,
        resolved_device: prev?.resolved_device ?? null,
        device_detail: prev?.device_detail ?? null,
        fallback_device: prev?.fallback_device ?? null,
        fallback_reason: prev?.fallback_reason ?? null,
        warnings: prev?.warnings ?? [],
        phase: "generating_chunk",
        message: `chunk ${p.idx + 1}${chunkCount ? ` of ${chunkCount}` : ""} ready`,
        chunk_idx: p.idx,
        chunk_count: chunkCount,
        fraction,
        elapsed_ms: prev?.elapsed_ms ?? 0,
        memory: prev?.memory ?? {},
      };
    });
  }, [activeModel, device]));
  useSidecarEvent<SynthFinishedEvent>("synth.finished", useCallback((p) => {
    mergeProgress({
      synthesis_id: p.synthesis_id,
      phase: "complete",
      message: "synthesis complete",
      fraction: 1.0,
    });
    if (activeBatchRemainingRef.current > 0) {
      activeBatchRemainingRef.current -= 1;
    }
    if (activeBatchRemainingRef.current <= 0) {
      stopUiTimer();
      setRunning(false);
    }
  }, [mergeProgress, stopUiTimer]));
  useSidecarEvent<SynthFinishedEvent>("synth.updated", useCallback((p) => {
    mergeProgress({
      synthesis_id: p.synthesis_id,
      phase: "complete",
      message: "synthesis updated",
      fraction: 1.0,
    });
  }, [mergeProgress]));

  const displayProgress = useMemo(() => {
    if (!running) return progress;
    if (progress) {
      return progress;
    }
    return {
      synthesis_id: activeSynthesisIdRef.current ?? "pending",
      model_id: activeModel,
      requested_device: device,
      resolved_device: null,
      device_detail: null,
      fallback_device: null,
      fallback_reason: null,
      warnings: [],
      phase: "starting",
      message: "starting synthesis",
      chunk_idx: null,
      chunk_count: 0,
      fraction: null,
      elapsed_ms: 0,
      memory: {},
    } satisfies SynthProgress;
  }, [activeModel, device, progress, running]);

  const synth = useMutation({
    mutationFn: async () => {
      if (!voiceId || !activeModel) throw new Error("pick a voice and a model");
      if (running) throw new Error("synthesis already in progress");
      const count = clampRunCount(runCount);
      const batchId = count > 1 ? createBatchId() : undefined;
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      startUiTimer(0);
      activeSynthesisIdRef.current = null;
      activeBatchRemainingRef.current = count;
      setRunning(true);
      setProgress({
        synthesis_id: "pending",
        model_id: activeModel,
        requested_device: device,
        resolved_device: null,
        device_detail: null,
        fallback_device: null,
        fallback_reason: null,
        warnings: [],
        phase: "starting",
        message: count > 1 ? `starting synthesis 1 of ${count}` : "starting synthesis",
        chunk_idx: null,
        chunk_count: 0,
        fraction: null,
        elapsed_ms: 0,
        memory: {},
      });
      const paramsToSend: Record<string, number | string> = {};
      if (!simpleMode) {
        for (const p of paramSchema) {
          const stored = storedParams[p.key];
          if (stored !== undefined && stored !== p.default) {
            paramsToSend[p.key] = stored;
          }
        }
      }
      if (modelHasLanguageChoice) {
        paramsToSend.language = activeLanguage;
      }
      const trimmedSeed = simpleMode ? "" : seedInput.trim();
      const seedNum = trimmedSeed === "" ? undefined : Number.parseInt(trimmedSeed, 10);
      const seed = seedNum !== undefined && Number.isFinite(seedNum) ? seedNum : undefined;
      const results: SynthRunResult[] = [];
      for (let index = 0; index < count; index += 1) {
        if (cancelRequestedRef.current) {
          throw new Error("synthesis cancelled");
        }
        if (index > 0) {
          activeSynthesisIdRef.current = null;
          setProgress((prev) => ({
            synthesis_id: "pending",
            model_id: activeModel,
            requested_device: device,
            resolved_device: null,
            device_detail: null,
            fallback_device: null,
            fallback_reason: null,
            warnings: [],
            phase: "starting",
            message: `starting synthesis ${index + 1} of ${count}`,
            chunk_idx: null,
            chunk_count: 0,
            fraction: null,
            elapsed_ms: prev?.elapsed_ms ?? 0,
            memory: {},
          }));
        }
        const result = await tauri.rpc<SynthRunResult>(
          "synth.run",
          {
            voice_id: voiceId,
            text,
            model_id: activeModel,
            device,
            params: paramsToSend,
            ...(seed !== undefined ? { seed: seed + index } : {}),
            ...(batchId
              ? {
                batch_id: batchId,
                batch_index: index,
                batch_count: count,
              }
              : {}),
          },
        );
        results.push(result);
      }
      return results;
    },
    onSuccess: (results) => {
      const result = results.at(-1);
      mergeProgress({
        synthesis_id: result?.synthesis_id ?? activeSynthesisIdRef.current ?? "pending",
        phase: "complete",
        message: results.length > 1 ? `${results.length} syntheses complete` : "synthesis complete",
        fraction: 1.0,
      });
      qc.invalidateQueries({ queryKey: ["synth-history"] });
      qc.invalidateQueries({ queryKey: ["voice-prompts", activeModel] });
    },
    onError: (error) => {
      if (cancelRequestedRef.current || isCancellationError(error)) {
        mergeProgress({
          phase: "cancelled",
          message: "synthesis cancelled",
          fraction: null,
        });
        activeBatchRemainingRef.current = 0;
        stopUiTimer();
        qc.invalidateQueries({ queryKey: ["synth-history"] });
        qc.invalidateQueries({ queryKey: ["voice-prompts", activeModel] });
        return;
      }
      mergeProgress({
        phase: "failed",
        message: (error as Error).message,
        fraction: null,
      });
      activeBatchRemainingRef.current = 0;
      stopUiTimer();
      qc.invalidateQueries({ queryKey: ["synth-history"] });
      qc.invalidateQueries({ queryKey: ["voice-prompts", activeModel] });
    },
    onSettled: () => {
      activeBatchRemainingRef.current = 0;
      stopUiTimer();
      setRunning(false);
      cancelRequestedRef.current = false;
      setCancelRequested(false);
    },
  });

  const cancelGeneration = useMutation({
    mutationFn: async () => {
      const synthesisId = activeSynthesisIdRef.current;
      if (!synthesisId || synthesisId === "pending") {
        throw new Error("synthesis has not started yet");
      }
      cancelRequestedRef.current = true;
      setCancelRequested(true);
      activeBatchRemainingRef.current = 0;
      mergeProgress({
        synthesis_id: synthesisId,
        phase: "cancelling",
        message: "cancelling synthesis",
        fraction: null,
      });
      void tauri.rpc<SynthCancelResult>("synth.cancel", { synthesis_id: synthesisId }).catch(() => null);
      try {
        await tauri.restartSidecar();
      } catch (error) {
        cancelRequestedRef.current = false;
        setCancelRequested(false);
        throw error;
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["synth-history"] });
      qc.invalidateQueries({ queryKey: ["synth-running"] });
      qc.invalidateQueries({ queryKey: ["sidecar-status"] });
      qc.invalidateQueries({ queryKey: ["voice-prompts", activeModel] });
    },
  });

  const generationInProgress = running || synth.isPending;
  const activeCancellableSynthesisId =
    displayProgress?.synthesis_id && displayProgress.synthesis_id !== "pending"
      ? displayProgress.synthesis_id
      : null;
  const cancelDisabled =
    !activeCancellableSynthesisId || cancelRequested || cancelGeneration.isPending;
  const showDetailedDiagnostics = showGenerationDiagnostics && !simpleMode;
  const generatedGroups = useMemo(() => groupSynthesisHistory(history.data), [history.data]);
  const selectedDraft = useMemo(
    () => promptDrafts.find((draft) => draft.id === selectedDraftId),
    [promptDrafts, selectedDraftId],
  );
  const historyOptions = useMemo(() => historyFilterOptions(history.data), [history.data]);
  const filteredGroups = useMemo(
    () =>
      filterGeneratedGroups(generatedGroups, {
        search: historySearch,
        voiceId: historyVoiceFilter,
        modelId: simpleMode ? "all" : historyModelFilter,
        status: simpleMode ? "all" : historyStatusFilter,
      }),
    [
      generatedGroups,
      historyModelFilter,
      historySearch,
      historyStatusFilter,
      historyVoiceFilter,
      simpleMode,
    ],
  );

  useEffect(() => {
    if (selectedDraftId && !selectedDraft) {
      setSelectedDraftId("");
    }
  }, [selectedDraft, selectedDraftId]);

  const saveCurrentDraft = useCallback(() => {
    if (!text.trim()) return;
    const name = window.prompt("Draft name", draftNameFromText(text));
    if (name === null) return;
    addPromptDraft(name, text);
  }, [addPromptDraft, text]);

  const renameSelectedDraft = useCallback(() => {
    if (!selectedDraft) return;
    const name = window.prompt("Draft name", selectedDraft.name);
    if (name === null) return;
    renamePromptDraft(selectedDraft.id, name);
  }, [renamePromptDraft, selectedDraft]);

  const deleteSelectedPromptDraft = useCallback(() => {
    if (!selectedDraft) return;
    const ok = window.confirm(`Delete draft "${selectedDraft.name}"?`);
    if (!ok) return;
    deletePromptDraft(selectedDraft.id);
    setSelectedDraftId("");
  }, [deletePromptDraft, selectedDraft]);

  const restoreRun = useCallback((run: SynthesisHistoryItem) => {
    if (run.voice_deleted || run.model_deleted) return;
    setText(run.full_text);
    setModelId(run.model_id);
    setVoiceId(run.voice_id);
    setRunCount(clampRunCount(run.batch_count && run.batch_count > 1 ? run.batch_count : 1));

    const rawSeed = run.params?.seed;
    setSeed(
      typeof rawSeed === "number" || typeof rawSeed === "string"
        ? String(rawSeed)
        : "",
    );

    resetSynthParams(run.model_id);
    const modelMeta = models?.find((m) => m.id === run.model_id);
    const runLanguage = typeof run.params?.language === "string" ? run.params.language : "";
    if (runLanguage && modelSupportsLanguage(modelMeta?.languages ?? [], runLanguage)) {
      setStudioLanguage(run.model_id, runLanguage);
    }
    for (const param of modelMeta?.params ?? []) {
      const value = run.params?.[param.key];
      if (typeof value === "number") {
        setSynthParam(run.model_id, param.key, value);
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [
    models,
    resetSynthParams,
    setModelId,
    setRunCount,
    setSeed,
    setStudioLanguage,
    setSynthParam,
    setText,
    setVoiceId,
  ]);


  return (
    <div className="p-8 max-w-5xl mx-auto">
      <header className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Studio</h1>
          <p className="text-sm text-zinc-400">
            Clone a voice from a short reference clip, then synthesize on your machine.
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          {sidecar?.running ? <span className="text-emerald-400">● sidecar ready</span>
            : <span>○ sidecar starting…</span>}
          {caps && (
            <span className="ml-3">
              compute:{" "}
              <span className="text-zinc-300">
                {computeModeLabel(devicePreference, device, backend?.backend)}
              </span>
            </span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <div className="card p-4 col-span-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="text-xs font-medium text-zinc-400">Text</label>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              disabled={!text.trim()}
              onClick={saveCurrentDraft}
              title="Save current text as a draft"
            >
              <Save className="w-3 h-3" />
              Save draft
            </button>
          </div>
          <textarea
            className="input min-h-[140px] resize-y"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {promptDrafts.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="input min-w-0 flex-1 py-1.5 text-xs"
                value={selectedDraftId}
                onChange={(e) => setSelectedDraftId(e.target.value)}
                aria-label="Prompt drafts"
              >
                <option value="">Drafts...</option>
                {promptDrafts.map((draft) => (
                  <option key={draft.id} value={draft.id}>
                    {draft.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={!selectedDraft}
                onClick={() => selectedDraft && setText(selectedDraft.text)}
              >
                <Play className="w-3 h-3" />
                Load
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={!selectedDraft}
                onClick={renameSelectedDraft}
                title="Rename draft"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs text-red-300 hover:text-red-200"
                disabled={!selectedDraft}
                onClick={deleteSelectedPromptDraft}
                title="Delete draft"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="mt-4 flex gap-2 items-center">
            <button
              className="btn-primary"
              disabled={!voiceId || !activeModel || !modelReady || !text.trim() || generationInProgress}
              onClick={() => synth.mutate()}
            >
              {generationInProgress ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {cancelRequested ? "Cancelling…" : generationInProgress ? "Synthesizing…" : "Synthesize"}
            </button>
            {generationInProgress && (
              <button
                type="button"
                className="btn-ghost px-3 py-2 text-sm text-red-300 hover:text-red-200"
                disabled={cancelDisabled}
                onClick={() => cancelGeneration.mutate()}
                title={
                  activeCancellableSynthesisId
                    ? "Cancel this generation permanently"
                    : "Waiting for synthesis to start"
                }
              >
                {cancelGeneration.isPending || cancelRequested ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                Cancel
              </button>
            )}
            <div
              className="inline-flex h-9 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900"
              title="Synthesis count"
            >
              <button
                type="button"
                className="flex w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                disabled={generationInProgress || runCount <= 1}
                onClick={() => setRunCount(runCount - 1)}
                aria-label="Decrease synthesis count"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <div className="flex min-w-10 items-center justify-center border-x border-zinc-800 px-2 text-sm font-medium tabular-nums text-zinc-100">
                {runCount}x
              </div>
              <button
                type="button"
                className="flex w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                disabled={generationInProgress || runCount >= 10}
                onClick={() => setRunCount(runCount + 1)}
                aria-label="Increase synthesis count"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            </div>
            {!modelReady && activeModel && modelStatuses && (
              <Link
                to="/models"
                className="inline-flex items-center gap-1.5 text-xs text-amber-300 hover:text-amber-200"
              >
                <AlertCircle className="w-3.5 h-3.5" />
                {activeModelStatus?.deps_installed
                  ? "weights not downloaded — install"
                  : "model not installed"}
              </Link>
            )}
            {synth.error && progress?.phase !== "cancelled" && (
              <span className="text-xs text-red-400">{(synth.error as Error).message}</span>
            )}
            {cancelGeneration.error && (
              <span className="text-xs text-red-400">
                {(cancelGeneration.error as Error).message}
              </span>
            )}
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-zinc-400">Model</label>
          </div>
          <select
            className={cn("input", generationInProgress && "cursor-not-allowed opacity-60")}
            value={activeModel}
            disabled={generationInProgress}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.license}
              </option>
            ))}
          </select>
          {modelHasLanguageChoice ? (
            <div className="mt-4">
              <label className="mb-2 block text-xs font-medium text-zinc-400">
                Language
              </label>
              <select
                className={cn("input", generationInProgress && "cursor-not-allowed opacity-60")}
                value={activeLanguage}
                disabled={generationInProgress}
                onChange={(e) => setStudioLanguage(activeModel, e.target.value)}
              >
                {modelLanguages.map((language) => (
                  <option key={language} value={language}>
                    {languageLabel(language)}
                  </option>
                ))}
              </select>
            </div>
          ) : modelLanguages.length === 1 ? (
            <div className="mt-2 text-[11px] text-zinc-500">
              {languageLabel(modelLanguages[0])} only
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-zinc-400">Voice</label>
            <button
              className="btn-ghost px-2 py-1 text-xs"
              disabled={generationInProgress}
              onClick={() => setVoiceDialogOpen(true)}
            >
              <Plus className="w-3 h-3" /> add
            </button>
          </div>
          <div className="space-y-1.5 max-h-72 overflow-auto">
            {totalVoices === 0 && (
              <div className="text-xs text-zinc-500 py-3">
                No voices yet. Add a 5–15s reference clip.
              </div>
            )}
            {totalVoices > 0 && selectableVoices.length === 0 && (
              <div className="text-xs text-zinc-500 py-3">
                {modelReady
                  ? "No voices have a prompt for the selected model."
                  : "Install the selected model first."}
              </div>
            )}
            {selectableVoices.map((v) => {
              const ready = promptReady.has(v.id);
              return (
                <button
                  key={v.id}
                  className={cn(
                    "w-full text-left rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    voiceId === v.id
                      ? "bg-indigo-500/20 text-indigo-100 ring-1 ring-indigo-500/40"
                      : "hover:bg-zinc-800/60",
                    generationInProgress && "cursor-not-allowed opacity-60",
                  )}
                  disabled={generationInProgress}
                  onClick={() => setVoiceId(v.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{v.name}</span>
                    <span className="text-[11px] text-zinc-500">v{v.version}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {v.prompt_only
                      ? "prompt-only import"
                      : `${(v.ref_duration_ms / 1000).toFixed(1)}s · ${v.ref_audio_sr} Hz`}
                  </div>
                  <div
                    className={cn(
                      "text-[11px] mt-0.5",
                      ready ? "text-emerald-300/80" : "text-zinc-500",
                    )}
                  >
                    {ready ? "prompt ready" : "will prepare on synth"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {!simpleMode && (
        <section className="mt-4">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Advanced
          </button>
          {advancedOpen && (
            <div className="card p-4 mt-2 space-y-4">
              {hasAdvancedControls ? (
                <>
                  {paramSchema.length > 0 && (
                    <ParamControls
                      schema={paramSchema}
                      values={storedParams}
                      disabled={generationInProgress}
                      onChange={(key, value) => setSynthParam(activeModel, key, value)}
                      onResetKey={(key) => {
                        const next = { ...(synthParamsAll[activeModel] ?? {}) };
                        delete next[key];
                        if (Object.keys(next).length === 0) {
                          resetSynthParams(activeModel);
                        } else {
                          const def = paramSchema.find((p) => p.key === key)?.default;
                          if (def !== undefined) setSynthParam(activeModel, key, def);
                        }
                      }}
                    />
                  )}
                  {isTurbo && (
                    <p className="text-[11px] text-amber-300/90">
                      Turbo ignores expressive controls — switch to Chatterbox English to tune
                      exaggeration and reference adherence.
                    </p>
                  )}
                  {paramSchema.length > 0 && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => resetSynthParams(activeModel)}
                        disabled={generationInProgress || Object.keys(storedParams).length === 0}
                      >
                        <RotateCcw className="w-3 h-3" /> Reset all
                      </button>
                    </div>
                  )}
                  <div className="border-t border-zinc-800/80" />
                </>
              ) : null}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-300">Seed</label>
                  <button
                    type="button"
                    className="btn-ghost px-1.5 py-1 disabled:opacity-30"
                    title="Clear (use random seed)"
                    disabled={generationInProgress || seedInput === ""}
                    onClick={() => setSeed("")}
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className={cn("input", generationInProgress && "cursor-not-allowed opacity-60")}
                  placeholder="random"
                  value={seedInput}
                  disabled={generationInProgress}
                  onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
                />
                <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                  Set an integer for reproducible runs; leave blank for a fresh random seed each chunk.
                </p>
              </div>
            </div>
          )}
        </section>
      )}

      <VoiceCreateDialog
        open={voiceDialogOpen}
        onClose={() => setVoiceDialogOpen(false)}
        onCreated={(v) => {
          if (!generationInProgress) setVoiceId(v.id);
        }}
      />

      {(running || displayProgress?.phase === "failed" || displayProgress?.phase === "cancelled") && (
        <SynthProgressPanel
          progress={displayProgress}
          running={running}
          elapsedMs={uiElapsedMs}
          backendKind={backend?.backend}
          showDiagnostics={showDetailedDiagnostics}
        />
      )}

      <section className="mt-8 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Generated Audio</h2>
          {history.isFetching && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              refreshing
            </span>
          )}
        </div>
        {(history.data?.length ?? 0) > 0 && (
          <div
            className={cn(
              "grid gap-2",
              simpleMode
                ? "md:grid-cols-[minmax(0,1fr)_160px]"
                : "md:grid-cols-[minmax(0,1fr)_160px_160px_130px]",
            )}
          >
            <input
              className="input py-1.5 text-xs"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Search generated text..."
            />
            <select
              className="input py-1.5 text-xs"
              value={historyVoiceFilter}
              onChange={(e) => setHistoryVoiceFilter(e.target.value)}
              aria-label="Filter by voice"
            >
              <option value="all">All voices</option>
              {historyOptions.voices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {!simpleMode && (
              <>
                <select
                  className="input py-1.5 text-xs"
                  value={historyModelFilter}
                  onChange={(e) => setHistoryModelFilter(e.target.value)}
                  aria-label="Filter by model"
                >
                  <option value="all">All models</option>
                  {historyOptions.models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input py-1.5 text-xs"
                  value={historyStatusFilter}
                  onChange={(e) => setHistoryStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  <option value="ready">Ready</option>
                  <option value="partial">Partial</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="running">Running</option>
                </select>
              </>
            )}
          </div>
        )}
        {history.data?.length === 0 && (
          <div className="text-sm text-zinc-500">
            Generated runs will appear here with their model, prompt, date, and playback controls.
          </div>
        )}
        {(history.data?.length ?? 0) > 0 && filteredGroups.length === 0 && (
          <div className="text-sm text-zinc-500">
            No generated runs match the current filters.
          </div>
        )}
        {filteredGroups.map((group) => (
          <GeneratedRunGroup
            key={group.key}
            group={group}
            backendKind={backend?.backend}
            showDiagnostics={showDetailedDiagnostics}
            generationInProgress={generationInProgress}
            simpleMode={simpleMode}
            onUseRun={restoreRun}
          />
        ))}
      </section>
    </div>
  );
}

function SynthProgressPanel({
  progress,
  running,
  elapsedMs,
  backendKind,
  showDiagnostics,
}: {
  progress: SynthProgress | null;
  running: boolean;
  elapsedMs: number;
  backendKind?: BackendKind | null;
  showDiagnostics: boolean;
}) {
  const fraction = progress?.fraction;
  const memory = progress?.memory ?? {};
  const memoryEntries = Object.entries(memory).filter(([, v]) => v > 0);
  const failed = progress?.phase === "failed";
  const cancelled = progress?.phase === "cancelled";

  return (
    <section className="mt-6 card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-zinc-300">Synthesis Progress</h2>
          <div className="mt-1 text-xs text-zinc-400">
            {failed
              ? progress?.message ?? "Synthesis failed"
              : cancelled
                ? progress?.message ?? "Synthesis cancelled"
              : running
                ? "Generating audio"
                : progress?.message ?? "Starting synthesis"}
          </div>
        </div>
        <div className="text-[11px] text-zinc-500 tabular-nums shrink-0">
          {formatDuration(elapsedMs)}
        </div>
      </div>

      <div className="mt-3 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        {cancelled ? (
          <div className="h-full w-full bg-zinc-700" />
        ) : typeof fraction === "number" ? (
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-gradient-to-r from-indigo-500 to-fuchsia-500 animate-indeterminate" />
        )}
      </div>

      {showDiagnostics && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
          <Metric label="Phase" value={progress?.phase ?? (running ? "starting" : "idle")} />
          <Metric
            label="Chunk"
            value={
              progress?.chunk_idx !== null && progress?.chunk_idx !== undefined
                ? `${progress.chunk_idx + 1} / ${progress.chunk_count}`
                : progress?.chunk_count
                  ? `0 / ${progress.chunk_count}`
                  : "—"
            }
          />
          <Metric
            label="Requested"
            value={displayDeviceLabel(progress?.requested_device, backendKind) || "—"}
          />
          <Metric
            label="Resolved"
            value={displayDeviceLabel(progress?.resolved_device, backendKind) || "pending"}
          />
          <Metric label="Placement" value={progress?.device_detail ?? "pending"} wide />
          {progress?.fallback_device && (
            <Metric
              label="Fallback"
              value={displayDeviceLabel(progress.fallback_device, backendKind)}
            />
          )}
        </div>
      )}

      {progress?.fallback_device && (
        <div className="mt-3 text-[11px] text-amber-300/90">
          Using CPU fallback for this run.
        </div>
      )}

      {showDiagnostics && memoryEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {memoryEntries.map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-zinc-800/70 px-2 py-1 text-[11px] text-zinc-400"
            >
              {memoryLabel(k, backendKind)}:{" "}
              <span className="text-zinc-200">{formatBytesFromBytes(v)}</span>
            </span>
          ))}
        </div>
      )}

      {showDiagnostics && progress?.warnings && progress.warnings.length > 0 && (
        <div className="mt-3 space-y-1">
          {progress.warnings.map((w) => (
            <div key={w} className="text-[11px] text-amber-300/90">
              {w}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={cn(wide && "col-span-2")}>
      <div className="uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="mt-0.5 truncate text-zinc-300">{value}</div>
    </div>
  );
}

function memoryLabel(k: string, backend: BackendKind | null | undefined): string {
  const acceleratorPrefix = backend === "rocm" ? "rocm " : "cuda ";
  return k
    .replace(/_bytes$/, "")
    .replace(/^mps_/, "mps ")
    .replace(/^cuda_/, acceleratorPrefix)
    .replaceAll("_", " ");
}

function formatBytesFromBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function clampRunCount(value: number): number {
  return Math.max(MIN_SYNTH_RUN_COUNT, Math.min(MAX_SYNTH_RUN_COUNT, Math.round(value)));
}

function createBatchId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface GeneratedRunGroupData {
  key: string;
  runs: SynthesisHistoryItem[];
  favorite?: SynthesisHistoryItem;
  createdAtMs: number;
}

function groupSynthesisHistory(runs: SynthesisHistoryItem[] | undefined): GeneratedRunGroupData[] {
  const grouped = new Map<string, SynthesisHistoryItem[]>();
  for (const run of runs ?? []) {
    const key = run.batch_id || run.id;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return [...grouped.entries()]
    .map(([key, groupRuns]) => {
      const sortedRuns = [...groupRuns].sort(compareSynthRunsInBatch);
      return {
        key,
        runs: sortedRuns,
        favorite: sortedRuns.find((run) => run.is_favorite),
        createdAtMs: Math.max(...sortedRuns.map((run) => timestampMs(run.created_at))),
      };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

interface GeneratedHistoryFilters {
  search: string;
  voiceId: string;
  modelId: string;
  status: string;
}

function sortModelLanguages(languages: string[]): string[] {
  return [...new Set(languages.map(normalizeLanguageKey))];
}

function resolveModelLanguage(languages: string[], stored: string | undefined): string {
  const normalizedStored = stored ? normalizeLanguageKey(stored) : "";
  if (normalizedStored && languages.includes(normalizedStored)) {
    return normalizedStored;
  }
  return languages[0] ?? "english";
}

function modelSupportsLanguage(languages: string[], language: string): boolean {
  const normalized = normalizeLanguageKey(language);
  return languages.some((candidate) => normalizeLanguageKey(candidate) === normalized);
}

function languageLabel(language: string): string {
  const normalized = normalizeLanguageKey(language);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeLanguageKey(language: string): string {
    return language.toLowerCase();
}

function synthesisLanguage(run: SynthesisHistoryItem): string | undefined {
  return typeof run.params?.language === "string" ? run.params.language : undefined;
}

function filterGeneratedGroups(
  groups: GeneratedRunGroupData[],
  filters: GeneratedHistoryFilters,
): GeneratedRunGroupData[] {
  const search = filters.search.trim().toLowerCase();
  return groups.filter((group) => {
    if (filters.status !== "all" && synthesisGroupStatus(group.runs) !== filters.status) {
      return false;
    }
    if (filters.voiceId !== "all" && !group.runs.some((run) => run.voice_id === filters.voiceId)) {
      return false;
    }
    if (filters.modelId !== "all" && !group.runs.some((run) => run.model_id === filters.modelId)) {
      return false;
    }
    if (!search) return true;
    return group.runs.some((run) => {
      const language = synthesisLanguage(run);
      return [
        run.full_text,
        run.voice_name,
        run.model_name,
        run.status,
        language ?? "",
        language ? languageLabel(language) : "",
      ].some((value) => value.toLowerCase().includes(search));
    });
  });
}

function historyFilterOptions(runs: SynthesisHistoryItem[] | undefined): {
  voices: { id: string; label: string }[];
  models: { id: string; label: string }[];
} {
  const voices = new Map<string, string>();
  const models = new Map<string, string>();
  for (const run of runs ?? []) {
    voices.set(run.voice_id, run.voice_name);
    models.set(run.model_id, run.model_name);
  }
  return {
    voices: [...voices.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    models: [...models.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function draftNameFromText(text: string): string {
  const firstLine = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return firstLine || `Draft ${new Date().toLocaleDateString()}`;
}

function compareSynthRunsInBatch(a: SynthesisHistoryItem, b: SynthesisHistoryItem): number {
  const ai = typeof a.batch_index === "number" ? a.batch_index : Number.MAX_SAFE_INTEGER;
  const bi = typeof b.batch_index === "number" ? b.batch_index : Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return timestampMs(a.created_at) - timestampMs(b.created_at);
}

function synthesisTakeLabel(
  run: SynthesisHistoryItem,
  fallbackIndex: number,
  groupSize: number,
): string | undefined {
  if (groupSize <= 1) return undefined;
  const index = typeof run.batch_index === "number" ? run.batch_index : fallbackIndex;
  const total =
    typeof run.batch_count === "number" && run.batch_count > 1 ? run.batch_count : groupSize;
  return `Take ${index + 1} of ${total}`;
}

function timestampMs(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusBadgeClass(status: string): string {
  return cn(
    "text-[11px] px-1.5 py-0.5 rounded",
    status === "ready"
      ? "bg-emerald-500/10 text-emerald-300"
      : status === "failed"
        ? "bg-red-500/10 text-red-300"
        : status === "cancelled"
          ? "bg-zinc-800 text-zinc-300"
          : status === "partial"
            ? "bg-amber-500/10 text-amber-300"
            : "bg-zinc-800 text-zinc-400",
  );
}

function synthesisGroupStatus(runs: SynthesisHistoryItem[]): string {
  if (runs.some((run) => run.status === "running" || run.status === "pending")) {
    return "running";
  }
  if (runs.every((run) => run.status === "ready")) return "ready";
  if (runs.every((run) => run.status === "cancelled")) return "cancelled";
  if (runs.every((run) => run.status === "failed")) return "failed";
  if (runs.some((run) => run.status === "ready")) return "partial";
  if (runs.some((run) => run.status === "cancelled")) return "cancelled";
  return runs[0]?.status ?? "pending";
}

function runDeviceLabel(
  run: SynthesisHistoryItem,
  backend: BackendKind | null | undefined,
): string {
  return deviceTransitionLabel(run.requested_device, run.resolved_device, backend);
}

function synthesisGroupDeviceLabel(
  runs: SynthesisHistoryItem[],
  backend: BackendKind | null | undefined,
): string {
  const labels = new Set(runs.map((run) => runDeviceLabel(run, backend)).filter(Boolean));
  if (labels.size === 0) return "";
  if (labels.size === 1) return [...labels][0];
  return "mixed devices";
}

function playableAudioCount(runs: SynthesisHistoryItem[]): number {
  return runs.filter((run) => run.status === "ready" && !!run.final_audio_path).length;
}

async function exportSynthesisAudio(
  run: SynthesisHistoryItem,
  takeLabel?: string,
): Promise<void> {
  if (!run.final_audio_path) return;
  const takeSuffix = takeLabel ? `-${safeFilename(takeLabel)}` : "";
  const destination = await saveFileDialog({
    defaultPath: `${safeFilename(run.voice_name)}-${new Date(run.created_at).toISOString().slice(0, 10)}${takeSuffix}.wav`,
    filters: [{ name: "WAV audio", extensions: ["wav"] }],
  });
  if (!destination) return;
  await tauri.exportAudio(run.final_audio_path, destination);
}

function useOneLineOverflow(text: string) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = ref.current;
        if (!current) return;

        const style = window.getComputedStyle(current);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const oneLineHeight = Number.isFinite(lineHeight)
          ? lineHeight
          : current.getBoundingClientRect().height;
        const clone = current.cloneNode(true) as HTMLElement;
        clone.style.position = "absolute";
        clone.style.visibility = "hidden";
        clone.style.pointerEvents = "none";
        clone.style.left = "-10000px";
        clone.style.top = "0";
        clone.style.boxSizing = "border-box";
        clone.style.width = `${current.getBoundingClientRect().width}px`;
        clone.style.height = "auto";
        clone.style.maxHeight = "none";
        clone.style.overflow = "visible";
        clone.style.display = "block";
        clone.style.setProperty("-webkit-line-clamp", "unset");
        clone.style.setProperty("-webkit-box-orient", "unset");
        document.body.appendChild(clone);
        const fullHeight = clone.scrollHeight;
        clone.remove();

        setOverflows(fullHeight > oneLineHeight + 1);
      });
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  return { ref, overflows };
}

function GeneratedRunGroup({
  group,
  backendKind,
  showDiagnostics,
  generationInProgress,
  simpleMode,
  onUseRun,
}: {
  group: GeneratedRunGroupData;
  backendKind?: BackendKind | null;
  showDiagnostics: boolean;
  generationInProgress: boolean;
  simpleMode: boolean;
  onUseRun: (run: SynthesisHistoryItem) => void;
}) {
  const qc = useQueryClient();
  const { data: models } = useModels();
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const canSelectBest = playableAudioCount(group.runs) > 1;
  const selectedTake = canSelectBest ? group.favorite : undefined;
  const primary = selectedTake ?? group.runs[0];
  const { ref: promptRef, overflows: promptCanExpand } = useOneLineOverflow(
    primary?.full_text ?? "",
  );
  const primaryIndex = primary
    ? group.runs.findIndex((candidate) => candidate.id === primary.id)
    : -1;
  const primaryTakeLabel = primary
    ? synthesisTakeLabel(
        primary,
        primaryIndex >= 0 ? primaryIndex : 0,
        group.runs.length,
      )
    : undefined;
  const primaryExport = useMutation({
    mutationFn: async () => {
      if (!primary) return;
      await exportSynthesisAudio(primary, primaryTakeLabel);
    },
  });
  const deleteGroup = useMutation({
    mutationFn: () =>
      tauri.rpc<SynthDeleteResult>("synth.delete", {
        synthesis_ids: group.runs.map((run) => run.id),
      }),
    onSuccess: () => {
      setDeleteDialogOpen(false);
      setExpanded(false);
      qc.invalidateQueries({ queryKey: ["synth-history"] });
      group.runs.forEach((run) => {
        qc.removeQueries({ queryKey: ["synth-chunks", run.id] });
      });
    },
  });
  useEffect(() => {
    setExpanded(false);
  }, [selectedTake?.id]);
  useEffect(() => {
    setPromptExpanded(false);
  }, [primary?.id]);
  useEffect(() => {
    if (!promptCanExpand) setPromptExpanded(false);
  }, [promptCanExpand]);
  if (!primary) return null;

  const groupStatus = synthesisGroupStatus(group.runs);
  const otherRuns = group.runs.filter((run) => run.id !== primary.id);
  const deviceInfo = showDiagnostics ? synthesisGroupDeviceLabel(group.runs, backendKind) : "";
  const voiceDeleted = group.runs.some((run) => run.voice_deleted);
  const modelDeleted = group.runs.some((run) => run.model_deleted);
  const showGroupStatus = groupStatus !== "ready";
  const primaryPlayable = primary.status === "ready" && !!primary.final_audio_path;
  const deleteLocked = group.runs.some((run) => run.status === "pending" || run.status === "running");
  const primaryLanguage = synthesisLanguage(primary);
  const primaryModelMeta = models?.find((m) => m.id === primary.model_id);
  return (
    <article className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="relative min-w-0 flex-1">
          <p
            ref={promptRef}
            className={cn(
              "text-sm leading-6 text-zinc-100",
              !promptExpanded && "line-clamp-1",
              !promptExpanded && promptCanExpand && "pr-8",
            )}
          >
            {primary.full_text}
          </p>
          {!promptExpanded && promptCanExpand && (
            <button
              type="button"
              className="absolute bottom-0 right-0 rounded bg-zinc-950 px-1.5 text-xs leading-6 text-zinc-400 hover:text-zinc-100"
              aria-label="Show full prompt"
              title="Show full prompt"
              onClick={() => setPromptExpanded(true)}
            >
              ...
            </button>
          )}
          {promptExpanded && promptCanExpand && (
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                className="btn-ghost h-6 w-6 p-0"
                aria-label="Collapse prompt"
                title="Collapse prompt"
                onClick={() => setPromptExpanded(false)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
        {!simpleMode && (
          <button
            type="button"
            className="btn-ghost shrink-0 px-2 py-1 text-xs"
            disabled={generationInProgress || primary.voice_deleted || primary.model_deleted}
            onClick={() => onUseRun(primary)}
            title={
              primary.voice_deleted || primary.model_deleted
                ? "Cannot reuse deleted voice or model"
                : "Restore this run in Studio"
            }
          >
            <RotateCcw className="w-3 h-3" />
            Use again
          </button>
        )}
      </div>

      <div className="mt-3">
        {primaryPlayable ? (
          <Waveform
            key={`${primary.final_audio_path}-${primary.updated_at}`}
            path={primary.final_audio_path!}
          />
        ) : (
          <div className="text-xs text-zinc-500">
            {primary.status === "cancelled" ? "Generation was cancelled." : "Audio is not playable yet."}
          </div>
        )}
      </div>

      {expanded && otherRuns.length > 0 && (
        <div className="mt-4 space-y-2">
          {otherRuns.map((run, index) => {
            const originalIndex = group.runs.findIndex((candidate) => candidate.id === run.id);
            return (
              <GeneratedTake
                key={run.id}
                run={run}
                backendKind={backendKind}
                canSelectBest={canSelectBest}
                showDiagnostics={showDiagnostics}
                generationInProgress={generationInProgress}
                simpleMode={simpleMode}
                takeLabel={synthesisTakeLabel(
                  run,
                  originalIndex >= 0 ? originalIndex : index,
                  group.runs.length,
                )}
                onUseRun={onUseRun}
              />
            );
          })}
        </div>
      )}

      {primaryExport.error && (
        <div className="mt-2 text-[11px] text-red-400">
          {(primaryExport.error as Error).message}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800/70 pt-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span className="inline-flex min-w-0 items-center gap-1">
            <span className="truncate text-zinc-300">{primary.voice_name}</span>
            <span className="text-zinc-600">v{primary.voice_version}</span>
          </span>
          <span className="uppercase tracking-wide text-zinc-500">{primary.model_name}</span>
          {primaryLanguage && (
            <span title={primaryLanguage}>{languageLabel(primaryLanguage)}</span>
          )}
          <span className="tabular-nums">{formatDateTime(group.createdAtMs)}</span>
          {deviceInfo && <span>{deviceInfo}</span>}
          {voiceDeleted && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300">
              Voice deleted
            </span>
          )}
          {modelDeleted && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
              Model deleted
            </span>
          )}
          {showGroupStatus && (
            <span className={statusBadgeClass(groupStatus)}>
              {groupStatus}
            </span>
          )}
          {primary.fallback_device && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300"
              title={primary.fallback_reason ?? undefined}
            >
              fallback: {primary.fallback_device}
            </span>
          )}
          {group.runs.length > 1 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800/70 text-zinc-300">
              {group.runs.length} takes
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {otherRuns.length > 0 && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {expanded ? "Hide takes" : "Show all takes"}
            </button>
          )}
          {primaryPlayable && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              disabled={primaryExport.isPending}
              onClick={() => primaryExport.mutate()}
              title="Export WAV"
            >
              {primaryExport.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              Export
            </button>
          )}
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs text-red-300 hover:text-red-200"
            disabled={deleteLocked || deleteGroup.isPending}
            onClick={() => {
              deleteGroup.reset();
              setDeleteDialogOpen(true);
            }}
            title={
              deleteLocked
                ? "Cannot delete a generated entry while it is pending or running"
                : "Delete generated entry"
            }
          >
            {deleteGroup.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            Delete
          </button>
        </div>
      </div>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => {
          if (!deleteGroup.isPending) setDeleteDialogOpen(false);
        }}
        title="Delete generated entry"
        description={
          group.runs.length > 1
            ? `This removes all ${group.runs.length} takes from history and deletes their generated audio.`
            : "This removes the entry from history and deletes its generated audio."
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300 line-clamp-3">
            {primary.full_text}
          </p>
          {deleteGroup.error && (
            <div className="text-xs text-red-400">
              {(deleteGroup.error as Error).message}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-2 text-sm"
              disabled={deleteGroup.isPending}
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-2 text-sm text-red-300 hover:text-red-200"
              disabled={deleteGroup.isPending}
              onClick={() => deleteGroup.mutate()}
            >
              {deleteGroup.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              Delete
            </button>
          </div>
        </div>
      </Dialog>

      {!simpleMode && (
        <ParamBadgeRow
          run={primary}
          modelMeta={primaryModelMeta}
          className="mt-3 border-t border-zinc-800/70 pt-3"
        />
      )}
    </article>
  );
}

function GeneratedTake({
  run,
  backendKind,
  takeLabel,
  canSelectBest,
  showDiagnostics,
  generationInProgress,
  simpleMode,
  onUseRun,
}: {
  run: SynthesisHistoryItem;
  backendKind?: BackendKind | null;
  takeLabel?: string;
  canSelectBest: boolean;
  showDiagnostics: boolean;
  generationInProgress: boolean;
  simpleMode: boolean;
  onUseRun: (run: SynthesisHistoryItem) => void;
}) {
  const qc = useQueryClient();
  const { data: models } = useModels();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const chunks = useSynthChunks(run.id, { enabled: !simpleMode && detailsOpen });
  const modelMeta = models?.find((m) => m.id === run.model_id);
  const playable = run.status === "ready" && !!run.final_audio_path;
  const deviceInfo = runDeviceLabel(run, backendKind);
  const exportAudio = useMutation({
    mutationFn: () => exportSynthesisAudio(run, takeLabel),
  });
  const favorite = useMutation({
    mutationFn: async () => {
      await tauri.rpc("synth.set_favorite", { synthesis_id: run.id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["synth-history"] });
    },
  });

  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {takeLabel && (
              <span className="text-xs font-medium text-zinc-200">
                {takeLabel}
              </span>
            )}
            {run.status !== "ready" && (
              <span className={statusBadgeClass(run.status)}>
                {run.status}
              </span>
            )}
            {run.fallback_device && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300"
                title={run.fallback_reason ?? undefined}
              >
                fallback: {run.fallback_device}
              </span>
            )}
          </div>
          {showDiagnostics && deviceInfo && (
            <div className="text-[11px] text-zinc-500 mt-0.5">
              {deviceInfo}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!simpleMode && (
            <>
              <button
                className="btn-ghost px-2 py-1 text-xs"
                disabled={generationInProgress || run.voice_deleted || run.model_deleted}
                onClick={() => onUseRun(run)}
                title={
                  run.voice_deleted || run.model_deleted
                    ? "Cannot reuse deleted voice or model"
                    : "Restore this take in Studio"
                }
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => setDetailsOpen((v) => !v)}
                title="Show chunks"
              >
                {detailsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Chunks
              </button>
            </>
          )}
          {playable && (
            <>
              {canSelectBest && (
                <button
                  className={cn(
                    "btn-ghost px-2 py-1 text-xs",
                    run.is_favorite && "text-amber-300 hover:text-amber-200",
                  )}
                  disabled={favorite.isPending}
                  onClick={() => favorite.mutate()}
                  title="Select best take"
                  aria-label="Select best take"
                >
                  {favorite.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Star
                      className="w-3.5 h-3.5"
                      fill={run.is_favorite ? "currentColor" : "none"}
                    />
                  )}
                </button>
              )}
              <button
                className="btn-ghost px-2 py-1 text-xs"
                disabled={exportAudio.isPending}
                onClick={() => exportAudio.mutate()}
                title="Export WAV"
              >
                {exportAudio.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Export
              </button>
            </>
          )}
        </div>
      </div>

      {!simpleMode && (
        <ParamBadgeRow run={run} modelMeta={modelMeta} className="mt-3" />
      )}

      {exportAudio.error && (
        <div className="mt-2 text-[11px] text-red-400">
          {(exportAudio.error as Error).message}
        </div>
      )}
      {favorite.error && (
        <div className="mt-2 text-[11px] text-red-400">
          {(favorite.error as Error).message}
        </div>
      )}

      <div className="mt-3">
        {playable ? (
          <Waveform
            key={`${run.final_audio_path}-${run.updated_at}`}
            path={run.final_audio_path!}
          />
        ) : (
          <div className="text-xs text-zinc-500">
            {run.status === "cancelled" ? "Generation was cancelled." : "Audio is not playable yet."}
          </div>
        )}
      </div>

      {!simpleMode && detailsOpen && (
        <GeneratedChunkList
          run={run}
          chunks={chunks.data}
          loading={chunks.isLoading || chunks.isFetching}
          error={chunks.error}
          generationInProgress={generationInProgress}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["synth-history"] });
            qc.invalidateQueries({ queryKey: ["synth-chunks", run.id] });
          }}
        />
      )}
    </div>
  );
}

function GeneratedChunkList({
  run,
  chunks,
  loading,
  error,
  generationInProgress,
  onChanged,
}: {
  run: SynthesisHistoryItem;
  chunks: SynthesisChunk[] | undefined;
  loading: boolean;
  error: unknown;
  generationInProgress: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="mt-4 border-t border-zinc-800/80 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-zinc-300">Chunks</div>
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            loading
          </span>
        )}
      </div>
      {error ? (
        <div className="text-[11px] text-red-400">
          {(error as Error).message}
        </div>
      ) : null}
      {!loading && !error && chunks?.length === 0 && (
        <div className="text-xs text-zinc-500">
          No chunk records are available for this run.
        </div>
      )}
      <div className="space-y-2">
        {chunks?.map((chunk) => (
          <GeneratedChunk
            key={chunk.id}
            run={run}
            chunk={chunk}
            generationInProgress={generationInProgress}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

function GeneratedChunk({
  run,
  chunk,
  generationInProgress,
  onChanged,
}: {
  run: SynthesisHistoryItem;
  chunk: SynthesisChunk;
  generationInProgress: boolean;
  onChanged: () => void;
}) {
  const [draftText, setDraftText] = useState(chunk.text);
  const [seedText, setSeedText] = useState(String(chunk.seed));
  const locked = generationInProgress || run.voice_deleted || run.model_deleted || run.status === "cancelled";
  const playable = chunk.status === "ready" && !!chunk.audio_path;
  const dirty = draftText !== chunk.text || seedText !== String(chunk.seed);
  const overrideEntries = Object.entries(chunk.params_override ?? {});

  useEffect(() => {
    setDraftText(chunk.text);
    setSeedText(String(chunk.seed));
  }, [chunk.id, chunk.revision, chunk.seed, chunk.text]);

  const regenerate = useMutation({
    mutationFn: async () => {
      const seed = Number.parseInt(seedText, 10);
      if (!draftText.trim()) throw new Error("chunk text is empty");
      if (!Number.isFinite(seed)) throw new Error("seed must be an integer");
      return tauri.rpc("synth.regenerate_chunk", {
        chunk_id: chunk.id,
        text_override: draftText,
        seed,
      });
    },
    onSuccess: onChanged,
  });

  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">
            Chunk {chunk.idx + 1}
          </span>
          {chunk.status !== "ready" && (
            <span className={statusBadgeClass(chunk.status)}>
              {chunk.status}
            </span>
          )}
          <span className="text-[11px] text-zinc-500">
            rev {chunk.revision}
          </span>
          {chunk.duration_ms ? (
            <span className="text-[11px] tabular-nums text-zinc-500">
              {formatDuration(chunk.duration_ms)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {dirty && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              disabled={regenerate.isPending}
              onClick={() => {
                setDraftText(chunk.text);
                setSeedText(String(chunk.seed));
              }}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={locked || regenerate.isPending || !draftText.trim()}
            onClick={() => regenerate.mutate()}
            title={
              run.status === "cancelled"
                ? "Cancelled runs cannot be regenerated"
                : run.voice_deleted || run.model_deleted
                ? "Cannot regenerate after deleting the source voice or model"
                : "Regenerate this chunk and rebuild the full run"
            }
          >
            {regenerate.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            Regenerate
          </button>
        </div>
      </div>

      <textarea
        className="input min-h-[70px] resize-y text-xs"
        value={draftText}
        disabled={locked || regenerate.isPending}
        onChange={(e) => setDraftText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[11px] text-zinc-500">
          Seed
          <input
            className="input w-28 py-1 text-xs"
            inputMode="numeric"
            value={seedText}
            disabled={locked || regenerate.isPending}
            onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </label>
        {overrideEntries.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {overrideEntries.map(([key, value]) => (
              <span
                key={key}
                className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[11px] text-zinc-400"
              >
                {key}: {String(value)}
              </span>
            ))}
          </div>
        )}
      </div>

      {regenerate.error && (
        <div className="mt-2 text-[11px] text-red-400">
          {(regenerate.error as Error).message}
        </div>
      )}

      <div className="mt-3">
        {playable ? (
          <Waveform
            key={`${chunk.audio_path}-${chunk.revision}`}
            path={chunk.audio_path!}
          />
        ) : (
          <div className="text-xs text-zinc-500">
            {chunk.status === "cancelled" ? "Chunk was cancelled." : "Chunk audio is not playable yet."}
          </div>
        )}
      </div>
    </div>
  );
}

function formatNumber(value: number, step?: number): string {
  if (Number.isInteger(value) && (!step || Number.isInteger(step))) return String(value);
  const decimals = step ? Math.min(4, Math.max(0, -Math.floor(Math.log10(step)))) : 2;
  return value.toFixed(decimals);
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("synthesis cancelled") || message.includes("sidecar restarted");
}

function ParamBadgeRow({
  run,
  modelMeta,
  className,
}: {
  run: SynthesisHistoryItem;
  modelMeta: ModelInfo | undefined;
  className?: string;
}) {
  const badges: { key: string; label: string; value: string }[] = [];
  for (const schema of modelMeta?.params ?? []) {
    const raw = run.params?.[schema.key];
    const num = typeof raw === "number" ? raw : schema.default;
    badges.push({
      key: schema.key,
      label: schema.label,
      value: formatNumber(num, schema.step),
    });
  }
  const seed = run.params?.seed;
  if (seed !== undefined && seed !== null) {
    badges.push({ key: "seed", label: "seed", value: String(seed) });
  }
  if (badges.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {badges.map((b) => (
        <span
          key={b.key}
          className="rounded bg-zinc-800/70 px-2 py-0.5 text-[11px] text-zinc-300"
        >
          <span className="text-zinc-500">{b.label}: </span>
          <span className="tabular-nums">{b.value}</span>
        </span>
      ))}
    </div>
  );
}

function resolveDevicePreference(
  preference: DevicePreference,
  caps: { cuda: boolean; mps: boolean } | undefined,
): "cpu" | "cuda" | "mps" {
  if (preference === "cpu") return "cpu";
  if (preference === "cuda") return caps?.cuda ? "cuda" : "cpu";
  if (preference === "mps") return caps?.mps ? "mps" : "cpu";
  if (caps?.cuda) return "cuda";
  if (caps?.mps) return "mps";
  return "cpu";
}

function safeFilename(input: string): string {
  const cleaned = input.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned || "generated-audio";
}
