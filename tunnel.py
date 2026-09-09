"""
Tunnel manager using Pinggy SSH to provide an instant public HTTPS URL
so mobile devices (phones) can connect and use hardware GPS.

Free Pinggy tunnels don't stay up forever — they can drop after a
while, or on any local network hiccup (Wi-Fi change, laptop sleep).
This module watches the SSH process and automatically reconnects
whenever it dies, instead of silently leaving clients pointed at a
dead URL, so `/api/network-info` never advertises a link that's no
longer resolvable.
"""

import re
import shutil
import subprocess
import threading
import time
from typing import Optional

_tunnel_process: Optional[subprocess.Popen] = None
_public_url: Optional[str] = None
_stop_requested = False
_watchdog_thread: Optional[threading.Thread] = None

_RECONNECT_DELAY_SECONDS = 3


def get_public_url() -> Optional[str]:
    """Returns the current tunnel URL, or None if no live tunnel is up."""
    return _public_url


def _read_stream(process: subprocess.Popen) -> None:
    """Read the SSH process's stdout looking for the assigned public URL."""
    global _public_url
    url_pattern = re.compile(
        r"https://[a-zA-Z0-9\-\.]+\.(?:pinggy\.net|pinggy-free\.link|run\.pinggy-free\.link)"
    )

    while True:
        line = process.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace")
        match = url_pattern.search(text)
        if match:
            _public_url = match.group(0)
            print(f"🌍 Mobile HTTPS Tunnel Active: {_public_url}")


def _spawn_ssh_process(local_port: int) -> Optional[subprocess.Popen]:
    ssh_path = shutil.which("ssh")
    if not ssh_path:
        print("⚠️ ssh command not found; cannot start Pinggy tunnel.")
        return None

    cmd = [
        ssh_path,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-p", "443",
        f"-R0:localhost:{local_port}",
        "a.pinggy.io",
    ]

    try:
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"⚠️ Failed to launch tunnel: {e}")
        return None


def _watchdog_loop(local_port: int) -> None:
    """Keeps a tunnel alive: (re)spawns the SSH process whenever it exits,
    until stop_tunnel() is called."""
    global _tunnel_process, _public_url

    while not _stop_requested:
        # Clear the old URL immediately — it's dead the moment we (re)connect,
        # so /api/network-info correctly reports "not ready" during the gap
        # instead of a stale link that no longer resolves.
        _public_url = None

        process = _spawn_ssh_process(local_port)
        if process is None:
            return  # ssh missing entirely — nothing a retry will fix

        _tunnel_process = process
        reader = threading.Thread(target=_read_stream, args=(process,), daemon=True)
        reader.start()

        process.wait()  # blocks until the SSH connection dies
        reader.join(timeout=1)

        if _stop_requested:
            return

        print(
            f"⚠️ Pinggy tunnel dropped; reconnecting in {_RECONNECT_DELAY_SECONDS}s …"
        )
        _public_url = None
        time.sleep(_RECONNECT_DELAY_SECONDS)


def start_tunnel(local_port: int = 8000) -> None:
    global _watchdog_thread, _stop_requested
    if _watchdog_thread is not None and _watchdog_thread.is_alive():
        return

    _stop_requested = False
    _watchdog_thread = threading.Thread(
        target=_watchdog_loop, args=(local_port,), daemon=True
    )
    _watchdog_thread.start()


def stop_tunnel() -> None:
    global _tunnel_process, _public_url, _stop_requested, _watchdog_thread
    _stop_requested = True
    if _tunnel_process:
        _tunnel_process.terminate()
        _tunnel_process = None
    _public_url = None
    _watchdog_thread = None
