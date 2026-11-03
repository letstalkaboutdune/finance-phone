// Pure logic for the phone page (docs/MOBILE.md): decrypting a snapshot and the numbers worked out from it.
// No DOM here, so tests/test_mobile.py can run it under Node against a real export.

export const FORMAT = "finance-snapshot";
const enc = new TextEncoder();

export function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseEnvelope(text) {
  let env;
  try { env = JSON.parse(text); } catch { throw new Error("That file isn't a Finance snapshot."); }
  if (env.format !== FORMAT) throw new Error("That file isn't a Finance snapshot.");
  if (env.version !== 1) throw new Error("This snapshot is from a newer version of the app. Reload the page.");
  return env;
}

// A non-extractable key: it can be kept in IndexedDB ("Remember on this phone") but never read back out.
export async function deriveKey(passphrase, env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64decode(env.salt), iterations: env.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

export async function decrypt(env, key) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(env.iv), additionalData: enc.encode(FORMAT) }, key, b64decode(env.data));
  } catch {
    throw new Error("Wrong passphrase.");
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// Dates in the snapshot are "YYYY-MM-DD", meant as local days.
export function isoToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00") - Date.parse(a + "T00:00")) / 86400000);
}

// The lowest end-of-day balance from `today` on (days before it are the past), with an optional extra spend on
// `spendDate`, which lowers every day from then on. null when the forecast doesn't reach today.
export function lowFrom(cash, today, spendCents = 0, spendDate = today) {
  let low = null;
  for (const [d, c] of cash.daily) {
    if (d < today) continue;
    const v = c - (d >= spendDate ? spendCents : 0);
    if (low === null || v < low[1]) low = [d, v];
  }
  return low;
}

// How much could go out today with the balance staying at or above the minimum through the forecast's end.
// Negative: the forecast already dips that far below it.
export function spare(cash, today) {
  const low = lowFrom(cash, today);
  return low && { cents: low[1] - (cash.min_cents || 0), low };
}

// The first day from `today` on that ends below the minimum (with an extra spend), or null.
export function firstBreach(cash, today, spendCents = 0, spendDate = today) {
  if (cash.min_cents == null) return null;
  for (const [d, c] of cash.daily) {
    if (d >= today && c - (d >= spendDate ? spendCents : 0) < cash.min_cents) return d;
  }
  return null;
}

export function upcoming(cash, today, days = 14) {
  return cash.events.filter((e) => e.date >= today && daysBetween(today, e.date) <= days);
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function money(cents, signed = false) {
  const s = dollars.format(Math.abs(cents) / 100);
  return cents < 0 ? "−" + s : (signed && cents > 0 ? "+" + s : s);
}

export function shortMoney(cents) {
  const v = Math.abs(cents) / 100, sign = cents < 0 ? "−" : "";
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
  if (v >= 1e4) return `${sign}$${Math.round(v / 1e3)}k`;
  return money(cents);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(iso, withYear = false) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}` + (withYear ? `, ${y}` : "");
}

export function monthName(ym) {
  return MONTHS[Number(ym.split("-")[1]) - 1];
}

export function pct(v, digits = 0) {
  return v == null ? "–" : `${v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`;
}

// Round axis ticks covering lo..hi: the first at or below lo, the last at or above hi, so nothing is drawn
// outside the plot.
export function niceTicks(lo, hi, count = 3) {
  if (hi <= lo) hi = lo + 1;
  const step0 = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; ; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
    if (v >= hi) break;
  }
  return ticks;
}
