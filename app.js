// The phone page (docs/MOBILE.md): open a snapshot file from the Syncthing folder, unlock it, show it.
// The encrypted file is kept in IndexedDB so the page opens without picking it again; the key only if asked.
import {
  daysBetween, decrypt, deriveKey, firstBreach, isoToday, lowFrom, money, monthName, niceTicks, parseEnvelope, pct,
  shortDate, shortMoney, spare, upcoming,
} from "./core.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STALE_DAYS = 10;

// ----- storage -----
const db = new Promise((resolve, reject) => {
  const r = indexedDB.open("finance-phone", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function store(mode, fn) {
  const tx = (await db).transaction("kv", mode);
  const req = fn(tx.objectStore("kv"));
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); });
}
const get = (k) => store("readonly", (s) => s.get(k));
const put = (k, v) => store("readwrite", (s) => s.put(v, k));
const del = (k) => store("readwrite", (s) => s.delete(k));

// ----- unlocking -----
let env = null, data = null, view = "today";

function show(screen) {
  for (const id of ["open", "unlock", "main"]) $("#" + id).hidden = id !== screen;
}

async function start() {
  const text = await get("envelope");
  if (!text) return show("open");
  env = parseEnvelope(text);
  const kept = await get("key");
  if (kept && kept.salt === env.salt && kept.iterations === env.iterations) {
    try { data = await decrypt(env, kept.key); return render(); } catch { /* passphrase changed: ask again */ }
  }
  askPassphrase();
}

function askPassphrase(message = "") {
  $("#unlock-error").textContent = message;
  $("#passphrase").value = "";
  show("unlock");
  $("#passphrase").focus();
}

async function openFile(file) {
  try {
    const text = await file.text();
    parseEnvelope(text);
    await put("envelope", text);
    await start();
  } catch (e) {
    alert(e.message);
  }
}

async function unlock(event) {
  event.preventDefault();
  const button = $("#unlock button");
  button.disabled = true;
  button.textContent = "Unlocking…";
  try {
    const key = await deriveKey($("#passphrase").value, env);
    data = await decrypt(env, key);
    if ($("#remember").checked) await put("key", { key, salt: env.salt, iterations: env.iterations });
    render();
  } catch (e) {
    askPassphrase(e.message);
  } finally {
    button.disabled = false;
    button.textContent = "Unlock";
  }
}

async function lock() {
  data = null;
  await del("key");
  askPassphrase();
}

// ----- rendering -----
function render() {
  show("main");
  $("#title").textContent = data.app_name || "Finance";
  for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-current", b.dataset.view === view);
  const body = $("#view");
  body.innerHTML = "";
  ({ today: renderToday, forecast: renderForecast, wealth: renderWealth, months: renderMonths })[view](body);
  window.scrollTo(0, 0);
}

function card(parent, html, cls = "") {
  const el = document.createElement("section");
  el.className = "card " + cls;
  el.innerHTML = html;
  parent.append(el);
  return el;
}

function freshness(parent) {
  const today = isoToday(), cash = data.cash;
  const generated = data.generated.replace("T", " ");
  const age = cash ? daysBetween(cash.as_of, today) : 0;
  const stale = age > STALE_DAYS;
  card(parent, `<p>${stale ? '<span class="icon" aria-hidden="true">▲</span> ' : ""}` +
    (cash ? `Balances as of <b>${shortDate(cash.as_of)}</b>${stale ? ` (${age} days ago)` : ""}. ` : "") +
    `Exported ${esc(shortDate(generated.slice(0, 10)))} at ${esc(generated.slice(11, 16))}.` +
    (stale ? " Import new statements on the computer for a closer forecast." : "") + "</p>",
    "note" + (stale ? " warn" : ""));
}

