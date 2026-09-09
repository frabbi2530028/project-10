"""
WebSocket connection manager for CampusGuard.

Tracks all connected users, their locations, and handles
broadcasting locations to everyone.
"""

from __future__ import annotations

import uuid
import time
import json
import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket

from utils import VALID_USER_TYPES


@dataclass
class UserState:
    """Represents a connected user's anonymous state."""

    user_id: str
    user_type: str          # "student" | "faculty" | "staff"
    websocket: Optional[WebSocket]  # None for simulated users
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    last_update: float = field(default_factory=time.time)
    is_simulated: bool = False


class ConnectionManager:
    """
    Manages WebSocket connections and user location state.

    Every connected user (or simulated user) is stored in an internal
    dict keyed by an anonymous UUID.  No personal identity is ever
    stored or transmitted — only user_type and coordinates.
    """

    def __init__(self) -> None:
        # user_id → UserState
        self._users: Dict[str, UserState] = {}

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self, websocket: WebSocket, user_type: str) -> str:
        """
        Accept a WebSocket connection and register the user.

        Returns the anonymous user_id assigned to this connection.
        """
        if user_type not in VALID_USER_TYPES:
            raise ValueError(f"Invalid user_type: {user_type!r}")

        await websocket.accept()
        user_id = uuid.uuid4().hex[:12]
        self._users[user_id] = UserState(
            user_id=user_id,
            user_type=user_type,
            websocket=websocket,
        )
        return user_id

    def disconnect(self, user_id: str) -> None:
        """Remove a user from the tracking store."""
        self._users.pop(user_id, None)

    # ------------------------------------------------------------------
    # Location updates
    # ------------------------------------------------------------------

    def update_location(
        self, user_id: str, lat: float, lng: float
    ) -> None:
        """Update the stored location for a user."""
        user = self._users.get(user_id)
        if user is None:
            return
        user.latitude = lat
        user.longitude = lng
        user.last_update = time.time()

    def _location_payload(self) -> list[dict]:
        """
        Build the anonymous location list sent to every client.

        Each entry: {id, type, lat, lng}
        No personal information is included.
        """
        locations = []
        for u in self._users.values():
            if u.latitude is not None and u.longitude is not None:
                locations.append(
                    {
                        "id": u.user_id,
                        "type": u.user_type,
                        "lat": u.latitude,
                        "lng": u.longitude,
                    }
                )
        return locations

    async def broadcast_locations(self) -> None:
        """Send the current location snapshot to every connected client."""
        payload = json.dumps(
            {"event": "locations", "data": self._location_payload()}
        )
        await self._broadcast(payload)

    # ------------------------------------------------------------------
    # Simulated users (for testing)
    # ------------------------------------------------------------------

    def add_simulated_user(
        self, user_type: str, lat: float, lng: float
    ) -> str:
        """Add a fake user at given coordinates. Returns the user_id."""
        if user_type not in VALID_USER_TYPES:
            raise ValueError(f"Invalid user_type: {user_type!r}")

        user_id = "sim_" + uuid.uuid4().hex[:8]
        self._users[user_id] = UserState(
            user_id=user_id,
            user_type=user_type,
            websocket=None,
            latitude=lat,
            longitude=lng,
            is_simulated=True,
        )
        return user_id

    def remove_simulated_user(self, user_id: str) -> bool:
        """Remove a simulated user. Returns True if found and removed."""
        user = self._users.get(user_id)
        if user and user.is_simulated:
            del self._users[user_id]
            return True
        return False

    def clear_simulated_users(self) -> int:
        """Remove all simulated users. Returns count removed."""
        to_remove = [
            uid for uid, u in self._users.items() if u.is_simulated
        ]
        for uid in to_remove:
            del self._users[uid]
        return len(to_remove)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _broadcast(self, message: str) -> None:
        """Send a text message to every real (non-simulated) WebSocket."""
        dead: list[str] = []
        for uid, user in self._users.items():
            if user.websocket is not None:
                try:
                    await user.websocket.send_text(message)
                except Exception:
                    dead.append(uid)
        # Clean up dead connections
        for uid in dead:
            self._users.pop(uid, None)

    @property
    def active_count(self) -> int:
        return len(self._users)

