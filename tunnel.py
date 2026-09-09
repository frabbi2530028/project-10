"""
Tunnel manager using Pinggy SSH to provide an instant public HTTPS URL
so mobile devices (phones) can connect and use hardware GPS.
"""

import re
import shutil
import subprocess
import threading
import time
from typing import Optional

_tunnel_process: Optional[subprocess.Popen] = None
_public_url: Optional[str] = None


def get_public_url() -> Optional[str]:
    return _public_url


def _read_stream(process: subprocess.Popen):
    global _public_url
    url_pattern = re.compile(r"https://[a-zA-Z0-9\-\.]+\.(?:pinggy\.net|pinggy-free\.link|run\.pinggy-free\.link)")

    while True:
        line = process.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace")
        match = url_pattern.search(text)
        if match:
            _public_url = match.group(0)
            print(f"🌍 Mobile HTTPS Tunnel Active: {_public_url}")


def start_tunnel(local_port: int = 8000) -> None:
    global _tunnel_process, _public_url
    if _tunnel_process is not None:
        return

    ssh_path = shutil.which("ssh")
    if not ssh_path:
        print("⚠️ ssh command not found; cannot start Pinggy tunnel.")
        return

    cmd = [
        ssh_path,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ServerAliveInterval=30",
        "-p", "443",
        f"-R0:localhost:{local_port}",
        "a.pinggy.io"
    ]

    try:
        _tunnel_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL
        )
        t = threading.Thread(target=_read_stream, args=(_tunnel_process,), daemon=True)
        t.start()
    except Exception as e:
        print(f"⚠️ Failed to launch tunnel: {e}")


def stop_tunnel() -> None:
    global _tunnel_process, _public_url
    if _tunnel_process:
        _tunnel_process.terminate()
        _tunnel_process = None
        _public_url = None

