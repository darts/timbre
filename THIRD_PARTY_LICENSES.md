# Third-Party Licenses & Attribution

Timbre itself is released under the [MIT License](LICENSE). It depends on,
bundles, or downloads at runtime a number of third-party components, each
governed by its own license. The notable ones are listed below; a fully
exhaustive transitive list is available in
[`pnpm-lock.yaml`](pnpm-lock.yaml) (frontend) and
[`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) (Rust shell). Python
dependencies are listed in [`py/requirements/`](py/requirements/).

## TTS Models

Voice models are downloaded on demand from Hugging Face by the in-app
installer. Each model retains its upstream license:

| Model | Vendor | License | Source |
|---|---|---|---|
| Qwen3-TTS-12Hz 1.7B Base | Qwen / Alibaba | Apache-2.0 | [HF](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) · [License](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/blob/main/LICENSE) |
| Qwen3-TTS-12Hz 0.6B Base | Qwen / Alibaba | Apache-2.0 | [HF](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base) · [License](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/blob/main/LICENSE) |
| Chatterbox Turbo | Resemble AI | MIT | [GitHub](https://github.com/resemble-ai/chatterbox) · [License](https://github.com/resemble-ai/chatterbox/blob/master/LICENSE) |
| Chatterbox English | Resemble AI | MIT | [GitHub](https://github.com/resemble-ai/chatterbox) · [License](https://github.com/resemble-ai/chatterbox/blob/master/LICENSE) |

Notes:

- **Voices are user-supplied.** Both engines run zero-shot from a reference
  clip the user provides. No preset voices, voice datasets, or sample
  speakers ship with Timbre, and no speech-dataset attribution is owed.
- **Chatterbox outputs carry an inaudible PerTh watermark** ([Resemble AI
  Perth](https://github.com/resemble-ai/Perth)) for provenance tracking.
  The watermark is embedded by the upstream model and cannot be stripped.

The authoritative per-model metadata Timbre uses at runtime lives in
[`resources/models.manifest.json`](resources/models.manifest.json).

## Desktop Shell - Rust

| Crate | License |
|---|---|
| [tauri](https://github.com/tauri-apps/tauri) (v2) | Apache-2.0 OR MIT |
| tauri-plugin-shell, tauri-plugin-dialog, tauri-plugin-fs | Apache-2.0 OR MIT |
| [serde](https://github.com/serde-rs/serde) / serde_json | Apache-2.0 OR MIT |
| [tokio](https://github.com/tokio-rs/tokio) | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | Apache-2.0 OR MIT |
| anyhow, thiserror, dirs, sha2, hex, flate2, tar, zip, zstd, uuid, futures-util | Apache-2.0 OR MIT (per crate) |
| tracing, tracing-subscriber, tracing-appender | MIT |
| [windows](https://github.com/microsoft/windows-rs) (Windows only, DXGI GPU probe) | Apache-2.0 OR MIT |

## Frontend - JavaScript / TypeScript

| Package | License |
|---|---|
| [React](https://react.dev) (+ react-dom, react-router-dom) | MIT |
| [Vite](https://vitejs.dev) | MIT |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |
| [TailwindCSS](https://tailwindcss.com) (+ postcss, autoprefixer) | MIT |
| [Lucide](https://lucide.dev) (lucide-react) | ISC |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Zod](https://zod.dev) | MIT |
| [TanStack React Query](https://tanstack.com/query) | MIT |
| clsx, tailwind-merge | MIT |
| sharp (icon build) | Apache-2.0 |

## Python ML Sidecar

A standalone Python 3.12 runtime is bundled per-platform via
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
(MIT / PSF-2.0). Dependencies (full list in [`py/requirements/`](py/requirements/)):

| Package | License | Purpose |
|---|---|---|
| [PyTorch](https://pytorch.org) | BSD-3-Clause | Tensor / model runtime |
| [transformers](https://github.com/huggingface/transformers) | Apache-2.0 | Hugging Face model loading |
| [accelerate](https://github.com/huggingface/accelerate) | Apache-2.0 | Device placement / dispatch |
| [safetensors](https://github.com/huggingface/safetensors) | Apache-2.0 | Tensor serialization |
| [huggingface_hub](https://github.com/huggingface/huggingface_hub) | Apache-2.0 | Model downloads |
| [diffusers](https://github.com/huggingface/diffusers) | Apache-2.0 | Used by Chatterbox |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | Reference-clip transcription |
| [librosa](https://librosa.org) | ISC | Audio analysis |
| [soundfile](https://github.com/bastibe/python-soundfile) | BSD-3-Clause | WAV/FLAC I/O |
| [numpy](https://numpy.org) | BSD-3-Clause | Numerics |
| [pysbd](https://github.com/nipunsadvilkar/pySBD) | MIT | Sentence segmentation |
| [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) | MIT | Loudness normalization |
| [pykakasi](https://github.com/miurahr/pykakasi) | MIT | Japanese script handling (Chatterbox) |
| [spacy-pkuseg](https://github.com/explosion/spacy-pkuseg) | MIT | Chinese segmentation (Chatterbox) |
| [resemble-perth](https://github.com/resemble-ai/Perth) | MIT | PerTh watermark (Chatterbox) |
| [omegaconf](https://github.com/omry/omegaconf) | BSD-2-Clause | Config (Chatterbox) |
| [qwen-tts](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) | Apache-2.0 | Qwen3 inference adapter |
| [chatterbox-tts](https://github.com/resemble-ai/chatterbox) | MIT | Chatterbox inference adapter |
| [uv](https://github.com/astral-sh/uv) | Apache-2.0 OR MIT | Bundled Python package installer |

## GPU / Compute Runtimes

PyTorch is installed against the user's selected backend during first-run
setup. Each runtime carries its own license:

- **NVIDIA CUDA** (`cu128` PyTorch wheels) - proprietary, redistributed under
  the [NVIDIA Software License Agreement](https://docs.nvidia.com/cuda/eula/index.html).
- **AMD ROCm** (Linux: PyTorch ROCm wheels; Windows: AMD's
  [`repo.radeon.com`](https://repo.radeon.com/) Radeon/Ryzen wheels) - mix of
  open-source (mostly MIT / Apache-2.0) and proprietary AMD components.
- **Apple Metal / MPS** - proprietary, shipped with macOS.
- **CPU** - no third-party runtime.

## Fonts & Icons

- The UI requests **Inter** as its primary sans-serif but does *not* bundle
  the font; the OS provides it (or falls back to the system sans-serif). No
  attribution required.
- App icons (`src-tauri/icons/`) are original Timbre branding.
- UI glyphs come from [Lucide](https://lucide.dev) (ISC).

## License Compatibility

All listed components are MIT-, BSD-, ISC-, or Apache-2.0-licensed (or
proprietary runtimes shipped under their vendor's redistribution terms). No
GPL/AGPL/LGPL dependencies are pulled in by Timbre's direct dependency set.
