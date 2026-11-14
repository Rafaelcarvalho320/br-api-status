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
  up: { tone: "good", label: "Operando" },
  degraded: { tone: "warning", label: "Lento" },
  down: { tone: "critical", label: "Fora do ar" },
  none: { tone: "empty", label: "Sem dados" },
};
const TONE_ICON = { good: "check", warning: "alert", critical: "x", empty: "dash" };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (id) => document.getElementById(id);
const icon = (name, size = 16) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
const plural = (n, one, many) => `${fmtInt.format(n)} ${n === 1 ? one : many}`;

// -- theme ---------------------------------------------------------------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const effectiveTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");

function syncTheme() {
  const dark = effectiveTheme() === "dark";
  const btn = $("theme");
  btn.innerHTML = icon(dark ? "sun" : "moon", 17);
  btn.setAttribute("aria-label", dark ? "Usar tema claro" : "Usar tema escuro");
  document.querySelector('meta[name="theme-color"]').content = dark ? "#09090b" : "#fafafa";
}

$("theme").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* private mode: the choice lasts this visit */ }
  syncTheme();
});
darkQuery.addEventListener("change", syncTheme);
syncTheme();

const nav = document.querySelector(".nav");
const onScroll = () => { nav.classList.toggle("scrolled", scrollY > 8); hideTip(); };

// -- helpers -------------------------------------------------------------

