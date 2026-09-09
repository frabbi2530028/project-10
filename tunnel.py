"""
Tunnel manager — gives the local dev server an instant public HTTPS URL so
phones (and a deployed frontend) can reach it.

Uses Cloudflare's quick tunnels (`cloudflared tunnel --url ...`), which need
no account and no config.

Why not Pinggy (used previously): its free tier serves an interstitial
"you are visiting a tunnel" HTML page to anything that looks like a browser,
while returning real responses to curl and other clients. That silently
breaks WebSockets from a real browser — the upgrade request gets HTML back
instead of a 101, so the app connects fine from scripts but shows "Offline"
on an actual phone. Browsers can't send the bypass header, because the
WebSocket API doesn't allow custom headers. Cloudflare quick tunnels have no
such interstitial and upgrade WebSockets correctly.

Install once with:  brew install cloudflared

The tunnel is watched and restarted if it dies, and `get_public_url()`
returns None while no tunnel is live, so callers never advertise a dead URL.
"""

import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Optional

_tunnel_process: Optional[subprocess.Popen] = None
_public_url: Optional[str] = None
_stop_requested = False
_watchdog_thread: Optional[threading.Thread] = None

_RECONNECT_DELAY_SECONDS = 3

# Active health checking of the tunnel itself (see _health_loop).
_HEALTH_INTERVAL_SECONDS = 20
_HEALTH_TIMEOUT = 8
_HEALTH_FAILURES_BEFORE_RESTART = 2

# cloudflared prints the assigned hostname to stderr during startup.
_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def get_public_url() -> Optional[str]:
    """Returns the current tunnel URL, or None if no live tunnel is up."""
    return _public_url


def _read_stream(process: subprocess.Popen) -> None:
    """Scan the tunnel process output for the assigned public URL."""
    global _public_url

    while True:
        line = process.stdout.readline()
        if not line:
            break
        match = _URL_PATTERN.search(line.decode("utf-8", errors="replace"))
        if match:
            _public_url = match.group(0)
            print(f"🌍 Mobile HTTPS Tunnel Active: {_public_url}")


def _spawn_tunnel_process(local_port: int) -> Optional[subprocess.Popen]:
    cloudflared = shutil.which("cloudflared")
    if not cloudflared:
        print("⚠️  cloudflared not found — no public tunnel.")
        print("   Install it with:  brew install cloudflared")
        print("   (The app still works locally; phones just can't reach it.)")
        return None

    cmd = [
        cloudflared,
        "tunnel",
        "--url", f"http://localhost:{local_port}",
        "--no-autoupdate",
    ]

    try:
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # cloudflared logs the URL on stderr
            stdin=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"⚠️  Failed to launch tunnel: {e}")
        return None


def _tunnel_is_reachable(url: str, local_port: int) -> bool:
    """Is the advertised tunnel URL actually serving our app right now?"""
    host = url.split("://", 1)[-1]
    try:
        socket.getaddrinfo(host, 443)
    except OSError:
        return False  # hostname is gone — the tunnel was torn down

    try:
        with urllib.request.urlopen(f"{url}/api/status", timeout=_HEALTH_TIMEOUT) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def _health_loop(process: subprocess.Popen, local_port: int) -> None:
    """
    Actively verify the tunnel, not just the process.

    cloudflared can keep running with a tunnel that no longer works — most
    often after the laptop changes Wi-Fi network or wakes from sleep. Watching
    only for process exit misses that entirely and leaves clients pointed at a
    hostname that no longer resolves, which looks to them like "server
    unreachable" while everything appears fine locally. When the URL stops
    answering we kill cloudflared so the watchdog respawns it and picks up a
    fresh hostname.
    """
    global _public_url

    failures = 0
    while not _stop_requested and process.poll() is None:
        time.sleep(_HEALTH_INTERVAL_SECONDS)

        url = _public_url
        if not url or process.poll() is not None or _stop_requested:
            continue

        if _tunnel_is_reachable(url, local_port):
            failures = 0
            continue

        failures += 1
        if failures >= _HEALTH_FAILURES_BEFORE_RESTART:
            print("⚠️  Tunnel stopped responding (network change?) — restarting it …")
            _public_url = None  # nothing should advertise a dead URL
            try:
                process.terminate()
            except Exception:
                pass
            return


def _watchdog_loop(local_port: int) -> None:
    """Keep a tunnel alive: (re)spawn it whenever it exits, until stopped."""
    global _tunnel_process, _public_url

    while not _stop_requested:
        # Clear the old URL immediately — a reconnect always gets a new
        # hostname, so callers must not keep advertising the previous one.
        _public_url = None

        process = _spawn_tunnel_process(local_port)
        if process is None:
            return  # cloudflared missing entirely — retrying won't fix it

        _tunnel_process = process
        reader = threading.Thread(target=_read_stream, args=(process,), daemon=True)
        reader.start()

        health = threading.Thread(
            target=_health_loop, args=(process, local_port), daemon=True
        )
        health.start()

        process.wait()  # blocks until the tunnel dies (or health check kills it)
        reader.join(timeout=1)

        if _stop_requested:
            return

        print(f"⚠️  Tunnel dropped; reconnecting in {_RECONNECT_DELAY_SECONDS}s …")
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
