"""
StudentMap — FastAPI backend entry-point.

Local:      python main.py           → http://localhost:8000
Production: uvicorn main:app --host 0.0.0.0 --port $PORT

Environment variables
---------------------
PORT            Port to bind (Render and most PaaS hosts set this).
ENABLE_TUNNEL   "0" to skip the local Cloudflare dev tunnel (set this in prod).
CORS_ORIGINS    Comma-separated allowed origins for the browser API calls,
                e.g. "https://campusguard-uiu.netlify.app". Defaults to "*".
"""

from __future__ import annotations

import json
import os
import random
import math
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import socket
import tunnel
from connection_manager import ConnectionManager
from utils import VALID_USER_TYPES


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("PORT", 8000))

# The dev tunnel only makes sense on a laptop, where a phone otherwise can't
# reach the server. In production the host already provides a public HTTPS URL.
ENABLE_TUNNEL = os.environ.get("ENABLE_TUNNEL", "1") not in ("0", "false", "False")

CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]


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
        # Public HTTPS tunnel so a phone can reach a laptop during development
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

# Legacy static build (the pre-React page). Harmless to keep serving locally.
if os.path.isdir("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")


# ---------------------------------------------------------------------------
# Root — serve the map page
# ---------------------------------------------------------------------------

@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
async def root():
    """
    Landing page.

    In production the real UI is the React app on Netlify; this backend only
    serves the API and the WebSocket. Locally the old static page still works,
    which keeps `python main.py` useful on its own.
    """
    if os.path.exists("static/index.html"):
        with open("static/index.html") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse(
        content="<h1>StudentMap API</h1><p>Backend is running. The UI is deployed separately.</p>"
    )


# ---------------------------------------------------------------------------
# WebSocket endpoint — real-time location tracking
# ---------------------------------------------------------------------------

@app.websocket("/ws/{user_type}")
async def websocket_endpoint(websocket: WebSocket, user_type: str):
    """
    Main WebSocket endpoint.

    Path parameter *user_type* must be one of: student, faculty, staff.

    Protocol (JSON messages):
    ─────────────────────────
    Client → Server:
      {"action": "location", "lat": <float>, "lng": <float>}

    Server → Client:
      {"event": "welcome",        "data": {"user_id": "...", "user_type": "..."}}
      {"event": "locations",      "data": [ {id, type, lat, lng}, … ]}
      {"event": "error",          "data": {"message": "..."}}
    """
    if user_type not in VALID_USER_TYPES:
        await websocket.close(code=1008, reason=f"Invalid user_type: {user_type}")
        return

    user_id = await manager.connect(websocket, user_type)

    # Tell the client their anonymous id
    await websocket.send_text(
        json.dumps(
            {
                "event": "welcome",
                "data": {"user_id": user_id, "user_type": user_type},
            }
        )
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps({"event": "error", "data": {"message": "Invalid JSON"}})
                )
                continue

            action = msg.get("action")

            if action == "location":
                lat = msg.get("lat")
                lng = msg.get("lng")
                if lat is None or lng is None:
                    continue
                manager.update_location(user_id, float(lat), float(lng))
                # Broadcast updated locations to everyone
                await manager.broadcast_locations()

            else:
                await websocket.send_text(
                    json.dumps(
                        {"event": "error", "data": {"message": f"Unknown action: {action}"}}
                    )
                )

    except WebSocketDisconnect:
        manager.disconnect(user_id)
        # Broadcast so other clients remove this user's dot
        await manager.broadcast_locations()


# ---------------------------------------------------------------------------
# REST — simulate users for testing
# ---------------------------------------------------------------------------

class SimulateRequest(BaseModel):
    user_type: str = "student"
    lat: float
    lng: float


class SimulateBatchRequest(BaseModel):
    center_lat: float
    center_lng: float
    radius_meters: float = 500.0
    count: int = 10


@app.post("/api/simulate")
async def add_simulated_user(req: SimulateRequest):
    """Add a single simulated user at a specific location."""
    try:
        uid = manager.add_simulated_user(req.user_type, req.lat, req.lng)
    except ValueError as e:
        return {"error": str(e)}
    await manager.broadcast_locations()
    return {"user_id": uid, "user_type": req.user_type}


@app.post("/api/simulate/batch")
async def add_simulated_batch(req: SimulateBatchRequest):
    """
    Add multiple simulated users scattered randomly around a center point.
    Useful for quickly populating the map for testing.
    """
    created = []
    for _ in range(min(req.count, 50)):  # cap at 50
        user_type = random.choice(list(VALID_USER_TYPES))
        # Random offset within radius
        angle = random.uniform(0, 2 * math.pi)
        dist = random.uniform(0, req.radius_meters)
        # Approximate lat/lng offset (works for small distances)
        dlat = (dist * math.cos(angle)) / 111_320
        dlng = (dist * math.sin(angle)) / (
            111_320 * math.cos(math.radians(req.center_lat))
        )
        uid = manager.add_simulated_user(
            user_type,
            req.center_lat + dlat,
            req.center_lng + dlng,
        )
        created.append({"user_id": uid, "user_type": user_type})

    await manager.broadcast_locations()
    return {"created": created, "count": len(created)}


@app.delete("/api/simulate/{user_id}")
async def remove_simulated_user(user_id: str):
    """Remove a specific simulated user."""
    removed = manager.remove_simulated_user(user_id)
    if removed:
        await manager.broadcast_locations()
    return {"removed": removed}


@app.delete("/api/simulate")
async def clear_simulated_users():
    """Remove all simulated users."""
    count = manager.clear_simulated_users()
    await manager.broadcast_locations()
    return {"removed_count": count}


@app.get("/api/status")
async def status():
    """Quick health check."""
    return {"active_users": manager.active_count, "status": "running"}


@app.get("/api/network-info")
async def network_info():
    """Returns local network and public HTTPS tunnel URLs for phone pairing."""
    local_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    public_url = tunnel.get_public_url()
    return {
        "public_https_url": public_url,
        "local_ip_url": f"http://{local_ip}:8000",
        "ready": public_url is not None,
    }


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
