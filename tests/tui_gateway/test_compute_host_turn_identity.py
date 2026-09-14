"""The compute-host (process-isolation) path must carry the parent's inflight turn id.

Third instance of the port's recurring bug class: upstream relocated
`_compute_host_turn_frame` out of `server.py` into `compute_host_bridge.py` and reformatted
it, so the carried `turn_id` read was silently dropped, and `compute_host.py` lost the
`turn_id=` argument it used to pass to `_start_inflight_turn`. The kwarg still existed, so a
name-grep looked green — but no caller passed it, and the child re-minted a *different* id.

Consequence: under process isolation the id on `message.start` and in the resume snapshot did
not identify the turn the host was actually running, defeating the client-rebinding guarantee
the carried patch exists to provide. In-process tests passed throughout.

Note the two distinct identities that must not be conflated:
  * ``inflight_turn_id`` — the turn identity shared with clients (what this module guards).
  * ``turn_id`` / ``request_id`` — upstream's opaque per-dispatch lifetime token, minted in
    ``_submit_prompt_to_compute_host`` and used only to match a completion to its dispatch.
"""

import threading

from tui_gateway import server


def _parent_session() -> dict:
    return {"history_lock": threading.RLock(), "history": [], "history_version": 0}


class TestFrameCarriesInflightTurnId:
    def test_frame_includes_the_live_inflight_turn_id(self):
        session = _parent_session()
        server._start_inflight_turn(session, "original prompt")
        expected = session["inflight_turn"]["turn_id"]

        frame = server._compute_host_turn_frame("rid-1", "sid-1", session, "original prompt")

        assert frame.get("inflight_turn_id") == expected
        assert expected, "inflight turn must have an id to carry"

    def test_frame_tolerates_a_session_with_no_inflight_turn(self):
        session = _parent_session()

        frame = server._compute_host_turn_frame("rid-1", "sid-1", session, "prompt")

        # Absent turn: empty string, never a crash and never a fabricated id.
        assert frame.get("inflight_turn_id") == ""

    def test_dispatch_token_is_a_separate_identity(self):
        """`inflight_turn_id` must not be the per-dispatch token, nor be clobbered by it."""
        session = _parent_session()
        server._start_inflight_turn(session, "prompt")
        expected = session["inflight_turn"]["turn_id"]

        frame = server._compute_host_turn_frame("rid-1", "sid-1", session, "prompt")

        # The frame leaves `turn_id`/`request_id` for the dispatch layer to own.
        assert frame["inflight_turn_id"] == expected
        assert frame.get("turn_id") != expected or frame.get("turn_id") is None


class TestHostAdoptsParentTurnId:
    def test_host_start_adopts_the_frame_id(self):
        """The regression: without the carried kwarg the child mints a different id."""
        parent = _parent_session()
        server._start_inflight_turn(parent, "prompt")
        expected = parent["inflight_turn"]["turn_id"]
        frame = server._compute_host_turn_frame("rid-1", "sid-1", parent, "prompt")

        child = {"history_lock": threading.RLock()}
        server._start_inflight_turn(child, frame["text"], turn_id=frame.get("inflight_turn_id"))

        assert child["inflight_turn"]["turn_id"] == expected

    def test_absent_id_still_mints_a_usable_turn_id(self):
        child = {"history_lock": threading.RLock()}

        server._start_inflight_turn(child, "prompt", turn_id="")

        assert child["inflight_turn"]["turn_id"], "must fall back to a minted id"

    def test_adopted_id_reaches_the_resume_snapshot(self):
        """A reconnecting client reads the snapshot, so the adopted id must surface there."""
        parent = _parent_session()
        server._start_inflight_turn(parent, "prompt")
        expected = parent["inflight_turn"]["turn_id"]
        frame = server._compute_host_turn_frame("rid-1", "sid-1", parent, "prompt")

        child = {"history_lock": threading.RLock()}
        server._start_inflight_turn(child, frame["text"], turn_id=frame.get("inflight_turn_id"))

        snapshot = server._inflight_snapshot(child)

        assert snapshot is not None
        assert snapshot.get("turn_id") == expected


class TestRealHostHandlerAdoptsTheId:
    """Drive `ComputeHost._run_real_turn` itself — the production consumer.

    The frame-level tests above pass even if the host handler forgets to pass
    ``turn_id=``; only driving the real handler proves the wiring end to end.
    """

    def test_run_real_turn_starts_the_turn_with_the_frames_id(self, monkeypatch):
        from tui_gateway.compute_host import ComputeHost

        parent = _parent_session()
        server._start_inflight_turn(parent, "prompt")
        expected = parent["inflight_turn"]["turn_id"]
        frame = server._compute_host_turn_frame("rid-1", "sid-host", parent, "prompt")

        child = {"history_lock": threading.RLock()}
        captured: dict = {}

        def fake_start(session, text, *, turn_id=None):
            captured["turn_id"] = turn_id
            raise RuntimeError("stop after the wiring under test")

        monkeypatch.setattr(server, "_start_inflight_turn", fake_start)

        host = ComputeHost.__new__(ComputeHost)
        monkeypatch.setattr(host, "_ensure_server_session", lambda _server, _frame: child, raising=False)
        monkeypatch.setattr(host, "_reply", lambda *a, **k: None, raising=False)
        monkeypatch.setattr(host, "emit", lambda *a, **k: None, raising=False)

        host._run_real_turn(frame)

        assert "turn_id" in captured, "_run_real_turn never called _start_inflight_turn"
        assert captured["turn_id"] == expected, (
            "host did not adopt the frame's inflight_turn_id — a resuming client "
            "would bind to a turn id the host is not running"
        )
