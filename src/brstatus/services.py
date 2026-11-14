"""The catalog of monitored endpoints.

Each service is checked with one real request that a typical integration would
make, and the answer is *validated*, not just status-coded: an API that returns
``200`` with an empty body or an error object is not up for anyone using it.

The probe data is chosen to be stable over time (the CEP of UFPA's campus, the
CNPJ of Banco do Brasil, DDD 91), so a validation failure means the service
changed, not that the sample went stale.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

#: A validator inspects the decoded JSON and returns ``None`` when the payload is
#: usable, or a short description of what is wrong with it.
Validator = Callable[[Any], "str | None"]


@dataclass(frozen=True)
class Service:
    id: str
    name: str
    provider: str
    url: str
    validate: Validator
    docs: str
    #: Above this many milliseconds a successful answer counts as degraded.
    slow_ms: int = 3000

    def resolved_url(self, now: datetime) -> str:
        """The URL with time placeholders filled in (``{year}``)."""
        return self.url.format(year=now.year)


def _field_equals(path: str, expected: Any) -> Validator:
    def check(payload: Any) -> str | None:
        value = payload
        for part in path.split("."):
            if not isinstance(value, dict) or part not in value:
                return f"missing {path}"
            value = value[part]
        if value != expected:
            return f"{path}={value!r}, expected {expected!r}"
        return None

    return check


def _field_present(path: str) -> Validator:
    def check(payload: Any) -> str | None:
        value = payload
        for part in path.split("."):
            if not isinstance(value, dict) or part not in value:
                return f"missing {path}"
            value = value[part]
        if value in (None, "", [], {}):
            return f"empty {path}"
        return None

    return check


def _list_of_at_least(minimum: int, item_key: str | None = None) -> Validator:
    def check(payload: Any) -> str | None:
        if not isinstance(payload, list):
            return f"expected a list, got {type(payload).__name__}"
        if len(payload) < minimum:
            return f"expected at least {minimum} items, got {len(payload)}"
        if item_key and not all(
            isinstance(item, dict) and item.get(item_key) not in (None, "")
            for item in payload
        ):
            return f"item without {item_key}"
        return None

    return check


def _sgs_value(payload: Any) -> str | None:
    """Banco Central SGS series: ``[{"data": "dd/mm/yyyy", "valor": "5.65"}]``."""
    problem = _list_of_at_least(1, "valor")(payload)
    if problem:
        return problem
    try:
        float(payload[-1]["valor"])
    except (TypeError, ValueError):
        return f"valor is not numeric: {payload[-1]['valor']!r}"
    return None


SERVICES: tuple[Service, ...] = (
    Service(
        id="brasilapi-cep",
        name="CEP",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/cep/v1/66075110",
        validate=_field_equals("state", "PA"),
        docs="https://brasilapi.com.br/docs#tag/CEP",
    ),
    Service(
        id="brasilapi-cnpj",
        name="CNPJ",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/cnpj/v1/00000000000191",
        validate=_field_present("razao_social"),
        docs="https://brasilapi.com.br/docs#tag/CNPJ",
    ),
    Service(
        id="brasilapi-banks",
        name="Bancos",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/banks/v1/001",
        validate=_field_equals("code", 1),
        docs="https://brasilapi.com.br/docs#tag/BANKS",
    ),
    Service(
        id="brasilapi-holidays",
        name="Feriados nacionais",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/feriados/v1/{year}",
        validate=_list_of_at_least(8, "date"),
        docs="https://brasilapi.com.br/docs#tag/Feriados-Nacionais",
    ),
    Service(
        id="brasilapi-ddd",
        name="DDD",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/ddd/v1/91",
        validate=_field_equals("state", "PA"),
        docs="https://brasilapi.com.br/docs#tag/DDD",
    ),
    Service(
        id="brasilapi-uf",
        name="Estados (IBGE)",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/ibge/uf/v1",
        validate=_list_of_at_least(27, "sigla"),
        docs="https://brasilapi.com.br/docs#tag/IBGE",
    ),
    Service(
        id="brasilapi-rates",
        name="Taxas (Selic)",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/taxas/v1/selic",
        validate=_field_present("valor"),
        docs="https://brasilapi.com.br/docs#tag/TAXAS",
    ),
    Service(
        id="brasilapi-exchange",
        name="Câmbio",
        provider="BrasilAPI",
        url="https://brasilapi.com.br/api/cambio/v1/moedas",
        validate=_list_of_at_least(10, "simbolo"),
        docs="https://brasilapi.com.br/docs#tag/CAMBIO",
    ),
    Service(
        id="viacep",
        name="CEP",
        provider="ViaCEP",
        url="https://viacep.com.br/ws/66075110/json/",
        validate=_field_equals("uf", "PA"),
        docs="https://viacep.com.br/",
    ),
    Service(
        id="opencep",
        name="CEP",
        provider="OpenCEP",
        url="https://opencep.com/v1/66075110",
        validate=_field_equals("uf", "PA"),
        docs="https://opencep.com/",
    ),
    Service(
        id="ibge-localidades",
        name="Localidades",
        provider="IBGE",
        url="https://servicodados.ibge.gov.br/api/v1/localidades/estados",
        validate=_list_of_at_least(27, "sigla"),
        docs="https://servicodados.ibge.gov.br/api/docs/localidades",
    ),
    Service(
        id="bcb-ptax",
        name="Dólar PTAX (SGS 1)",
        provider="Banco Central",
        url="https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json",
        validate=_sgs_value,
        docs="https://dadosabertos.bcb.gov.br/",
    ),
    Service(
        id="bcb-selic",
        name="Meta Selic (SGS 432)",
        provider="Banco Central",
        url="https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json",
        validate=_sgs_value,
        docs="https://dadosabertos.bcb.gov.br/",
    ),
    Service(
        id="awesomeapi-usd",
        name="Cotação USD-BRL",
        provider="AwesomeAPI",
        url="https://economia.awesomeapi.com.br/json/last/USD-BRL",
        validate=_field_present("USDBRL.bid"),
        docs="https://docs.awesomeapi.com.br/api-de-moedas",
    ),
    Service(
        id="fipe",
        name="Tabela FIPE",
        provider="Parallelum",
        url="https://parallelum.com.br/fipe/api/v1/carros/marcas",
        validate=_list_of_at_least(20, "codigo"),
        docs="https://deividfortuna.github.io/fipe/",
    ),
)
