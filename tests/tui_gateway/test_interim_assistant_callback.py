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
        with patch("tui_gateway.server._load_cfg", return_value={}), patch(
            "tui_gateway.server._emit",
            side_effect=lambda event, session, payload=None: emitted.append(
                (event, session, payload)
            ),
        ):
            callback = server._agent_cbs(sid)["interim_assistant_callback"]
            inflight_turn["assistant"] = "😀streamed prefix"
            callback("not streamed", already_streamed=False)
            inflight_turn["assistant"] += "already streamed"
            callback("already streamed", already_streamed=True)

        payloads = [event[2] for event in emitted]
        assert [payload["already_streamed"] for payload in payloads] == [False, True]
        assert [payload["assistant_prefix"] for payload in payloads] == [
            "😀streamed prefix",
            "😀streamed prefixalready streamed",
        ]
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
            server._utf16_code_units("😀streamed prefix"),
            server._utf16_code_units("😀streamed prefixalready streamed"),
        ]
        assert [boundary["arrival_sequence"] for boundary in snapshot_interim] == [1, 2]
        assert [boundary["segment_id"] for boundary in snapshot_interim] == [
            payload["segment_id"] for payload in payloads
        ]
        assert server._sessions[sid]["inflight_turn"] is inflight_turn
        assert server._sessions[sid]["running"] is True
    finally:
        server._sessions.pop(sid, None)


def test_gateway_ready_payload_advertises_interim_contracts():
    from tui_gateway import server

    with patch("tui_gateway.server.resolve_skin", return_value={"name": "test"}):
        payload = server.gateway_ready_payload()
        assert {"message.interim.v1", "inflight.interim.v1"}.issubset(payload["capabilities"])
        assert payload["change_events"] is True
        assert payload["skin"] == {"name": "test"}

    resolved_skin = {"name": "already-resolved"}
    with patch("tui_gateway.server.resolve_skin") as resolve_skin:
        payload = server.gateway_ready_payload(skin=resolved_skin)
        assert {"message.interim.v1", "inflight.interim.v1"}.issubset(payload["capabilities"])
        assert payload["change_events"] is True
        assert payload["skin"] is resolved_skin
    resolve_skin.assert_not_called()


def test_utf16_code_unit_offsets_match_javascript_slicing():
    from tui_gateway import server

    assert server._utf16_code_units("A😀B") == 4


def test_correction_and_interim_share_one_arrival_sequence():
    from tui_gateway import server

    sid = "mixed-boundary-session"
    session = {
        "history_lock": server.threading.RLock(),
        "inflight_turn": {"assistant": "before", "streaming": True, "user": "prompt"},
        "running": True,
    }
    server._sessions[sid] = session

    try:
        server._record_inflight_correction(session, "redirect")
        with patch("tui_gateway.server._emit"):
            server._on_interim_assistant(sid, "commentary", already_streamed=False)

        snapshot = server._inflight_snapshot(session)
        assert snapshot["correction_offsets"] == [len("before")]
        assert snapshot["correction_sequences"] == [1]
        assert snapshot["interim"][0]["assistant_offset"] == len("before")
        assert snapshot["interim"][0]["arrival_sequence"] == 2
    finally:
        server._sessions.pop(sid, None)


def test_inflight_snapshot_sanitizes_malformed_boundary_metadata():
    from tui_gateway import server

    snapshot = server._inflight_snapshot(
        {
            "inflight_turn": {
                "assistant": "partial",
                "streaming": True,
                "user": "prompt",
                "corrections": ["redirect"],
                "correction_offsets": [True],
                "correction_sequences": [-1],
                "interim": [
                    None,
                    "legacy",
                    {},
                    {"segment_id": "missing-text"},
                    {
                        "already_streamed": False,
                        "arrival_sequence": -1,
                        "assistant_offset": True,
                        "segment_id": "valid-sanitized",
                        "text": "commentary",
                    },
                ],
            }
        }
    )

    assert snapshot["corrections"] == ["redirect"]
    assert "correction_offsets" not in snapshot
    assert "correction_sequences" not in snapshot
    assert snapshot["interim"] == [
        {
            "already_streamed": False,
            "segment_id": "valid-sanitized",
            "text": "commentary",
        }
    ]


