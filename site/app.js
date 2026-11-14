"use strict";

// Everything here reads data/status.json, written by `python -m brstatus`.
// No framework and no build step: the page has to stay as cheap to host as the
// monitor is to run.

const DATA_URL = "data/status.json";
const DAYS = 90;
const STALE_AFTER_MIN = 45;
const REFRESH_MS = 5 * 60 * 1000;
const TZ = "America/Sao_Paulo";

const fmtDay = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtTime = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtPct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat("pt-BR");

const ICONS = {
  good: '<svg class="icon icon-good" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg class="icon icon-warning" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7 12.6H1z" fill="currentColor"/><path d="M8 6v3.6" stroke="#0b0b0b" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".95" fill="#0b0b0b"/></svg>',
  critical: '<svg class="icon icon-critical" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.5 5.5l5 5m0-5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  empty: '<svg class="icon icon-empty" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>',
};

const STATUS = {
  up: { tone: "good", label: "Operacional" },
  degraded: { tone: "warning", label: "Lento" },
  down: { tone: "critical", label: "Fora do ar" },
  none: { tone: "empty", label: "Sem dados" },
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const $ = (id) => document.getElementById(id);

// -- helpers -------------------------------------------------------------

function reasonText(reason) {
  if (!reason) return "";
  const [kind, ...rest] = reason.split(":");
  const detail = rest.join(":");
  switch (kind) {
    case "http": return `erro HTTP ${detail}`;
    case "timeout": return "tempo esgotado (10 s)";
    case "network": return "falha de rede";
    case "json": return "resposta não é JSON";
    case "payload": return `conteúdo inválido (${detail})`;
    case "slow": return "resposta acima de 3 s";
    case "retried": return "respondeu só depois de nova tentativa";
    default: return reason;
  }
}

/** Brasilia calendar day (yyyy-mm-dd) for a unix timestamp, matching the backend. */
function dayKey(ts) {
  return new Date((ts - 3 * 3600) * 1000).toISOString().slice(0, 10);
}

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
  const usable = (c.up + c.degraded) / c.n;
  if (c.down === 0 && c.degraded / c.n < 0.25) return "good";
  return usable >= 0.95 ? "warning" : "critical";
}

function totals(daily) {
  const t = { n: 0, up: 0, degraded: 0, down: 0, ms: 0 };
  for (const c of Object.values(daily || {})) for (const k in t) t[k] += c[k] || 0;
  return t;
}

const uptime = (t) => (t.n ? ((t.up + t.degraded) / t.n) * 100 : null);

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

function ago(ts, nowTs) {
  const s = Math.max(0, nowTs - ts);
  if (s < 90) return "agora há pouco";
  return `há ${duration(s)}`;
}

function pill(status) {
  const s = STATUS[status] || STATUS.none;
  return `<span class="pill">${ICONS[s.tone]}${s.label}</span>`;
}

// -- tooltip -------------------------------------------------------------

