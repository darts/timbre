"""Sidecar entry point.

Critical: this module runs *before* any heavy imports so we can quarantine
stdout. The Rust shell uses fd 1 as a length-prefixed JSON-RPC channel —
ANY library writing plain text to stdout (tqdm bars, HF warnings, model
loaders, even C-level printf) corrupts the framing and kills the call.

Strategy:
  1. `os.dup(1)` — preserve the real RPC fd before we touch anything.
  2. `os.dup2(2, 1)` — point fd 1 at stderr, so anything written to stdout
     (Python, tqdm, native code) is redirected to stderr instead.
  3. Replace `sys.stdout` so `print()` follows the redirect cleanly.
  4. Expose the preserved fd as `timbre._RPC_OUT` for `rpc.py` to use.
"""
from __future__ import annotations

import os
import sys
import warnings


def _quarantine_stdout() -> None:
    real_stdout_fd = os.dup(1)
    # Redirect fd 1 -> stderr at the OS level. Any library that writes to
    # stdout from now on is rerouted to stderr; Rust's stderr logger picks
    # it up.
    os.dup2(2, 1)
    # Replace Python's text-mode sys.stdout so prints land on stderr too.
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    sys.stdout = os.fdopen(
        1, "w", buffering=1, encoding="utf-8", errors="replace"
    )

    # Hand the preserved binary writer to the rpc module.
    import timbre as _pkg
    _pkg._RPC_OUT = os.fdopen(real_stdout_fd, "wb", buffering=0, closefd=True)


_quarantine_stdout()

# Let PyTorch route unsupported MPS kernels to CPU when it can. Timbre also
# retries selected accelerator failures on CPU at the adapter-operation level.
# This must be set before `torch` is imported anywhere downstream.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Silence the noise that always shows up before our code runs.
warnings.filterwarnings("ignore", category=SyntaxWarning, module=r"pysbd.*")
warnings.filterwarnings("ignore", category=FutureWarning, message=r".*TRANSFORMERS_CACHE.*")

# One-line startup banner via stderr so the Rust shell logs it. Confirms
# our env-var quarantine actually took effect.
print(
    f"[timbre] sidecar boot: pid={os.getpid()} "
    f"PYTORCH_ENABLE_MPS_FALLBACK={os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK','<unset>')}",
    file=sys.stderr,
    flush=True,
)

from timbre.server import main  # noqa: E402

if __name__ == "__main__":
    main()
