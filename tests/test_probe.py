from __future__ import annotations

from datetime import datetime, timezone

import pytest
from resilient_client import RequestTimeout, TransportError

from brstatus.probe import DEGRADED, DOWN, UP, probe
from brstatus.services import SERVICES, Service
from conftest import Reply, ScriptedTransport

URL = "https://api.example/cep"
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
SERVICE = Service(
    id="example",
    name="CEP",
    provider="Example",
    url=URL,
    validate=lambda p: None if p.get("uf") == "PA" else "wrong uf",
    docs="https://example",
    slow_ms=1000,
)


def run(clock, *replies: Reply, service: Service = SERVICE):
    transport = ScriptedTransport(clock, {service.url.format(year=2026): replies})
    return probe(service, transport=transport, clock=clock, now=lambda: NOW), transport


def test_fast_valid_answer_is_up(clock):
    sample, _ = run(clock, Reply({"uf": "PA"}, takes=0.25))
    assert (sample.status, sample.latency_ms, sample.attempts, sample.reason) == (
        UP,
        250,
        1,
        None,
    )
    assert sample.at == int(NOW.timestamp())


def test_slow_valid_answer_is_degraded(clock):
    sample, _ = run(clock, Reply({"uf": "PA"}, takes=1.5))
    assert (sample.status, sample.reason, sample.latency_ms) == (DEGRADED, "slow", 1500)


def test_answer_after_retry_is_degraded_and_counts_attempts(clock):
    sample, transport = run(clock, Reply(status=503), Reply({"uf": "PA"}))
    assert (sample.status, sample.reason, sample.attempts) == (DEGRADED, "retried", 2)
    assert len(transport.calls) == 2
    assert clock.slept, "the retry must back off, not hammer the service"


def test_persistent_server_error_is_down_after_every_attempt(clock):
    sample, transport = run(clock, Reply(status=503))
    assert (sample.status, sample.reason, sample.attempts) == (DOWN, "http:503", 3)
    assert sample.latency_ms is None
    assert len(transport.calls) == 3


def test_client_error_is_down_without_retrying(clock):
    sample, transport = run(clock, Reply(status=404))
    assert (sample.status, sample.reason, sample.attempts) == (DOWN, "http:404", 1)
    assert len(transport.calls) == 1


@pytest.mark.parametrize(
    ("error", "reason"),
    [(RequestTimeout("slow"), "timeout"), (TransportError("refused"), "network")],
)
def test_transport_failures_are_down_with_their_reason(clock, error, reason):
    sample, _ = run(clock, Reply(error=error))
    assert (sample.status, sample.reason, sample.attempts) == (DOWN, reason, 3)


def test_non_json_body_is_down(clock):
    sample, _ = run(clock, Reply(raw=b"<html>maintenance</html>"))
    assert (sample.status, sample.reason) == (DOWN, "json")


def test_valid_json_that_fails_validation_is_down(clock):
    sample, _ = run(clock, Reply({"erro": True}))
    assert (sample.status, sample.reason) == (DOWN, "payload:wrong uf")


def test_year_placeholder_is_filled_from_the_check_time(clock):
    holidays = next(s for s in SERVICES if s.id == "brasilapi-holidays")
    assert holidays.resolved_url(NOW).endswith("/feriados/v1/2026")


@pytest.mark.parametrize(
    ("service_id", "payload", "ok"),
    [
        ("viacep", {"uf": "PA"}, True),
        ("viacep", {"erro": "true"}, False),
        ("bcb-selic", [{"data": "09/12/2026", "valor": "13.75"}], True),
        ("bcb-selic", [{"data": "09/12/2026", "valor": "n/d"}], False),
        ("bcb-selic", [], False),
        ("awesomeapi-usd", {"USDBRL": {"bid": "5.65"}}, True),
        ("awesomeapi-usd", {"USDBRL": {"bid": ""}}, False),
        ("ibge-localidades", [{"sigla": "PA"}] * 27, True),
        ("ibge-localidades", [{"sigla": "PA"}] * 26, False),
        ("brasilapi-banks", {"code": 1}, True),
        ("brasilapi-banks", {"code": "1"}, False),
    ],
)
def test_catalog_validators(service_id, payload, ok):
    service = next(s for s in SERVICES if s.id == service_id)
    assert (service.validate(payload) is None) is ok


def test_service_ids_are_unique():
    ids = [s.id for s in SERVICES]
    assert len(ids) == len(set(ids))
