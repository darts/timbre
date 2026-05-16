import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiSettingsState {
  simpleMode: boolean;
  setSimpleMode: (value: boolean) => void;
  showGenerationDiagnostics: boolean;
  setShowGenerationDiagnostics: (value: boolean) => void;
  devicePreference: DevicePreference;
  setDevicePreference: (value: DevicePreference) => void;

  studioText: string;
  setStudioText: (value: string) => void;
  studioModelId: string;
  setStudioModelId: (value: string) => void;
  studioVoiceId: string;
  setStudioVoiceId: (value: string) => void;
  studioLanguages: Record<string, string>;
  setStudioLanguage: (modelId: string, language: string) => void;

  synthParams: Record<string, Record<string, number>>;
  setSynthParam: (modelId: string, key: string, value: number) => void;
  resetSynthParams: (modelId: string) => void;

  seed: string;
  setSeed: (value: string) => void;
  runCount: number;
  setRunCount: (value: number) => void;

  promptDrafts: PromptDraft[];
  addPromptDraft: (name: string, text: string) => void;
  renamePromptDraft: (id: string, name: string) => void;
  deletePromptDraft: (id: string) => void;
}

export type DevicePreference = "auto" | "cpu" | "cuda" | "mps";

export interface PromptDraft {
  id: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export const useUiSettings = create<UiSettingsState>()(
  persist(
    (set) => ({
      simpleMode: true,
      setSimpleMode: (value) => set({ simpleMode: value }),
      showGenerationDiagnostics: false,
      setShowGenerationDiagnostics: (value) =>
        set({ showGenerationDiagnostics: value }),
      devicePreference: "auto",
      setDevicePreference: (value) => set({ devicePreference: value }),

      studioText: "Hello — this voice was cloned from a short reference clip on your machine.",
      setStudioText: (value) => set({ studioText: value }),
      studioModelId: "",
      setStudioModelId: (value) => set({ studioModelId: value }),
      studioVoiceId: "",
      setStudioVoiceId: (value) => set({ studioVoiceId: value }),
      studioLanguages: {},
      setStudioLanguage: (modelId, language) =>
        set((state) => ({
          studioLanguages: {
            ...state.studioLanguages,
            [modelId]: language,
          },
        })),

      synthParams: {},
      setSynthParam: (modelId, key, value) =>
        set((state) => ({
          synthParams: {
            ...state.synthParams,
            [modelId]: { ...(state.synthParams[modelId] ?? {}), [key]: value },
          },
        })),
      resetSynthParams: (modelId) =>
        set((state) => {
          const next = { ...state.synthParams };
          delete next[modelId];
          return { synthParams: next };
        }),

      seed: "",
      setSeed: (value) => set({ seed: value }),
      runCount: 1,
      setRunCount: (value) =>
        set({ runCount: Math.max(1, Math.min(10, Math.round(value))) }),

      promptDrafts: [],
      addPromptDraft: (name, text) =>
        set((state) => {
          const now = Date.now();
          const trimmedName = name.trim() || "Untitled draft";
          return {
            promptDrafts: [
              {
                id: createLocalId(),
                name: trimmedName,
                text,
                createdAt: now,
                updatedAt: now,
              },
              ...state.promptDrafts,
            ].slice(0, 50),
          };
        }),
      renamePromptDraft: (id, name) =>
        set((state) => {
          const trimmedName = name.trim();
          if (!trimmedName) return {};
          return {
            promptDrafts: state.promptDrafts.map((draft) =>
              draft.id === id
                ? { ...draft, name: trimmedName, updatedAt: Date.now() }
                : draft,
            ),
          };
        }),
      deletePromptDraft: (id) =>
        set((state) => ({
          promptDrafts: state.promptDrafts.filter((draft) => draft.id !== id),
        })),
    }),
    { name: "timbre-ui-settings" },
  ),
);

function createLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
