import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import { fileSrc } from "@/lib/sidecar";
import { formatDuration } from "@/lib/utils";

export function Waveform({ path, src: directSrc }: { path?: string; src?: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = useMemo(() => directSrc ?? (path ? fileSrc(path) : ""), [directSrc, path]);
  const sourceLabel = path ?? directSrc ?? "";

  useEffect(() => {
    if (!src) return;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = src;
    audioRef.current = audio;

    setReady(false);
    setPlaying(false);
    setDuration(0);
    setCurrentTime(0);
    setPeaks(null);
    setError(null);

    const safeDuration = () =>
      Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const onLoadedMetadata = () => {
      setDuration(safeDuration());
      setReady(true);
    };
    const onCanPlay = () => setReady(true);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(safeDuration());
    };
    const onError = () => {
      setReady(false);
      setPlaying(false);
      const message = audio.error?.message || "Audio failed to load.";
      setError(message);
      console.error("audio load failed", { source: sourceLabel, src, error: audio.error });
    };
    const onOtherAudioStarted = (event: Event) => {
      const other = (event as CustomEvent<HTMLAudioElement>).detail;
      if (other !== audio) audio.pause();
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    window.addEventListener("timbre:audio-play", onOtherAudioStarted as EventListener);
    audio.load();

    return () => {
      window.removeEventListener("timbre:audio-play", onOtherAudioStarted as EventListener);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [sourceLabel, src]);

  useEffect(() => {
    if (!src) return;
    const controller = new AbortController();
    let cancelled = false;
    const decode = async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`waveform fetch failed: ${response.status}`);
        }
        const data = await response.arrayBuffer();
        const context = new AudioContext({ sampleRate: 8000 });
        try {
          const buffer = await context.decodeAudioData(data);
          if (!cancelled) setPeaks(extractPeaks(buffer, 512));
        } finally {
          void context.close();
        }
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError")) {
          console.warn("waveform decode failed", { source: sourceLabel, src, error: e });
          setPeaks([]);
        }
      }
    };
    void decode();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sourceLabel, src]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime || 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !ready) return;
    if (!audio.paused && !audio.ended) {
      audio.pause();
      return;
    }
    window.dispatchEvent(new CustomEvent("timbre:audio-play", { detail: audio }));
    try {
      if (audio.ended || (duration > 0 && audio.currentTime >= duration)) {
        audio.currentTime = 0;
      }
      await audio.play();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = e instanceof Error ? e.message : "Audio failed to play.";
      setError(message);
      setPlaying(false);
    }
  }, [duration, ready]);

  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => drawWaveform(canvas, peaks, progress);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, progress]);

  const seekFromPointer = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas || duration <= 0) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime || 0);
  }, [duration]);

  return (
    <div className="flex items-center gap-2">
      <button
        className="btn-ghost px-2 py-1"
        disabled={!ready || !!error}
        title={error ?? (playing ? "Pause audio" : "Play audio")}
        onClick={() => void togglePlayback()}
      >
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <canvas
          ref={canvasRef}
          className="block h-9 w-full cursor-pointer"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onPointerDown={seekFromPointer}
        />
        {error && (
          <div className="mt-1 text-[11px] text-red-400 truncate">
            {error}
          </div>
        )}
        {!error && (
          <div className="mt-1 flex justify-between text-[11px] text-zinc-500 tabular-nums">
            <span>{formatDuration(currentTime * 1000)}</span>
            <span>{duration > 0 ? formatDuration(duration * 1000) : "loading"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function extractPeaks(buffer: AudioBuffer, length: number): number[] {
  const peaks = Array.from({ length }, () => 0);
  const channelCount = buffer.numberOfChannels;
  const sampleCount = buffer.length;
  if (channelCount === 0 || sampleCount === 0) return peaks;

  for (let i = 0; i < length; i++) {
    const start = Math.floor((i * sampleCount) / length);
    const end = Math.max(start + 1, Math.floor(((i + 1) * sampleCount) / length));
    let peak = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let j = start; j < end; j++) {
        const value = Math.abs(samples[j] ?? 0);
        if (value > peak) peak = value;
      }
    }
    peaks[i] = peak;
  }

  const maxPeak = Math.max(...peaks);
  if (maxPeak <= 0) return peaks;
  return peaks.map((p) => p / maxPeak);
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[] | null,
  progress: number,
) {
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  ctx.scale(dpr, dpr);

  const barWidth = 2;
  const barGap = 1;
  const barRadius = 1;
  const step = barWidth + barGap;
  const barCount = Math.max(1, Math.floor(width / step));
  const drawBars = (color: string) => {
    ctx.fillStyle = color;
    for (let i = 0; i < barCount; i++) {
      const peak = peakAt(peaks, i, barCount);
      const barHeight = Math.max(2, Math.round(peak * (height - 2)));
      const x = i * step;
      const y = Math.round((height - barHeight) / 2);
      roundedRect(ctx, x, y, barWidth, barHeight, barRadius);
    }
  };

  drawBars("#52525b");

  const progressWidth = Math.round(width * progress);
  if (progressWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, progressWidth, height);
    ctx.clip();
    drawBars("#a78bfa");
    ctx.restore();
  }

  if (progress > 0 && progress < 1) {
    ctx.fillStyle = "#e4e4e7";
    ctx.fillRect(Math.round(progressWidth), 0, 1, height);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function peakAt(peaks: number[] | null, index: number, count: number): number {
  if (!peaks) {
    return 0.18 + 0.12 * Math.sin(index * 0.73) + 0.08 * Math.sin(index * 0.19);
  }
  if (peaks.length === 0) return 0.12;
  const start = Math.floor((index * peaks.length) / count);
  const end = Math.max(start + 1, Math.floor(((index + 1) * peaks.length) / count));
  let peak = 0;
  for (let i = start; i < end; i++) {
    peak = Math.max(peak, peaks[i] ?? 0);
  }
  return Math.max(0.06, peak);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}
