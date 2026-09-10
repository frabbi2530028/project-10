"""
HTTP and WebSocket endpoints, driven through FastAPI's TestClient.

All credentials below are invented; only their internal consistency matters.
"""

import pytest
from fastapi.testclient import TestClient

import auth
import main
from main import app

VALID_EMAIL = "someone2510001@cse.uiu.ac.bd"
VALID_ID = "0102510001"

CAMPUS_LAT, CAMPUS_LNG = 23.7683, 90.4269


@pytest.fixture
def client(monkeypatch):
    # The dev tunnel spawns a subprocess and has no business running in tests.
    monkeypatch.setattr(main, "ENABLE_TUNNEL", False)
    auth._sessions.clear()
    main.manager._users.clear()
    with TestClient(app) as c:
        yield c
    auth._sessions.clear()
    main.manager._users.clear()


def sign_in(client) -> str:
    resp = client.post("/api/login", json={"email": VALID_EMAIL, "student_id": VALID_ID})
    assert resp.status_code == 200
    return resp.json()["token"]


class TestLogin:
    def test_a_consistent_pair_returns_a_token(self, client):
        body = client.post(
            "/api/login", json={"email": VALID_EMAIL, "student_id": VALID_ID}
        ).json()
        assert body["token"]
        assert body["student"]["role"] == "student"

    def test_a_mismatched_pair_is_rejected(self, client):
        resp = client.post(
            "/api/login", json={"email": VALID_EMAIL, "student_id": "0102510009"}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"]

    def test_logout_invalidates_the_token(self, client):
        token = sign_in(client)
        assert client.post("/api/logout", json={"token": token}).status_code == 200
        assert auth.resolve_token(token) is None


class TestWebSocketGate:
    def test_a_valid_token_gets_a_welcome(self, client):
        token = sign_in(client)
        with client.websocket_connect(f"/ws/student?token={token}") as ws:
            msg = ws.receive_json()
            assert msg["event"] == "welcome"
            assert msg["data"]["user_type"] == "student"

    @pytest.mark.parametrize("query", ["", "?token=", "?token=forged"])
    def test_the_socket_is_shut_without_a_real_token(self, client, query):
        """The login screen must not be bypassable by opening a socket directly."""
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/student{query}") as ws:
                ws.receive_json()

    def test_an_unknown_role_is_refused(self, client):
        from starlette.websockets import WebSocketDisconnect

        token = sign_in(client)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/chancellor?token={token}") as ws:
                ws.receive_json()


class TestLocationProtocol:
    def test_a_position_is_echoed_back_in_the_snapshot(self, client):
        token = sign_in(client)
        with client.websocket_connect(f"/ws/student?token={token}") as ws:
            ws.receive_json()  # welcome
            ws.send_json({"action": "location", "lat": CAMPUS_LAT, "lng": CAMPUS_LNG})
            data = ws.receive_json()
            assert data["event"] == "locations"
            assert data["data"][0]["lat"] == CAMPUS_LAT

    @pytest.mark.parametrize(
        "message",
        [
            {"action": "location", "lat": "north", "lng": 90.4},   # not a number
            {"action": "location", "lat": None, "lng": 90.4},
            {"action": "location", "lat": 23.7},                    # lng missing
            {"action": "location", "lat": 999, "lng": 90.4},        # off the planet
            {"action": "location", "lat": 23.7, "lng": -400},
            {"action": "teleport", "lat": 23.7, "lng": 90.4},       # unknown action
        ],
    )
    def test_a_bad_message_is_reported_without_dropping_the_connection(
        self, client, message
    ):
        token = sign_in(client)
        with client.websocket_connect(f"/ws/student?token={token}") as ws:
            ws.receive_json()
            ws.send_json(message)
            assert ws.receive_json()["event"] == "error"

            # Still usable afterwards — one bad frame is not a fatal error.
            ws.send_json({"action": "location", "lat": CAMPUS_LAT, "lng": CAMPUS_LNG})
            assert ws.receive_json()["event"] == "locations"

    def test_malformed_json_is_reported(self, client):
        token = sign_in(client)
        with client.websocket_connect(f"/ws/student?token={token}") as ws:
            ws.receive_json()
            ws.send_text("{not json")
            assert ws.receive_json()["data"]["message"] == "Invalid JSON"

    def test_disconnecting_removes_the_user(self, client):
        token = sign_in(client)
        with client.websocket_connect(f"/ws/student?token={token}") as ws:
            ws.receive_json()
            assert main.manager.real_count == 1
        assert main.manager.real_count == 0


class TestSimulation:
    def test_batch_creates_users_near_the_centre(self, client):
        body = client.post(
            "/api/simulate/batch",
            json={"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG,
                  "radius_meters": 500, "count": 8},
        ).json()

        assert body["count"] == 8
        assert main.manager.active_count == 8
        for entry in main.manager._location_payload():
            assert abs(entry["lat"] - CAMPUS_LAT) < 0.01
            assert abs(entry["lng"] - CAMPUS_LNG) < 0.01

    @pytest.mark.parametrize(
        "payload",
        [
            {"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG, "count": 999},
            {"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG, "count": 0},
            {"center_lat": 999, "center_lng": CAMPUS_LNG},
            {"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG, "radius_meters": -5},
        ],
    )
    def test_out_of_range_batch_requests_are_refused(self, client, payload):
        assert client.post("/api/simulate/batch", json=payload).status_code == 422

    def test_an_unknown_role_is_refused_with_422(self, client):
        resp = client.post(
            "/api/simulate",
            json={"user_type": "chancellor", "lat": CAMPUS_LAT, "lng": CAMPUS_LNG},
        )
        assert resp.status_code == 422

    def test_clear_removes_everything_simulated(self, client):
        client.post(
            "/api/simulate/batch",
            json={"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG, "count": 5},
        )
        assert client.delete("/api/simulate").json()["removed_count"] == 5

    def test_the_endpoints_disappear_when_simulation_is_off(self, client, monkeypatch):
        monkeypatch.setattr(main, "ENABLE_SIMULATION", False)
        resp = client.post(
            "/api/simulate",
            json={"user_type": "student", "lat": CAMPUS_LAT, "lng": CAMPUS_LNG},
        )
        assert resp.status_code == 404


class TestCoordinateOffsets:
    """
    Regression: a degree of longitude shrinks to nothing at the poles, so
    dividing by cos(latitude) there turned a 500 m offset into a longitude of
    roughly 1e13 — and those coordinates were stored and broadcast to clients.
    """

    @pytest.mark.parametrize(
        "centre",
        [(90.0, 0.0), (-90.0, 179.9), (89.999, 10.0), (0.0, -180.0), (CAMPUS_LAT, CAMPUS_LNG)],
    )
    def test_offsets_are_always_real_points_on_earth(self, centre):
        from utils import is_valid_coordinate

        for _ in range(500):
            lat, lng = main._offset_coordinate(*centre, 500.0)
            assert is_valid_coordinate(lat, lng), f"{centre} produced {lat}, {lng}"

    def test_offsets_stay_near_the_centre_at_normal_latitudes(self):
        for _ in range(500):
            lat, lng = main._offset_coordinate(CAMPUS_LAT, CAMPUS_LNG, 500.0)
            assert abs(lat - CAMPUS_LAT) < 0.01
            assert abs(lng - CAMPUS_LNG) < 0.01

    def test_simulating_at_a_pole_yields_a_usable_map(self, client):
        client.post(
            "/api/simulate/batch",
            json={"center_lat": 90, "center_lng": 0, "radius_meters": 500, "count": 10},
        )
        from utils import is_valid_coordinate

        entries = main.manager._location_payload()
        assert len(entries) == 10
        assert all(is_valid_coordinate(e["lat"], e["lng"]) for e in entries)

    def test_longitude_wraps_rather_than_running_off_the_end(self):
        assert main._wrap_longitude(181.0) == pytest.approx(-179.0)
        assert main._wrap_longitude(-181.0) == pytest.approx(179.0)
        assert main._wrap_longitude(90.0) == pytest.approx(90.0)

    def test_latitude_clamps_at_the_poles(self):
        assert main._clamp_latitude(95.0) == 90.0
        assert main._clamp_latitude(-95.0) == -90.0
        assert main._clamp_latitude(23.5) == 23.5


class TestDiagnostics:
    def test_status(self, client):
        body = client.get("/api/status").json()
        assert body["status"] == "running"
        assert body["active_users"] == 0

    def test_status_separates_real_users_from_simulated_ones(self, client):
        client.post(
            "/api/simulate/batch",
            json={"center_lat": CAMPUS_LAT, "center_lng": CAMPUS_LNG, "count": 3},
        )
        body = client.get("/api/status").json()
        assert body["active_users"] == 3
        assert body["real_users"] == 0

    def test_network_info_reports_the_configured_port(self, client):
        body = client.get("/api/network-info").json()
        assert body["local_ip_url"].endswith(f":{main.PORT}")
        assert body["ready"] is False  # no tunnel in tests

    def test_root_serves_a_landing_page(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert "StudentMap API" in resp.text
