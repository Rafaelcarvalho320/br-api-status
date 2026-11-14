"use strict";

// Reads data/status.json (written by `python -m brstatus`) and renders it.
// No framework and no build step: hosting the page has to stay as cheap as
// running the monitor.

const DATA_URL = "data/status.json";
const DAYS = 90;
const STALE_AFTER_MIN = 45;
const REFRESH_MS = 5 * 60 * 1000;
const TZ = "America/Sao_Paulo";

const fmtDay = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtTime = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtPct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat("pt-BR");

const STATUS = {
  up: { icon: "good", label: "Operando" },
  degraded: { icon: "warning", label: "Lento" },
  down: { icon: "critical", label: "Fora do ar" },
  none: { icon: "empty", label: "Sem dados" },
};

// The network map is authored, not computed: a fixed schematic reads better
// than any automatic layout, and the catalog changes rarely. A service missing
// from here still appears in the table below; it just has no station yet.
const MAP = {
  width: 1000,
  height: 262,
  lines: [
    { provider: "ViaCEP", y: 44, from: 240, to: 340, stations: [["viacep", 290, "CEP"]] },
    { provider: "OpenCEP", y: 92, from: 240, to: 340, stations: [["opencep", 290, "CEP"]] },
    {
      provider: "BrasilAPI", y: 140, from: 100, to: 860,
      stations: [
        ["brasilapi-cnpj", 130, "CNPJ"], ["brasilapi-banks", 210, "Bancos"], ["brasilapi-cep", 290, "CEP"],
        ["brasilapi-holidays", 390, "Feriados"], ["brasilapi-ddd", 480, "DDD"], ["brasilapi-uf", 590, "Estados"],
        ["brasilapi-rates", 700, "Taxas"], ["brasilapi-exchange", 810, "Câmbio"],
      ],
    },
    { provider: "AwesomeAPI", y: 188, from: 140, to: 240, stations: [["awesomeapi-usd", 190, "USD-BRL"]] },
    { provider: "IBGE", y: 188, from: 540, to: 640, stations: [["ibge-localidades", 590, "Localidades"]] },
    { provider: "Parallelum", y: 236, from: 140, to: 240, stations: [["fipe", 190, "FIPE"]] },
    { provider: "Banco Central", y: 236, from: 650, to: 860, stations: [["bcb-selic", 700, "Selic"], ["bcb-ptax", 810, "PTAX"]] },
  ],
  // Interchanges: x, top and bottom row, and the comparisons that run there.
  transfers: [
    { name: "CEP", x: 290, y1: 44, y2: 140, ids: ["cep-viacep-brasilapi", "cep-viacep-opencep"] },
    { name: "Estados", x: 590, y1: 140, y2: 188, ids: ["uf-ibge-brasilapi"] },
    { name: "Selic", x: 700, y1: 140, y2: 236, ids: ["selic-bcb-brasilapi"] },
    { name: "PTAX", x: 810, y1: 140, y2: 236, ids: ["ptax-bcb-brasilapi"] },
  ],
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (id) => document.getElementById(id);
const icon = (name, size = 18) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;

// -- helpers -------------------------------------------------------------

function reasonText(reason) {
  if (!reason) return "";
  const [kind, ...rest] = reason.split(":");
  const detail = rest.join(":");
  switch (kind) {
    case "http": return `erro HTTP ${detail}`;
    case "timeout": return "tempo esgotado (10 s)";
    case "network": return "falha de rede";
    case "json": return "a resposta não é JSON";
    case "payload": return `conteúdo inválido (${detail})`;
    case "slow": return "resposta acima de 3 s";
    case "retried": return "só respondeu na segunda tentativa";
    default: return reason;
  }
}

/** Brasilia calendar day (yyyy-mm-dd) for a unix timestamp, matching the backend. */
const dayKey = (ts) => new Date((ts - 3 * 3600) * 1000).toISOString().slice(0, 10);

function lastDays(nowTs, count) {
  const days = [];
  for (let i = count - 1; i >= 0; i--) days.push(dayKey(nowTs - i * 86400));
  return days;
}

function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return fmtDay.format(new Date(Date.UTC(y, m - 1, d, 15)));
}

function dayTone(c) {
  if (!c || !c.n) return "empty";
  if (c.down === 0 && c.degraded / c.n < 0.25) return "good";
  return (c.up + c.degraded) / c.n >= 0.95 ? "warning" : "critical";
}

