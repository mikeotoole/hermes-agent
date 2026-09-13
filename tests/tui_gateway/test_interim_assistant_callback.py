"""Tests for the interim_assistant_callback config gating in tui_gateway.

These tests exercise the real _agent_cbs() wiring rather than a local
imitation, so a break in the production callback registration is caught.
"""

from __future__ import annotations

import threading
from unittest.mock import patch


def test_inflight_turn_start_assigns_stable_turn_id():
    from tui_gateway.server import _inflight_snapshot, _start_inflight_turn

    session = {"history_lock": threading.RLock()}

    _start_inflight_turn(session, "prompt")
    first = session["inflight_turn"]["turn_id"]

    assert isinstance(first, str)
    assert first
    assert session["inflight_turn"]["turn_id"] == first
    assert _inflight_snapshot(session)["turn_id"] == first


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
    """Cold hydration can reconstruct interim segments from the live snapshot."""
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
        with patch("tui_gateway.server._load_cfg", return_value={}), patch(
            "tui_gateway.server._emit",
            side_effect=lambda event, session, payload=None: emitted.append(
                (event, session, payload)
            ),
        ):
            callback = server._agent_cbs(sid)["interim_assistant_callback"]
            inflight_turn["assistant"] = "streamed prefix"
            callback("not streamed", already_streamed=False)
            inflight_turn["assistant"] += "already streamed"
            callback("already streamed", already_streamed=True)

        payloads = [event[2] for event in emitted]
        assert [payload["already_streamed"] for payload in payloads] == [False, True]
        assert [payload["text"] for payload in payloads] == [
            "not streamed",
            "already streamed",
        ]
        assert all(
            isinstance(payload["segment_id"], str) and payload["segment_id"]
            for payload in payloads
        )
        assert payloads[0]["segment_id"] != payloads[1]["segment_id"]

        snapshot_interim = server._inflight_snapshot(server._sessions[sid])["interim"]
        assert [boundary["assistant_offset"] for boundary in snapshot_interim] == [
            len("streamed prefix"),
            len("streamed prefixalready streamed"),
        ]
        assert [boundary["segment_id"] for boundary in snapshot_interim] == [
            payload["segment_id"] for payload in payloads
        ]
        assert server._sessions[sid]["inflight_turn"] is inflight_turn
        assert server._sessions[sid]["running"] is True
    finally:
        server._sessions.pop(sid, None)


def test_agent_cbs_records_interim_offsets_in_utf16_code_units():
    from tui_gateway import server

    sid = "session-interim-utf16"
    server._sessions[sid] = {
        "history_lock": server.threading.RLock(),
        "inflight_turn": {
            "assistant": "😀draft",
            "streaming": True,
            "user": "prompt",
        },
    }

    try:
        with patch("tui_gateway.server._load_cfg", return_value={}), patch(
            "tui_gateway.server._emit"
        ):
            server._agent_cbs(sid)["interim_assistant_callback"](
                "commentary", already_streamed=False
            )

        snapshot = server._inflight_snapshot(server._sessions[sid])

        assert snapshot["interim"][0]["assistant_offset"] == 7
    finally:
        server._sessions.pop(sid, None)


def test_inflight_correction_offsets_use_the_same_utf16_units():
    from tui_gateway import server

    session = {
        "inflight_turn": {
            "assistant": "😀draft",
            "streaming": True,
            "user": "prompt",
        }
    }

    server._record_inflight_correction(session, "nudge")

    assert server._inflight_snapshot(session)["correction_offsets"] == [7]


def test_snapshot_preserves_arrival_order_across_interims_and_corrections():
    from tui_gateway import server

    sid = "session-interleaved-boundaries"
    session = {
        "history_lock": server.threading.RLock(),
        "inflight_turn": {
            "assistant": "draft",
            "streaming": True,
            "user": "prompt",
        },
    }
    server._sessions[sid] = session

    try:
        with patch("tui_gateway.server._load_cfg", return_value={}), patch(
            "tui_gateway.server._emit"
        ):
            callback = server._agent_cbs(sid)["interim_assistant_callback"]
            callback("first commentary", already_streamed=False)
            server._record_inflight_correction(session, "redirect")
            callback("second commentary", already_streamed=False)

        snapshot = server._inflight_snapshot(session)

        assert [item["arrival_sequence"] for item in snapshot["interim"]] == [0, 2]
        assert snapshot["correction_entries"] == [
            {
                "arrival_sequence": 1,
                "assistant_offset": 5,
                "text": "redirect",
            }
        ]
    finally:
        server._sessions.pop(sid, None)
