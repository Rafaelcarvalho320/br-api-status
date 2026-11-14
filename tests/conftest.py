"""A scripted transport: no network, deterministic time."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

import pytest
from resilient_client import FakeClock, Request, Response


class Reply:
    """One scripted outcome: a status and a JSON body, or an exception."""

    def __init__(
        self,
        body: Any = None,
        status: int = 200,
        *,
        raw: bytes | None = None,
        takes: float = 0.1,
        error: Exception | None = None,
    ) -> None:
        self.body = body
        self.status = status
        self.raw = raw
        self.takes = takes
        self.error = error


class ScriptedTransport:
    """Answers each URL with the next scripted reply; the last one repeats."""

    def __init__(self, clock: FakeClock, script: dict[str, Iterable[Reply]]):
        self.clock = clock
        self.script = {url: list(replies) for url, replies in script.items()}
        self.calls: list[str] = []

    def send(self, request: Request, timeout: float) -> Response:
        self.calls.append(request.url)
        replies = self.script.get(request.url)
        if not replies:
            return Response(404, {}, b'{"message":"not found"}', request)
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        self.clock.advance(reply.takes)
        if reply.error is not None:
            raise reply.error
        content = (
            reply.raw if reply.raw is not None else json.dumps(reply.body).encode()
        )
        return Response(reply.status, {}, content, request)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(start=1000.0)
