# Supported hardware

Timbre detects your GPU/APU vendor on first run and pre-selects a compute
backend; you can override the choice with **"Show all options"** on the setup
screen.

Detection only checks whether a GPU/APU of each *vendor* is present — it does
not validate the exact model. The supported hardware for each backend is listed
below. A card outside these ranges is still offered its vendor's backend, but
falls back to CPU at runtime.

## NVIDIA — CUDA (PyTorch 2.8, CUDA 12.8)

- Timbre installs `torch==2.8.0` from PyTorch's `cu128` wheel lane; CUDA
  hardware support follows that wheel.
- PyTorch's 2.8 install matrix lists CUDA 12.8 wheels for Linux and Windows.
- PyTorch's CUDA 12.8 binary builds **dropped Maxwell and Pascal kernels**, so the
  **GTX 10-series (Pascal), GTX 900-series (Maxwell), and older fall back to CPU.**
- For consumer NVIDIA GPUs, **GeForce RTX 20-series / GTX 16-series** (Turing)
  or newer is the recommended floor.
- Requires an NVIDIA driver new enough for CUDA 12.8.

## AMD — ROCm on Linux (PyTorch 2.8, ROCm 6.4)

- Timbre installs `torch==2.8.0` from PyTorch's Linux-only `rocm6.4` wheel lane.
- Hardware detection follows AMD's ROCm 6.4.4 Radeon/Ryzen matrices; detection
  still only checks the vendor, not the exact GPU/APU model.
- AMD's Radeon Linux matrix lists PyTorch 2.8/Nightly with ROCm 6.4.4 as
  available from PyTorch.org nightly builds and not extensively tested by AMD;
  AMD's Ryzen Linux matrix lists PyTorch 2.8 with ROCm 6.4.4 as production
  support.
- **Radeon discrete GPUs:** RX 9070, RX 9070 XT, RX 9070 GRE, Radeon AI PRO
  R9700, RX 9060, RX 9060 XT, RX 7900 XTX, RX 7900 XT, RX 7900 GRE, Radeon PRO
  W7900, Radeon PRO W7900 Dual Slot, Radeon PRO W7800, Radeon PRO W7800 48GB,
  RX 7800 XT, Radeon PRO W7700, RX 7700 XT.
- **Ryzen AI APUs:** Ryzen AI Max+ 395, Ryzen AI Max 390, Ryzen AI Max 385,
  Ryzen AI 9 HX 375, Ryzen AI 9 HX 370, Ryzen AI 9 365.

## AMD — ROCm on Windows (preview)

> Alpha-quality preview (ROCm `rocm-rel-6.4.4`). Requires the **AMD Adrenalin AI
> driver with the ROCm runtime** installed — the wheels link against
> driver-shipped DLLs.

- AMD's Windows matrices list PyTorch 2.8 with ROCm 6.4.4 support for the
  hardware below, while noting that the full ROCm stack is not yet supported on
  Windows.
- **Radeon discrete GPUs:** RX 9070, RX 9070 XT, Radeon AI PRO R9700, RX 9060 XT,
  RX 7900 XTX, Radeon PRO W7900, Radeon PRO W7900 Dual Slot.
- **Ryzen AI APUs:** Ryzen AI Max+ 395, Ryzen AI Max 390, Ryzen AI Max 385,
  Ryzen AI 9 HX 375, Ryzen AI 9 HX 370, Ryzen AI 9 365.

## Apple Silicon — MPS

All M-series Macs use the Metal Performance Shaders backend. (Timbre ships only an
arm64 macOS build.)

## CPU

Available on every platform as the universal fallback — no GPU required, but slower than the GPU.

## Sources

- [PyTorch previous versions: v2.8.0 wheel lanes](https://pytorch.org/get-started/previous-versions/)
- [PyTorch CUDA 12.8 architecture support update](https://dev-discuss.pytorch.org/t/cuda-toolkit-version-and-architecture-support-update-maxwell-and-pascal-architecture-support-removed-in-cuda-12-8-and-12-9-builds/3128)
- [AMD ROCm 6.4.4 Radeon Linux compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-6.4.4/docs/compatibility/compatibilityrad/native_linux/native_linux_compatibility.html)
- [AMD ROCm 6.4.4 Ryzen Linux compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-6.4.4/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html)
- [AMD ROCm 6.4.4 Radeon Windows compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-6.4.4/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)
- [AMD ROCm 6.4.4 Ryzen Windows compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-6.4.4/docs/compatibility/compatibilityryz/windows/windows_compatibility.html)
