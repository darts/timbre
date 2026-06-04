{ lib
, stdenv
, rustPlatform
, nodejs_24
, pnpm_10
, fetchPnpmDeps
, pnpmConfigHook
, pkg-config
, webkitgtk_4_1
, openssl
, glib
, gtk3
, libsoup_3
, librsvg
, gdk-pixbuf
, cairo
, pango
, atk
, wrapGAppsHook3
}:

# Tauri release build for Timbre.
#
# Repo layout: pnpm-lock.yaml at repo root, Cargo.lock under src-tauri/. We
# build from the repo root (so pnpmConfigHook finds the lockfile) and
# tell rustPlatform.buildRustPackage to invoke cargo from src-tauri/ via
# cargoRoot / buildAndTestSubdir. Do NOT set `sourceRoot = "src-tauri"` —
# that breaks the pnpm hook.
#
# python-build-standalone and the per-backend torch wheels are still
# downloaded at FirstRun into the user's data dir
# (`~/.local/share/timbre`) rather than baked into the Nix store — the
# store is immutable and we need a writable venv for the backend installer.
#
# Cargo deps are vendored via `cargoLock.lockFile`, so no `cargoHash` is
# needed. The pnpm dependency hash is pinned below for reproducible offline
# frontend installs.

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "timbre";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  cargoLock.lockFile = ../src-tauri/Cargo.lock;
  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-ELJ2zxxD5GPspoU6RLlCLQCTvYR2UnErdONKcvhl8TY=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpmConfigHook
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    webkitgtk_4_1
    openssl
    glib
    gtk3
    libsoup_3
    librsvg
    gdk-pixbuf
    cairo
    pango
    atk
  ];

  # Tauri CLI orchestrates: pnpm build (Vite -> dist/) then cargo build.
  # `--no-bundle` skips .deb/.AppImage/.rpm; the Nix package is the wrapped
  # binary itself, not a Linux installer.
  buildPhase = ''
    runHook preBuild
    pnpm exec tauri build --no-bundle
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 src-tauri/target/release/timbre $out/bin/timbre
    runHook postInstall
  '';

  doCheck = false;

  meta = with lib; {
    description = "From text to timbre — on-device voice cloning";
    homepage = "https://github.com/kialo/timbre";
    license = licenses.unfree;
    platforms = [ "x86_64-linux" ];
    mainProgram = "timbre";
  };
})