function renderToday(body) {
  freshness(body);
  const close = data.close, left = close.steps.filter((s) => !s.done);
  if (left.length) {
    card(body, `<p><b>Closing ${esc(close.label)}:</b> ${left.length} of ${close.steps.length} steps left. ` +
      `Next: <b>${esc(left[0].title)}</b>, ${esc(left[0].detail.charAt(0).toLowerCase() + left[0].detail.slice(1))}.</p>`, "note");
  }
  const cash = data.cash, today = isoToday();
  const s = cash && spare(cash, today);
  if (!s) {
    card(body, "<h2>Spare cash</h2><p class='muted'>No forecast covers today. Export again from the computer.</p>");
    return;
  }
  const minText = cash.min_cents ? `your ${shortMoney(cash.min_cents)} minimum` : "zero";
  card(body, s.cents >= 0
    ? `<h2>Spare cash</h2><div class="hero">${money(s.cents)}</div>
       <p class="muted">You could spend this today and stay above ${minText} through ${shortDate(cash.end, true)}.
       Lowest point: ${money(s.low[1])} on ${shortDate(s.low[0])}.</p>`
    : `<h2>Spare cash</h2><div class="hero critical"><span class="icon" aria-hidden="true">▲</span> ${money(s.cents)}</div>
       <p class="muted">The forecast drops ${money(-s.cents)} below ${minText}, lowest on ${shortDate(s.low[0])}
       (${money(s.low[1])}).</p>`);

  const whatIf = card(body, `<h2>What if I spend…</h2>
    <form class="row"><label>Amount<input id="wi-amount" inputmode="decimal" placeholder="$0"></label>
    <label>On<input id="wi-date" type="date" value="${today}" min="${today}" max="${cash.end}"></label></form>
    <p id="wi-result" class="muted">Type an amount to see the new low point.</p>`);
  const update = () => {
    const cents = Math.round(parseFloat($("#wi-amount").value.replace(/[$,\s]/g, "")) * 100);
    const day = $("#wi-date").value || today;
    if (!(cents > 0)) return void ($("#wi-result").textContent = "Type an amount to see the new low point.");
    const low = lowFrom(cash, today, cents, day), breach = firstBreach(cash, today, cents, day);
    $("#wi-result").innerHTML = breach
      ? `<span class="critical"><span class="icon" aria-hidden="true">▲</span> Drops below ${minText} on ${shortDate(breach)}.</span> Lowest ${money(low[1])} on ${shortDate(low[0])}.`
      : `<span class="good"><span class="icon" aria-hidden="true">✓</span> Stays above ${minText}.</span> Lowest ${money(low[1])} on ${shortDate(low[0])}.`;
  };
  whatIf.addEventListener("input", update);
  whatIf.querySelector("form").addEventListener("submit", (e) => e.preventDefault());

  const next = upcoming(cash, today);
  card(body, `<h2>Next 14 days</h2>` + (next.length ? eventList(next) : "<p class='muted'>Nothing expected.</p>"));
}

function eventList(events) {
  return `<ul class="list">${events.map((e) => `<li><span class="date">${shortDate(e.date)}</span>
    <span class="name">${esc(e.name)}${e.note ? `<small>${esc(e.note)}</small>` : ""}</span>
    <span class="amt ${e.cents > 0 ? "in" : "out"}">${money(e.cents, true)}<small>${money(e.balance_cents)}</small></span></li>`).join("")}</ul>`;
}

function renderForecast(body) {
  const cash = data.cash;
  if (!cash) return void card(body, "<p class='muted'>No checking or savings balance yet.</p>");
  const today = isoToday();
  const c = card(body, `<h2>Checking + savings</h2><p class="muted">Forecast from ${shortDate(cash.as_of)} to ${shortDate(cash.end, true)}.</p><div class="chart"></div>`);
  lineChart(c.querySelector(".chart"), cash.daily, { min: cash.min_cents, marker: today, height: 220 });
  const byMonth = new Map();
  for (const e of cash.events.filter((e) => e.date >= cash.as_of)) {
    const k = e.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(e);
  }
  for (const [k, events] of byMonth) card(body, `<h2>${monthName(k)} ${k.slice(0, 4)}</h2>${eventList(events)}`);
}

function renderWealth(body) {
  const nw = data.net_worth, fi = data.fi;
  if (!nw) return void card(body, "<p class='muted'>No balances yet.</p>");
  const h = nw.history, before = h.length > 1 ? h[h.length - 2] : null;
  const delta = before ? nw.total_cents - before.total_cents : null;
  const c = card(body, `<h2>Net worth on ${shortDate(nw.on)}</h2><div class="hero">${money(nw.total_cents)}</div>
    <p class="muted">${delta == null ? "" : `${delta >= 0 ? "▲" : "▼"} ${money(Math.abs(delta))} since ${shortDate(before.on)}. `}
    Liquid ${shortMoney(nw.liquid_cents)}.</p><div class="chart"></div>`);
  if (h.length > 1) lineChart(c.querySelector(".chart"), h.map((s) => [s.on, s.total_cents]), { height: 120 });

  if (fi) {
    const marks = fi.milestones.map(([n, cents]) =>
      `<div class="mark" style="left:${Math.min(100, (cents / fi.target_cents) * 100)}%"><span>${esc(n)}</span></div>`).join("");
    const when = fi.years == null ? "" : fi.years <= 0 ? " Reached." : ` About ${fi.years.toFixed(1)} years at your current saving.`;
    card(body, `<h2>Financial independence</h2><div class="hero">${pct(fi.percent)}</div>
      <p class="muted">of ${shortMoney(fi.target_cents)}${fi.target_from === "fixed" ? " (fixed target)" : ""}.${when}</p>
      <div class="progress" role="img" aria-label="${pct(fi.percent)} of the target"><div style="width:${Math.min(100, fi.percent * 100)}%"></div>${marks}</div>`);
  }

  const groups = new Map();
  for (const a of nw.accounts) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  for (const [g, accounts] of groups) {
    const total = accounts.reduce((t, a) => t + a.cents, 0);
    card(body, `<h2>${esc(g)} <span class="right">${money(total)}</span></h2><ul class="list">${accounts.map((a) =>
      `<li><span class="name">${esc(a.name)}<small>${esc(a.owner || "")}${a.carried ? " · not updated this month" : ` · ${shortDate(a.as_of)}`}</small></span>
       <span class="amt">${money(a.cents)}</span></li>`).join("")}</ul>`);
  }
}