function totals(daily) {
  const t = { n: 0, up: 0, degraded: 0, down: 0, ms: 0 };
  for (const c of Object.values(daily || {})) for (const k in t) t[k] += c[k] || 0;
  return t;
}

const uptime = (t) => (t.n ? ((t.up + t.degraded) / t.n) * 100 : null);
const pct = (v) => (v == null ? "—" : `${fmtPct.format(v)}%`);
const ms = (v) => (v == null ? "—" : `${fmtInt.format(v)} ms`);

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function duration(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} dias`;
}

const ago = (ts, nowTs) => (nowTs - ts < 90 ? "agora há pouco" : `há ${duration(nowTs - ts)}`);
const current = (s) => (s.samples.at(-1) || [])[1] || "none";
const latency24h = (s, nowTs) => median(s.samples.filter((r) => r[0] >= nowTs - 86400 && r[2] != null).map((r) => r[2]));
const fullName = (s) => (s.provider === s.name ? s.name : `${s.provider} · ${s.name}`);

function stateHTML(status, reason) {
  const st = STATUS[status] || STATUS.none;
  const why = status !== "up" && reason ? `<span class="state-why">${esc(reasonText(reason))}</span>` : "";
  return `<span class="state">${icon(st.icon)}${st.label}</span>${why}`;
}

function cmpOutcome(items) {
  if (items.some((c) => c && c.status === "divergent")) return "divergent";
  if (!items.length || items.some((c) => !c || c.status === "inconclusive")) return "inconclusive";
  return "consistent";
}

// -- tooltip -------------------------------------------------------------

const tip = $("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 20 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };

// -- headline ------------------------------------------------------------

function renderHeadline(data, nowTs) {
  const services = Object.entries(data.services);
  const down = services.filter(([, s]) => current(s) === "down");
  const slow = services.filter(([, s]) => current(s) === "degraded");
  const names = (list) => list.map(([, s]) => fullName(s)).join(", ");

  let ic = "good";
  let text = `Todos os ${services.length} serviços estão operando normalmente`;
  if (!services.length) {
    ic = "empty";
    text = "Nenhuma verificação registrada ainda";
  } else if (down.length === 1) {
    ic = "critical";
    const open = (down[0][1].incidents || []).at(-1);
    const since = open && open.end == null ? ` desde as ${fmtTime.format(new Date(open.start * 1000))}` : "";
    text = `${fullName(down[0][1])} está fora do ar${since}`;
  } else if (down.length > 1) {
    ic = "critical";
    text = `${down.length} serviços fora do ar: ${names(down)}`;
  } else if (slow.length) {
    ic = "warning";
    text = slow.length === 1 ? `${fullName(slow[0][1])} está lento` : `${slow.length} serviços lentos: ${names(slow)}`;
  }
  if (down.length && slow.length) text += `. Lento: ${names(slow)}`;
  $("headline").innerHTML = `${icon(ic, 28)}<span class="hl-text">${esc(text)}</span>`;

  const all = { n: 0, up: 0, degraded: 0, down: 0, ms: 0 };
  for (const [, s] of services) { const t = totals(s.daily); for (const k in all) all[k] += t[k]; }
  const lat = median(services.flatMap(([, s]) => s.samples.filter((r) => r[0] >= nowTs - 86400 && r[2] != null).map((r) => r[2])));
  const cmp = Object.values(data.consistency || {});
  const divergent = cmp.filter((c) => c.status === "divergent").length;
  $("facts").innerHTML = [
    `<strong>${pct(uptime(all))}</strong> de disponibilidade média em 90 dias`,
    `mediana de <strong>${ms(lat)}</strong> nas últimas 24 h`,
    `<strong>${divergent} de ${cmp.length}</strong> conferências com divergência`,
  ].join(" · ");
}

// -- map -----------------------------------------------------------------

function renderMap(data) {
  const svc = data.services;
  const cmp = data.consistency || {};
  const parts = [];

  for (const line of MAP.lines) {
    parts.push(`<line class="rail" x1="${line.from}" x2="${line.to}" y1="${line.y}" y2="${line.y}"/>`);
    parts.push(`<text class="prov" x="${line.from - 14}" y="${line.y + 5}" text-anchor="end">${esc(line.provider)}</text>`);
  }

  const inTransfer = new Set();
  for (const t of MAP.transfers) {
    const outcome = cmpOutcome(t.ids.map((id) => cmp[id]));
    const h = t.y2 - t.y1 + 28;
    const problems = t.ids.reduce((n, id) => n + ((cmp[id] && cmp[id].problems) || 0), 0);
    const label = outcome === "divergent"
      ? `${problems} ${problems === 1 ? "divergência" : "divergências"}`
      : outcome === "consistent" ? "as fontes concordam" : "comparação inconclusiva";
    parts.push(`<a href="#cmp-${t.ids[0]}" class="xfer-link" data-xfer="${esc(t.name)}" data-label="${esc(label)}" aria-label="${esc(`Baldeação ${t.name}: ${label}`)}">` +
      `<rect class="xfer ${outcome}" x="${t.x - 14}" y="${t.y1 - 14}" width="28" height="${h}" rx="14"/></a>`);
    if (outcome === "divergent") parts.push(`<use class="xfer-flag" href="#ic-warning" x="${t.x - 24}" y="${t.y1 - 26}" width="18" height="18"/>`);
    for (const line of MAP.lines) {
      for (const [id, x] of line.stations) if (x === t.x && line.y >= t.y1 && line.y <= t.y2) inTransfer.add(id);
    }
  }

  for (const line of MAP.lines) {
    for (const [id, x, short] of line.stations) {
      const s = svc[id];
      const status = s ? current(s) : "none";
      const y = line.y;
      const side = inTransfer.has(id);
      let mark;
      if (status === "up") mark = `<circle class="st-up" cx="${x}" cy="${y}" r="7"/>`;
      else if (status === "down") mark = `<circle class="pulse" cx="${x}" cy="${y}" r="9" fill="var(--critical)"/><use href="#ic-critical" x="${x - 11}" y="${y - 11}" width="22" height="22"/>`;
      else mark = `<circle cx="${x}" cy="${y}" r="9" fill="var(--surface)"/><use href="#ic-${STATUS[status].icon}" x="${x - 11}" y="${y - 11}" width="22" height="22"/>`;
      const aria = s ? `${fullName(s)}: ${STATUS[status].label}` : short;
      parts.push(`<a href="#svc-${esc(id)}" class="station" data-id="${esc(id)}" aria-label="${esc(aria)}">` +
        `<circle class="hit" cx="${x}" cy="${y}" r="17"/>${mark}` +
        `<text class="lbl" x="${side ? x + 20 : x}" y="${side ? y - 8 : y - 15}" text-anchor="${side ? "start" : "middle"}">${esc(short)}</text></a>`);
    }
  }

  $("map").innerHTML = `<svg viewBox="0 0 ${MAP.width} ${MAP.height}" role="group" aria-label="Mapa da rede de APIs monitoradas">${parts.join("")}</svg>`;

  const svg = $("map").querySelector("svg");
  const tipFor = (el) => {
    if (el.classList.contains("station")) {
      const s = svc[el.dataset.id];
      if (!s) return "";
      const last = s.samples.at(-1) || [];
      const st = STATUS[current(s)];
      return `<b>${esc(fullName(s))}</b><br>${st.label}${last[2] != null ? ` · ${ms(last[2])}` : ""}` +
        `${last[4] ? `<br><span class="muted">${esc(reasonText(last[4]))}</span>` : ""}`;
    }
    return `<b>Baldeação ${esc(el.dataset.xfer)}</b><br>${esc(el.dataset.label)}`;
  };
  const show = (el) => {
    const html = tipFor(el);
    if (!html) return;
    const r = el.getBoundingClientRect();
    showTip(html, r.left + r.width / 2, r.top);
  };
  svg.querySelectorAll("a").forEach((el) => {
    el.addEventListener("pointerenter", () => show(el));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hideTip);
  });
  svg.querySelectorAll(".station").forEach((el) => el.addEventListener("click", (ev) => {
    ev.preventDefault();
    hideTip();
    openRow(el.dataset.id, true);
  }));
}

// -- services ------------------------------------------------------------

function renderServices(data, nowTs) {
  const days = lastDays(nowTs, DAYS);
  const root = $("services");
  const wasOpen = new Set([...root.querySelectorAll('.svc-btn[aria-expanded="true"]')].map((b) => b.closest(".row").dataset.id));
  root.innerHTML = "";
  let provider = null;
  for (const [id, s] of Object.entries(data.services)) {
    if (s.provider !== provider) {
      provider = s.provider;
      root.insertAdjacentHTML("beforeend", `<div class="group" role="heading" aria-level="3">${esc(provider)}</div>`);
    }
    root.appendChild(serviceRow(id, s, days, nowTs));
    if (wasOpen.has(id)) openRow(id, false);
  }
}

function serviceRow(id, s, days, nowTs) {
  const last = s.samples.at(-1);
  const status = last ? last[1] : "none";
  const up = uptime(totals(s.daily));
  const lat = latency24h(s, nowTs);
  const badDays = days.filter((d) => ["warning", "critical"].includes(dayTone(s.daily[d]))).length;

  const el = document.createElement("div");
  el.className = "row";
  el.id = `svc-${id}`;
  el.dataset.id = id;
  el.innerHTML = `
    <div class="row-main">
      <div><button class="svc-btn" type="button" aria-expanded="false" aria-controls="det-${esc(id)}">${icon("chevron", 16)}${esc(s.name)}</button></div>
      <div>${stateHTML(status, last && last[4])}</div>
      <div class="days" role="img" aria-label="${esc(`${fullName(s)}: ${pct(up)} de disponibilidade em 90 dias, ${badDays} ${badDays === 1 ? "dia" : "dias"} com problema`)}">${days.map((d) => `<span class="day ${dayTone(s.daily[d])}"></span>`).join("")}</div>
      <div class="figure num">${pct(up)} <small>disponível</small></div>
      <div class="figure num">${ms(lat)} <small>mediana 24 h</small></div>
    </div>
    <div class="detail" id="det-${esc(id)}" hidden></div>`;

  const btn = el.querySelector(".svc-btn");
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    const box = el.querySelector(".detail");
    box.hidden = !open;
    if (open && !box.childElementCount) box.appendChild(detail(s, nowTs));
  });

  const strip = el.querySelector(".days");
  const bars = [...strip.children];
  let lit = null;
  const onMove = (ev) => {
    const hit = bars.find((b) => {
      if (!b.offsetParent) return false;
      const r = b.getBoundingClientRect();
      return ev.clientX >= r.left - 1 && ev.clientX <= r.right + 1;
    });
    if (!hit) return;
    if (lit) lit.classList.remove("hl");
    lit = hit;
    hit.classList.add("hl");
    const d = days[bars.indexOf(hit)];
    const c = s.daily[d];
    const ok = c ? c.n - c.down : 0;
    const body = !c || !c.n
      ? '<span class="muted">sem verificações neste dia</span>'
      : `${pct(uptime(c))} disponível<br><span class="muted">${c.n} verificações · ${c.down} fora do ar · ${c.degraded} lentas${ok ? ` · média ${ms(Math.round(c.ms / ok))}` : ""}</span>`;
    const r = hit.getBoundingClientRect();
    showTip(`<b>${esc(dayLabel(d))}</b><br>${body}`, r.left + r.width / 2, r.top);
  };
  strip.addEventListener("pointermove", onMove);
  strip.addEventListener("pointerdown", onMove);
  strip.addEventListener("pointerleave", () => { if (lit) lit.classList.remove("hl"); lit = null; hideTip(); });
  return el;
}

function openRow(id, scroll) {
  const row = document.getElementById(`svc-${id}`);
  if (!row) return;
  const btn = row.querySelector(".svc-btn");
  if (btn.getAttribute("aria-expanded") !== "true") btn.click();
  if (scroll) {
    history.replaceState(null, "", `#svc-${id}`);
    row.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    btn.focus({ preventScroll: true });
  }
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function detail(s, nowTs) {
  const frag = document.createDocumentFragment();
  const W = 600, H = 110, PAD = 8;
  const start = nowTs - 48 * 3600;
  const rows = s.samples.filter((r) => r[0] >= start);
  const ok = rows.filter((r) => r[2] != null);
  const yMax = niceCeil(Math.max(s.slow_ms || 0, ...ok.map((r) => r[2]), 1));
  const x = (ts) => ((ts - start) / (nowTs - start)) * W;
  const y = (v) => H - PAD - (v / yMax) * (H - 2 * PAD);

  // The line breaks at outages instead of drawing across them.
  let path = "";
  let pen = false;
  for (const r of rows) {
    if (r[2] == null) { pen = false; continue; }
    path += `${pen ? "L" : "M"}${x(r[0]).toFixed(1)},${y(r[2]).toFixed(1)}`;
    pen = true;
  }
  const downs = rows.filter((r) => r[1] === "down")
    .map((r) => `<rect class="down" x="${(x(r[0]) - 1.5).toFixed(1)}" y="${H - PAD - 9}" width="3" height="9" rx="1"/>`).join("");
  const mid = yMax / 2;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="chart-head"><span>Latência nas últimas 48 h · ${ok.length} medições</span><span>grade em ${fmtInt.format(mid)} ms · topo em ${fmtInt.format(yMax)} ms</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Latência de ${fullName(s)} nas últimas 48 horas`)}">
      <line class="grid" x1="0" x2="${W}" y1="${y(mid)}" y2="${y(mid)}" vector-effect="non-scaling-stroke"/>
      <line class="base" x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" vector-effect="non-scaling-stroke"/>
      <path class="line" d="${path}" vector-effect="non-scaling-stroke"/>
      ${downs}
      <line class="cross" y1="0" y2="${H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
    </svg>
    <div class="chart-foot"><span>48 h atrás</span><span>agora</span></div>`;
  frag.appendChild(wrap);

  const svg = wrap.querySelector("svg");
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    if (!rows.length) return;
    const rect = svg.getBoundingClientRect();
    const ts = start + ((ev.clientX - rect.left) / rect.width) * (nowTs - start);
    const r = rows.reduce((a, b) => (Math.abs(b[0] - ts) < Math.abs(a[0] - ts) ? b : a));
    const px = x(r[0]);
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    const st = STATUS[r[1]] || STATUS.none;
    showTip(`<b>${esc(fmtDateTime.format(new Date(r[0] * 1000)))}</b><br>${r[2] == null ? "sem resposta" : ms(r[2])} · ${st.label}` +
      `${r[4] ? `<br><span class="muted">${esc(reasonText(r[4]))}</span>` : ""}`,
      rect.left + (px / W) * rect.width, rect.top + (r[2] == null ? H - PAD : y(r[2])) * (rect.height / H));
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });

  const inc = (s.incidents || []).slice(-5).reverse();
  const list = document.createElement("ul");
  list.className = "mini-log";
  list.innerHTML = inc.length
    ? inc.map((i) => `<li>${esc(fmtDateTime.format(new Date(i.start * 1000)))} · ${i.end ? `durou ${duration(i.end - i.start)}` : "<b>em andamento</b>"} · ${esc(i.reasons.map(reasonText).join(", "))}</li>`).join("")
    : "<li>Nenhuma queda registrada no histórico guardado.</li>";
  frag.appendChild(list);
  return frag;
}

