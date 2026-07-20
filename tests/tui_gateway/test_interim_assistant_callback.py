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
            callback("not streamed", already_streamed=False)
            callback("already streamed", already_streamed=True)

        payloads = [event[2] for event in emitted]
        assert [payload["already_streamed"] for payload in payloads] == [False, True]
        assert [payload["text"] for payload in payloads] == ["not streamed", "already streamed"]
        assert all(isinstance(payload["segment_id"], str) and payload["segment_id"] for payload in payloads)
        assert payloads[0]["segment_id"] != payloads[1]["segment_id"]
        assert server._inflight_snapshot(server._sessions[sid])["interim"] == payloads
        assert server._sessions[sid]["inflight_turn"] is inflight_turn
        assert server._sessions[sid]["running"] is True
    finally:
        server._sessions.pop(sid, None)


def test_gateway_ready_payload_advertises_interim_contracts():
    from tui_gateway import server

    with patch("tui_gateway.server.resolve_skin", return_value={"name": "test"}):
        assert server.gateway_ready_payload() == {
            "capabilities": ["message.interim.v1", "inflight.interim.v1"],
            "change_events": True,
            "skin": {"name": "test"},
        }


