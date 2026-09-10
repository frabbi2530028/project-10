"""
StudentMap — FastAPI backend entry-point.

Local:      python main.py           → http://localhost:8000
Production: uvicorn main:app --host 0.0.0.0 --port $PORT

Environment variables
---------------------
PORT               Port to bind (Render and most PaaS hosts set this).
ENABLE_TUNNEL      "0" to skip the local Cloudflare dev tunnel (set this in prod).
ENABLE_SIMULATION  "0" to disable the /api/simulate* test endpoints (set this
                   in prod, where anyone could otherwise litter the live map
                   with fake dots).
CORS_ORIGINS       Comma-separated allowed origins for the browser API calls,
                   e.g. "https://studentmap-uiu.netlify.app". Defaults to "*".
CURRENT_TRIMESTER  Override the trimester the login check treats as current.
"""

from __future__ import annotations

import json
import math
import os
import random
import socket
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

import auth
import tunnel
from connection_manager import ConnectionManager
from utils import (
    MAX_LATITUDE,
    MIN_LATITUDE,
    VALID_USER_TYPES,
    env_flag,
    is_valid_coordinate,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("PORT", 8000))

# The dev tunnel only makes sense on a laptop, where a phone otherwise can't
# reach the server. In production the host already provides a public HTTPS URL.
ENABLE_TUNNEL = env_flag("ENABLE_TUNNEL", True)

# Simulated users are a local testing aid, not a feature.
ENABLE_SIMULATION = env_flag("ENABLE_SIMULATION", True)

CORS_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()
]

# Ceiling on one /api/simulate/batch call, so a single request can't flood the
# map (or the memory of a free-tier instance).
MAX_SIMULATED_PER_BATCH = 50

# Metres per degree of latitude. Longitude shrinks by cos(latitude); over the
# few hundred metres this is used for, the flat-earth approximation is exact
# to well under a metre.
METRES_PER_DEGREE = 111_320


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    print("🟢  StudentMap server starting …")
    print(f"   Listening on port {PORT}")
    if ENABLE_TUNNEL:
        # Public HTTPS tunnel so a phone can reach a laptop during development.
        tunnel.start_tunnel(PORT)
    yield
    print("🔴  StudentMap server shutting down …")
    tunnel.stop_tunnel()


app = FastAPI(title="StudentMap", lifespan=lifespan)

# The React frontend is served from a different origin (Netlify) than this
# API, so the browser needs explicit permission for the /api/* calls.
# WebSockets aren't subject to CORS, so the live map works regardless.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_simulation_enabled() -> None:
    if not ENABLE_SIMULATION:
        raise HTTPException(
            status_code=404, detail="Simulated users are disabled on this server."
        )


# ---------------------------------------------------------------------------
# Root
# ---------------------------------------------------------------------------

@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
async def root() -> HTMLResponse:
    """
    Landing page for anyone who opens the API host directly.

    This service is the API and the WebSocket only — the user interface is the
    React app, deployed separately.
    """
    return HTMLResponse(
        "<h1>StudentMap API</h1>"
        "<p>Backend is running. The map itself is deployed separately.</p>"
        '<p>Health check: <a href="/api/status">/api/status</a></p>'
    )


# ---------------------------------------------------------------------------
# Login — UIU student credentials
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    student_id: str


@app.post("/api/login")
async def login(req: LoginRequest) -> dict:
    """
    Check a UIU email / student ID pair and hand back a session token.

    The token is required to open the location WebSocket, so the login gate
    can't simply be skipped by connecting directly.
    """
    student, error = auth.validate_student(req.email, req.student_id)
    if student is None:
        raise HTTPException(status_code=401, detail=error)

    return {"token": auth.issue_token(student), "student": student.public()}


@app.post("/api/logout")
async def logout(token: str = Body(embed=True)) -> dict:
    auth.revoke_token(token)
    return {"ok": True}


# ---------------------------------------------------------------------------
# WebSocket endpoint — real-time location tracking
# ---------------------------------------------------------------------------

async def _send_event(websocket: WebSocket, event: str, data: dict | list) -> None:
    await websocket.send_text(json.dumps({"event": event, "data": data}))


async def _handle_location(websocket: WebSocket, user_id: str, msg: dict) -> None:
    """Apply one {"action": "location"} message from a client."""
    try:
        lat = float(msg["lat"])
        lng = float(msg["lng"])
    except (KeyError, TypeError, ValueError):
        # A malformed update is the client's problem, not a reason to drop the
        # connection — say so and carry on.
        await _send_event(
            websocket, "error", {"message": "location needs numeric lat and lng"}
        )
        return

    if not is_valid_coordinate(lat, lng):
        await _send_event(
            websocket, "error", {"message": "lat/lng outside the range of Earth"}
        )
        return

    manager.update_location(user_id, lat, lng)
    manager.schedule_broadcast()


