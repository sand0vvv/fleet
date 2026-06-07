"""Tracks connected runner WebSockets and pushes commands down to machines."""
import db


class WSManager:
    def __init__(self):
        self._conns = {}  # machine_name -> WebSocket

    async def connect(self, machine_name, ws):
        await ws.accept()
        old = self._conns.get(machine_name)
        if old:
            try:
                await old.close()
            except Exception:
                pass
        self._conns[machine_name] = ws
        db.touch_machine(machine_name)

    def disconnect(self, machine_name):
        self._conns.pop(machine_name, None)
        db.set_machine_offline(machine_name)

    def is_online(self, machine_name):
        return machine_name in self._conns

    def machines(self):
        return list(self._conns.keys())

    async def push(self, machine_name, payload: dict) -> bool:
        """Push a command down to a machine's runner. Returns False if offline."""
        ws = self._conns.get(machine_name)
        if not ws:
            return False
        await ws.send_json(payload)
        return True


manager = WSManager()
