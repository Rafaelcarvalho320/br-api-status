from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from brstatus import state
from brstatus.probe import DEGRADED, DOWN, UP, Sample
from brstatus.services import Service

SERVICE = Service(
    id="svc",
    name="Svc",
    provider="P",
    url="https://x",
    validate=lambda p: None,
    docs="",
)
T0 = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)


def sample(at: datetime, status: str, reason: str | None = None, ms: int | None = 100):
    return Sample(
        "svc", int(at.timestamp()), status, ms if status != DOWN else None, 1, reason
    )


def feed(st, *pairs):
    for at, smp in pairs:
        state.record_samples(st, [SERVICE], [smp], at)
    return st["services"]["svc"]


def test_daily_counters_and_latency_sum():
    st = state.empty_state()
    entry = feed(
        st,
        (T0, sample(T0, UP, ms=100)),
        (
            T0 + timedelta(minutes=15),
            sample(T0 + timedelta(minutes=15), DEGRADED, "slow", 4000),
        ),
        (
            T0 + timedelta(minutes=30),
            sample(T0 + timedelta(minutes=30), DOWN, "timeout"),
        ),
    )
    assert entry["daily"] == {
        "2026-11-14": {"n": 3, "up": 1, "degraded": 1, "down": 1, "ms": 4100}
    }


def test_days_are_counted_in_brasilia_time():
    # 01:00 UTC on the 15th is still 22:00 on the 14th in Brasilia.
    late = datetime(2026, 11, 15, 1, 0, tzinfo=timezone.utc)
    entry = feed(state.empty_state(), (late, sample(late, UP)))
    assert list(entry["daily"]) == ["2026-11-14"]


def test_incident_opens_on_first_down_and_closes_on_recovery():
    times = [T0 + timedelta(minutes=15 * i) for i in range(5)]
    entry = feed(
        state.empty_state(),
        (times[0], sample(times[0], UP)),
        (times[1], sample(times[1], DOWN, "http:503")),
        (times[2], sample(times[2], DOWN, "timeout")),
        (times[3], sample(times[3], DOWN, "http:503")),
        (times[4], sample(times[4], DEGRADED, "slow")),
    )
    assert entry["incidents"] == [
        {
            "start": int(times[1].timestamp()),
            "end": int(times[4].timestamp()),
            "checks": 3,
            "reasons": ["http:503", "timeout"],
        }
    ]


def test_slow_checks_do_not_open_incidents():
    entry = feed(state.empty_state(), (T0, sample(T0, DEGRADED, "slow")))
    assert entry["incidents"] == []


def test_open_incident_stays_open_across_runs():
    t1 = T0 + timedelta(minutes=15)
    entry = feed(
        state.empty_state(),
        (T0, sample(T0, DOWN, "network")),
        (t1, sample(t1, DOWN, "network")),
    )
    assert len(entry["incidents"]) == 1
    assert entry["incidents"][0]["end"] is None
    assert entry["incidents"][0]["checks"] == 2


def test_windows_are_trimmed():
    st = state.empty_state()
    old = T0 - timedelta(days=120)
    recent = T0 - timedelta(hours=49)
    feed(st, (old, sample(old, UP)), (recent, sample(recent, UP)))
    entry = feed(st, (T0, sample(T0, UP)))
    assert [row[0] for row in entry["samples"]] == [int(T0.timestamp())]
    assert list(entry["daily"]) == [state.day_of(int(recent.timestamp())), "2026-11-14"]


def test_removed_services_disappear_from_state():
    st = state.empty_state()
    st["services"]["retired"] = {"samples": [], "daily": {}, "incidents": []}
    state.record_samples(st, [SERVICE], [], T0)
    assert set(st["services"]) == {"svc"}


def test_service_without_a_sample_this_run_keeps_its_history():
    st = state.empty_state()
    feed(st, (T0, sample(T0, UP)))
    state.record_samples(st, [SERVICE], [], T0 + timedelta(minutes=15))
    assert len(st["services"]["svc"]["samples"]) == 1


def test_consistency_tally_counts_inconclusive_apart():
    st = state.empty_state()
    base = {"id": "cep", "checked_at": int(T0.timestamp()), "details": []}
    for status in ("consistent", "divergent", "inconclusive", "consistent"):
        state.record_consistency(st, [{**base, "status": status}], T0)
    assert st["consistency"]["cep"]["daily"] == {
        "2026-11-14": {"consistent": 2, "divergent": 1, "inconclusive": 1}
    }
    assert st["consistency"]["cep"]["status"] == "consistent"


def test_round_trip_and_version_guard(tmp_path):
    path = tmp_path / "data" / "status.json"
    st = state.empty_state()
    feed(st, (T0, sample(T0, UP)))
    state.save(st, path)
    assert state.load(path) == json.loads(json.dumps(st))

    path.write_text(json.dumps({"version": 99}), encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported state version"):
        state.load(path)


def test_missing_file_starts_fresh(tmp_path):
    assert state.load(tmp_path / "nope.json") == state.empty_state()