// -- consistency ---------------------------------------------------------

function renderConsistency(data, nowTs) {
  const root = $("consistency");
  const items = Object.values(data.consistency || {});
  if (!items.length) {
    root.innerHTML = '<p class="empty-note">Nenhuma conferência registrada ainda. Ela roda junto com cada verificação.</p>';
    return;
  }
  root.innerHTML = items.map((c) => {
    let state;
    if (c.status === "consistent") state = `${icon("good")}${c.compared === 1 ? "As fontes concordam" : `Concordam nos ${c.compared} itens`}`;
    else if (c.status === "divergent") state = `${icon("warning")}${c.problems} ${c.problems === 1 ? "divergência" : "divergências"}${c.compared > 1 ? ` em ${c.compared} itens` : ""}`;
    else state = `${icon("empty")}Inconclusiva: uma fonte não respondeu`;

    const lines = (c.details || []).slice(0, 8).map((d) => {
      switch (d.kind) {
        case "mismatch":
          return `<li><code>${esc(d.key)}</code>, campo ${esc(d.field)}: ${esc(c.left)} diz <q>${esc(d.left ?? "vazio")}</q> e ${esc(c.right)} diz <q>${esc(d.right ?? "vazio")}</q></li>`;
        case "only_left": return `<li><code>${esc(d.key)}</code> existe na ${esc(c.left)}, mas a ${esc(c.right)} não encontra</li>`;
        case "only_right": return `<li><code>${esc(d.key)}</code> existe na ${esc(c.right)}, mas a ${esc(c.left)} não encontra</li>`;
        case "duplicate_left": case "duplicate_right":
          return `<li><code>${esc(d.key)}</code> aparece ${d.count} vezes na ${esc(d.kind === "duplicate_left" ? c.left : c.right)}</li>`;
        default: return `<li>${esc(d.reason || d.kind)}</li>`;
      }
    }).join("");

    const days = Object.values(c.daily || {});
    const sum = days.reduce((a, d) => ({ ok: a.ok + d.consistent, bad: a.bad + d.divergent }), { ok: 0, bad: 0 });
    const done = sum.ok + sum.bad;
    const rounds = `${fmtInt.format(done)} ${done === 1 ? "rodada" : "rodadas"}`;
    const hist = !done ? "" : sum.bad ? ` · divergiu em ${fmtInt.format(sum.bad)} de ${rounds}` : ` · nenhuma divergência em ${rounds}`;

    return `<div class="cmp-row" id="cmp-${esc(c.id)}">
      <div class="cmp-name">${esc(c.name)}<span class="cmp-desc">${esc(c.description)}</span></div>
      <div class="cmp-pair">${esc(c.left)} × ${esc(c.right)}</div>
      <div><span class="state">${state}</span><span class="state-why">conferido ${esc(ago(c.checked_at, nowTs))}${hist}</span></div>
      ${lines ? `<ul class="cmp-list">${lines}</ul>` : ""}
    </div>`;
  }).join("");
}

