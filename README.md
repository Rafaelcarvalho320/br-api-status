# br-api-status

[![monitor](https://github.com/Rafaelcarvalho320/br-api-status/actions/workflows/monitor.yml/badge.svg)](https://github.com/Rafaelcarvalho320/br-api-status/actions/workflows/monitor.yml)
[![CI](https://github.com/Rafaelcarvalho320/br-api-status/actions/workflows/ci.yml/badge.svg)](https://github.com/Rafaelcarvalho320/br-api-status/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Página pública de status das APIs públicas brasileiras que todo mundo usa em
integração: **BrasilAPI, ViaCEP, OpenCEP, IBGE, Banco Central, AwesomeAPI e
FIPE**. Mostra disponibilidade, latência e incidentes e, além disso, confere
se as fontes que publicam o mesmo dado **concordam entre si**.

A rede aparece como um mapa de metrô: cada provedor é uma linha, cada
endpoint é uma estação, e as **baldeações** são os pontos onde duas fontes
publicam o mesmo dado e as respostas são comparadas.

**Ao vivo:** https://rafaelcarvalho320.github.io/br-api-status/

Não tem servidor, banco nem custo. Um workflow do GitHub Actions roda a cada
~15 minutos, grava o histórico num branch e publica a página no GitHub Pages.

> *[English summary below](#english-summary)*

## O problema

Quem integra com API pública brasileira já passou por isso: o CEP para de
resolver, o checkout trava, e a dúvida é se o problema está no seu código ou
no serviço. Não existe uma página oficial de status para a maioria delas.

E estar no ar não basta. Uma API que responde `200` com
`{"erro": "true"}` está fora do ar para quem depende dela. Duas APIs que
respondem rápido, mas discordam sobre o mesmo CEP, também são um problema, só
que mais silencioso.

## O que é medido

**Disponibilidade.** Para cada serviço, uma requisição real com um dado
estável, como o CEP do campus da UFPA, o CNPJ do Banco do Brasil ou o DDD 91.
A resposta é **validada**, não só o status HTTP:

| Estado | Regra |
| --- | --- |
| Operacional | resposta válida na 1ª tentativa, em menos de 3 s |
| Lento | resposta válida, mas só depois de nova tentativa ou acima de 3 s |
| Fora do ar | erro de rede, timeout (10 s), erro HTTP, corpo que não é JSON ou JSON que não passa na validação, depois de até 3 tentativas com backoff exponencial |

Um incidente abre na primeira verificação *fora do ar* e fecha na primeira
que volta a responder. Lentidão aparece nas barras e no gráfico de latência,
mas não abre incidente; se abrisse, os incidentes de verdade ficariam
enterrados.

**Consistência entre fontes.** Quando duas APIs publicam o mesmo fato, as
duas são comparadas campo a campo com o
[reconciliation-report](https://github.com/Rafaelcarvalho320/reconciliation-report):

| Comparação | Fontes | Campos |
| --- | --- | --- |
| CEP (5 capitais) | ViaCEP × BrasilAPI, ViaCEP × OpenCEP | UF, cidade, bairro, logradouro |
| Unidades da federação | IBGE × BrasilAPI | código, sigla, nome, região |
| Meta Selic | Banco Central × BrasilAPI | taxa, sem tolerância |
| Dólar PTAX | Banco Central × BrasilAPI | venda do último dia útil, sem tolerância |

A comparação ignora acento e maiúscula (`Belém` = `BELEM`) e só o dígito do CEP
importa (`66075-110` = `66075110`). Só sobra o que é divergência de fato. No
primeiro dia já apareceu uma: o CEP **40020-000** (Rua Chile, Salvador)
existe na BrasilAPI e na OpenCEP, mas a ViaCEP responde que não encontra.

Quando uma fonte não responde, a comparação fica **inconclusiva** e não conta
como divergência. Falha de rede é problema de disponibilidade e já aparece
nas sondas.

## Como funciona

```
GitHub Actions (cron, ~15 min)
  ├─ restaura status.json do branch `data`
  ├─ python -m brstatus     → 15 sondas + 5 comparações
  ├─ grava status.json no branch `data` (commit único, force-push)
  └─ publica site/ + status.json no GitHub Pages
```

- **Sondas** usam o [resilient-api-client](https://github.com/Rafaelcarvalho320/resilient-api-client):
  timeout, retry com backoff exponencial e jitter, e um hook que conta as
  tentativas. É assim que "respondeu, mas só na 2ª tentativa" vira *lento*
  em vez de *operacional*.
- **O histórico fica num branch órfão `data` com um único commit.** Uma
  verificação a cada 15 minutos daria ~100 commits por dia no `main`. Se o
  branch não existe, é a primeira execução; se o fetch falha por outro
  motivo, a execução aborta em vez de recomeçar do zero e sobrescrever 90
  dias de histórico.
- **O arquivo é limitado por construção:** amostras brutas só das últimas
  48 h (gráfico de latência), contadores diários por 90 dias (barras) e os
  últimos 20 incidentes por serviço. Fica em torno de 150 KB.
- **Os dias são contados no horário de Brasília**, porque "ontem", numa
  página sobre serviços brasileiros, é o ontem brasileiro.
- **As sondas rodam em sequência, não em paralelo.** Em paralelo, os
  handshakes TLS simultâneos disputavam a CPU e todas as latências saíam ~3× maiores que
  as reais.
- **A página é HTML, CSS e JS puros**, sem framework nem build. Ela lê
  `data/status.json`, se atualiza a cada 5 minutos e avisa quando o
  agendamento do GitHub atrasou e os dados podem estar velhos.
- **O mapa é desenhado à mão, não calculado.** Um esquema fixo lê melhor do
  que qualquer layout automático, e o catálogo muda pouco. Um serviço novo
  aparece na tabela mesmo antes de ganhar sua estação no mapa.
- **A fonte é a [Overpass](https://github.com/RedHatOfficial/Overpass)**
  (OFL), derivada da tipografia de sinalização viária e hospedada no próprio
  site, sem CDN de terceiros.

**Limitação honesta:** os runners do GitHub ficam nos EUA. A latência inclui
a viagem até o Brasil e serve para ver tendência, não para medir a
experiência de quem está no país.

## Rodando localmente

```console
$ python -m venv .venv && . .venv/bin/activate
$ pip install -e ".[dev]"
$ python -m brstatus --state site/data/status.json
up          782 ms  brasilapi-cep
up          687 ms  brasilapi-cnpj
...
divergent    cep-viacep-brasilapi  1
consistent   uf-ibge-brasilapi  0
$ python -m http.server -d site 8000   # abra http://localhost:8000
```

Testes (sem rede: um transporte falso e um relógio controlado substituem a
internet):

```console
$ pytest
$ ruff check src tests
```

## Adicionando um serviço

Um item em `src/brstatus/services.py`:

```python
Service(
    id="brasilapi-ncm",
    name="NCM",
    provider="BrasilAPI",
    url="https://brasilapi.com.br/api/ncm/v1/33051000",
    validate=_field_present("descricao"),
    docs="https://brasilapi.com.br/docs#tag/NCM",
)
```

Escolha um dado que não muda com o tempo. Se o validador falhar, a causa
precisa ser o serviço, não a amostra que ficou velha.

## English summary

A public status page for the Brazilian public APIs that integrations rely on
(BrasilAPI, ViaCEP, OpenCEP, IBGE, Banco Central, AwesomeAPI, FIPE), run
entirely on GitHub Actions and GitHub Pages at zero cost. The network is drawn
as a transit map: providers are lines, endpoints are stations, and the
interchanges are where two sources publish the same fact and get reconciled.

Beyond uptime and latency, it checks **cross-source consistency**: when two
APIs publish the same fact (a CEP's address, the list of states, the Selic
target, the PTAX rate), they are reconciled field by field, accent- and
case-insensitively. On day one this surfaced a real gap: CEP 40020-000 exists
in BrasilAPI and OpenCEP but ViaCEP reports it as not found.

Decisions worth knowing:

- **Payloads are validated, not just status-coded.** A `200` carrying
  `{"erro": "true"}` is down for anyone using it.
- **"Answered only after a retry" is degraded, not up**, using the retry hook
  of my resilient-api-client.
- **An unreachable source makes a comparison inconclusive, never divergent.**
  Availability and correctness are reported separately.
- **History lives on a single-commit orphan `data` branch**, keeping `main`
  free of ~100 data commits a day. A failed fetch aborts the run instead of
  starting fresh and overwriting 90 days of history.
- **Bounded state:** 48 h of raw samples, 90 days of daily counters, last 20
  incidents per service, about 150 KB.
- **Probes run sequentially.** In parallel, concurrent TLS handshakes inflated
  every latency about 3x.
- **Honest limitation:** GitHub runners are in the US, so latency shows trends,
  not what a user in Brazil experiences.

Code and docstrings are in English; the sections above are in Portuguese.

## Licença

MIT. Veja [LICENSE](LICENSE).
