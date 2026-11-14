"""Run every probe and comparison once and update the state file.

Usage::

    python -m brstatus --state site/data/status.json

Meant to be run on a schedule (GitHub Actions, cron). Exits 0 even when
services are down: an outage is data to record, not a failure of the monitor.
It exits non-zero only when the monitor itself is broken.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from brstatus import consistency, state
from brstatus.probe import probe
from brstatus.services import SERVICES


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="brstatus", description=__doc__.splitlines()[0]
    )
    parser.add_argument("--state", type=Path, default=Path("site/data/status.json"))
    parser.add_argument(
        "--skip-consistency", action="store_true", help="only run the uptime probes"
    )
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    current = state.load(args.state)

    # Sequential on purpose. Run in parallel, twelve TLS handshakes compete for
    # the same CPU and every latency came out ~3x higher than the real one,
    # which on a status page is a wrong answer, not a slower one.
    samples = [probe(service, now=lambda: now) for service in SERVICES]
    state.record_samples(current, SERVICES, samples, now)

    for sample in samples:
        ms = "-" if sample.latency_ms is None else f"{sample.latency_ms} ms"
        print(f"{sample.status:9} {ms:>8}  {sample.service_id}  {sample.reason or ''}")

    if not args.skip_consistency:
        results = consistency.run_all(now=now)
        state.record_consistency(current, results, now)
        for result in results:
            print(f"{result['status']:12} {result['id']}  {result.get('problems', '')}")

    state.save(current, args.state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
