"""Connection tracking, location state, and broadcasting."""

import asyncio
import json

import pytest

import connection_manager as cm
from connection_manager import ConnectionManager


class FakeWebSocket:
    """Records what would have been sent, and can be told to fail."""

    def __init__(self, fail: bool = False):
        self.accepted = False
        self.sent: list[str] = []
        self.fail = fail

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, message: str) -> None:
        # Yield control, so a broadcast really does interleave with anything
        # else on the event loop — that is what the mutation test relies on.
        await asyncio.sleep(0)
        if self.fail:
            raise RuntimeError("socket is gone")
        self.sent.append(message)


def payloads(ws: FakeWebSocket) -> list:
    return [json.loads(m)["data"] for m in ws.sent]


@pytest.fixture
def manager():
    return ConnectionManager()


class TestConnectionLifecycle:
    async def test_connect_accepts_and_assigns_an_anonymous_id(self, manager):
        ws = FakeWebSocket()
        user_id = await manager.connect(ws, "student")
        assert ws.accepted
        assert user_id and len(user_id) == 12
        assert manager.active_count == 1

    async def test_ids_are_unique(self, manager):
        first = await manager.connect(FakeWebSocket(), "student")
        second = await manager.connect(FakeWebSocket(), "faculty")
        assert first != second

    async def test_rejects_an_unknown_role(self, manager):
        with pytest.raises(ValueError):
            await manager.connect(FakeWebSocket(), "chancellor")

    async def test_disconnect_removes_the_user(self, manager):
        user_id = await manager.connect(FakeWebSocket(), "student")
        manager.disconnect(user_id)
        assert manager.active_count == 0
        manager.disconnect(user_id)  # disconnecting twice is harmless


class TestLocations:
    async def test_a_user_appears_only_once_they_have_a_position(self, manager):
        ws = FakeWebSocket()
        user_id = await manager.connect(ws, "student")

        await manager.broadcast_locations()
        assert payloads(ws)[-1] == []

        manager.update_location(user_id, 23.81, 90.41)
        await manager.broadcast_locations()
        assert payloads(ws)[-1] == [
            {"id": user_id, "type": "student", "lat": 23.81, "lng": 90.41}
        ]

    async def test_broadcast_carries_no_identifying_fields(self, manager):
        user_id = await manager.connect(FakeWebSocket(), "student")
        manager.update_location(user_id, 23.81, 90.41)
        ws = FakeWebSocket()
        await manager.connect(ws, "faculty")
        await manager.broadcast_locations()

        for entry in payloads(ws)[-1]:
            assert set(entry) == {"id", "type", "lat", "lng"}

    def test_updating_an_unknown_user_is_ignored(self, manager):
        manager.update_location("nobody", 1.0, 2.0)  # must not raise
        assert manager.active_count == 0

    async def test_stale_users_are_dropped(self, manager, monkeypatch):
        user_id = await manager.connect(FakeWebSocket(), "student")
        manager.update_location(user_id, 23.81, 90.41)

        now = cm.time.monotonic()
        monkeypatch.setattr(
            cm.time, "monotonic", lambda: now + cm.STALE_AFTER_SECONDS + 1
        )
        assert manager.active_count == 0

    async def test_simulated_users_are_never_treated_as_stale(self, manager, monkeypatch):
        manager.add_simulated_user("staff", 23.81, 90.41)

        now = cm.time.monotonic()
        monkeypatch.setattr(
            cm.time, "monotonic", lambda: now + cm.STALE_AFTER_SECONDS * 100
        )
        assert manager.active_count == 1


class TestBroadcasting:
    async def test_every_connected_client_receives_the_snapshot(self, manager):
        sockets = [FakeWebSocket() for _ in range(3)]
        for ws in sockets:
            await manager.connect(ws, "student")

        await manager.broadcast_locations()
        assert all(len(ws.sent) == 1 for ws in sockets)

    async def test_a_dead_socket_is_dropped_without_stopping_the_others(self, manager):
        healthy = FakeWebSocket()
        broken = FakeWebSocket(fail=True)
        await manager.connect(healthy, "student")
        broken_id = await manager.connect(broken, "student")

        await manager.broadcast_locations()

        assert len(healthy.sent) == 1       # unaffected by its neighbour
        assert manager.active_count == 1    # the broken one is gone
        assert broken_id not in manager._users

    async def test_connecting_during_a_broadcast_does_not_break_it(self, manager):
        """
        Regression: the send loop used to iterate the live user dict while
        awaiting, so anyone connecting mid-broadcast raised "dictionary
        changed size during iteration" and every remaining client silently
        missed that update.
        """
        for _ in range(20):
            await manager.connect(FakeWebSocket(), "student")

        async def join_midway():
            await asyncio.sleep(0)  # land inside the broadcast's first await
            await manager.connect(FakeWebSocket(), "faculty")

        await asyncio.gather(manager.broadcast_locations(), join_midway())
        assert manager.active_count == 21

    async def test_scheduled_broadcasts_are_coalesced(self, manager, monkeypatch):
        monkeypatch.setattr(cm, "BROADCAST_INTERVAL_SECONDS", 0.01)
        ws = FakeWebSocket()
        user_id = await manager.connect(ws, "student")
        manager.update_location(user_id, 23.81, 90.41)

        # A burst of heartbeats, as N clients reporting at once would produce.
        for _ in range(25):
            manager.schedule_broadcast()

        await asyncio.sleep(0.05)
        assert len(ws.sent) == 1


class TestSimulatedUsers:
    def test_add_and_remove(self, manager):
        user_id = manager.add_simulated_user("faculty", 23.81, 90.41)
        assert user_id.startswith("sim_")
        assert manager.remove_simulated_user(user_id) is True
        assert manager.remove_simulated_user(user_id) is False

    async def test_real_users_cannot_be_removed_through_the_simulated_api(self, manager):
        user_id = await manager.connect(FakeWebSocket(), "student")
        assert manager.remove_simulated_user(user_id) is False
        assert manager.active_count == 1

    async def test_clear_leaves_real_users_alone(self, manager):
        await manager.connect(FakeWebSocket(), "student")
        for _ in range(4):
            manager.add_simulated_user("staff", 23.81, 90.41)

        assert manager.clear_simulated_users() == 4
        assert manager.active_count == 1
        assert manager.real_count == 1

    def test_rejects_an_unknown_role(self, manager):
        with pytest.raises(ValueError):
            manager.add_simulated_user("chancellor", 23.81, 90.41)
