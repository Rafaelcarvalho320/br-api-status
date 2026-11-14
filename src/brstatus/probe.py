"""One check of one service, reduced to a :class:`Sample`.

Classification, from the point of view of someone integrating with the API:

``down``
    No usable answer: network failure, timeout, an error status, a body that is
    not JSON, or JSON that fails the service's validator.
``degraded``
    A usable answer, but only after a retry, or slower than the service's
    ``slow_ms`` threshold.
``up``
    A usable answer on the first attempt, in time.

Latency is the wall time until the usable answer arrived, retries included.
That is the number an integration actually waits for.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from resilient_client import (
    Hooks,
    RequestTimeout,
    ResilientClient,
    RetryEvent,
    RetryExhausted,
    RetryPolicy,
    Transport,
    TransportError,
)
from resilient_client.clock import Clock, SystemClock

from brstatus.services import Service

UP = "up"
DEGRADED = "degraded"
DOWN = "down"

USER_AGENT = "br-api-status (+https://github.com/Rafaelcarvalho320/br-api-status)"
TIMEOUT_SECONDS = 10.0
RETRY = RetryPolicy(max_attempts=3, backoff_base=1.0, backoff_factor=2.0, jitter=0.3)


@dataclass(frozen=True)
class Sample:
    """The outcome of one check.

    ``reason`` is a short machine-readable code (``http:503``, ``timeout``,
    ``network``, ``json``, ``payload:<detail>``, ``slow``, ``retried``) that the
    status page translates for people. ``None`` when the service is up.
    """

    service_id: str
    at: int
    status: str
    latency_ms: int | None
    attempts: int
    reason: str | None

    def as_row(self) -> list[object]:
        """Compact stored form: ``[at, status, ms, attempts, reason]``."""
        return [self.at, self.status, self.latency_ms, self.attempts, self.reason]


def probe(
    service: Service,
    *,
    transport: Transport | None = None,
    clock: Clock | None = None,
    retry: RetryPolicy = RETRY,
    now: Callable[[], datetime] | None = None,
) -> Sample:
    """Check ``service`` once and classify the result."""
    clock = clock or SystemClock()
    retries: list[RetryEvent] = []
    client = ResilientClient(
        transport=transport,
        timeout=TIMEOUT_SECONDS,
        retry=retry,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        raise_for_status=False,
        clock=clock,
        hooks=Hooks(on_retry=retries.append),
    )

    started_at = now() if now else datetime.now(timezone.utc)
    started = clock.now()

    def sample(status: str, reason: str | None, latency: bool = True) -> Sample:
        elapsed = round((clock.now() - started) * 1000) if latency else None
        return Sample(
            service_id=service.id,
            at=int(started_at.timestamp()),
            status=status,
            latency_ms=elapsed,
            attempts=len(retries) + 1,
            reason=reason,
        )

    try:
        with client:
            response = client.get(service.resolved_url(started_at))
    except RetryExhausted as exc:
        return sample(DOWN, _transport_reason(exc.last_error), latency=False)
    except TransportError as exc:
        return sample(DOWN, _transport_reason(exc), latency=False)

    # Only 2xx carries a usable body: an unconditional request answered with
    # 304 Not Modified (seen on Banco Central SGS 432) is down, not "bad JSON".
    if not 200 <= response.status_code < 300:
        return sample(DOWN, f"http:{response.status_code}", latency=False)
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        return sample(DOWN, "json", latency=False)
    problem = service.validate(payload)
    if problem:
        return sample(DOWN, f"payload:{problem}", latency=False)

    result = sample(UP, None)
    if retries:
        return replace(result, status=DEGRADED, reason="retried")
    if result.latency_ms is not None and result.latency_ms > service.slow_ms:
        return replace(result, status=DEGRADED, reason="slow")
    return result


def _transport_reason(error: BaseException) -> str:
    if isinstance(error, RequestTimeout):
        return "timeout"
    if isinstance(error, TransportError):
        return "network"
    # RetryExhausted wraps an HTTPStatusError only when raise_for_status is on,
    # which it is not here; anything else is unexpected and worth surfacing.
    return f"error:{type(error).__name__}"
