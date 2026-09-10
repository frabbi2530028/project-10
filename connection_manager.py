"""
WebSocket connection manager for StudentMap.

Owns the set of connected users, their last known position, and the job of
broadcasting the anonymous location snapshot to everyone.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

from utils import VALID_USER_TYPES

# A real client sends its position every few seconds. If we haven't heard from
# one in this long, the socket is half-open (the phone slept, the Wi-Fi
# vanished) and no exception will ever tell us — TCP just goes quiet. Dropping
# them stops a ghost dot sitting on the map forever. Generous on purpose: it
# is many heartbeats' worth of silence, so a brief stall never evicts anyone.
STALE_AFTER_SECONDS = 60.0

# Broadcasts are coalesced rather than sent per incoming update. Without this,
# N clients each sending a heartbeat produce N broadcasts to N recipients —
# quadratic traffic that becomes the bottleneck well before the map does.
BROADCAST_INTERVAL_SECONDS = 0.5


@dataclass
class UserState:
    """A connected user's anonymous state."""

    user_id: str
    user_type: str                  # "student" | "faculty" | "staff"
    websocket: WebSocket | None     # None for simulated users
    latitude: float | None = None
    longitude: float | None = None
    last_update: float = field(default_factory=time.monotonic)
    is_simulated: bool = False

    @property
    def has_position(self) -> bool:
        return self.latitude is not None and self.longitude is not None


class ConnectionManager:
    """
    Manages WebSocket connections and user location state.

    Every user — real or simulated — is stored in a dict keyed by an anonymous
    random id. No personal identity is ever stored or transmitted: only the
    role and the coordinates leave this class.
    """

    def __init__(self) -> None:
        self._users: dict[str, UserState] = {}
        self._broadcast_task: asyncio.Task | None = None

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

    def update_location(self, user_id: str, lat: float, lng: float) -> None:
        """Record a new position for a user. Unknown ids are ignored."""
        user = self._users.get(user_id)
        if user is None:
            return
        user.latitude = lat
        user.longitude = lng
        user.last_update = time.monotonic()

    # ------------------------------------------------------------------
    # Simulated users (local testing)
    # ------------------------------------------------------------------

    def add_simulated_user(self, user_type: str, lat: float, lng: float) -> str:
        """Add a fake user at the given coordinates. Returns the user_id."""
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
        """Remove one simulated user. True if it existed and was removed."""
        user = self._users.get(user_id)
        if user is not None and user.is_simulated:
            del self._users[user_id]
            return True
        return False

    def clear_simulated_users(self) -> int:
        """Remove every simulated user. Returns how many were removed."""
        stale = [uid for uid, u in self._users.items() if u.is_simulated]
        for uid in stale:
            del self._users[uid]
        return len(stale)

    # ------------------------------------------------------------------
    # Broadcasting
    # ------------------------------------------------------------------

    def schedule_broadcast(self) -> None:
        """
        Ask for a broadcast soon, collapsing a burst of calls into one send.

        Every client heartbeat lands here, so sending immediately would mean
        N² messages per round. Instead the first caller starts a short timer
        and everyone arriving during it rides along on the same broadcast.
        """
        if self._broadcast_task is not None and not self._broadcast_task.done():
            return
        self._broadcast_task = asyncio.create_task(self._delayed_broadcast())

    async def _delayed_broadcast(self) -> None:
        await asyncio.sleep(BROADCAST_INTERVAL_SECONDS)
        await self.broadcast_locations()

    async def broadcast_locations(self) -> None:
        """Send the current location snapshot to every connected client."""
        self._prune_stale()
        payload = json.dumps({"event": "locations", "data": self._location_payload()})
        await self._broadcast(payload)

    def _location_payload(self) -> list[dict]:
        """
        The anonymous location list every client receives.

        Each entry is {id, type, lat, lng} — no names, no student IDs, nothing
        that ties a dot back to a person.
        """
        return [
            {
                "id": u.user_id,
                "type": u.user_type,
                "lat": u.latitude,
                "lng": u.longitude,
            }
            for u in self._users.values()
            if u.has_position
        ]

    async def _broadcast(self, message: str) -> None:
        """
        Send a text message to every real (non-simulated) WebSocket.

        The recipient list is snapshotted first: sending yields to the event
        loop, and a user connecting or disconnecting mid-send would otherwise
        mutate the dict we are iterating and raise RuntimeError, killing the
        broadcast for everyone else. Sends run concurrently because one slow
        or half-dead client must not hold up the rest.
        """
        targets = [u for u in self._users.values() if u.websocket is not None]
        if not targets:
            return

        results = await asyncio.gather(
            *(u.websocket.send_text(message) for u in targets),
            return_exceptions=True,
        )
        for user, result in zip(targets, results):
            if isinstance(result, Exception):
                # The socket is gone; drop the user so their dot disappears.
                self._users.pop(user.user_id, None)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _prune_stale(self) -> None:
        """
        Drop real users who stopped reporting.

        Simulated users are exempt — they are placed once and never move, so
        silence is their normal state.
        """
        cutoff = time.monotonic() - STALE_AFTER_SECONDS
        stale = [
            uid
            for uid, u in self._users.items()
            if not u.is_simulated and u.last_update < cutoff
        ]
        for uid in stale:
            del self._users[uid]

    @property
    def active_count(self) -> int:
        """How many users are on the map right now, simulated ones included."""
        self._prune_stale()
        return len(self._users)

    @property
    def real_count(self) -> int:
        """How many of those are actual connected people."""
        self._prune_stale()
        return sum(1 for u in self._users.values() if not u.is_simulated)
