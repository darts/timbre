import { z } from "zod";

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  license: z.string(),
  license_url: z.string().url(),
  license_acknowledgement_required: z.boolean().optional().default(false),
  adapter: z.string(),
  hf_repo: z.string(),
  description: z.string().optional(),
  ratings: z.object({
    speed: z.number().min(1).max(10),
    quality: z.number().min(1).max(10),
  }).optional(),
  approx_size_mb: z.number(),
  sample_rate: z.number(),
  ref_clip: z.object({
    min_seconds: z.number(),
    max_seconds: z.number(),
    transcript_required: z.boolean().optional().default(false),
  }),
  languages: z.array(z.string()),
  hardware: z.array(z.string()),
  is_default: z.boolean().optional().default(false),
  variant: z.string().optional(),
  params: z.array(z.object({
    key: z.string(),
    label: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number(),
    default: z.number(),
    help: z.string().optional(),
  })).optional().default([]),
  getting_started: z.object({
    ref_clip_tips: z.string().optional(),
    text_tips: z.string().optional(),
    audio_length_tips: z.string().optional(),
    sample_prompts: z.array(z.object({
      label: z.string(),
      text: z.string(),
    })).optional().default([]),
    tags: z.array(z.object({
      tag: z.string(),
      group: z.string().optional(),
    })).optional().default([]),
    tags_note: z.string().optional(),
    param_guidance: z.array(z.object({
      key: z.string(),
      values: z.array(z.object({
        setting: z.string(),
        effect: z.string(),
      })),
    })).optional().default([]),
    gotchas: z.array(z.string()).optional().default([]),
  }).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;
export type ModelParam = ModelInfo["params"][number];
export type GettingStarted = NonNullable<ModelInfo["getting_started"]>;

export const Voice = z.object({
  id: z.string(),
  root_id: z.string().optional(),
  version: z.number().optional().default(1),
  is_current: z.boolean().optional().default(true),
  name: z.string(),
  created_at: z.number(),
  ref_audio_path: z.string(),
  ref_audio_sr: z.number(),
  ref_transcript: z.string().nullable().optional(),
  ref_duration_ms: z.number(),
  source_notes: z.string().nullable().optional(),
  prompt_only: z.boolean().optional().default(false),
  prompt_count: z.number().optional().default(0),
});
export type Voice = z.infer<typeof Voice>;

export const PromptStatus = z.object({
  voice_id: z.string(),
  model_id: z.string(),
  ready: z.boolean(),
  path: z.string().nullable(),
});
export type PromptStatus = z.infer<typeof PromptStatus>;

export const ChunkResult = z.object({
  id: z.string(),
  idx: z.number(),
  audio_path: z.string(),
  duration_ms: z.number(),
  text: z.string(),
  elapsed_ms: z.number().optional(),
});
export type ChunkResult = z.infer<typeof ChunkResult>;

export const SynthesisChunk = z.object({
  id: z.string(),
  synthesis_id: z.string(),
  idx: z.number(),
  text: z.string(),
  seed: z.number(),
  audio_path: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  params_override: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]))
    .optional()
    .default({}),
  status: z.string(),
  revision: z.number().optional().default(1),
});
export type SynthesisChunk = z.infer<typeof SynthesisChunk>;

export const SynthesisHistoryItem = z.object({
  id: z.string(),
  voice_id: z.string(),
  voice_name: z.string(),
  voice_version: z.number().optional().default(1),
  voice_deleted: z.boolean().optional().default(false),
  model_id: z.string(),
  model_name: z.string(),
  model_deleted: z.boolean().optional().default(false),
  full_text: z.string(),
  requested_device: z.string().optional().default("cpu"),
  resolved_device: z.string().nullable().optional(),
  device_detail: z.string().nullable().optional(),
  fallback_device: z.string().nullable().optional(),
  fallback_reason: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  final_audio_path: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  status: z.string(),
  batch_id: z.string().nullable().optional(),
  batch_index: z.number().nullable().optional(),
  batch_count: z.number().nullable().optional(),
  is_favorite: z.boolean().optional().default(false),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});
export type SynthesisHistoryItem = z.infer<typeof SynthesisHistoryItem>;

export const ModelStatus = z.object({
  model_id: z.string(),
  deps_installed: z.boolean(),
  deps_error: z.string().nullable().optional(),
  weights_downloaded: z.boolean(),
  weights_path: z.string(),
  expected_bytes: z.number().nullable().optional(),
  downloaded_bytes: z.number().nullable().optional(),
  installed_bytes: z.number().nullable().optional(),
  files_done: z.number().nullable().optional(),
  files_total: z.number().nullable().optional(),
  size_source: z.string().nullable().optional(),
});
export type ModelStatus = z.infer<typeof ModelStatus>;

export const DeviceCapabilities = z.object({
  torch_version: z.string().optional(),
  cuda: z.boolean(),
  mps: z.boolean(),
  cpu: z.boolean(),
  error: z.string().optional(),
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilities>;
