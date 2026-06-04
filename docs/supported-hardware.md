# Supported hardware

Timbre detects your GPU/APU vendor on first run and pre-selects a compute
backend; you can override the choice with **"Show all options"** on the setup
screen.

Detection only checks whether a GPU/APU of each *vendor* is present. It does not
validate the exact model. A card outside the ranges below can still be offered
its vendor backend, but unsupported cards fall back to CPU at runtime.

## NVIDIA - CUDA (PyTorch 2.9.1, CUDA 12.8)

- Timbre installs `torch==2.9.1` from PyTorch's `cu128` wheel lane; CUDA
  hardware support follows that wheel.
- PyTorch's CUDA 12.8 binary builds dropped Maxwell and Pascal kernels, so the
  **GTX 10-series (Pascal), GTX 900-series (Maxwell), and older fall back to CPU.**
- For consumer NVIDIA GPUs, **GeForce RTX 20-series / GTX 16-series** (Turing)
  or newer is the recommended floor.
- Requires an NVIDIA driver new enough for CUDA 12.8.

## AMD - ROCm on Linux (ROCm 7.2.1, PyTorch 2.9.1)

Timbre installs AMD's ROCm 7.2.1 PyTorch wheels from `repo.radeon.com` into its
own Python 3.12 environment. You still need the system AMDGPU/ROCm driver stack
installed first.

Recommended driver setup:

```sh
# Ubuntu 24.04
sudo apt update
wget https://repo.radeon.com/amdgpu-install/7.2.1/ubuntu/noble/amdgpu-install_7.2.1.70201-1_all.deb
sudo apt install ./amdgpu-install_7.2.1.70201-1_all.deb
sudo amdgpu-install -y --usecase=graphics,rocm
sudo usermod -a -G render,video $LOGNAME
sudo reboot
```

After reboot, verify the driver before selecting ROCm in Timbre:

```sh
groups
rocminfo
```

Supported Linux OS targets in AMD's ROCm 7.2.1 Radeon matrix:

- Ubuntu 24.04.4 Desktop with HWE, Ubuntu 22.04.5 Desktop with HWE, and RHEL
  10.1.

Supported Radeon discrete GPUs:

- RX 9060, RX 9060 XT, RX 9070, RX 9070 XT, RX 9070 GRE, RX 7900 XTX, RX 7900
  XT, RX 7900 GRE, Radeon PRO W7900, Radeon PRO W7900 Dual Slot, Radeon PRO
  W7800, Radeon PRO W7800 48GB, Radeon PRO W7700, RX 7700, RX 7700 XT, RX 7800
  XT, Radeon AI PRO R9600, Radeon AI PRO R9600D, Radeon AI PRO R9700, Radeon AI
  PRO R9700S.

Supported Ryzen AI APUs on Linux:

- Ryzen AI Max+ 395, Ryzen AI Max 390, Ryzen AI Max 385, Ryzen AI 9 HX 375,
  Ryzen AI 9 HX 370, Ryzen AI 9 365, Ryzen AI 9 HX 475, Ryzen AI 9 HX 470,
  Ryzen AI 9 465.

## AMD - ROCm on Windows (ROCm 7.2.1 preview, PyTorch 2.9.1)

Timbre installs AMD's ROCm 7.2.1 SDK and PyTorch wheels into its own Python 3.12
environment. You still need AMD's Windows graphics driver installed first.

Before selecting ROCm in Timbre:

1. Use Windows 11.
2. Install **AMD Software Adrenalin 26.2.2**, the driver required by AMD's
   PyTorch on Windows 7.2.1 release.
3. Reboot.
4. Select the AMD GPU/APU ROCm backend in Timbre.

Do not install Python or PyTorch manually for Timbre. The app downloads its own
isolated Python runtime and installs the AMD wheels there.

Supported Radeon discrete GPUs on Windows:

- RX 9070, RX 9070 XT, Radeon AI PRO R9700, RX 9060 XT, RX 7900 XTX, Radeon PRO
  W7900, Radeon PRO W7900 Dual Slot, RX 7700.

Supported Ryzen AI APUs on Windows:

- Ryzen AI Max+ 395, Ryzen AI Max 390, Ryzen AI Max 385, Ryzen AI 9 HX 375,
  Ryzen AI 9 HX 370, Ryzen AI 9 365, Ryzen AI 9 HX 475, Ryzen AI 9 HX 470,
  Ryzen AI 9 465.

AMD notes that PyTorch on Windows includes ROCm 7.2.1 components, but the full
ROCm stack is not yet supported on Windows. Internally PyTorch ROCm uses the
`torch.cuda` API; Timbre labels this as ROCm in the UI when the ROCm backend is
installed.

## Apple Silicon - MPS

All M-series Macs use the Metal Performance Shaders backend. Timbre ships only
an arm64 macOS build.

## CPU

Available on every platform as the universal fallback. No GPU is required, but
CPU inference is slower than GPU inference.

## Sources

- [PyTorch previous versions: v2.9.1 wheel lanes](https://pytorch.org/get-started/previous-versions/)
- [PyTorch CUDA 12.8 architecture support update](https://dev-discuss.pytorch.org/t/cuda-toolkit-version-and-architecture-support-update-maxwell-and-pascal-architecture-support-removed-in-cuda-12-8-and-12-9-builds/3128)
- [AMD ROCm 7.2.1 Radeon Linux driver install](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/native_linux/install-radeon.html)
- [AMD ROCm 7.2.1 Radeon Linux PyTorch install](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/native_linux/install-pytorch.html)
- [AMD ROCm 7.2.1 Radeon Linux compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/native_linux/native_linux_compatibility.html)
- [AMD ROCm 7.2.1 Ryzen Linux compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html)
- [AMD ROCm 7.2.1 Radeon Windows PyTorch install](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html)
- [AMD ROCm 7.2.1 Radeon Windows compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)
- [AMD ROCm 7.2.1 Ryzen Windows compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/windows/windows_compatibility.html)