@app.websocket("/ws/{user_type}")
async def websocket_endpoint(
    websocket: WebSocket, user_type: str, token: str | None = None
) -> None:
    """
    Main WebSocket endpoint.

    Path parameter *user_type* must be one of: student, faculty, staff.
    Query parameter *token* must be a session token from POST /api/login —
    a browser can't attach headers to a WebSocket handshake, so the token
    travels in the query string.

    Protocol (JSON messages):
    ─────────────────────────
    Client → Server:
      {"action": "location", "lat": <float>, "lng": <float>}

    Server → Client:
      {"event": "welcome",   "data": {"user_id": "...", "user_type": "..."}}
      {"event": "locations", "data": [ {id, type, lat, lng}, … ]}
      {"event": "error",     "data": {"message": "..."}}
    """
    if user_type not in VALID_USER_TYPES:
        await websocket.close(code=1008, reason=f"Invalid user_type: {user_type}")
        return

    if auth.resolve_token(token) is None:
        # 1008 = policy violation. Without this the login page would be
        # decorative: anyone could open a socket directly and be on the map.
        await websocket.close(code=1008, reason="Sign in first")
        return

    user_id = await manager.connect(websocket, user_type)

    try:
        await _send_event(
            websocket, "welcome", {"user_id": user_id, "user_type": user_type}
        )

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send_event(websocket, "error", {"message": "Invalid JSON"})
                continue

            if not isinstance(msg, dict):
                await _send_event(
                    websocket, "error", {"message": "Expected a JSON object"}
                )
                continue

            action = msg.get("action")
            if action == "location":
                await _handle_location(websocket, user_id, msg)
            else:
                await _send_event(
                    websocket, "error", {"message": f"Unknown action: {action}"}
                )

    except WebSocketDisconnect:
        pass
    finally:
        # Unconditional: an unexpected error here must not leave the user
        # registered, or their dot haunts the map until the server restarts.
        manager.disconnect(user_id)
        await manager.broadcast_locations()


# ---------------------------------------------------------------------------
# REST — simulated users, for local testing
# ---------------------------------------------------------------------------

class SimulateRequest(BaseModel):
    user_type: str = "student"
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class SimulateBatchRequest(BaseModel):
    center_lat: float = Field(ge=-90, le=90)
    center_lng: float = Field(ge=-180, le=180)
    radius_meters: float = Field(default=500.0, gt=0, le=50_000)
    count: int = Field(default=10, ge=1, le=MAX_SIMULATED_PER_BATCH)


def _offset_coordinate(
    lat: float, lng: float, radius_meters: float
) -> tuple[float, float]:
    """
    A random point within *radius_meters* of the given coordinate.

    A degree of longitude narrows by cos(latitude), which approaches zero at
    the poles: dividing by it there turned a 500 m offset into a longitude of
    ~1e13, and those nonsense coordinates were stored and broadcast to every
    client. Clamping the divisor bounds the offset, and wrapping the result
    keeps it a real point on Earth even when the caller starts at a pole.
    """
    angle = random.uniform(0, 2 * math.pi)
    distance = random.uniform(0, radius_meters)

    dlat = (distance * math.cos(angle)) / METRES_PER_DEGREE
    # cos(89.9°) — past this the east/west offset stops being meaningful.
    shrink = max(math.cos(math.radians(lat)), 0.0017)
    dlng = (distance * math.sin(angle)) / (METRES_PER_DEGREE * shrink)

    return _clamp_latitude(lat + dlat), _wrap_longitude(lng + dlng)


def _clamp_latitude(lat: float) -> float:
    """Latitude stops at the poles; it does not wrap around."""
    return min(max(lat, MIN_LATITUDE), MAX_LATITUDE)


def _wrap_longitude(lng: float) -> float:
    """Longitude is a circle: 181° east is 179° west."""
    return (lng + 180.0) % 360.0 - 180.0


@app.post("/api/simulate")
async def add_simulated_user(req: SimulateRequest) -> dict:
    """Add a single simulated user at a specific location."""
    _require_simulation_enabled()
    try:
        uid = manager.add_simulated_user(req.user_type, req.lat, req.lng)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await manager.broadcast_locations()
    return {"user_id": uid, "user_type": req.user_type}


@app.post("/api/simulate/batch")
async def add_simulated_batch(req: SimulateBatchRequest) -> dict:
    """
    Add several simulated users scattered around a centre point.
    Useful for populating the map quickly while testing.
    """
    _require_simulation_enabled()

    roles = sorted(VALID_USER_TYPES)
    created = []
    for _ in range(req.count):
        user_type = random.choice(roles)
        lat, lng = _offset_coordinate(req.center_lat, req.center_lng, req.radius_meters)
        created.append(
            {
                "user_id": manager.add_simulated_user(user_type, lat, lng),
                "user_type": user_type,
            }
        )

    await manager.broadcast_locations()
    return {"created": created, "count": len(created)}


@app.delete("/api/simulate/{user_id}")
async def remove_simulated_user(user_id: str) -> dict:
    """Remove one simulated user."""
    _require_simulation_enabled()
    removed = manager.remove_simulated_user(user_id)
    if removed:
        await manager.broadcast_locations()
    return {"removed": removed}


@app.delete("/api/simulate")
async def clear_simulated_users() -> dict:
    """Remove every simulated user."""
    _require_simulation_enabled()
    count = manager.clear_simulated_users()
    await manager.broadcast_locations()
    return {"removed_count": count}


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

@app.get("/api/status")
async def status() -> dict:
    """Health check, also used by the tunnel watchdog."""
    return {
        "status": "running",
        "active_users": manager.active_count,
        "real_users": manager.real_count,
        "active_sessions": auth.active_session_count(),
        "simulation_enabled": ENABLE_SIMULATION,
    }


def _local_ip() -> str:
    """
    This machine's address on the LAN.

    Opening a UDP socket to a public address makes the OS pick the interface
    it would actually route through; nothing is sent, so it works offline-ish
    and never blocks.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


@app.get("/api/network-info")
async def network_info() -> dict:
    """Local network and public HTTPS tunnel URLs, for pairing a phone."""
    public_url = tunnel.get_public_url()
    return {
        "public_https_url": public_url,
        "local_ip_url": f"http://{_local_ip()}:{PORT}",
        "ready": public_url is not None,
    }


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
