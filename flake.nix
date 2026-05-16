{
  description = "Timbre — dev environment for the Tauri shell, React UI, and Python sidecar";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) lib stdenv;

        # Core toolchains — match what's actually used by the project:
        #   * Rust shell           -> rustc / cargo / rustfmt / clippy
        #   * React UI             -> nodejs + pnpm (Vite, Tauri CLI, etc.)
        #   * Python sidecar       -> python 3.12 (project pins >=3.10,<3.13)
        # The embedded-Python backend pack the app installs at runtime is
        # downloaded into the user's app-data dir via python-build-standalone,
        # so we don't bundle it here.
        common = with pkgs; [
          rustc
          cargo
          rustfmt
          clippy
          rust-analyzer

          nodejs_24
          pnpm

          python312
          uv

          pkg-config
          git
          curl
        ];

        # Tauri's WebView backends differ per OS. macOS uses the system
        # WKWebView (no extra deps); Linux needs WebKitGTK + friends.
        darwinDeps = with pkgs; lib.optionals stdenv.isDarwin [
          libiconv
        ];

        linuxDeps = with pkgs; lib.optionals stdenv.isLinux [
          openssl
          glib
          gtk3
          libsoup_3
          webkitgtk_4_1
          librsvg
          gdk-pixbuf
          cairo
          pango
          atk
        ];
      in {
        devShells.default = pkgs.mkShell {
          packages = common ++ darwinDeps ++ linuxDeps;

          shellHook = ''
            export RUST_BACKTRACE=1
            # Keep cargo / pnpm artifacts inside the project so a `nix store gc`
            # never trashes them.
            export CARGO_HOME="$PWD/.cargo"
            export PNPM_HOME="$PWD/.pnpm-store"
            export PATH="$CARGO_HOME/bin:$PNPM_HOME:$PATH"

            echo "Timbre dev shell:"
            echo "  rust   $(rustc --version | awk '{print $2}')"
            echo "  node   $(node --version)"
            echo "  pnpm   $(pnpm --version)"
            echo "  python $(python3 --version | awk '{print $2}')"
          '';
        };

        # `nix fmt` runs nixpkgs-fmt over the flake itself.
        formatter = pkgs.nixpkgs-fmt;
      });
}
