from __future__ import annotations

from datetime import datetime, timezone

from resilient_client import RetryPolicy, TransportError

from brstatus import consistency
from brstatus.consistency import CEPS, Fetcher, run_comparison
from conftest import Reply, ScriptedTransport

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
BY_ID = {c.id: c for c in consistency.COMPARISONS}


def viacep(cep, **over):
    return {
        "cep": f"{cep[:5]}-{cep[5:]}",
        "uf": "PA",
        "localidade": "Belém",
        "bairro": "Guamá",
        "logradouro": "Rua Augusto Corrêa",
        **over,
    }


def brasilapi(cep, **over):
    return {
        "cep": cep,
        "state": "PA",
        "city": "Belem",  # accent lost on purpose: must still match
        "neighborhood": "GUAMÁ",  # case differs on purpose: must still match
        "street": "Rua Augusto Corrêa",
        **over,
    }


def cep_script(
    viacep_over=None, brasilapi_over=None, viacep_missing=(), brasilapi_missing=()
):
    script = {}
    for cep in CEPS:
        v = (
            {"erro": "true"}
            if cep in viacep_missing
            else viacep(cep, **(viacep_over or {}).get(cep, {}))
        )
        script[f"https://viacep.com.br/ws/{cep}/json/"] = [Reply(v)]
        if cep not in brasilapi_missing:
            b = brasilapi(cep, **(brasilapi_over or {}).get(cep, {}))
            script[f"https://brasilapi.com.br/api/cep/v1/{cep}"] = [Reply(b)]
    return script


def fetcher(clock, script):
    transport = ScriptedTransport(clock, script)
    fetch = Fetcher(transport=transport, clock=clock)
    return fetch, transport


def test_sources_that_agree_after_normalization_are_consistent(clock):
    fetch, _ = fetcher(clock, cep_script())
    result = run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    assert result["status"] == "consistent"
    assert (result["compared"], result["matched"], result["problems"]) == (5, 5, 0)


def test_field_mismatch_reports_the_raw_values(clock):
    script = cep_script(brasilapi_over={"66075110": {"neighborhood": "Universitário"}})
    fetch, _ = fetcher(clock, script)
    result = run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    assert result["status"] == "divergent"
    assert result["details"] == [
        {
            "kind": "mismatch",
            "key": "66075110",
            "field": "bairro",
            "left": "Guamá",
            "right": "Universitário",
        }
    ]


def test_not_found_on_one_side_is_missing_data(clock):
    fetch, _ = fetcher(clock, cep_script(viacep_missing={"40020000"}))
    result = run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    assert result["status"] == "divergent"
    assert result["details"] == [{"kind": "only_right", "key": "40020000"}]


def test_unreachable_source_is_inconclusive_not_divergent(clock):
    script = cep_script()
    script["https://brasilapi.com.br/api/cep/v1/22070011"] = [
        Reply(error=TransportError("connection reset"))
    ]
    fetch, _ = fetcher(clock, script)
    result = run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    assert result["status"] == "inconclusive"
    assert "22070011" in result["error"]
    assert result["details"] == []


def test_server_error_is_inconclusive(clock):
    script = cep_script()
    script["https://viacep.com.br/ws/66075110/json/"] = [Reply(status=502)]
    fetch, _ = fetcher(clock, script)
    assert (
        run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)["status"]
        == "inconclusive"
    )


def test_shared_source_is_fetched_once_across_comparisons(clock):
    script = cep_script()
    for cep in CEPS:
        script[f"https://opencep.com/v1/{cep}"] = [Reply(viacep(cep))]
    fetch, transport = fetcher(clock, script)
    run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    run_comparison(BY_ID["cep-viacep-opencep"], fetch, NOW)
    viacep_calls = [u for u in transport.calls if "viacep" in u]
    assert len(viacep_calls) == len(CEPS)


def test_ptax_asks_brasilapi_for_the_banco_central_business_day(clock):
    sgs = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json"
    cambio = "https://brasilapi.com.br/api/cambio/v1/cotacao/USD/2026-11-13"
    script = {
        sgs: [Reply([{"data": "13/11/2026", "valor": "5.6518"}])],
        cambio: [
            Reply(
                {
                    "cotacoes": [
                        {"tipo_boletim": "ABERTURA", "cotacao_venda": 5.6649},
                        {"tipo_boletim": "FECHAMENTO PTAX", "cotacao_venda": 5.6518},
                    ]
                }
            )
        ],
    }
    fetch, _ = fetcher(clock, script)
    result = run_comparison(BY_ID["ptax-bcb-brasilapi"], fetch, NOW)
    assert result["status"] == "consistent"
    assert result["matched"] == 1


SELIC_SGS = (
    "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json"
)


def test_selic_detects_a_stale_republisher(clock):
    script = {
        SELIC_SGS: [Reply([{"data": "09/12/2026", "valor": "13.75"}])],
        "https://brasilapi.com.br/api/taxas/v1/selic": [
            Reply({"nome": "SELIC", "valor": 14.25})
        ],
    }
    fetch, _ = fetcher(clock, script)
    result = run_comparison(BY_ID["selic-bcb-brasilapi"], fetch, NOW)
    assert result["status"] == "divergent"
    assert result["details"][0]["field"] == "valor"


def test_every_comparison_has_a_unique_id():
    ids = [c.id for c in consistency.COMPARISONS]
    assert len(ids) == len(set(ids))


def test_retry_policy_is_bounded():
    # Guard against someone turning the consistency fetcher into a hammer.
    fetch = Fetcher()
    policy: RetryPolicy = fetch._client._retry
    assert policy.max_attempts <= 3
    fetch.close()


def test_values_from_a_source_are_bounded_before_they_are_stored(clock):
    huge = "x" * 100_000
    script = cep_script(brasilapi_over={"66075110": {"neighborhood": huge}})
    fetch, _ = fetcher(clock, script)
    result = run_comparison(BY_ID["cep-viacep-brasilapi"], fetch, NOW)
    [row] = result["details"]
    assert len(row["right"]) == 160
    assert row["right"].endswith("…")


def test_not_modified_is_a_source_failure_not_bad_json(clock):
    ibge = "https://servicodados.ibge.gov.br/api/v1/localidades/estados"
    fetch, _ = fetcher(clock, {ibge: [Reply(status=304)]})
    result = run_comparison(BY_ID["uf-ibge-brasilapi"], fetch, NOW)
    assert result["status"] == "inconclusive"
    assert result["error"].endswith("HTTP 304")
