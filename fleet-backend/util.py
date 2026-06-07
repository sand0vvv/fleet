"""Small pure helpers (no deps) — easy to unit-test."""
import re


def agent_name_from_path(path: str) -> str:
    """Last path segment, splitting on BOTH / and \\ (backend runs on Linux but
    paths may be Windows-style from the runner)."""
    parts = re.split(r"[\\/]+", (path or "").strip().rstrip("\\/"))
    return parts[-1] if parts and parts[-1] else (path or "")
