"""Jev on the owner's Mac: the Laya typed-decisions server for The Orchestrator.

Started by launchd only (com.theorchestrator.jev-local, see install.sh), never
by hand or by an agent. CPU only, one checkpoint resident, bound to loopback,
no auth. The port comes from JEV_LOCAL_PORT (default 8766). Port 8765 is
reserved for another local server and is refused.
"""
import os
import sys

HOST = "127.0.0.1"
DEFAULT_PORT = 8766
RESERVED_PORT = 8765


def local_port() -> int:
    text = os.environ.get("JEV_LOCAL_PORT", str(DEFAULT_PORT))
    if not text.isdigit() or not 1024 <= int(text) <= 65535:
        print(f"jev-local: JEV_LOCAL_PORT must be a port from 1024 to 65535, got {text!r}.", file=sys.stderr)
        sys.exit(2)
    port = int(text)
    if port == RESERVED_PORT:
        print(
            f"jev-local: port {RESERVED_PORT} is reserved for another local server and is never shared. "
            f"Use {DEFAULT_PORT}.",
            file=sys.stderr,
        )
        sys.exit(2)
    return port


port = local_port()

import uvicorn  # noqa: E402  (after the port check, so a refused port loads nothing)
from laya import serve  # noqa: E402
from laya.router import Router  # noqa: E402

serve._apply_thread_limit()
router = Router(device="cpu", max_loaded=1, default="typed-decisions", standalone_repos=True)
router.preload(["typed-decisions"])
uvicorn.run(serve.create_app(router), host=HOST, port=port, log_level="info")