const WINDOW = 6;            // months in the chart and the list, ending at the chosen one
let monthIdx = null;         // the chosen month (index into data.months); null = the latest
let monthFirst = null;       // the first month in the chart

function renderMonths(body) {
  const months = data.months;
  if (!months.length) return void card(body, "<p class='muted'>No closed months with transactions yet.</p>");
  if (monthIdx === null || monthIdx >= months.length) monthIdx = months.length - 1;
  const m = months[monthIdx], budget = data.budget_cents;
  const label = (x) => `${monthName(x.month)} ${x.month.slice(0, 4)}`;
  const detail = card(body, `<div class="picker">
      <button type="button" class="button small" data-step="-1" aria-label="Earlier month" ${monthIdx === 0 ? "disabled" : ""}>‹</button>
      <h2>${label(m)}</h2>
      <button type="button" class="button small" data-step="1" aria-label="Later month" ${monthIdx === months.length - 1 ? "disabled" : ""}>›</button></div>
    <ul class="list">
    <li><span class="name">Income</span><span class="amt">${money(m.income_cents)}</span></li>
    <li><span class="name">Expenses${budget ? `<small>of ${money(budget)} budget: ${money(Math.abs(budget - m.expense_cents))} ${budget >= m.expense_cents ? "under" : "over"}</small>` : ""}</span><span class="amt">${money(m.expense_cents)}</span></li>
    <li><span class="name">Investments</span><span class="amt">${money(m.investments_cents)}</span></li>
    <li><span class="name">Taxes</span><span class="amt">${money(m.taxes_cents)}</span></li>
    <li><span class="name">Savings rate</span><span class="amt">${pct(m.savings_rate, 1)}</span></li></ul>`);
  detail.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => pickMonth(monthIdx + Number(b.dataset.step))));

  // The window stays put while the chosen month is inside it, and slides just enough when it isn't.
  if (monthFirst === null || monthIdx < monthFirst || monthIdx >= monthFirst + WINDOW) {
    monthFirst = monthFirst !== null && monthIdx < monthFirst ? monthIdx : monthIdx - WINDOW + 1;
  }
  const first = monthFirst = Math.max(0, Math.min(monthFirst, months.length - WINDOW));
  const shown = months.slice(first, first + WINDOW);
  const c = card(body, `<h2>Income vs expenses</h2>
    <div class="legend"><span><i class="sw income"></i>Income</span><span><i class="sw expense"></i>Expenses</span><span class="muted">Tap a month</span></div><div class="chart"></div>`);
  pairedBars(c.querySelector(".chart"), shown, monthIdx - first, (i) => pickMonth(first + i));
  const list = card(body, `<h2>By month</h2><ul class="list">${shown.map((x, i) => [x, first + i]).reverse().map(([x, i]) =>
    `<li data-i="${i}" class="pick${i === monthIdx ? " chosen" : ""}"><span class="name">${label(x)}<small>Savings rate ${pct(x.savings_rate, 1)}</small></span>
     <span class="amt">${money(x.income_cents)}<small>${money(x.expense_cents)} spent</small></span></li>`).join("")}</ul>`);
  list.querySelectorAll("[data-i]").forEach((li) => li.addEventListener("click", () => pickMonth(Number(li.dataset.i))));
}

