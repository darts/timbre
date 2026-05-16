import { useMemo } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles } from "lucide-react";
import { tauri } from "@/lib/ipc";
import { useModels, useModelStatuses } from "@/lib/queries";
import { PromptStatus } from "@/lib/schema";

/** Per-voice control: shows whether voice-clone prompts have been built
 *  for installed models, and offers one-click "Prepare" actions. */
export function VoicePrepareControl({ voiceId }: { voiceId: string }) {
  const { data: models } = useModels();
  const { data: statuses } = useModelStatuses();
  const qc = useQueryClient();

  const installedModels = useMemo(() => {
    if (!models || !statuses) return undefined;
    return models.filter((m) => {
      const s = statuses.find((x) => x.model_id === m.id);
      return s?.deps_installed && s.weights_downloaded;
    });
  }, [models, statuses]);

  const promptStatuses = useQueries({
    queries: (installedModels ?? []).map((model) => ({
      queryKey: ["voice-prompt", voiceId, model.id],
      queryFn: async () => {
        const raw = await tauri.rpc<unknown>("voices.prompt_status", {
          voice_id: voiceId,
          model_id: model.id,
        });
        return PromptStatus.parse(raw);
      },
      refetchOnMount: "always" as const,
    })),
  });

  const prepare = useMutation({
    mutationFn: (modelId: string) =>
      tauri.rpc("voices.prepare_for_model", {
        voice_id: voiceId,
        model_id: modelId,
      }),
    onSuccess: (_data, modelId) => {
      qc.invalidateQueries({ queryKey: ["voice-prompt", voiceId, modelId] });
      // Studio reads the bulk version of this query to filter its voice
      // picker; refresh it too so a freshly-prepared voice shows up there
      // without a manual page reload.
      qc.invalidateQueries({ queryKey: ["voices"] });
      qc.invalidateQueries({ queryKey: ["voice-prompts", modelId] });
    },
  });

  if (!installedModels?.length) {
    return (
      <span className="text-[11px] text-zinc-500">
        install a model from the Models tab to prepare voices
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {installedModels.map((model, i) => {
        const ready = promptStatuses[i]?.data?.ready;
        const pending = prepare.isPending && prepare.variables === model.id;
        return ready ? (
          <span
            key={model.id}
            className="inline-flex items-center gap-1 text-[11px] text-emerald-300"
          >
            <Check className="w-3 h-3" />
            prompt ready for {model.name}
          </span>
        ) : (
          <button
            key={model.id}
            className="btn-ghost text-xs px-2 py-1"
            onClick={() => prepare.mutate(model.id)}
            disabled={prepare.isPending}
            title={`Build and cache the voice-clone prompt for ${model.name}`}
          >
            {pending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {pending ? "Preparing…" : `Prepare for ${model.name}`}
          </button>
        );
      })}
      {prepare.error && (
        <span className="text-[11px] text-red-400 truncate">
          {(prepare.error as Error).message}
        </span>
      )}
    </div>
  );
}
