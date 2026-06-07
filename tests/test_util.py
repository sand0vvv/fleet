from util import agent_name_from_path


def test_windows_path():
    assert agent_name_from_path(r"C:\Users\vovav\Desktop\financier") == "financier"


def test_windows_trailing_slash():
    assert agent_name_from_path("C:\\Users\\vovav\\Desktop\\financier\\") == "financier"


def test_posix_path():
    assert agent_name_from_path("/home/u/projects/tac") == "tac"


def test_plain_name():
    assert agent_name_from_path("financier") == "financier"


def test_empty():
    assert agent_name_from_path("") == ""