function reasonText(reason) {
  if (!reason) return "";
  const [kind, ...rest] = reason.split(":");
  const detail = rest.join(":");
  switch (kind) {
    case "http": return `HTTP ${detail}`;
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
const ms = (v) => (v == null ? "—" : `${fmtInt.format(v)} ms`);

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function duration(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} dias`;
}

const ago = (ts, nowTs) => (nowTs - ts < 90 ? "agora há pouco" : `há ${duration(nowTs - ts)}`);
const current = (s) => (s.samples.at(-1) || [])[1] || "none";
const recentLatencies = (s, since) => s.samples.filter((r) => r[0] >= since && r[2] != null).map((r) => r[2]);
const fullName = (s) => (s.provider === s.name ? s.name : `${s.provider} · ${s.name}`);
const shortUrl = (url) => url.replace(/^https?:\/\//, "").replace("{year}", new Date().getFullYear());

// -- tooltip -------------------------------------------------------------

const tip = $("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
  const top = y - r.height - 10 < 8 ? y + 18 : y - r.height - 10;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.hidden = true; }

// -- hero ----------------------------------------------------------------

function renderHero(data, nowTs) {
  const services = Object.values(data.services);
  const down = services.filter((s) => current(s) === "down");
  const slow = services.filter((s) => current(s) === "degraded");
  const names = (list) => list.map(fullName).join(", ");

  let tone = "good";
  let title = "Todos os sistemas operando";
  let sub = `${services.length} endpoints responderam certo na última verificação.`;
  if (!services.length) {
    tone = "empty";
    title = "Nenhuma verificação registrada ainda";
    sub = "Os dados aparecem depois da primeira execução do monitor.";
  } else if (down.length === 1) {
    tone = "critical";
    const s = down[0];
    const open = (s.incidents || []).at(-1);
    title = `${fullName(s)} está fora do ar`;
    const why = reasonText((s.samples.at(-1) || [])[4]);
    sub = [why && `Motivo: ${why}`, open && open.end == null && `desde as ${fmtTime.format(new Date(open.start * 1000))}`].filter(Boolean).join(", ");
    const others = services.length - 1 - slow.length;
    sub = sub ? `${sub}. ${slow.length ? `Também lento: ${names(slow)}.` : `Os outros ${others} serviços respondem normalmente.`}` : "";
  } else if (down.length > 1) {
    tone = "critical";
    title = `${down.length} serviços fora do ar`;
    sub = names(down);
  } else if (slow.length) {
    tone = "warning";
    title = slow.length === 1 ? `${fullName(slow[0])} está lento` : `${slow.length} serviços lentos`;
    sub = slow.length === 1 ? reasonText((slow[0].samples.at(-1) || [])[4]) : names(slow);
  }
  if (down.length > 1 && slow.length) sub += `. Lento: ${names(slow)}`;

  document.body.dataset.state = tone;
  $("banner").className = `banner ${tone}`;
  $("banner-icon").innerHTML = icon(TONE_ICON[tone], 20);
  $("headline").textContent = title;
  $("headline-sub").textContent = sub;

  const all = { n: 0, up: 0, degraded: 0, down: 0, ms: 0 };
  for (const s of services) { const t = totals(s.daily); for (const k in all) all[k] += t[k]; }
  const lat = median(services.flatMap((s) => recentLatencies(s, nowTs - 86400)));
  const up = uptime(all);
  const cmp = Object.values(data.consistency || {});
  const divergent = cmp.filter((c) => c.status === "divergent").length;
  const working = services.length - down.length;
  const values = [
    up == null ? "—" : `${fmtPct.format(up)}<small>%</small>`,
    lat == null ? "—" : `${fmtInt.format(lat)}<small>ms</small>`,
    `${working}<small>/ ${services.length}</small>`,
    `${divergent}<small>/ ${cmp.length}</small>`,
  ];
  $("stats").querySelectorAll("dd").forEach((dd, i) => {
    dd.classList.remove("sk");
    dd.innerHTML = values[i];
  });
}

function renderUpdated(gen, nowTs) {
  const el = $("updated");
  if (!gen) { el.className = "live"; el.querySelector(".live-text").textContent = "Sem dados"; return; }
  const stale = nowTs - gen > STALE_AFTER_MIN * 60;
  el.className = `live ${stale ? "stale" : "ok"}`;
  el.title = `Última verificação: ${fmtDateTime.format(new Date(gen * 1000))} (horário de Brasília)`;
  el.querySelector(".live-text").textContent = stale
    ? `Dados atrasados, ${ago(gen, nowTs)}`
    : `Atualizado ${ago(gen, nowTs)}`;
}

// -- services ------------------------------------------------------------

function renderServices(data, nowTs) {
  const days = lastDays(nowTs, DAYS);
  const root = $("services");
  const wasOpen = new Set([...root.querySelectorAll(".svc.open")].map((el) => el.dataset.id));
  root.innerHTML = "";

  const groups = new Map();
  for (const [id, s] of Object.entries(data.services)) {
    if (!groups.has(s.provider)) groups.set(s.provider, []);
    groups.get(s.provider).push([id, s]);
  }
  for (const [provider, list] of groups) {
    const ok = list.filter(([, s]) => current(s) === "up").length;
    const worst = list.some(([, s]) => current(s) === "down") ? "critical" : ok === list.length ? "good" : "warning";
    root.insertAdjacentHTML("beforeend",
      `<div class="group" role="heading" aria-level="3"><span>${esc(provider)}</span>` +
      `<span class="group-meta"><span class="dot ${worst}"></span>${ok}/${list.length} operando</span></div>`);
    for (const [id, s] of list) {
      root.appendChild(serviceRow(id, s, days, nowTs));
      if (wasOpen.has(id)) toggleRow(id, true);
    }
  }
}

function serviceRow(id, s, days, nowTs) {
  const last = s.samples.at(-1);
  const status = last ? last[1] : "none";
  const st = STATUS[status] || STATUS.none;
  const up = uptime(totals(s.daily));
  const lat = median(recentLatencies(s, nowTs - 86400));
  const badDays = days.filter((d) => ["warning", "critical"].includes(dayTone(s.daily[d]))).length;
  const why = status !== "up" && status !== "none"
    ? `<span class="svc-why ${st.tone}">${st.label}${last[4] ? ` · ${esc(reasonText(last[4]))}` : ""}</span>` : "";

  const el = document.createElement("div");
  el.className = "svc";
  el.id = `svc-${id}`;
  el.dataset.id = id;
  el.innerHTML = `
    <div class="svc-head">
      <button class="svc-btn" type="button" aria-expanded="false" aria-controls="det-${esc(id)}">
        <span class="dot ${st.tone}${status === "down" ? " live-ping" : ""}" role="img" aria-label="${st.label}"></span>
        <span class="svc-name"><span class="svc-title">${esc(s.name)}</span>${why}</span>
      </button>
      <div class="bars" role="img" aria-label="${esc(`${fullName(s)}: ${pct(up)} de disponibilidade em 90 dias, ${plural(badDays, "dia", "dias")} com problema`)}">${days.map((d) => `<span class="bar ${dayTone(s.daily[d])}"></span>`).join("")}</div>
      <span class="num up">${pct(up)}</span>
      <span class="num lat">${ms(lat)}</span>
      <svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><use href="#ic-chevron"/></svg>
    </div>
    <div class="detail" id="det-${esc(id)}" hidden></div>`;

  el.querySelector(".svc-btn").addEventListener("click", () => toggleRow(id));

  const strip = el.querySelector(".bars");
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
      : `${pct(uptime(c))} disponível<br><span class="muted">${plural(c.n, "verificação", "verificações")} · ${c.down} fora do ar · ${c.degraded} lentas${ok ? ` · média ${ms(Math.round(c.ms / ok))}` : ""}</span>`;
    const r = hit.getBoundingClientRect();
    showTip(`<b>${esc(dayLabel(d))}</b><br>${body}`, r.left + r.width / 2, r.top);
  };
  strip.addEventListener("pointermove", onMove);
  strip.addEventListener("pointerdown", onMove);
  strip.addEventListener("pointerleave", () => { if (lit) lit.classList.remove("hl"); lit = null; hideTip(); });
  el._service = s;
  el._now = nowTs;
  return el;
}

function toggleRow(id, force) {
  const row = document.getElementById(`svc-${id}`);
  if (!row) return;
  const open = force ?? !row.classList.contains("open");
  row.classList.toggle("open", open);
  row.querySelector(".svc-btn").setAttribute("aria-expanded", String(open));
  const box = row.querySelector(".detail");
  box.hidden = !open;
  if (open && !box.childElementCount) box.appendChild(detail(id, row._service, row._now));
}

function openFromHash() {
  const id = location.hash.startsWith("#svc-") ? location.hash.slice(5) : null;
  if (!id || !document.getElementById(`svc-${id}`)) return;
  toggleRow(id, true);
  document.getElementById(`svc-${id}`).scrollIntoView({ block: "start" });
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function detail(id, s, nowTs) {
  const W = 600, H = 132, PAD = 10;
  const start = nowTs - 48 * 3600;
  const rows = s.samples.filter((r) => r[0] >= start);
  const ok = rows.filter((r) => r[2] != null);
  const yMax = niceCeil(Math.max(...ok.map((r) => r[2]), 200));
  const x = (ts) => ((ts - start) / (nowTs - start)) * W;
  const y = (v) => H - PAD - (v / yMax) * (H - 2 * PAD);
  const base = H - PAD;

  // The line breaks at outages instead of drawing across them.
  const runs = [];
  let run = [];
  for (const r of rows) {
    if (r[2] == null) { if (run.length) runs.push(run); run = []; continue; }
    run.push([x(r[0]), y(r[2])]);
  }
  if (run.length) runs.push(run);
  const pts = (list) => list.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L");
  const line = runs.map((r) => `M${pts(r)}`).join("");
  const area = runs.filter((r) => r.length > 1).map((r) => `M${r[0][0].toFixed(1)},${base}L${pts(r)}L${r.at(-1)[0].toFixed(1)},${base}Z`).join("");
  const lone = runs.filter((r) => r.length === 1).map(([[px, py]]) => `<circle class="pt" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3"/>`).join("");
  const downs = rows.filter((r) => r[1] === "down")
    .map((r) => `<rect class="down" x="${(x(r[0]) - 1.5).toFixed(1)}" y="${base - 10}" width="3" height="10" rx="1"/>`).join("");
  const values = ok.map((r) => r[2]);
  const last = s.samples.at(-1) || [];
  const st = STATUS[last[1]] || STATUS.none;
  const gid = `area-${id}`;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="detail-grid">
      <div class="panel">
        <div class="chart-head">
          <span>Latência nas últimas 48&nbsp;h · ${plural(ok.length, "medição", "medições")}</span>
          <span>mín <b class="num">${ms(values.length ? Math.min(...values) : null)}</b> · p50 <b class="num">${ms(median(values))}</b> · máx <b class="num">${ms(values.length ? Math.max(...values) : null)}</b></span>
        </div>
        <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Latência de ${fullName(s)} nas últimas 48 horas`)}">
          <defs><linearGradient id="${esc(gid)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="area-top"/><stop offset="1" class="area-bottom"/></linearGradient></defs>
          <line class="grid" x1="0" x2="${W}" y1="${y(yMax / 2)}" y2="${y(yMax / 2)}" vector-effect="non-scaling-stroke"/>
          <line class="base" x1="0" x2="${W}" y1="${base}" y2="${base}" vector-effect="non-scaling-stroke"/>
          <path d="${area}" fill="url(#${esc(gid)})"/>
          <path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
          ${lone}${downs}
          <line class="cross" y1="0" y2="${H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
        </svg>
        <div class="chart-foot"><span>48&nbsp;h atrás</span><span>grade em ${fmtInt.format(yMax / 2)}&nbsp;ms</span><span>agora</span></div>
      </div>
      <dl class="panel facts">
        <div><dt>Situação</dt><dd>${st.label}${last[4] ? ` · ${esc(reasonText(last[4]))}` : ""}</dd></div>
        <div><dt>Última verificação</dt><dd>${last[0] ? `${esc(fmtTime.format(new Date(last[0] * 1000)))}, ${esc(ago(last[0], nowTs))} · ${plural(last[3] || 1, "tentativa", "tentativas")}` : "—"}</dd></div>
        <div><dt>Requisição</dt><dd class="mono"><a href="${esc(s.url.replace("{year}", new Date().getFullYear()))}" rel="noopener">${esc(shortUrl(s.url))}</a></dd></div>
        <div><dt>Documentação</dt><dd><a class="ext" href="${esc(s.docs)}" rel="noopener">${esc(new URL(s.docs).hostname)}${icon("arrow", 14)}</a></dd></div>
      </dl>
    </div>`;

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
    const rs = STATUS[r[1]] || STATUS.none;
    showTip(`<b>${esc(fmtDateTime.format(new Date(r[0] * 1000)))}</b><br>${r[2] == null ? "sem resposta" : ms(r[2])} · ${rs.label}` +
      `${r[4] ? `<br><span class="muted">${esc(reasonText(r[4]))}</span>` : ""}`,
      rect.left + (px / W) * rect.width, rect.top + (r[2] == null ? base : y(r[2])) * (rect.height / H));
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });

  const inc = (s.incidents || []).slice(-5).reverse();
  const list = document.createElement("ul");
  list.className = "mini-log";
  list.innerHTML = inc.length
    ? inc.map((i) => `<li><span class="dot ${i.end ? "empty" : "critical"}"></span><span>${esc(fmtDateTime.format(new Date(i.start * 1000)))} · ${i.end ? `durou ${duration(i.end - i.start)}` : "em andamento"} · ${esc(i.reasons.map(reasonText).join(", "))}</span></li>`).join("")
    : '<li><span class="dot good"></span><span>Nenhuma queda no histórico guardado.</span></li>';
  wrap.appendChild(list);
  return wrap;
}