// -- incidents -----------------------------------------------------------

function renderIncidents(data) {
  const all = [];
  for (const s of Object.values(data.services)) for (const i of s.incidents || []) all.push({ ...i, s });
  all.sort((a, b) => (b.end == null) - (a.end == null) || b.start - a.start);
  const root = $("incidents");
  if (!all.length) {
    root.innerHTML = '<div class="rows"><p class="empty-note"><strong>Nenhuma queda registrada.</strong> Quando um serviço sai do ar, a queda aparece aqui com o horário de início, a duração e o motivo.</p></div>';
    return;
  }
  root.innerHTML = `<div class="rows"><ul class="log">${all.slice(0, 12).map((i) => `
    <li>${icon(i.end ? "empty" : "critical")}
      <div><div class="what">${esc(fullName(i.s))}</div><div class="why">${esc(i.reasons.map(reasonText).join(", "))} · ${i.checks} ${i.checks === 1 ? "verificação" : "verificações"}</div></div>
      <div class="when">${esc(fmtDateTime.format(new Date(i.start * 1000)))}<br>${i.end ? `durou ${duration(i.end - i.start)}` : "<b>em andamento</b>"}</div>
    </li>`).join("")}</ul></div>`;
}

// -- load ----------------------------------------------------------------

function showLoading() {
  $("services").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
}

