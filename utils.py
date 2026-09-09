"""
Utility functions for CampusGuard.
Haversine distance calculation and system constants.
"""

import math

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# How often the client should send location updates (seconds)
LOCATION_UPDATE_INTERVAL = 3

# User type → dot color mapping (for reference / validation)
USER_TYPE_COLORS = {
    "student": "red",
    "faculty": "blue",
    "staff": "green",
}

VALID_USER_TYPES = set(USER_TYPE_COLORS.keys())

# ---------------------------------------------------------------------------
# Haversine formula
# ---------------------------------------------------------------------------

# Earth's mean radius in meters
_EARTH_RADIUS_M = 6_371_000


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points on Earth
    using the Haversine formula.

    Parameters
    ----------
    lat1, lon1 : float
        Latitude and longitude of the first point in **degrees**.
    lat2, lon2 : float
        Latitude and longitude of the second point in **degrees**.

    Returns
    -------
    float
        Distance in **meters**.
    """
    # Convert degrees → radians
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δφ = math.radians(lat2 - lat1)
    Δλ = math.radians(lon2 - lon1)

    a = (
        math.sin(Δφ / 2) ** 2
        + math.cos(φ1) * math.cos(φ2) * math.sin(Δλ / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return _EARTH_RADIUS_M * c

