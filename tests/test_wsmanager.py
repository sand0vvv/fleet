"""WSManager reconnect/presence hardening — the 'no online machines' glitch.

These exercise the in-memory connection bookkeeping (no DB needed): db calls are stubbed so
the manager can be tested in isolation. The bugs being guarded against:
  - a CLOSE 1006 zombie WS staying registered -> machine looks online forever / push to a dead sock
  - an old socket's disconnect evicting a freshly-reconnected one -> false 'offline'
"""
import asyncio

import wsmanager
from wsmanager import WSManager


class FakeWS:
    """Minimal WebSocket double: records accept/close, can simulate a dead send."""

    def __init__(self, dead=False):
        self.accepted = False
        self.closed = False
        self.sent = []
        self.dead = dead

    async def accept(self):
        self.accepted = True

    async def close(self):
        self.closed = True

    async def send_json(self, payload):
        if self.dead:
            raise ConnectionError("socket is dead")
        self.sent.append(payload)


def _stub_db(monkeypatch):
    """Stub db.* so the manager doesn't touch Supabase."""
    monkeypatch.setattr(wsmanager.db, "touch_machine", lambda name: None)
    monkeypatch.setattr(wsmanager.db, "set_machine_offline", lambda name: None)


def test_reconnect_replaces_zombie(monkeypatch):
    _stub_db(monkeypatch)
    mgr = WSManager()

    async def go():
        old = FakeWS()
        await mgr.connect("home", old)
        assert mgr.is_online("home")
        # runner reconnects (old socket was a 1006 zombie) -> old must be closed, new registered
        new = FakeWS()
        await mgr.connect("home", new)
        assert old.closed is True
        assert mgr._conns["home"] is new
        assert mgr.is_online("home")

    asyncio.run(go())


def test_stale_disconnect_does_not_evict_new(monkeypatch):
    _stub_db(monkeypatch)
    mgr = WSManager()

    async def go():
        old = FakeWS()
        await mgr.connect("home", old)
        new = FakeWS()
        await mgr.connect("home", new)
        # the OLD socket's delayed disconnect must NOT drop the live new conn
        mgr.disconnect("home", old)
        assert mgr.is_online("home") is True
        # the actual live socket disconnecting DOES drop it
        mgr.disconnect("home", new)
        assert mgr.is_online("home") is False

    asyncio.run(go())


def test_push_failure_evicts_dead_conn(monkeypatch):
    _stub_db(monkeypatch)
    mgr = WSManager()

    async def go():
        dead = FakeWS(dead=True)
        await mgr.connect("home", dead)
        ok = await mgr.push("home", {"type": "ping"})
        assert ok is False                 # send failed -> fail-closed
        assert mgr.is_online("home") is False  # dead conn evicted, no zombie 'online'

    asyncio.run(go())


def test_push_offline_returns_false(monkeypatch):
    _stub_db(monkeypatch)
    mgr = WSManager()

    async def go():
        assert await mgr.push("ghost", {"type": "ping"}) is False

    asyncio.run(go())
