"""
Shared constants and small helpers used across the backend.
"""

from __future__ import annotations

import os

# The three roles a connected user can have. The map colours each one
# differently; the actual colour values live in the frontend (config.js),
# which is the only place that renders them.
VALID_USER_TYPES = frozenset({"student", "faculty", "staff"})

# Latitude/longitude bounds, used to reject nonsense coordinates before they
# reach the map.
MIN_LATITUDE, MAX_LATITUDE = -90.0, 90.0
MIN_LONGITUDE, MAX_LONGITUDE = -180.0, 180.0

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


def env_flag(name: str, default: bool) -> bool:
    """
    Read a boolean environment variable.

    Accepts the spellings people actually type ("1"/"0", "true"/"false",
    "yes"/"no", "on"/"off", any case). An unset or unrecognised value falls
    back to *default*, so a typo can't silently flip a feature off.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUTHY:
        return True
    if value in _FALSY:
        return False
    return default


def is_valid_coordinate(lat: float, lng: float) -> bool:
    """True when the pair is a real point on Earth (and not NaN/infinity)."""
    return (
        MIN_LATITUDE <= lat <= MAX_LATITUDE
        and MIN_LONGITUDE <= lng <= MAX_LONGITUDE
    )
