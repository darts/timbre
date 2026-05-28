//! GPU vendor detection used by FirstRun to recommend a backend pack.
//!
//! This runs *before* the Python/torch venv exists, so we can't ask torch
//! (`torch.cuda.is_available()`) — we probe the OS directly. Detection is
//! vendor-presence only ("is there an NVIDIA / AMD GPU?"); which exact cards
//! each backend actually supports is documented in
//! `docs/supported-hardware.md`, not enforced here. A detected-but-unsupported
//! card (e.g. a Pascal GTX on the cu128 lane) is still offered its vendor's
//! backend and falls back to CPU at runtime via the accelerator-retry path in
//! `device_policy.py`.
//!
//! macOS is never probed (the frontend skips the query): we ship only the
//! arm64 build and every Apple Silicon chip implies MPS.

use serde::Serialize;

/// PCI / DXGI vendor IDs.
const VENDOR_NVIDIA: u32 = 0x10de;
const VENDOR_AMD: u32 = 0x1002;

#[derive(Debug, Clone, Copy, Serialize, Default, PartialEq, Eq)]
pub struct GpuVendors {
    pub has_nvidia: bool,
    pub has_amd: bool,
    /// `false` when we couldn't probe (no `/sys`, DXGI failed). The UI then
    /// falls back to showing all applicable backends with CPU pre-selected,
    /// rather than hiding GPU options it can't confirm.
    pub probed: bool,
}

#[cfg(not(windows))]
pub fn detect() -> GpuVendors {
    scan_pci(std::path::Path::new("/sys/bus/pci/devices"))
}

#[cfg(windows)]
pub fn detect() -> GpuVendors {
    detect_dxgi()
}

/// Scan a Linux sysfs PCI tree for NVIDIA / AMD **display controllers**.
/// The root is passed in so this is unit-testable against a fixture dir; on
/// non-Linux hosts the directory is absent, so `probed` stays `false`.
#[cfg(not(windows))]
fn scan_pci(root: &std::path::Path) -> GpuVendors {
    use std::fs;

    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return GpuVendors::default(), // probed = false
    };

    let mut out = GpuVendors {
        has_nvidia: false,
        has_amd: false,
        probed: true,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        // PCI class is 0xBBSSPP; keep only base class 0x03 (display controller)
        // so we don't trip on a GPU's audio function or other AMD/NVIDIA chips.
        let class = fs::read_to_string(dir.join("class")).unwrap_or_default();
        if !is_display_controller(&class) {
            continue;
        }
        match read_hex(&dir.join("vendor")) {
            Some(VENDOR_NVIDIA) => out.has_nvidia = true,
            Some(VENDOR_AMD) => out.has_amd = true,
            _ => {}
        }
    }
    out
}

#[cfg(not(windows))]
fn is_display_controller(class: &str) -> bool {
    parse_hex(class).map(|c| (c >> 16) == 0x03).unwrap_or(false)
}

#[cfg(not(windows))]
fn read_hex(path: &std::path::Path) -> Option<u32> {
    parse_hex(&std::fs::read_to_string(path).ok()?)
}

#[cfg(not(windows))]
fn parse_hex(s: &str) -> Option<u32> {
    let t = s.trim();
    u32::from_str_radix(t.strip_prefix("0x").unwrap_or(t), 16).ok()
}

/// Enumerate display adapters via DXGI and read their PCI `VendorId`. Any
/// failure (factory creation, no adapters) leaves `probed = false`.
#[cfg(windows)]
fn detect_dxgi() -> GpuVendors {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let mut out = GpuVendors::default();
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return out, // probed = false
        };
        out.probed = true;

        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let desc = match adapter.GetDesc1() {
                Ok(desc) => desc,
                Err(_) => continue,
            };
            // Skip the software / "Microsoft Basic Render Driver" adapter.
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            match desc.VendorId {
                VENDOR_NVIDIA => out.has_nvidia = true,
                VENDOR_AMD => out.has_amd = true,
                _ => {}
            }
        }
    }
    out
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("timbre-gpu-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_device(root: &std::path::Path, slot: &str, class: &str, vendor: &str) {
        let d = root.join(slot);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("class"), class).unwrap();
        fs::write(d.join("vendor"), vendor).unwrap();
    }

    #[test]
    fn detects_nvidia_and_amd_display_controllers() {
        let root = temp_root();
        write_device(&root, "0000:01:00.0", "0x030000\n", "0x10de\n"); // NVIDIA GPU
        write_device(&root, "0000:0a:00.0", "0x030000\n", "0x1002\n"); // AMD GPU
        let r = scan_pci(&root);
        fs::remove_dir_all(&root).ok();
        assert_eq!(
            r,
            GpuVendors {
                has_nvidia: true,
                has_amd: true,
                probed: true
            }
        );
    }

    #[test]
    fn ignores_intel_and_non_display_functions() {
        let root = temp_root();
        write_device(&root, "0000:00:02.0", "0x030000\n", "0x8086\n"); // Intel iGPU — unsupported vendor
        write_device(&root, "0000:01:00.1", "0x040300\n", "0x10de\n"); // NVIDIA HDMI audio — not class 0x03
        let r = scan_pci(&root);
        fs::remove_dir_all(&root).ok();
        assert_eq!(
            r,
            GpuVendors {
                has_nvidia: false,
                has_amd: false,
                probed: true
            }
        );
    }

    #[test]
    fn missing_sysfs_is_unprobed() {
        let r = scan_pci(std::path::Path::new("/timbre/definitely/not/here"));
        assert_eq!(r, GpuVendors::default());
        assert!(!r.probed);
    }
}
