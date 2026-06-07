"""Import smoke tests — catch syntax/import errors in the services."""


def test_import_backend_app():
    import app  # noqa: F401  (fleet-backend on path via conftest)


def test_import_helpers():
    import db, telegram, transcribe, wsmanager, config, util  # noqa: F401