function pickMonth(i) {
  monthIdx = Math.max(0, Math.min(data.months.length - 1, i));
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

// ----- charts (docs/UI_REDESIGN.md conventions: 2px lines, recessive grid, crosshair on touch) -----
const SVG = "http://www.w3.org/2000/svg";

function tooltip(container) {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  container.append(tip);
  return tip;
}

function lineChart(container, points, { min = null, marker = null, height = 200 } = {}) {
  const w = container.clientWidth || 320, pad = { l: 44, r: 8, t: 8, b: 22 };
  const vals = points.map((p) => p[1]).concat(min == null ? [] : [min]);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  let svg = `<svg width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img" aria-label="Line chart">`;
  for (const t of ticks) svg += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${shortMoney(t * 1)}</text>`;
  let lastMonth = null, lastX = -99;
  points.forEach(([d], i) => {
    const m = d.slice(0, 7);
    if (m !== lastMonth && x(i) - lastX > 34) {
      svg += `<text class="axis" x="${x(i)}" y="${height - 6}" text-anchor="middle">${monthName(m)}</text>`;
      lastX = x(i);
    }
    lastMonth = m;
  });
  if (min != null) svg += `<line class="min" x1="${pad.l}" x2="${w - pad.r}" y1="${y(min)}" y2="${y(min)}"/><text class="axis" x="${w - pad.r}" y="${y(min) - 4}" text-anchor="end">Minimum</text>`;
  const mi = marker ? points.findIndex((p) => p[0] >= marker) : -1;
  if (mi > 0) svg += `<line class="marker" x1="${x(mi)}" x2="${x(mi)}" y1="${pad.t}" y2="${height - pad.b}"/><text class="axis" x="${x(mi) + 4}" y="${pad.t + 10}">Today</text>`;
  svg += `<path class="line" d="${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")}"/>`;
  svg += `<line class="cross" style="display:none" y1="${pad.t}" y2="${height - pad.b}"/><circle class="dot" r="4" style="display:none"/></svg>`;
  container.innerHTML = svg;
  const el = container.querySelector("svg"), cross = el.querySelector(".cross"), dot = el.querySelector(".dot"), tip = tooltip(container);
  const move = (ev) => {
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((ev.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (points.length - 1))));
    const [d, v] = points[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.style.display = "";
    tip.innerHTML = `${shortDate(d, true)}<b>${money(v)}</b>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(w - tip.offsetWidth, Math.max(0, x(i) - tip.offsetWidth / 2))}px`;
  };
  el.addEventListener("pointerdown", move);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerleave", () => { cross.style.display = dot.style.display = "none"; tip.hidden = true; });
}

function pairedBars(container, months, chosen, onPick, height = 180) {
  const w = container.clientWidth || 320, pad = { l: 44, r: 8, t: 8, b: 22 };
  const ticks = niceTicks(0, Math.max(...months.flatMap((m) => [m.income_cents, m.expense_cents])));
  const hi = ticks[ticks.length - 1];
  const y = (v) => pad.t + (1 - v / hi) * (height - pad.t - pad.b);
  const slot = (w - pad.l - pad.r) / months.length, bar = Math.min(18, (slot - 12) / 2);
  let svg = `<svg width="${w}" height="${height}" role="img" aria-label="Income and expenses by month">`;
  for (const t of ticks) svg += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${shortMoney(t)}</text>`;
  const rounded = (x0, v, cls) => {
    const top = y(v), base = y(0), r = Math.max(0, Math.min(4, (base - top) / 2, bar / 2));
    return `<path class="${cls}" d="M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bar - r}Q${x0 + bar},${top} ${x0 + bar},${top + r}V${base}Z"/>`;
  };
  months.forEach((m, i) => {
    const cx = pad.l + slot * (i + 0.5), dim = i === chosen ? "" : " dim";
    svg += rounded(cx - bar - 1, m.income_cents, "income" + dim) + rounded(cx + 1, m.expense_cents, "expense" + dim);
    svg += `<rect class="hit" data-i="${i}" x="${cx - slot / 2}" y="${pad.t}" width="${slot}" height="${height - pad.t}"/>`;
    svg += `<text class="axis${i === chosen ? " chosen" : ""}" x="${cx}" y="${height - 6}" text-anchor="middle">${monthName(m.month)}</text>`;
  });
  container.innerHTML = svg + "</svg>";
  container.querySelectorAll(".hit").forEach((h) => h.addEventListener("click", () => onPick(Number(h.dataset.i))));
}

// ----- wiring -----
$("#file").addEventListener("change", (e) => e.target.files[0] && openFile(e.target.files[0]));
$("#file2").addEventListener("change", (e) => e.target.files[0] && openFile(e.target.files[0]));
$("#unlock").addEventListener("submit", unlock);
$("#lock").addEventListener("click", lock);
for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", () => { view = b.dataset.view; render(); });
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js");
  // A new version took over (sw.js claims open pages): reload once so its files are the ones running.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
}
start().catch((e) => { alert(e.message); show("open"); });