function showError(message) {
  $("headline").innerHTML = `${icon("critical", 28)}<span class="hl-text">Não foi possível carregar os dados</span>`;
  $("facts").innerHTML = `${esc(message)} <button class="retry" type="button">Tentar de novo</button>`;
  $("facts").querySelector(".retry").addEventListener("click", load);
  $("updated").textContent = "";
}

let loadedOnce = false;

async function load() {
  let data;
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`O servidor respondeu HTTP ${res.status}.`);
    data = await res.json();
  } catch (err) {
    showError(err instanceof SyntaxError ? "O arquivo de dados veio corrompido." : err.message || "Falha de rede.");
    return;
  }
  const nowTs = Math.floor(Date.now() / 1000);
  const gen = data.generated_at;
  const upd = $("updated");
  if (gen) {
    const stale = nowTs - gen > STALE_AFTER_MIN * 60;
    upd.classList.toggle("stale", stale);
    upd.innerHTML = `Última verificação às <strong>${esc(fmtTime.format(new Date(gen * 1000)))}</strong>, ${esc(ago(gen, nowTs))}<br>` +
      (stale ? "o agendamento atrasou; os dados podem estar velhos" : "horário de Brasília");
  }
  renderHeadline(data, nowTs);
  renderMap(data);
  renderServices(data, nowTs);
  renderConsistency(data, nowTs);
  renderIncidents(data);
  if (!loadedOnce && location.hash.startsWith("#svc-")) openRow(location.hash.slice(5), true);
  loadedOnce = true;
}

showLoading();
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
window.addEventListener("scroll", hideTip, { passive: true });
