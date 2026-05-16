"""Length-prefixed JSON-RPC 2.0 framing (LSP-style) over stdio.

Frame format:
    Content-Length: <N>\\r\\n
    \\r\\n
    <N bytes of JSON>

Both peers use this. The sidecar receives `request` objects (with `id`) and
`notification` objects (no `id`). It returns `response` objects to requests
and may emit unsolicited notifications (for streaming progress).
"""
from __future__ import annotations

import io
import json
import sys
import threading
import traceback
from dataclasses import dataclass
from typing import Any, Callable

# JSON-RPC 2.0 standard error codes
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


@dataclass
class _Method:
    fn: Callable[..., Any]
    streaming: bool  # True if fn accepts a `notify` kwarg for progress events


class RpcServer:
    def __init__(self) -> None:
        self._methods: dict[str, _Method] = {}
        self._write_lock = threading.Lock()
        # Use raw buffers so we never get newline translation on Windows.
        # Output goes to a quarantined fd set up by timbre/__main__.py —
        # `sys.stdout` itself has been redirected to stderr at the OS level
        # so noisy libraries can't corrupt the JSON-RPC framing.
        import timbre as _pkg
        self._stdin: io.BufferedReader = sys.stdin.buffer
        self._stdout = getattr(_pkg, "_RPC_OUT", sys.stdout.buffer)

    def method(self, name: str, *, streaming: bool = False):
        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            self._methods[name] = _Method(fn=fn, streaming=streaming)
            return fn

        return deco

    # --- Framing -----------------------------------------------------------
    def _read_message(self) -> dict | None:
        headers: dict[str, str] = {}
        while True:
            line = self._stdin.readline()
            if not line:
                return None
            if line in (b"\r\n", b"\n"):
                break
            try:
                k, v = line.decode("utf-8").split(":", 1)
            except ValueError:
                continue
            headers[k.strip().lower()] = v.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None
        body = self._stdin.read(length)
        if len(body) != length:
            return None
        return json.loads(body)

    def _write_message(self, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        with self._write_lock:
            self._stdout.write(header)
            self._stdout.write(body)
            self._stdout.flush()

    # --- Public helpers ---------------------------------------------------
    def notify(self, method: str, params: Any | None = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._write_message(msg)

    # --- Main loop --------------------------------------------------------
    def serve(self) -> None:
        while True:
            try:
                msg = self._read_message()
            except json.JSONDecodeError:
                self._write_message({
                    "jsonrpc": "2.0", "id": None,
                    "error": {"code": ERR_PARSE, "message": "parse error"},
                })
                continue
            if msg is None:
                return  # EOF -> shut down cleanly
            self._dispatch(msg)

    def _dispatch(self, msg: dict) -> None:
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not isinstance(method, str):
            if req_id is not None:
                self._write_message({
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": ERR_INVALID_REQUEST, "message": "missing method"},
                })
            return

        m = self._methods.get(method)
        if m is None:
            if req_id is not None:
                self._write_message({
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": ERR_METHOD_NOT_FOUND, "message": f"unknown method: {method}"},
                })
            return

        # Run each request on its own thread so long synth calls don't block
        # progress notifications coming back on the same channel.
        def run() -> None:
            try:
                if m.streaming:
                    def notify(name: str, data: Any | None = None) -> None:
                        self.notify(name, data)
                    result = m.fn(notify=notify, **params) if isinstance(params, dict) else m.fn(notify, *params)
                else:
                    result = m.fn(**params) if isinstance(params, dict) else m.fn(*params)
                if req_id is not None:
                    self._write_message({"jsonrpc": "2.0", "id": req_id, "result": result})
            except RpcError as e:
                if req_id is not None:
                    self._write_message({
                        "jsonrpc": "2.0", "id": req_id,
                        "error": {"code": e.code, "message": e.message, "data": e.data},
                    })
            except Exception as e:  # noqa: BLE001
                traceback.print_exc(file=sys.stderr)
                if req_id is not None:
                    self._write_message({
                        "jsonrpc": "2.0", "id": req_id,
                        "error": {
                            "code": ERR_INTERNAL,
                            "message": f"{type(e).__name__}: {e}",
                        },
                    })

        threading.Thread(target=run, daemon=True).start()
