import type { BackendKind } from "@/lib/ipc";
import type { DevicePreference } from "@/lib/settings";

export function displayDeviceLabel(
  device: string | null | undefined,
  backend: BackendKind | null | undefined,
): string {
  if (!device) return "";
  const lower = device.toLowerCase();
  if (lower === "cuda") return backend === "rocm" ? "ROCm" : "CUDA";
  if (lower === "mps") return "MPS";
  if (lower === "cpu") return "CPU";
  return device.toUpperCase();
}

export function computeModeLabel(
  preference: DevicePreference,
  device: string,
  backend: BackendKind | null | undefined,
): string {
  const label = displayDeviceLabel(device, backend);
  return preference === "auto" ? `Auto (${label})` : label;
}

export function deviceTransitionLabel(
  requested: string | null | undefined,
  resolved: string | null | undefined,
  backend: BackendKind | null | undefined,
): string {
  const requestedLabel = displayDeviceLabel(requested, backend);
  const resolvedLabel = displayDeviceLabel(resolved, backend);
  if (requestedLabel && resolvedLabel) return `${requestedLabel} -> ${resolvedLabel}`;
  return requestedLabel || resolvedLabel;
}
