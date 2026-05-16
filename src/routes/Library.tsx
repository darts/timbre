import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Download, Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { tauri } from "@/lib/ipc";
import { useSynthRunningStatus, useVoices } from "@/lib/queries";
import { Voice } from "@/lib/schema";
import { useUiSettings } from "@/lib/settings";
import { VoiceCreateDialog } from "@/components/VoiceCreateDialog";
import { VoicePrepareControl } from "@/components/VoicePrepareControl";
import { formatDateTime } from "@/lib/utils";

export function Library() {
  const { data: voices } = useVoices();
  const synthRunning = useSynthRunningStatus({ refetchInterval: 1000 });
  const activeVoiceId = useUiSettings((s) => s.studioVoiceId);
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingVoice, setEditingVoice] = useState<Voice | null>(null);
  const requestInProgress = synthRunning.data?.running ?? false;

  const refreshVoices = () => {
    qc.invalidateQueries({ queryKey: ["voices"] });
    qc.invalidateQueries({ queryKey: ["voice-prompt"] });
    qc.invalidateQueries({ queryKey: ["voice-prompts"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => tauri.rpc("voices.delete", { voice_id: id }),
    onSuccess: () => {
      refreshVoices();
      qc.invalidateQueries({ queryKey: ["synth-history"] });
    },
  });

  const importPrompts = useMutation({
    mutationFn: async () => {
      const ok = window.confirm(
        "Import only trusted Timbre voice archives. Prompt archives contain model prompt payloads but no source recording or transcript.",
      );
      if (!ok) return null;
      const file = await openFileDialog({
        multiple: false,
        filters: [{ name: "Timbre voice", extensions: ["timbrevoice"] }],
      });
      if (!file) return null;
      const archivePath = typeof file === "string" ? file : (file as { path: string }).path;
      return tauri.rpc<Voice>("voices.import_prompts", { archive_path: archivePath });
    },
    onSuccess: (voice) => {
      if (!voice) return;
      refreshVoices();
    },
  });

  const exportPrompts = useMutation({
    mutationFn: async (voice: Voice) => {
      if ((voice.prompt_count ?? 0) <= 0) {
        throw new Error("Prepare this voice for a model before exporting prompts.");
      }
      const destination = await saveFileDialog({
        defaultPath: `${safeFilename(voice.name)}.timbrevoice`,
        filters: [{ name: "Timbre voice", extensions: ["timbrevoice"] }],
      });
      if (!destination) return null;
      return tauri.rpc("voices.export_prompts", {
        voice_id: voice.id,
        destination_path: destination,
      });
    },
  });

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header className="flex items-end justify-between mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Voices</h1>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => importPrompts.mutate()}
            disabled={importPrompts.isPending}
            title="Import a prompt-only voice archive"
          >
            {importPrompts.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            Import
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEditingVoice(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="w-4 h-4" /> Add voice
          </button>
        </div>
      </header>

      <div className="space-y-2">
        {voices?.length === 0 && (
          <div className="text-sm text-zinc-500">
            No voices yet. Add a 5–15s reference clip — clean, single-speaker audio works best.
          </div>
        )}
        {voices?.map((v) => {
          const deleteDisabled = requestInProgress && v.id === activeVoiceId;
          return (
            <div key={v.id} className="card p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-medium truncate">{v.name}</div>
                  <span className="text-[11px] rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                    v{v.version}
                  </span>
                  {v.prompt_only && (
                    <span className="text-[11px] rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-200">
                      prompt-only
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {v.prompt_only
                    ? `${promptCountLabel(v.prompt_count)} · ${formatDateTime(v.created_at)}`
                    : `${(v.ref_duration_ms / 1000).toFixed(1)}s · ${v.ref_audio_sr} Hz · ${formatDateTime(v.created_at)}`}
                </div>
                {!v.prompt_only && v.ref_transcript && (
                  <div className="text-xs text-zinc-400 mt-1.5 line-clamp-2">{v.ref_transcript}</div>
                )}
                {!v.prompt_only && !v.ref_transcript && (
                  <div className="text-[11px] text-amber-400/80 mt-1.5">
                    No transcript — cloning quality may be reduced.
                  </div>
                )}
                {v.prompt_only && (
                  <div className="text-[11px] text-zinc-500 mt-1.5">
                    Imported prompts only. Source recording and transcript are not available.
                  </div>
                )}
                {!v.prompt_only && (
                  <div className="mt-2">
                    <VoicePrepareControl voiceId={v.id} />
                  </div>
                )}
              </div>
              <button
                className="btn-ghost"
                onClick={() => exportPrompts.mutate(v)}
                disabled={exportPrompts.isPending || (v.prompt_count ?? 0) <= 0}
                title={
                  (v.prompt_count ?? 0) > 0
                    ? "Export cached prompts only"
                    : "Prepare this voice for a model before exporting prompts"
                }
              >
                {exportPrompts.isPending && exportPrompts.variables?.id === v.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
              </button>
              {!v.prompt_only && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditingVoice(v);
                    setDialogOpen(true);
                  }}
                  title="Edit voice"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
              <button
                className="btn-ghost"
                onClick={() => remove.mutate(v.id)}
                disabled={deleteDisabled || (remove.isPending && remove.variables === v.id)}
                title={
                  deleteDisabled
                    ? "Cannot delete the active voice while synthesis is running"
                    : "Delete voice and all versions"
                }
              >
                {remove.isPending && remove.variables === v.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {(importPrompts.error || exportPrompts.error) && (
        <div className="mt-3 text-xs text-red-400">
          {((importPrompts.error || exportPrompts.error) as Error).message}
        </div>
      )}

      <VoiceCreateDialog
        open={dialogOpen}
        voice={editingVoice}
        preserveCreateDraftOnClose
        onClose={() => {
          setDialogOpen(false);
          setEditingVoice(null);
        }}
      />
    </div>
  );
}

function promptCountLabel(count: number | undefined): string {
  const n = count ?? 0;
  return `${n} cached ${n === 1 ? "prompt" : "prompts"}`;
}

function safeFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "timbre-voice";
}
