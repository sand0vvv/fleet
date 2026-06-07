from util import forward_prefix


def test_not_forwarded():
    assert forward_prefix({"text": "hi"}) == ""


def test_forward_origin_user():
    msg = {"forward_origin": {"type": "user", "sender_user": {"first_name": "Иван", "last_name": "П"}}}
    assert forward_prefix(msg) == "[переслано от Иван П]\n"


def test_forward_origin_hidden():
    msg = {"forward_origin": {"type": "hidden_user", "sender_user_name": "Аноним"}}
    assert forward_prefix(msg) == "[переслано от Аноним]\n"


def test_forward_origin_channel():
    msg = {"forward_origin": {"type": "channel", "chat": {"title": "Новости"}}}
    assert forward_prefix(msg) == "[переслано от Новости]\n"


def test_legacy_forward_from():
    msg = {"forward_from": {"username": "bob"}, "forward_date": 123}
    assert forward_prefix(msg) == "[переслано от bob]\n"


def test_forwarded_no_name():
    msg = {"forward_date": 123}
    assert forward_prefix(msg) == "[переслано]\n"
