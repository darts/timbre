import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileMusic, Loader2, Mic, Save, Sparkles, Square, Trash2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Waveform } from "@/components/Waveform";
import { tauri } from "@/lib/ipc";
import { Voice } from "@/lib/schema";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  voice?: Voice | null;
  onCreated?: (voice: Voice) => void;
  preserveCreateDraftOnClose?: boolean;
}

type SourceMode = "record" | "file";

interface RecorderSession {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sampleRate: number;
  startedAt: number;
}

const initialState = { name: "", audioPath: "" as string, transcript: "" };
const REFERENCE_TEXT =
  "The quiet studio is ready. I will speak clearly, keep a steady pace, and pause naturally between ideas, so this recording captures my voice for accurate local speech generation.";
const MAX_RECORDING_SECONDS = 15;
const PROCESSOR_BUFFER_SIZE = 4096;

export function VoiceCreateDialog({
  open,
  onClose,
  voice,
  onCreated,
  preserveCreateDraftOnClose = false,
}: Props) {
  const qc = useQueryClient();
  const [state, setState] = useState(initialState);
  const [sourceMode, setSourceMode] = useState<SourceMode>("record");
  const [recording, setRecording] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingPreviewUrl, setRecordingPreviewUrl] = useState<string | null>(null);
  const [savedRecordingPath, setSavedRecordingPath] = useState<string | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const recordingPreviewUrlRef = useRef<string | null>(null);

  const set = <K extends keyof typeof initialState>(k: K, v: (typeof initialState)[K]) =>
    setState((s) => ({ ...s, [k]: v }));
  const stateForVoice = (v: Voice | null | undefined) => ({
    name: v?.name ?? "",
    audioPath: v?.ref_audio_path ?? "",
    transcript: v?.ref_transcript ?? "",
  });
  const editing = Boolean(voice);

  const clearRecordingPreview = useCallback(() => {
    if (recordingPreviewUrlRef.current) {
      URL.revokeObjectURL(recordingPreviewUrlRef.current);
    }
    recordingPreviewUrlRef.current = null;
    setRecordingBlob(null);
    setRecordingPreviewUrl(null);
    setSavedRecordingPath(null);
    setRecordedDuration(0);
  }, []);

  const stopRecording = useCallback((keepClip = true) => {
    const session = recorderRef.current;
    if (!session) return;
    recorderRef.current = null;
    session.processor.onaudioprocess = null;
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    void session.context.close();

    const chunks = chunksRef.current;
    chunksRef.current = [];
    setRecording(false);
    setInputLevel(0);

    if (!keepClip) {
      setRecordingElapsed(0);
      return;
    }

    let samples = mergeChunks(chunks);
    const maxSamples = Math.floor(session.sampleRate * MAX_RECORDING_SECONDS);
    if (samples.length > maxSamples) {
      samples = samples.slice(0, maxSamples);
    }
    if (samples.length === 0) {
      setRecordingElapsed(0);
      setRecordingError("No microphone audio was captured.");
      return;
    }

    const duration = samples.length / session.sampleRate;
    const blob = encodeWav(samples, session.sampleRate);
    const url = URL.createObjectURL(blob);
    if (recordingPreviewUrlRef.current) {
      URL.revokeObjectURL(recordingPreviewUrlRef.current);
    }
    recordingPreviewUrlRef.current = url;
    setRecordingBlob(blob);
    setRecordingPreviewUrl(url);
    setSavedRecordingPath(null);
    setRecordedDuration(duration);
    setRecordingElapsed(duration);
    setRecordingError(null);
    setState((s) => ({
      ...s,
      audioPath: "",
      name: s.name.trim() ? s.name : "Recorded voice",
      transcript: s.transcript.trim() ? s.transcript : REFERENCE_TEXT,
    }));
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const session = recorderRef.current;
      if (!session) return;
      const elapsed = (performance.now() - session.startedAt) / 1000;
      setRecordingElapsed(Math.min(elapsed, MAX_RECORDING_SECONDS));
      if (elapsed >= MAX_RECORDING_SECONDS) {
        stopRecording(true);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [recording, stopRecording]);

  useEffect(() => {
    if (!open) return;
    if (preserveCreateDraftOnClose && !voice) {
      setRecordingError(null);
      return;
    }
    stopRecording(false);
    clearRecordingPreview();
    setState(stateForVoice(voice));
    setSourceMode(voice ? "file" : "record");
    setRecordingElapsed(0);
    setInputLevel(0);
    setRecordingError(null);
  }, [clearRecordingPreview, open, preserveCreateDraftOnClose, stopRecording, voice]);

  useEffect(() => {
    return () => {
      stopRecording(false);
      clearRecordingPreview();
    };
  }, [clearRecordingPreview, stopRecording]);

  // Whether the backend pack has faster-whisper. If not, the Generate
  // button surfaces a helpful pointer instead of silently failing.
  const transcriberAvailable = useQuery({
    queryKey: ["transcriber-available"],
    queryFn: () => tauri.rpc<{ available: boolean }>("transcribe.is_available"),
    enabled: open,
    staleTime: 60_000,
  });

  const saveRecordingClip = useCallback(async () => {
    if (savedRecordingPath) return savedRecordingPath;
    if (!recordingBlob) {
      throw new Error("Record a reference clip before generating a transcript.");
    }
    const bytes = Array.from(new Uint8Array(await recordingBlob.arrayBuffer()));
    const path = await tauri.saveVoiceRecording(bytes);
    setSavedRecordingPath(path);
    return path;
  }, [recordingBlob, savedRecordingPath]);

  const transcribe = useMutation({
    mutationFn: async () => {
      const audioPath = sourceMode === "record" ? await saveRecordingClip() : state.audioPath;
      if (!audioPath) {
        throw new Error("Choose or record a reference clip before generating a transcript.");
      }
      return tauri.rpc<{ text: string; language: string }>("transcribe.audio", {
        audio_path: audioPath,
      });
    },
    onSuccess: (data) => set("transcript", data.text),
  });

  const saveVoice = useMutation({
    mutationFn: async () => {
      let audioPath = state.audioPath;
      if (sourceMode === "record") {
        audioPath = await saveRecordingClip();
      }

      const payload = {
        name: state.name || basename(audioPath) || "Voice",
        ref_audio_path: audioPath,
        ref_transcript: state.transcript.trim() || null,
      };
      return editing && voice
        ? tauri.rpc<Voice>("voices.update", {
            voice_id: voice.id,
            ...payload,
          })
        : tauri.rpc<Voice>("voices.create", payload);
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["voices"] });
      qc.invalidateQueries({ queryKey: ["voice-prompts"] });
      onCreated?.(v);
      stopRecording(false);
      clearRecordingPreview();
      setState(initialState);
      setSourceMode("record");
      setRecordingElapsed(0);
      setInputLevel(0);
      setRecordingError(null);
      transcribe.reset();
      onClose();
    },
  });

  const startRecording = useCallback(async () => {
    if (saveVoice.isPending || transcribe.isPending || recording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingError("Microphone recording is not available in this webview.");
      return;
    }
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setRecordingError("Audio capture is not available in this webview.");
      return;
    }

    setSourceMode("record");
    setRecordingError(null);
    clearRecordingPreview();
    transcribe.reset();
    window.dispatchEvent(new CustomEvent("timbre:audio-play", { detail: null }));

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      context = new AudioContextCtor();
      await context.resume();
      source = context.createMediaStreamSource(stream);
      const channelCount = Math.max(1, source.channelCount || 1);
      processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, channelCount, 1);
      chunksRef.current = [];
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const output = event.outputBuffer;
        if (output.numberOfChannels > 0) {
          output.getChannelData(0).fill(0);
        }
        const sampleCount = input.length;
        const channels = Math.max(1, input.numberOfChannels);
        const frame = new Float32Array(sampleCount);
        let sumSquares = 0;
        for (let i = 0; i < sampleCount; i++) {
          let value = 0;
          for (let channel = 0; channel < channels; channel++) {
            value += input.getChannelData(channel)[i] ?? 0;
          }
          value /= channels;
          frame[i] = value;
          sumSquares += value * value;
        }
        chunksRef.current.push(frame);
        setInputLevel(Math.min(1, Math.sqrt(sumSquares / sampleCount) * 8));
      };
      source.connect(processor);
      processor.connect(context.destination);
      recorderRef.current = {
        stream,
        context,
        source,
        processor,
        sampleRate: context.sampleRate,
        startedAt: performance.now(),
      };
      setRecordingElapsed(0);
      setRecording(true);
      setState((s) => ({
        ...s,
        audioPath: "",
        transcript: s.transcript.trim() ? s.transcript : REFERENCE_TEXT,
      }));
    } catch (error) {
      processor?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
      chunksRef.current = [];
      setRecording(false);
      setInputLevel(0);
      setRecordingElapsed(0);
      setRecordingError(microphoneErrorMessage(error));
    }
  }, [
    clearRecordingPreview,
    recording,
    saveVoice.isPending,
    transcribe,
    transcribe.isPending,
  ]);

  const pickFile = async () => {
    const file = await openFileDialog({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg"] }],
    });
    if (!file) return;
    stopRecording(false);
    clearRecordingPreview();
    const path = typeof file === "string" ? file : (file as { path: string }).path;
    setSourceMode("file");
    set("audioPath", path);
    if (!state.name) {
      set("name", basename(path).replace(/\.[^.]+$/, ""));
    }
  };

  const close = () => {
    if (saveVoice.isPending || transcribe.isPending) return;

    if (preserveCreateDraftOnClose && !editing) {
      stopRecording(true);
      setRecordingError(null);
      transcribe.reset();
      onClose();
      return;
    }

    stopRecording(false);
    clearRecordingPreview();
    setState(editing ? initialState : stateForVoice(voice));
    setSourceMode(editing ? "record" : voice ? "file" : "record");
    setRecordingError(null);
    transcribe.reset();
    onClose();
  };

  const useReferenceText = () => set("transcript", REFERENCE_TEXT);
  const hasTranscribableClip =
    sourceMode === "record" ? !!recordingBlob && !recording : !!state.audioPath;
  const canTranscribe =
    hasTranscribableClip &&
    !saveVoice.isPending &&
    !transcribe.isPending &&
    transcriberAvailable.data?.available !== false;
  const canSave =
    sourceMode === "record"
      ? !!recordingBlob && !recording
      : !!state.audioPath;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={editing ? "Edit voice" : "Add a voice"}
      description={
        editing
          ? "Save changes as a new immutable voice version. Existing generated audio keeps using the old version."
          : "Clone a speaker from a short reference clip. A transcript helps align the prompt to the audio."
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">
            Reference clip
          </label>
          <div className="grid grid-cols-2 gap-2">
            <SourceButton
              selected={sourceMode === "record"}
              disabled={saveVoice.isPending || recording}
              onClick={() => {
                setSourceMode("record");
                setState((s) => ({
                  ...s,
                  audioPath: "",
                  transcript: s.transcript.trim() ? s.transcript : REFERENCE_TEXT,
                }));
              }}
              icon={<Mic className="w-4 h-4" />}
            >
              Record
            </SourceButton>
            <SourceButton
              selected={sourceMode === "file"}
              disabled={saveVoice.isPending || recording}
              onClick={() => setSourceMode("file")}
              icon={<FileMusic className="w-4 h-4" />}
            >
              File
            </SourceButton>
          </div>
        </div>

        {sourceMode === "record" ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-400 mb-1">
                  Reference text
                </div>
                <p className="text-sm leading-6 text-zinc-200">{REFERENCE_TEXT}</p>
              </div>
              <button
                type="button"
                className="btn-ghost text-xs px-2 py-1 shrink-0"
                onClick={useReferenceText}
                disabled={saveVoice.isPending}
              >
                <Sparkles className="w-3 h-3" />
                Use text
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {recording ? (
                <button
                  type="button"
                  className="btn bg-red-500 text-white hover:bg-red-400"
                  onClick={() => stopRecording(true)}
                >
                  <Square className="w-4 h-4" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void startRecording()}
                  disabled={saveVoice.isPending || transcribe.isPending}
                >
                  <Mic className="w-4 h-4" />
                  Record
                </button>
              )}
              {recordingPreviewUrl && !recording && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={clearRecordingPreview}
                  disabled={saveVoice.isPending}
                >
                  <Trash2 className="w-4 h-4" />
                  Discard
                </button>
              )}
              <div className="text-xs text-zinc-400 tabular-nums">
                {recording
                  ? `${formatSeconds(recordingElapsed)} / ${formatSeconds(MAX_RECORDING_SECONDS)}`
                  : recordingPreviewUrl
                    ? `${formatSeconds(recordedDuration)} recorded`
                    : "Ready to record"}
              </div>
            </div>

            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-100",
                  recording ? "bg-red-400" : "bg-zinc-700",
                )}
                style={{ width: `${Math.round(inputLevel * 100)}%` }}
              />
            </div>

            {recordingPreviewUrl && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
                <Waveform src={recordingPreviewUrl} />
              </div>
            )}

            {recordingError && (
              <p className="text-[11px] text-red-400">{recordingError}</p>
            )}
            <p className="text-[11px] text-zinc-500">
              Read the reference text once in a quiet room. The recorder stops automatically at 15 seconds.
            </p>
          </div>
        ) : (
          <div>
            <button
              type="button"
              className="btn-soft w-full justify-start"
              onClick={pickFile}
              disabled={saveVoice.isPending}
            >
              <FileMusic className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {state.audioPath ? basename(state.audioPath) : "Choose an audio file..."}
              </span>
            </button>
            <p className="text-[11px] text-zinc-500 mt-1">
              3-15 seconds of clean, single-speaker audio works best. Timbre copies it
              into the voice library as a managed mono WAV.
            </p>
            {state.audioPath && (
              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
                <Waveform path={state.audioPath} />
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name</label>
          <input
            className="input"
            value={state.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Narrator"
            disabled={saveVoice.isPending}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-zinc-400">
              Transcript{" "}
              <span className="text-zinc-500 font-normal">
                (recommended for cloning quality)
              </span>
            </label>
            {(sourceMode === "file" || sourceMode === "record") && (
              <button
                type="button"
                className="btn-ghost text-xs px-2 py-1"
                disabled={!canTranscribe}
                onClick={() => transcribe.mutate()}
                title={
                  transcriberAvailable.data?.available === false
                    ? "faster-whisper isn't installed in the active backend"
                    : "Auto-generate from the reference clip"
                }
              >
                {transcribe.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                {state.transcript ? "Regenerate" : "Generate"}
              </button>
            )}
          </div>
          <textarea
            className="input min-h-[88px] resize-y font-sans"
            value={state.transcript}
            onChange={(e) => set("transcript", e.target.value)}
            placeholder={
              transcribe.isPending
                ? "Transcribing - first run downloads ~150MB of speech-to-text weights..."
                : sourceMode === "record"
                  ? "The reference text is used here by default. Edit it if your recording differs."
                  : "Type the spoken content, or click Generate to auto-fill from the clip."
            }
            disabled={saveVoice.isPending || transcribe.isPending}
          />
          <p className="text-[11px] text-zinc-500 mt-1">
            Qwen3-TTS-Base and F5-TTS condition synthesis on the reference
            transcript. Without one, results sound unnatural or drift.
          </p>
          {transcribe.error && (
            <p className="text-[11px] text-red-400 mt-1">
              {(transcribe.error as Error).message}
            </p>
          )}
          {(sourceMode === "file" || sourceMode === "record") &&
            transcriberAvailable.data?.available === false && (
            <p className="text-[11px] text-amber-300/90 mt-1">
              Auto-transcription isn&apos;t installed in this backend.{" "}
              <Link
                to="/settings"
                onClick={close}
                className="underline underline-offset-2 hover:text-amber-200"
              >
                Reinstall backend
              </Link>{" "}
              to enable it.
            </p>
          )}
        </div>

        {saveVoice.error && (
          <div className="text-xs text-red-400">
            {(saveVoice.error as Error).message}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={close} disabled={saveVoice.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!canSave || saveVoice.isPending}
            onClick={() => saveVoice.mutate()}
          >
            {saveVoice.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {editing ? "Save version" : "Save voice"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function SourceButton({
  selected,
  disabled,
  onClick,
  icon,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "btn-soft w-full",
        selected && "bg-indigo-500/15 text-indigo-100 ring-1 ring-indigo-500/50 hover:bg-indigo-500/20",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const pcm = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    view.setInt16(offset, pcm, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Enable microphone permission for Timbre and try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found.";
  }
  if (error instanceof Error) return error.message;
  return "Microphone recording failed.";
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || "";
}
