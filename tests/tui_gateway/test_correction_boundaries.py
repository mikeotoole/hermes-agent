"""Correction-boundary contracts carried downstream onto the v0.21.2 tag.

Upstream v0.21.2 records ``correction_offsets`` with Python ``len()`` and keeps no
arrival order. Renderer clients slice by UTF-16 code units, so an emoji ahead of a
mid-turn redirect shifts every later boundary and paints the correction bubble in
the wrong place. These tests pin the downstream behaviour:

* offsets are UTF-16 code units (astral characters count as 2);
* each correction carries the arrival sequence observed when it was accepted;
* the resume snapshot forwards those entries only when they pair 1:1 with the
  corrections list.
"""

from tui_gateway.server import (
    _append_inflight_delta,
    _inflight_snapshot,
    _record_inflight_correction,
    _start_inflight_turn,
    _utf16_code_units,
)


def _session() -> dict:
    session: dict = {}
    _start_inflight_turn(session, "original prompt")
    return session


class TestUtf16CodeUnits:
    def test_bmp_text_matches_python_len(self):
        assert _utf16_code_units("hello") == 5

    def test_astral_characters_count_as_surrogate_pairs(self):
        # "🙂" is one code point but two UTF-16 code units — the exact case where
        # Python len() and a JavaScript string slice disagree.
        assert len("🙂") == 1
        assert _utf16_code_units("🙂") == 2

    def test_mixed_text_counts_each_astral_char_twice(self):
        assert _utf16_code_units("ab🙂cd") == 6

    def test_empty_string_is_zero(self):
        assert _utf16_code_units("") == 0


class TestCorrectionOffsets:
    def test_offset_uses_utf16_units_after_astral_delta(self):
        session = _session()
        _append_inflight_delta(session, "🙂🙂")
        _record_inflight_correction(session, "actually do this instead")

        # Python len() would say 2; the renderer slices at 4.
        assert session["inflight_turn"]["correction_offsets"] == [4]

    def test_offset_is_plain_length_for_bmp_text(self):
        session = _session()
        _append_inflight_delta(session, "abcd")
        _record_inflight_correction(session, "redirect")

        assert session["inflight_turn"]["correction_offsets"] == [4]

    def test_original_prompt_is_preserved_beside_the_correction(self):
        session = _session()
        _append_inflight_delta(session, "partial answer")
        _record_inflight_correction(session, "redirect")

        turn = session["inflight_turn"]
        assert turn["user"] == "original prompt"
        assert turn["corrections"] == ["redirect"]

    def test_blank_correction_is_ignored(self):
        session = _session()
        _append_inflight_delta(session, "abc")
        _record_inflight_correction(session, "   ")

        assert "correction_offsets" not in session["inflight_turn"]


class TestArrivalSequence:
    def test_sequences_increment_per_correction(self):
        session = _session()
        _append_inflight_delta(session, "aa")
        _record_inflight_correction(session, "first")
        _append_inflight_delta(session, "bb")
        _record_inflight_correction(session, "second")

        entries = session["inflight_turn"]["correction_entries"]
        assert [entry["arrival_sequence"] for entry in entries] == [0, 1]
        assert [entry["assistant_offset"] for entry in entries] == [2, 4]

    def test_equal_offsets_keep_distinct_arrival_order(self):
        # Two redirects landing between the same two deltas share an offset; only
        # the arrival sequence can order them.
        session = _session()
        _append_inflight_delta(session, "abc")
        _record_inflight_correction(session, "first")
        _record_inflight_correction(session, "second")

        entries = session["inflight_turn"]["correction_entries"]
        assert [entry["assistant_offset"] for entry in entries] == [3, 3]
        assert [entry["arrival_sequence"] for entry in entries] == [0, 1]


class TestInflightSnapshot:
    def test_snapshot_forwards_entries_and_utf16_offsets(self):
        session = _session()
        _append_inflight_delta(session, "🙂")
        _record_inflight_correction(session, "redirect")

        snapshot = _inflight_snapshot(session)

        assert snapshot is not None
        assert snapshot["user"] == "original prompt"
        assert snapshot["corrections"] == ["redirect"]
        assert snapshot["correction_offsets"] == [2]
        assert snapshot["correction_entries"] == [
            {"arrival_sequence": 0, "assistant_offset": 2, "text": "redirect"}
        ]

    def test_snapshot_omits_entries_when_they_do_not_pair(self):
        session = _session()
        _append_inflight_delta(session, "abc")
        _record_inflight_correction(session, "redirect")
        # A legacy/foreign producer wrote corrections without matching entries.
        session["inflight_turn"]["correction_entries"] = []

        snapshot = _inflight_snapshot(session)

        assert snapshot is not None
        assert snapshot["corrections"] == ["redirect"]
        assert "correction_entries" not in snapshot

    def test_snapshot_without_corrections_has_no_correction_keys(self):
        session = _session()
        _append_inflight_delta(session, "abc")

        snapshot = _inflight_snapshot(session)

        assert snapshot is not None
        assert "corrections" not in snapshot
        assert "correction_entries" not in snapshot
