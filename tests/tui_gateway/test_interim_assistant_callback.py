"""Tests for the interim_assistant_callback config gating in tui_gateway.

These tests exercise the real _agent_cbs() wiring rather than a local
imitation, so a break in the production callback registration is caught.
"""

from __future__ import annotations

from unittest.mock import patch


def test_load_interim_assistant_messages_defaults_true():
    from tui_gateway.server import _load_interim_assistant_messages

    with patch("tui_gateway.server._load_cfg", return_value={}):
        assert _load_interim_assistant_messages() is True


def test_load_interim_assistant_messages_explicit_true():
    from tui_gateway.server import _load_interim_assistant_messages

    with patch("tui_gateway.server._load_cfg", return_value={"display": {"interim_assistant_messages": True}}):
        assert _load_interim_assistant_messages() is True


def test_load_interim_assistant_messages_explicit_false():
    from tui_gateway.server import _load_interim_assistant_messages

    with patch("tui_gateway.server._load_cfg", return_value={"display": {"interim_assistant_messages": False}}):
        assert _load_interim_assistant_messages() is False


def test_load_interim_assistant_messages_string_off():
    from tui_gateway.server import _load_interim_assistant_messages

    with patch("tui_gateway.server._load_cfg", return_value={"display": {"interim_assistant_messages": "off"}}):
        assert _load_interim_assistant_messages() is False


def test_agent_cbs_includes_interim_callback_when_enabled():
    """_agent_cbs() includes interim_assistant_callback when the config is on.

    Exercises the real _agent_cbs() wiring: the callback must be present in
    the returned dict and, when invoked, must emit a message.interim event
    with the text and already_streamed flag passed through.
    """
    from tui_gateway.server import _agent_cbs

    emitted: list[tuple] = []

    def fake_emit(event_type, sid, payload=None):
        emitted.append((event_type, sid, payload))

    with patch("tui_gateway.server._load_cfg", return_value={}), \
         patch("tui_gateway.server._emit", side_effect=fake_emit):
        cbs = _agent_cbs("test-session")

        assert "interim_assistant_callback" in cbs
        cb = cbs["interim_assistant_callback"]
        assert callable(cb)

        # Invoke the real callback inside the patch context — the lambda
        # resolves _emit by name at call time, so it must be called while
        # the patch is active.
        cb("hello world", already_streamed=True)

    assert len(emitted) == 1
    assert emitted[0][0] == "message.interim"
    assert emitted[0][1] == "test-session"
    assert emitted[0][2]["text"] == "hello world"
    assert emitted[0][2]["already_streamed"] is True


def test_agent_cbs_omits_interim_callback_when_disabled():
    """_agent_cbs() omits interim_assistant_callback when the config is off.

    Exercises the real _agent_cbs() wiring: the callback must NOT be present
    in the returned dict when display.interim_assistant_messages is false.
    """
    from tui_gateway.server import _agent_cbs

    with patch("tui_gateway.server._load_cfg", return_value={"display": {"interim_assistant_messages": False}}):
        cbs = _agent_cbs("test-session")

    assert "interim_assistant_callback" not in cbs


def test_agent_cbs_interim_callback_passes_already_streamed_false():
    """The real callback passes already_streamed=False by default."""
    from tui_gateway.server import _agent_cbs

    emitted: list[tuple] = []

    def fake_emit(event_type, sid, payload=None):
        emitted.append((event_type, sid, payload))

    with patch("tui_gateway.server._load_cfg", return_value={}), \
         patch("tui_gateway.server._emit", side_effect=fake_emit):
        cbs = _agent_cbs("test-session")

        cb = cbs["interim_assistant_callback"]
        cb("interim text")

    assert emitted[0][2]["already_streamed"] is False
    assert emitted[0][2]["text"] == "interim text"


def test_agent_cbs_snapshots_interim_boundaries_for_reconnect():
    from tui_gateway import server

    sid = "reconnect-session"
    inflight_turn = {"assistant": "", "streaming": True, "user": "prompt"}
    server._sessions[sid] = {
        "history_lock": server.threading.RLock(),
        "inflight_turn": inflight_turn,
        "running": True,
    }
    emitted: list[tuple] = []

    try:
        with patch("tui_gateway.server._load_cfg", return_value={}), \
             patch("tui_gateway.server._emit", side_effect=lambda event, session, payload=None: emitted.append((event, session, payload))):
            callback = server._agent_cbs(sid)["interim_assistant_callback"]
            inflight_turn["assistant"] = "streamed prefix"
            callback("not streamed", already_streamed=False)
            inflight_turn["assistant"] += "already streamed"
            callback("already streamed", already_streamed=True)

        payloads = [event[2] for event in emitted]
        assert [payload["already_streamed"] for payload in payloads] == [False, True]
        assert [payload["assistant_prefix"] for payload in payloads] == [
            "streamed prefix",
            "streamed prefixalready streamed",
        ]
        assert [payload["text"] for payload in payloads] == ["not streamed", "already streamed"]
        assert all(isinstance(payload["segment_id"], str) and payload["segment_id"] for payload in payloads)
        assert payloads[0]["segment_id"] != payloads[1]["segment_id"]
        snapshot_interim = server._inflight_snapshot(server._sessions[sid])["interim"]
        assert [boundary["assistant_offset"] for boundary in snapshot_interim] == [
            len("streamed prefix"),
            len("streamed prefixalready streamed"),
        ]
        assert all("assistant_prefix" not in boundary for boundary in snapshot_interim)
        assert [boundary["segment_id"] for boundary in snapshot_interim] == [
            payload["segment_id"] for payload in payloads
        ]
        assert server._sessions[sid]["inflight_turn"] is inflight_turn
        assert server._sessions[sid]["running"] is True
    finally:
        server._sessions.pop(sid, None)


def test_gateway_ready_payload_advertises_interim_contracts():
    from tui_gateway import server

    assert server._utf16_code_units("A😀B") == 4

    with patch("tui_gateway.server.resolve_skin", return_value={"name": "test"}):
        assert server.gateway_ready_payload() == {
            "capabilities": ["message.interim.v1", "inflight.interim.v1"],
            "skin": {"name": "test"},
        }
