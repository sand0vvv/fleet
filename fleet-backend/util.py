"""Small pure helpers (no deps) — easy to unit-test."""
import re


def agent_name_from_path(path: str) -> str:
    """Last path segment, splitting on BOTH / and \\ (backend runs on Linux but
    paths may be Windows-style from the runner)."""
    parts = re.split(r"[\\/]+", (path or "").strip().rstrip("\\/"))
    return parts[-1] if parts and parts[-1] else (path or "")


def _person(u: dict) -> str:
    if not u:
        return ""
    return " ".join(x for x in [u.get("first_name"), u.get("last_name")] if x) or (u.get("username") or "")


def forward_prefix(msg: dict) -> str:
    """If the Telegram message is forwarded, return a '[переслано от X]\\n' tag, else ''."""
    fo = msg.get("forward_origin") or {}
    name = ""
    t = fo.get("type")
    if t == "user":
        name = _person(fo.get("sender_user") or {})
    elif t == "hidden_user":
        name = fo.get("sender_user_name") or ""
    elif t == "channel":
        name = (fo.get("chat") or {}).get("title") or ""
    elif t == "chat":
        name = (fo.get("sender_chat") or {}).get("title") or ""
    # legacy fields
    if not name:
        if msg.get("forward_sender_name"):
            name = msg["forward_sender_name"]
        elif msg.get("forward_from"):
            name = _person(msg["forward_from"])
        elif msg.get("forward_from_chat"):
            name = (msg["forward_from_chat"] or {}).get("title") or ""
    forwarded = bool(fo or msg.get("forward_from") or msg.get("forward_sender_name")
                     or msg.get("forward_from_chat") or msg.get("forward_date"))
    if not forwarded:
        return ""
    return f"[переслано от {name}]\n" if name else "[переслано]\n"