const tip = $("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.hidden = true; }

// -- sections ------------------------------------------------------------

function renderSummary(data, nowTs) {
  const services = Object.values(data.services);
  const current = services.map((s) => (s.samples.at(-1) || [])[1] || "none");
  const down = current.filter((s) => s === "down").length;
  const slow = current.filter((s) => s === "degraded").length;

  let tone = "good";
  let text = "Todos os serviços estão respondendo normalmente";
  if (down) {
    tone = "critical";
    text = down === 1 ? "1 serviço está fora do ar" : `${down} serviços estão fora do ar`;
    if (slow) text += ` e ${slow} ${slow === 1 ? "está lento" : "estão lentos"}`;
  } else if (slow) {
    tone = "warning";
    text = slow === 1 ? "1 serviço está lento" : `${slow} serviços estão lentos`;
  }
  if (!services.length) { tone = "empty"; text = "Ainda não há verificações registradas"; }

  const all = { n: 0, up: 0, degraded: 0, down: 0, ms: 0 };
  for (const s of services) { const t = totals(s.daily); for (const k in all) all[k] += t[k]; }
  const up90 = uptime(all);
  const dayAgo = nowTs - 86400;
  const lat = median(services.flatMap((s) => s.samples.filter((r) => r[0] >= dayAgo && r[2] != null).map((r) => r[2])));
  const cmp = Object.values(data.consistency || {});
  const divergent = cmp.filter((c) => c.status === "divergent").length;

  $("summary").innerHTML = `
    <div class="banner">${ICONS[tone]}<span>${esc(text)}</span></div>
    <div class="tile"><div class="label">Disponibilidade média</div><div class="value">${up90 == null ? "—" : fmtPct.format(up90) + "%"}</div><div class="sub">${fmtInt.format(all.n)} verificações em até 90 dias</div></div>
    <div class="tile"><div class="label">Latência mediana</div><div class="value">${lat == null ? "—" : fmtInt.format(lat) + " ms"}</div><div class="sub">últimas 24 h, todos os serviços</div></div>
    <div class="tile"><div class="label">Fontes que discordam</div><div class="value">${fmtInt.format(divergent)} <span style="font-size:15px;font-weight:500;color:var(--text-2)">de ${cmp.length}</span></div><div class="sub">na última comparação</div></div>`;
}

function renderServices(data, nowTs) {
  const days = lastDays(nowTs, DAYS);
  const groups = new Map();
  for (const [id, s] of Object.entries(data.services)) {
    if (!groups.has(s.provider)) groups.set(s.provider, []);
    groups.get(s.provider).push([id, s]);
  }

  const root = $("services");
  root.innerHTML = "";
  for (const [provider, items] of groups) {
    root.insertAdjacentHTML("beforeend", `<h3 class="provider">${esc(provider)}</h3>`);
    for (const [id, s] of items) root.appendChild(serviceCard(id, s, days, nowTs));
  }
}

function serviceCard(id, s, days, nowTs) {
  const last = s.samples.at(-1);
  const status = last ? last[1] : "none";
  const t = totals(s.daily);
  const up = uptime(t);
  const lat = median(s.samples.filter((r) => r[0] >= nowTs - 86400 && r[2] != null).map((r) => r[2]));
  const badDays = days.filter((d) => ["warning", "critical"].includes(dayTone(s.daily[d]))).length;

  const el = document.createElement("article");
  el.className = "svc";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="svc-top">
      <div class="svc-name"><h3>${esc(s.name)}</h3><a href="${esc(s.docs)}" rel="noopener">docs</a></div>
      <div class="svc-stats">
        <span><b>${up == null ? "—" : fmtPct.format(up) + "%"}</b> disponível</span>
        <span><b>${lat == null ? "—" : fmtInt.format(lat) + " ms"}</b> mediana 24 h</span>
        ${pill(status)}
      </div>
    </div>
    <div class="days" role="img" aria-label="${esc(`${s.provider} ${s.name}: ${up == null ? "sem dados" : fmtPct.format(up) + "% de disponibilidade"} em 90 dias, ${badDays} dias com problema`)}">
      ${days.map((d) => `<span class="day ${dayTone(s.daily[d])}"></span>`).join("")}
    </div>
    <div class="axis-row"><span class="long">90 dias atrás</span><span class="short">30 dias atrás</span><span>hoje</span></div>
    <details class="more"><summary>Latência e incidentes</summary><div class="detail"></div></details>`;

  if (last && last[1] !== "up" && last[4]) {
    el.querySelector(".svc-name").insertAdjacentHTML("beforeend", `<span class="why" style="color:var(--text-2);font-size:13px">${esc(reasonText(last[4]))}</span>`);
  }

  const strip = el.querySelector(".days");
  const bars = [...strip.children];
  let lit = null;
  const onMove = (ev) => {
    const visible = bars.filter((b) => b.offsetParent !== null);
    const hit = visible.find((b) => { const r = b.getBoundingClientRect(); return ev.clientX >= r.left - 1 && ev.clientX <= r.right + 1; });
    if (!hit) return;
    if (lit) lit.classList.remove("hl");
    lit = hit; hit.classList.add("hl");
    const d = days[bars.indexOf(hit)];
    const c = s.daily[d];
    const body = !c || !c.n
      ? '<span class="muted">sem verificações</span>'
      : `${fmtPct.format(uptime(c))}% disponível<br><span class="muted">${c.n} verificações · ${c.down} fora · ${c.degraded} lentas${c.n - c.down ? ` · média ${fmtInt.format(Math.round(c.ms / (c.n - c.down)))} ms` : ""}</span>`;
    const r = hit.getBoundingClientRect();
    showTip(`<b>${esc(dayLabel(d))}</b><br>${body}`, r.left + r.width / 2, r.top);
  };
  const onLeave = () => { if (lit) lit.classList.remove("hl"); lit = null; hideTip(); };
  strip.addEventListener("pointermove", onMove);
  strip.addEventListener("pointerdown", onMove);
  strip.addEventListener("pointerleave", onLeave);

  el.querySelector("details").addEventListener("toggle", (ev) => {
    const box = el.querySelector(".detail");
    if (ev.target.open && !box.childElementCount) box.appendChild(detail(s, nowTs));
  });
  return el;
}

function detail(s, nowTs) {
  const frag = document.createDocumentFragment();
  const W = 600, H = 90, PAD = 6;
  const start = nowTs - 48 * 3600;
  const rows = s.samples.filter((r) => r[0] >= start);
  const ok = rows.filter((r) => r[2] != null);
  const max = Math.max(s.slow_ms || 0, ...ok.map((r) => r[2]), 1);
  const yMax = niceCeil(max);
  const x = (ts) => ((ts - start) / (nowTs - start)) * W;
  const y = (ms) => H - PAD - (ms / yMax) * (H - 2 * PAD);

  // Break the line at outages instead of drawing across them.
  let path = "";
  let pen = false;
  for (const r of rows) {
    if (r[2] == null) { pen = false; continue; }
    path += `${pen ? "L" : "M"}${x(r[0]).toFixed(1)},${y(r[2]).toFixed(1)}`;
    pen = true;
  }
  const downs = rows.filter((r) => r[1] === "down").map((r) => `<rect class="down" x="${(x(r[0]) - 1.5).toFixed(1)}" y="${H - 8}" width="3" height="8" rx="1"/>`).join("");
  const mid = yMax / 2;

  const wrap = document.createElement("div");
  wrap.className = "spark-wrap";
  wrap.innerHTML = `
    <div class="spark-labels"><span>Latência nas últimas 48 h (ms)</span><span>máx. da escala ${fmtInt.format(yMax)} ms</span></div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Latência de ${s.provider} ${s.name} nas últimas 48 horas, ${ok.length} medições`)}">
      <line class="grid" x1="0" x2="${W}" y1="${y(mid)}" y2="${y(mid)}" vector-effect="non-scaling-stroke"/>
      <line class="base" x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" vector-effect="non-scaling-stroke"/>
      <path class="line" d="${path}" vector-effect="non-scaling-stroke"/>
      ${downs}
      <line class="cross" y1="0" y2="${H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
    </svg>
    <div class="spark-labels"><span>48 h atrás</span><span>agora</span></div>`;
  frag.appendChild(wrap);

  const svg = wrap.querySelector("svg");
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    if (!rows.length) return;
    const rect = svg.getBoundingClientRect();
    const ts = start + ((ev.clientX - rect.left) / rect.width) * (nowTs - start);
    const r = rows.reduce((a, b) => (Math.abs(b[0] - ts) < Math.abs(a[0] - ts) ? b : a));
    const px = x(r[0]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    const st = STATUS[r[1]] || STATUS.none;
    const val = r[2] == null ? "sem resposta" : `${fmtInt.format(r[2])} ms`;
    showTip(`<b>${esc(fmtDateTime.format(new Date(r[0] * 1000)))}</b><br>${val} · ${st.label}${r[4] ? `<br><span class="muted">${esc(reasonText(r[4]))}</span>` : ""}`,
      rect.left + (px / W) * rect.width, rect.top + (r[2] == null ? H - 8 : y(r[2])) * (rect.height / H));
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });

  const inc = (s.incidents || []).slice(-5).reverse();
  const list = document.createElement("ul");
  list.className = "svc-incidents";
  list.innerHTML = inc.length
    ? inc.map((i) => `<li>${esc(fmtDateTime.format(new Date(i.start * 1000)))} · ${i.end ? `durou ${duration(i.end - i.start)}` : "<b>em andamento</b>"} · ${esc(i.reasons.map(reasonText).join(", "))}</li>`).join("")
    : "<li>Nenhum incidente registrado.</li>";
  frag.appendChild(list);
  return frag;
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function renderConsistency(data, nowTs) {
  const root = $("consistency");
  const items = Object.values(data.consistency || {});
  if (!items.length) { root.innerHTML = '<div class="empty-state">Nenhuma comparação registrada ainda.</div>'; return; }

  root.innerHTML = items.map((c) => {
    let tone, head;
    if (c.status === "consistent") { tone = "good"; head = `Concordam em ${c.matched} de ${c.compared}`; }
    else if (c.status === "divergent") { tone = "warning"; head = `${c.problems} ${c.problems === 1 ? "divergência" : "divergências"} em ${c.compared}`; }
    else { tone = "empty"; head = "Inconclusivo: uma das fontes não respondeu"; }

    const lines = (c.details || []).slice(0, 8).map((d) => {
      switch (d.kind) {
        case "mismatch":
          return `<li><code>${esc(d.key)}</code> · ${esc(d.field)}: ${esc(c.left)} diz <span class="q">“${esc(d.left ?? "vazio")}”</span>, ${esc(c.right)} diz <span class="q">“${esc(d.right ?? "vazio")}”</span></li>`;
        case "only_left": return `<li><code>${esc(d.key)}</code> existe na ${esc(c.left)}, mas a ${esc(c.right)} não encontra</li>`;
        case "only_right": return `<li><code>${esc(d.key)}</code> existe na ${esc(c.right)}, mas a ${esc(c.left)} não encontra</li>`;
        case "duplicate_left": case "duplicate_right":
          return `<li><code>${esc(d.key)}</code> aparece ${d.count}× na ${esc(d.kind === "duplicate_left" ? c.left : c.right)}</li>`;
        default: return `<li>${esc(d.reason || d.kind)}</li>`;
      }
    }).join("");

    const days = Object.values(c.daily || {});
    const sum = days.reduce((a, d) => ({ ok: a.ok + d.consistent, bad: a.bad + d.divergent }), { ok: 0, bad: 0 });
    const done = sum.ok + sum.bad;
    const tally = done ? `Histórico: ${fmtInt.format(sum.ok)} de ${fmtInt.format(done)} ${done === 1 ? "comparação concluída" : "comparações concluídas"} sem divergência (${days.length} ${days.length === 1 ? "dia" : "dias"})` : "";

    return `<article class="cmp">
      <h3>${esc(c.name)}</h3>
      <p class="pair">${esc(c.left)} × ${esc(c.right)}</p>
      <span class="pill">${ICONS[tone]}${esc(head)}</span>
      ${lines ? `<ul>${lines}</ul>` : ""}
      <p class="desc">${esc(c.description)} · verificado ${esc(ago(c.checked_at, nowTs))}</p>
      ${tally ? `<p class="tally">${tally}</p>` : ""}
    </article>`;
  }).join("");
}

function renderIncidents(data) {
  const all = [];
  for (const s of Object.values(data.services)) for (const i of s.incidents || []) all.push({ ...i, s });
  all.sort((a, b) => (b.end == null) - (a.end == null) || b.start - a.start);
  const root = $("incidents");
  if (!all.length) { root.innerHTML = '<div class="empty-state">Nenhum incidente registrado. Os incidentes aparecem aqui quando um serviço fica fora do ar.</div>'; return; }
  root.innerHTML = `<ul class="inc-list">${all.slice(0, 12).map((i) => `
    <li>${ICONS[i.end ? "empty" : "critical"]}
      <div><div class="what">${esc(i.s.provider)} · ${esc(i.s.name)}</div><div class="why">${esc(i.reasons.map(reasonText).join(", "))} · ${i.checks} ${i.checks === 1 ? "verificação" : "verificações"}</div></div>
      <div class="when">${esc(fmtDateTime.format(new Date(i.start * 1000)))}<br>${i.end ? `durou ${duration(i.end - i.start)}` : "<b>em andamento</b>"}</div>
    </li>`).join("")}</ul>`;
}

// -- load ----------------------------------------------------------------

async function load() {
  let data;
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    $("updated").textContent = `Não foi possível carregar os dados (${err.message}). Tente recarregar a página.`;
    return;
  }
  const nowTs = Math.floor(Date.now() / 1000);
  const gen = data.generated_at;
  const upd = $("updated");
  if (gen) {
    const stale = nowTs - gen > STALE_AFTER_MIN * 60;
    upd.classList.toggle("stale", stale);
    upd.textContent = `Última verificação ${ago(gen, nowTs)} (${fmtTime.format(new Date(gen * 1000))}, horário de Brasília)` +
      (stale ? ". O agendamento atrasou; os dados podem estar desatualizados." : "");
  }
  const open = new Set([...document.querySelectorAll("details.more[open]")].map((d) => d.closest(".svc")?.dataset.id));
  renderSummary(data, nowTs);
  renderServices(data, nowTs);
  renderConsistency(data, nowTs);
  renderIncidents(data);
  document.querySelectorAll(".svc").forEach((el) => {
    if (open.has(el.dataset.id)) el.querySelector("details").open = true;
  });
}

load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
window.addEventListener("scroll", hideTip, { passive: true });
