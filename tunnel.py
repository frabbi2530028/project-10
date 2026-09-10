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

from utils import env_flag

_tunnel_process: subprocess.Popen | None = None
_public_url: str | None = None
_stop_requested = False
_watchdog_thread: threading.Thread | None = None

_RECONNECT_DELAY_SECONDS = 3

# Active health checking of the tunnel itself (see _health_loop).
_HEALTH_GRACE_SECONDS = 90      # let a new tunnel settle before judging it
_HEALTH_INTERVAL_SECONDS = 60
_HEALTH_TIMEOUT = 10
_HEALTH_FAILURES_BEFORE_RESTART = 3   # ~3 min of real unreachability

# Restarting the tunnel changes the public hostname, which breaks any already
# deployed frontend that has the old one compiled in. That is a worse outcome
# than a temporarily slow tunnel, so unhealthy-restart is opt-in.
_RESTART_ON_UNHEALTHY = env_flag("TUNNEL_RESTART_ON_UNHEALTHY", False)

# cloudflared prints the assigned hostname to stderr during startup.
_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def get_public_url() -> str | None:
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


def _spawn_tunnel_process(local_port: int) -> subprocess.Popen | None:
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


def _tunnel_health(url: str) -> bool | None:
    """
    Is the advertised tunnel URL actually serving our app?

    Returns True (healthy), False (definitely broken), or None (inconclusive —
    don't act on it).

    The None case matters. A local resolver that can't yet see a freshly
    created *.trycloudflare.com name says nothing about whether the tunnel
    works for the rest of the internet — macOS in particular caches the
    failed lookups from just before the name existed. Treating that as
    "broken" made this function kill healthy tunnels every 20 seconds, so
    the public URL churned constantly and nothing could stay connected.
    A DNS failure is therefore inconclusive, never a reason to restart.
    """
    host = url.split("://", 1)[-1]
    try:
        socket.getaddrinfo(host, 443)
    except OSError:
        return None  # local DNS can't see it — tells us nothing about the tunnel

    try:
        with urllib.request.urlopen(f"{url}/api/status", timeout=_HEALTH_TIMEOUT) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def _health_loop(process: subprocess.Popen) -> None:
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

    # Give a new tunnel time to settle and propagate before judging it.
    time.sleep(_HEALTH_GRACE_SECONDS)

    failures = 0
    while not _stop_requested and process.poll() is None:
        time.sleep(_HEALTH_INTERVAL_SECONDS)

        url = _public_url
        if not url or process.poll() is not None or _stop_requested:
            continue

        health = _tunnel_health(url)
        if health is None:
            continue  # inconclusive — leave a working tunnel alone
        if health:
            failures = 0
            continue

        failures += 1
        if failures < _HEALTH_FAILURES_BEFORE_RESTART:
            continue

        if not _RESTART_ON_UNHEALTHY:
            # Report it, but don't act. Restarting mints a brand new hostname,
            # and any deployed frontend has the old one compiled in — so an
            # unnecessary restart takes the whole site down until it is
            # rebuilt and redeployed. A sluggish tunnel usually recovers on
            # its own; a rotated URL never does. Losing the URL is the worse
            # failure, so by default we leave the tunnel alone and only let
            # process death trigger a respawn.
            print("⚠️  Tunnel looks unresponsive, but leaving it alone "
                  "(restarting would change the public URL). "
                  "Set TUNNEL_RESTART_ON_UNHEALTHY=1 to restart instead.")
            failures = 0
            continue

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
            target=_health_loop, args=(process,), daemon=True
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
    """Shut the tunnel down and stop the watchdog from respawning it."""
    global _tunnel_process, _public_url, _stop_requested, _watchdog_thread

    _stop_requested = True
    process, _tunnel_process = _tunnel_process, None
    if process is not None:
        try:
            process.terminate()
        except OSError:
            pass  # already exited — nothing to shut down

    _public_url = None
    _watchdog_thread = None
