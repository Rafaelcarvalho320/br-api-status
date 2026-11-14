"""The state file: everything the status page shows, kept bounded.

One JSON document, rewritten on every run:

* ``services.<id>.samples``: raw checks for the last 48 hours (latency chart,
  current status);
* ``services.<id>.daily``: per-day counters for the last 90 days (uptime bars);
* ``services.<id>.incidents``: the last 20 outages, open one included;
* ``consistency``: the latest result of each comparison plus a 90-day daily
  tally of clean versus divergent runs.

Raw samples are not kept for 90 days on purpose: at one check every 15 minutes
that is ~8,600 rows per service, and the page only needs per-day totals for that
range. Aggregating on write keeps the file small enough to load on a phone.

Days are counted in Brasilia time (UTC-3, no daylight saving since 2019),
because "yesterday" on a page about Brazilian services should mean the
Brazilian yesterday.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from brstatus.probe import DOWN, Sample
from brstatus.services import Service

SCHEMA_VERSION = 1
SAMPLE_WINDOW = timedelta(hours=48)
DAILY_WINDOW_DAYS = 90
MAX_INCIDENTS = 20
BRASILIA = timezone(timedelta(hours=-3), "BRT")


def empty_state() -> dict[str, Any]:
    return {
        "version": SCHEMA_VERSION,
        "generated_at": None,
        "services": {},
        "consistency": {},
    }


def load(path: Path) -> dict[str, Any]:
    """Read the state, or start fresh when there is none yet.

    A file from an unknown schema version is refused rather than guessed at:
    silently starting fresh would throw away 90 days of history.
    """
    if not path.exists():
        return empty_state()
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported state version: {state.get('version')!r}")
    return state


def save(state: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    tmp.replace(path)


def day_of(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, BRASILIA).date().isoformat()


def record_samples(
    state: dict[str, Any],
    services: Iterable[Service],
    samples: Iterable[Sample],
    now: datetime,
) -> None:
    """Fold one run's samples into the state, then trim every window."""
    by_id = {s.service_id: s for s in samples}
    now_ts = int(now.timestamp())

    for service in services:
        entry = state["services"].setdefault(
            service.id, {"samples": [], "daily": {}, "incidents": []}
        )
        # Metadata is rewritten every run so a renamed service shows its new
        # name without a migration.
        entry.update(
            name=service.name,
            provider=service.provider,
            url=service.url,
            docs=service.docs,
            slow_ms=service.slow_ms,
        )
        sample = by_id.get(service.id)
        if sample is not None:
            entry["samples"].append(sample.as_row())
            _count_daily(entry["daily"], sample)
            _track_incident(entry["incidents"], sample)

        cutoff = now_ts - int(SAMPLE_WINDOW.total_seconds())
        entry["samples"] = [row for row in entry["samples"] if row[0] >= cutoff]
        entry["daily"] = _trim_days(entry["daily"], now)
        entry["incidents"] = entry["incidents"][-MAX_INCIDENTS:]

    known = {s.id for s in services}
    for stale in set(state["services"]) - known:
        del state["services"][stale]
    state["generated_at"] = now_ts


def _count_daily(daily: dict[str, dict[str, int]], sample: Sample) -> None:
    day = daily.setdefault(
        day_of(sample.at), {"n": 0, "up": 0, "degraded": 0, "down": 0, "ms": 0}
    )
    day["n"] += 1
    day[sample.status] += 1
    if sample.latency_ms is not None:
        day["ms"] += sample.latency_ms


def _track_incident(incidents: list[dict[str, Any]], sample: Sample) -> None:
    """Open an incident on the first ``down`` check, close it on the next good one.

    Only ``down`` opens an incident. A slow answer is visible in the bars and in
    the latency chart; calling every slow check an incident would bury the real
    outages.
    """
    current = incidents[-1] if incidents and incidents[-1]["end"] is None else None
    if sample.status == DOWN:
        if current is None:
            incidents.append(
                {
                    "start": sample.at,
                    "end": None,
                    "checks": 1,
                    "reasons": [sample.reason],
                }
            )
        else:
            current["checks"] += 1
            if sample.reason not in current["reasons"]:
                current["reasons"].append(sample.reason)
    elif current is not None:
        current["end"] = sample.at


def _trim_days(daily: dict[str, Any], now: datetime) -> dict[str, Any]:
    first = (
        now.astimezone(BRASILIA).date() - timedelta(days=DAILY_WINDOW_DAYS - 1)
    ).isoformat()
    return {day: counts for day, counts in sorted(daily.items()) if day >= first}


def record_consistency(
    state: dict[str, Any], results: Iterable[dict[str, Any]], now: datetime
) -> None:
    """Store the latest result of each comparison and tally it per day.

    Inconclusive runs are counted apart: a comparison that could not run says
    nothing about whether the sources agree.
    """
    results = list(results)
    store = state["consistency"]
    for result in results:
        previous = store.get(result["id"], {})
        daily = previous.get("daily", {})
        day = daily.setdefault(
            day_of(result["checked_at"]),
            {"consistent": 0, "divergent": 0, "inconclusive": 0},
        )
        day[result["status"]] += 1
        store[result["id"]] = {**result, "daily": _trim_days(daily, now)}

    # Rebuild in catalog order, dropping comparisons that no longer exist.
    state["consistency"] = {r["id"]: store[r["id"]] for r in results}