// -- consistency ---------------------------------------------------------

function renderConsistency(data, nowTs) {
  const root = $("consistency");
  const items = Object.values(data.consistency || {});
  if (!items.length) {
    root.innerHTML = '<div class="card empty-state">Nenhuma conferência registrada ainda. Ela roda junto com cada verificação.</div>';
    return;
  }
  root.innerHTML = items.map((c) => {
    let tone, badge;
    if (c.status === "consistent") { tone = "good"; badge = "Concordam"; }
    else if (c.status === "divergent") { tone = "warning"; badge = plural(c.problems, "divergência", "divergências"); }
    else { tone = "empty"; badge = "Inconclusiva"; }

    const lines = (c.details || []).slice(0, 6).map((d) => {
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

    const meter = c.compared
      ? `<div><div class="meter" role="img" aria-label="${esc(`${c.matched} de ${c.compared} itens iguais`)}">${Array.from({ length: c.compared }, (_, i) => `<span class="${i >= c.matched ? "bad" : ""}"></span>`).join("")}</div>
         <div class="meter-label"><span>${plural(c.compared, "item comparado", "itens comparados")}</span><span>${plural(c.matched, "igual", "iguais")}</span></div></div>`
      : `<p class="cmp-note">Sem comparação nesta rodada: uma das fontes não respondeu.</p>`;

    const days = Object.values(c.daily || {});
    const sum = days.reduce((a, d) => ({ ok: a.ok + d.consistent, bad: a.bad + d.divergent }), { ok: 0, bad: 0 });
    const done = sum.ok + sum.bad;
    const hist = !done ? "" : sum.bad ? ` · divergiu em ${fmtInt.format(sum.bad)} de ${plural(done, "rodada", "rodadas")}` : ` · nenhuma divergência em ${plural(done, "rodada", "rodadas")}`;

    return `<article class="cmp" id="cmp-${esc(c.id)}">
      <div class="cmp-top">
        <div><h3>${esc(c.name)}</h3><p class="cmp-desc">${esc(c.description)}</p></div>
        <span class="badge ${tone}">${icon(TONE_ICON[tone], 15)}${badge}</span>
      </div>
      <div class="pair" aria-label="${esc(`${c.left} comparada com ${c.right}`)}">
        <span class="src">${esc(c.left)}</span>
        <span class="wire ${tone}"><span class="node">${icon(TONE_ICON[tone], 16)}</span></span>
        <span class="src">${esc(c.right)}</span>
      </div>
      ${meter}
      ${lines ? `<ul class="cmp-list">${lines}</ul>` : ""}
      <div class="cmp-foot">Conferido ${esc(ago(c.checked_at, nowTs))}${hist}</div>
    </article>`;
  }).join("");
}

// -- incidents -----------------------------------------------------------

function renderIncidents(data, nowTs) {
  const all = [];
  for (const [id, s] of Object.entries(data.services)) for (const i of s.incidents || []) all.push({ ...i, id, s });
  all.sort((a, b) => (b.end == null) - (a.end == null) || b.start - a.start);
  const root = $("incidents");
  if (!all.length) {
    root.innerHTML = `<div class="card empty-state"><span class="banner-icon">${icon("check", 18)}</span><span><strong>Nenhuma queda registrada.</strong> Quando um serviço sai do ar, a queda aparece aqui com o início, a duração e o motivo.</span></div>`;
    return;
  }
  root.innerHTML = `<div class="card"><ol class="timeline">${all.slice(0, 12).map((i) => `
    <li>
      <span class="dot ${i.end ? "empty" : "critical"}"></span>
      <div><div class="tl-what"><a href="#svc-${esc(i.id)}" data-open="${esc(i.id)}">${esc(fullName(i.s))}</a></div>
        <div class="tl-why">${esc(i.reasons.map(reasonText).join(", "))} · ${plural(i.checks, "verificação", "verificações")}</div></div>
      <div class="tl-when">${i.end ? "" : "<b>Em andamento</b>"}${esc(fmtDateTime.format(new Date(i.start * 1000)))}${i.end ? ` · durou ${duration(i.end - i.start)}` : ` · ${esc(ago(i.start, nowTs))}`}</div>
    </li>`).join("")}</ol></div>`;
  root.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", () => toggleRow(a.dataset.open, true)));
}

// -- load ----------------------------------------------------------------

function showLoading() {
  $("services").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $("consistency").innerHTML = '<div class="skeleton tall"></div><div class="skeleton tall"></div>';
}

function showError(message) {
  document.body.dataset.state = "empty";
  $("banner").className = "banner empty";
  $("banner-icon").innerHTML = icon("dash", 20);
  $("headline").textContent = "Não foi possível carregar os dados";
  $("headline-sub").innerHTML = `${esc(message)} <button class="retry" type="button">Tentar de novo</button>`;
  $("headline-sub").querySelector(".retry").addEventListener("click", load);
  $("updated").className = "live";
  $("updated").querySelector(".live-text").textContent = "Sem conexão";
  if ($("services").querySelector(".skeleton")) {
    $("services").innerHTML = '<div class="empty-state">Os serviços aparecem aqui quando os dados carregarem.</div>';
    $("consistency").innerHTML = "";
  }
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
  renderUpdated(data.generated_at, nowTs);
  renderHero(data, nowTs);
  renderServices(data, nowTs);
  renderConsistency(data, nowTs);
  renderIncidents(data, nowTs);
  if (!loadedOnce) {
    document.querySelectorAll("main .card, .cmp").forEach((el, i) => {
      el.classList.add("reveal");
      el.style.animationDelay = `${Math.min(i, 6) * 50}ms`;
    });
    openFromHash();
  }
  loadedOnce = true;
}

showLoading();
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("hashchange", openFromHash);
onScroll();
