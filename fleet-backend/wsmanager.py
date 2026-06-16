"""Tracks connected runner WebSockets and pushes commands down to machines."""
import db


class WSManager:
    def __init__(self):
        self._conns = {}  # machine_name -> WebSocket

    async def connect(self, machine_name, ws):
        await ws.accept()
        # A runner reconnecting (CLOSE 1006 left a zombie behind) MUST cleanly replace the old WS,
        # never leave two live conns for one machine. Close the stale one, then register the new.
        old = self._conns.get(machine_name)
        if old is not None and old is not ws:
            try:
                await old.close()
            except Exception:
                pass
        self._conns[machine_name] = ws
        db.touch_machine(machine_name)

    def disconnect(self, machine_name, ws=None):
        # Only drop the entry if it's still THIS socket — a fresh reconnect may have already
        # replaced it (the old socket's disconnect must not evict the new live one).
        if ws is not None and self._conns.get(machine_name) is not ws:
            return
        self._conns.pop(machine_name, None)
        db.set_machine_offline(machine_name)

    def is_online(self, machine_name):
        return machine_name in self._conns

    def machines(self):
        return list(self._conns.keys())

    async def push(self, machine_name, payload: dict) -> bool:
        """Push a command down to a machine's runner. Returns False if offline or the send fails
        (half-open socket) — a failed send evicts the dead conn so routing reflects reality."""
        ws = self._conns.get(machine_name)
        if not ws:
            return False
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            # send blew up -> socket is dead; drop it (fail-closed, no zombie 'online')
            self.disconnect(machine_name, ws)
            return False


manager = WSManager()
