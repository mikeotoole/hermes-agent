"""The interim boundary must be recorded on the REAL turn path, not just via `_agent_cbs`.

`_invoke_agent` assigns `agent.interim_assistant_callback` per turn, and that assignment
OVERWRITES the one `_agent_cbs` installs at session level. A previous revision of this port
left the per-turn assignment as a bare ``_emit("message.interim", ...)``, which still emitted
the event but recorded no boundary on the inflight turn. Every existing test drove the
callback through `_agent_cbs`, so the suite stayed green while the shipped path was dead and
commentary reappeared at the top of the reply after a mid-turn reconnect.

These tests invoke the real `_invoke_agent` wiring and assert on observable turn state, never
on source text (source-reading tests are banned by AGENTS.md and would pass against a
subtly-miswired implementation).
"""

import threading
from typing import Any

import pytest

# tui_gateway split modules are rebound onto server.py's globals via method_ctx.bind_module,
# so the PRODUCTION callable lives on `server`. Importing the split module directly bypasses
# that rebinding and raises NameError — always drive these paths through `server`.
from tui_gateway import server
from tui_gateway.server import _append_inflight_delta, _sessions, _start_inflight_turn


class _Agent:
    """Minimal stand-in exposing only what `_invoke_agent` wires."""

    def __init__(self) -> None:
        self.interim_assistant_callback = None
        self.session_id = "agent-sid"

    def run(self, **_kwargs: Any) -> str:  # pragma: no cover - never reached
        return ""


class _TurnRun:
    def __init__(self, agent: _Agent) -> None:
        self.agent = agent
        self.tts_queue = None
        self.history: list = []
        self.run_kwargs: dict = {}
        self.result = None


@pytest.fixture
def live_session(monkeypatch):
    """A registered session with a live inflight turn, as a real turn would have."""
    sid = "real-turn-path-session"
    session: dict = {"history_lock": threading.RLock()}
    _start_inflight_turn(session, "original prompt")
    _sessions[sid] = session
    monkeypatch.setattr(server, "_load_interim_assistant_messages", lambda: True, raising=False)
    try:
        yield sid, session
    finally:
        _sessions.pop(sid, None)


def _install_callback(sid: str, session: dict) -> _Agent:
    """Run the real `_invoke_agent` far enough to install the per-turn callback.

    `_invoke_agent` wires callbacks and then runs the conversation; we let the run itself
    blow up and assert on the wiring it performed first. This exercises the production
    assignment rather than a reimplementation of it.
    """
    agent = _Agent()
    st = _TurnRun(agent)
    with pytest.raises(Exception):
        server._invoke_agent(
            sid, session, st, "prompt", "prompt", None, [], None, None,
        )
    return agent


class TestPerTurnCallbackRecordsBoundary:
    def test_invoke_agent_installs_a_callback(self, live_session):
        sid, session = live_session
        agent = _install_callback(sid, session)

        assert callable(agent.interim_assistant_callback)

    def test_installed_callback_records_boundary_on_the_inflight_turn(self, live_session):
        """The regression: a bare _emit leaves `interim` empty and this fails."""
        sid, session = live_session
        _append_inflight_delta(session, "ab🙂")
        agent = _install_callback(sid, session)

        agent.interim_assistant_callback("first commentary", already_streamed=False)

        interim = session["inflight_turn"].get("interim") or []
        assert len(interim) == 1, "per-turn callback did not record a boundary"
        boundary = interim[0]
        # "ab🙂" is 3 code points but 4 UTF-16 code units — the renderer slices by the latter.
        assert boundary["assistant_offset"] == 4
        assert boundary["arrival_sequence"] == 0
        assert boundary["text"] == "first commentary"
        assert boundary["segment_id"]

    def test_successive_commentary_keeps_arrival_order(self, live_session):
        sid, session = live_session
        agent = _install_callback(sid, session)

        agent.interim_assistant_callback("first", already_streamed=False)
        _append_inflight_delta(session, "output")
        agent.interim_assistant_callback("second", already_streamed=False)

        interim = session["inflight_turn"].get("interim") or []
        assert [b["arrival_sequence"] for b in interim] == [0, 1]
        assert [b["assistant_offset"] for b in interim] == [0, 6]

    def test_boundary_survives_into_the_resume_snapshot(self, live_session):
        """A reconnecting client reads the snapshot, so the boundary must reach it."""
        from tui_gateway.server import _inflight_snapshot

        sid, session = live_session
        _append_inflight_delta(session, "partial")
        agent = _install_callback(sid, session)
        agent.interim_assistant_callback("commentary", already_streamed=False)

        snapshot = _inflight_snapshot(session)

        assert snapshot is not None
        assert len(snapshot.get("interim") or []) == 1
        assert snapshot["interim"][0]["assistant_offset"] == 7

    def test_disabled_config_installs_no_callback(self, live_session, monkeypatch):
        sid, session = live_session
        monkeypatch.setattr(server, "_load_interim_assistant_messages", lambda: False, raising=False)

        agent = _install_callback(sid, session)

        assert agent.interim_assistant_callback is None
