"""Cross-source consistency: do two APIs that publish the same fact agree?

Uptime says an API answered. It does not say the answer was right. Several
Brazilian public APIs republish the same data (CEPs, the list of states, the
Selic target, the PTAX rate), so the honest second question is whether they
agree, and the reconciliation library answers it with a keyed comparison.

A source that cannot be reached makes the comparison *inconclusive*, never
"divergent": a network failure is an availability problem and is already
reported by the probes. Only a source that answered "not found" for a key the
other side knows is counted as missing data.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from reconciler import Reconciliation, Record, Schema, format_key, reconcile
from resilient_client import (
    ResilientClient,
    ResilientClientError,
    RetryPolicy,
    Transport,
    TTLCache,
)

from brstatus.probe import USER_AGENT

#: CEPs compared across providers. Chosen to cover several states and kinds of
#: address; 40020-000 (Rua Chile, Salvador) is known to be missing from one of
#: them, which is exactly the kind of finding this section exists to show.
CEPS = ("66075110", "01310100", "70150900", "22070011", "40020000")


class SourceUnavailable(Exception):
    """A source failed in a way that says nothing about its data."""


class Fetcher:
    """Fetch JSON with retry, and cache it so a URL used twice costs one call."""

    def __init__(self, transport: Transport | None = None, **client_kwargs: Any):
        self._client = ResilientClient(
            transport=transport,
            timeout=10.0,
            retry=RetryPolicy(max_attempts=3, backoff_base=1.0),
            cache=TTLCache(),
            cache_ttl=300.0,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            raise_for_status=False,
            **client_kwargs,
        )

    def json(self, url: str) -> Any | None:
        """Decoded JSON, or ``None`` when the source says the item does not exist."""
        try:
            response = self._client.get(url)
        except ResilientClientError as exc:
            raise SourceUnavailable(f"{url}: {type(exc).__name__}") from exc
        if response.status_code in (400, 404):
            return None
        if not response.ok:
            raise SourceUnavailable(f"{url}: HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise SourceUnavailable(f"{url}: invalid JSON") from exc

    def close(self) -> None:
        self._client.close()


Loader = Callable[[Fetcher], Iterable[Record]]


@dataclass(frozen=True)
class Comparison:
    id: str
    name: str
    description: str
    left_name: str
    right_name: str
    left: Loader
    right: Loader
    schema: Schema


# -- loaders ------------------------------------------------------------------


def _viacep(fetch: Fetcher) -> Iterable[Record]:
    for cep in CEPS:
        data = fetch.json(f"https://viacep.com.br/ws/{cep}/json/")
        if not data or data.get("erro"):
            continue
        yield {
            "cep": data.get("cep"),
            "uf": data.get("uf"),
            "cidade": data.get("localidade"),
            "bairro": data.get("bairro"),
            "logradouro": data.get("logradouro"),
        }


def _brasilapi_cep(fetch: Fetcher) -> Iterable[Record]:
    for cep in CEPS:
        data = fetch.json(f"https://brasilapi.com.br/api/cep/v1/{cep}")
        if not data:
            continue
        yield {
            "cep": data.get("cep"),
            "uf": data.get("state"),
            "cidade": data.get("city"),
            "bairro": data.get("neighborhood"),
            "logradouro": data.get("street"),
        }


def _opencep(fetch: Fetcher) -> Iterable[Record]:
    for cep in CEPS:
        data = fetch.json(f"https://opencep.com/v1/{cep}")
        if not data:
            continue
        yield {
            "cep": data.get("cep"),
            "uf": data.get("uf"),
            "cidade": data.get("localidade"),
            "bairro": data.get("bairro"),
            "logradouro": data.get("logradouro"),
        }


def _states(url: str) -> Loader:
    def load(fetch: Fetcher) -> Iterable[Record]:
        for item in fetch.json(url) or []:
            yield {
                "id": item.get("id"),
                "sigla": item.get("sigla"),
                "nome": item.get("nome"),
                "regiao": (item.get("regiao") or {}).get("nome"),
            }

    return load


def _bcb_last(series: int) -> Callable[[Fetcher], dict[str, Any] | None]:
    def load(fetch: Fetcher) -> dict[str, Any] | None:
        url = (
            f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{series}"
            "/dados/ultimos/1?formato=json"
        )
        data = fetch.json(url)
        return data[-1] if data else None

    return load


def _bcb_selic(fetch: Fetcher) -> Iterable[Record]:
    last = _bcb_last(432)(fetch)
    if last:
        yield {"taxa": "selic", "valor": last["valor"]}


def _brasilapi_selic(fetch: Fetcher) -> Iterable[Record]:
    data = fetch.json("https://brasilapi.com.br/api/taxas/v1/selic")
    if data:
        yield {"taxa": "selic", "valor": data.get("valor")}


def _bcb_ptax_date(fetch: Fetcher) -> str | None:
    """Date of the latest PTAX in the SGS series, as ``yyyy-mm-dd``."""
    last = _bcb_last(1)(fetch)
    if not last:
        return None
    day, month, year = last["data"].split("/")
    return f"{year}-{month}-{day}"


def _bcb_ptax(fetch: Fetcher) -> Iterable[Record]:
    last = _bcb_last(1)(fetch)
    if last:
        yield {"data": _bcb_ptax_date(fetch), "venda": last["valor"]}


def _brasilapi_ptax(fetch: Fetcher) -> Iterable[Record]:
    # The date comes from the Banco Central side on purpose: both sides must be
    # asked about the same business day, and SGS knows which one is latest.
    date = _bcb_ptax_date(fetch)
    if not date:
        return
    data = fetch.json(f"https://brasilapi.com.br/api/cambio/v1/cotacao/USD/{date}")
    for quote in (data or {}).get("cotacoes", []):
        if str(quote.get("tipo_boletim", "")).upper().startswith("FECHAMENTO"):
            yield {"data": date, "venda": quote.get("cotacao_venda")}


_CEP_SCHEMA = Schema.build(
    key=["cep"],
    compare=["uf", "cidade", "bairro", "logradouro"],
    normalizers={"cep": "digits"},
    default_compare_normalizer="unaccented",
)

COMPARISONS: tuple[Comparison, ...] = (
    Comparison(
        id="cep-viacep-brasilapi",
        name="CEP",
        description="Endereço de 5 CEPs em capitais diferentes",
        left_name="ViaCEP",
        right_name="BrasilAPI",
        left=_viacep,
        right=_brasilapi_cep,
        schema=_CEP_SCHEMA,
    ),
    Comparison(
        id="cep-viacep-opencep",
        name="CEP",
        description="Endereço de 5 CEPs em capitais diferentes",
        left_name="ViaCEP",
        right_name="OpenCEP",
        left=_viacep,
        right=_opencep,
        schema=_CEP_SCHEMA,
    ),
    Comparison(
        id="uf-ibge-brasilapi",
        name="Unidades da federação",
        description="Código, sigla, nome e região das 27 UFs",
        left_name="IBGE",
        right_name="BrasilAPI",
        left=_states("https://servicodados.ibge.gov.br/api/v1/localidades/estados"),
        right=_states("https://brasilapi.com.br/api/ibge/uf/v1"),
        schema=Schema.build(
            key=["id"],
            compare=["sigla", "nome", "regiao"],
            normalizers={"id": "integer"},
        ),
    ),
    Comparison(
        id="selic-bcb-brasilapi",
        name="Meta Selic",
        description="Taxa vigente, sem tolerância",
        left_name="Banco Central",
        right_name="BrasilAPI",
        left=_bcb_selic,
        right=_brasilapi_selic,
        schema=Schema.build(
            key=["taxa"], compare=["valor"], normalizers={"valor": "money"}
        ),
    ),
    Comparison(
        id="ptax-bcb-brasilapi",
        name="Dólar PTAX",
        description="PTAX de venda do último dia útil, sem tolerância",
        left_name="Banco Central",
        right_name="BrasilAPI",
        left=_bcb_ptax,
        right=_brasilapi_ptax,
        schema=Schema.build(
            key=["data"], compare=["venda"], normalizers={"venda": "money"}
        ),
    ),
)


# -- running ------------------------------------------------------------------


def run_comparison(
    comparison: Comparison, fetch: Fetcher, now: datetime | None = None
) -> dict[str, Any]:
    """Run one comparison and return its JSON-ready result."""
    checked_at = int((now or datetime.now(timezone.utc)).timestamp())
    base: dict[str, Any] = {
        "id": comparison.id,
        "name": comparison.name,
        "description": comparison.description,
        "left": comparison.left_name,
        "right": comparison.right_name,
        "checked_at": checked_at,
    }
    try:
        # Materialize both sides first so a failure halfway through one side
        # never produces a half-compared, misleading result.
        left = list(comparison.left(fetch))
        right = list(comparison.right(fetch))
    except SourceUnavailable as exc:
        return {**base, "status": "inconclusive", "error": str(exc), "details": []}

    result = reconcile(
        left,
        right,
        comparison.schema,
        left_name=comparison.left_name,
        right_name=comparison.right_name,
    )
    details = describe(result)
    return {
        **base,
        "status": "consistent" if result.is_clean else "divergent",
        "compared": len(
            {*_keys(left, comparison.schema), *_keys(right, comparison.schema)}
        ),
        "matched": result.matched,
        "problems": result.problem_count,
        "details": details,
        "error": None,
    }


def _keys(records: Iterable[Record], schema: Schema) -> set[str]:
    return {format_key(k) for r in records if (k := schema.key_of(r)) is not None}


def describe(result: Reconciliation) -> list[dict[str, Any]]:
    """Every finding as a flat row, with the values each source actually sent.

    The comparison runs on normalized values (no accents, no case, digits only
    for CEPs), but people need to see the raw values to judge the divergence,
    so rows carry what was received, not what was compared.
    """
    schema = result.schema
    rows: list[dict[str, Any]] = []
    for mismatch in result.mismatched:
        for difference in mismatch.differences:
            rows.append(
                {
                    "kind": "mismatch",
                    "key": format_key(mismatch.key),
                    "field": difference.field,
                    "left": mismatch.left.get(difference.field),
                    "right": mismatch.right.get(difference.field),
                }
            )
    for kind, records in (
        ("only_left", result.only_left),
        ("only_right", result.only_right),
    ):
        for record in records:
            key = schema.key_of(record)
            rows.append({"kind": kind, "key": format_key(key) if key else "?"})
    for kind, duplicates in (
        ("duplicate_left", result.duplicate_left),
        ("duplicate_right", result.duplicate_right),
    ):
        for key, count in duplicates.items():
            rows.append({"kind": kind, "key": format_key(key), "count": count})
    for kind, unkeyed in (
        ("unkeyed_left", result.unkeyed_left),
        ("unkeyed_right", result.unkeyed_right),
    ):
        rows.extend({"kind": kind, "key": "?", "reason": u.reason} for u in unkeyed)
    return rows


def run_all(
    comparisons: Iterable[Comparison] = COMPARISONS,
    fetch: Fetcher | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    own = fetch is None
    fetch = fetch or Fetcher()
    try:
        return [run_comparison(c, fetch, now) for c in comparisons]
    finally:
        if own:
            fetch.close()
