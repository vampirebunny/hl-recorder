// Hyperliquid smart-money position recorder.
// Runs every 15 minutes on GitHub Actions (see .github/workflows/record.yml). No dependencies; needs Node 20+.
//
// What it does each run:
//   1. Once a day, scans the leaderboard and picks the top wallets by consistency score (same scoring as the dashboard).
//   2. Records each tracked wallet's net BTC and HYPE perp position.
//   3. Writes only changes, so the files stay small:
//        data/YYYY-MM.json   positions: { wallets: { addr: { BTC: [[t,pos],...], HYPE: [[t,pos],...] } } }
//        data/runs.json      when the recorder ran: { runs: [[start,end],...], first: { addr: firstSeenMs } }
//        data/wallets-auto.json  the daily scan result
//   Wallets listed in wallets.json are always tracked, in addition to the scan's picks.

import fs from 'node:fs/promises';

const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const LB_URL = process.env.HL_LB || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const DATA = process.env.HL_DATA || 'data';
const COINS = ['BTC', 'HYPE'];
const DAY = 864e5;
const CFG = { minAV: 100000, minPnl: 250000, maxTurnover: 25, candidates: 120, minHistory: 180, track: 40, keepDays: 400 };
const EXCLUDE = new Set(['0xdfc24b077bc1425ad1dea75bcb6f8158e10df303']); // HLP vault
const GAP = 40 * 60e3; // runs further apart than this count as a gap in coverage

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

async function post(body) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { await sleep(8000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 5) throw e; await sleep(2000 * (i + 1)); }
  }
  throw new Error('rate limited');
}
async function readJson(path, dflt) { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return dflt; } }
async function writeJson(path, obj) { await fs.writeFile(path, JSON.stringify(obj)); }

function interp(s, t) {
  if (t <= s[0][0]) return s[0][1];
  if (t >= s[s.length - 1][0]) return s[s.length - 1][1];
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m][0] <= t) lo = m; else hi = m; }
  const [t0, v0] = s[lo], [t1, v1] = s[hi]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0 || 1);
}
// Same consistency score as the dashboard.
function score(pf) {
  const at = (pf.find(x => x[0] === 'allTime') || [])[1];
  if (!at || !at.pnlHistory.length) return null;
  const pnl = at.pnlHistory.map(([t, v]) => [t, +v]), av = at.accountValueHistory.map(([t, v]) => [t, +v]);
  const now = pnl[pnl.length - 1][0];
  const fa = av.find(x => x[1] > 0);
  const start = Math.min(fa ? fa[0] : pnl[0][0], pnl[0][0]);
  const hd = (now - start) / DAY;
  const wins = [];
  for (const d of [30, 90, 180, 365, 1095, 1825]) {
    const t = now - d * DAY; if (start > t + 4 * DAY) continue;
    const dp = pnl[pnl.length - 1][1] - interp(pnl, t);
    const avs = av.filter(x => x[0] >= t && x[1] > 0).map(x => x[1]);
    wins.push({ d, pnl: dp, roi: dp / Math.max(avs.length ? mean(avs) : Math.max(av[av.length - 1][1], 1), 1000) });
  }
  let months = 0, pos = 0;
  for (let t = now; t - 30 * DAY >= start - 4 * DAY; t -= 30 * DAY) { months++; if (interp(pnl, t) - interp(pnl, t - 30 * DAY) > 0) pos++; }
  let peak = -Infinity, dd = 0; for (const [, v] of pnl) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  const avAll = av.filter(x => x[1] > 0).map(x => x[1]);
  const ddPct = dd / Math.max(avAll.length ? mean(avAll) : 1, 1000);
  const wpos = wins.length ? wins.filter(x => x.pnl > 0).length / wins.length : 0;
  const w = d => wins.find(x => x.d === d);
  const roi1 = w(365) ? w(365).roi : w(180) ? w(180).roi * 2 : w(90) ? w(90).roi * 4 : 0;
  if (hd < CFG.minHistory || !months) return null;
  return 100 * (0.4 * pos / months + 0.25 * wpos + 0.2 * (1 - Math.min(ddPct, 1)) + 0.15 * clamp(roi1, 0, 1));
}

async function dailyScan() {
  console.log('Running daily wallet scan…');
  const lb = await (await fetch(LB_URL)).json();
  const rows = lb.leaderboardRows.map(r => {
    const w = Object.fromEntries(r.windowPerformances.map(([k, v]) => [k, { pnl: +v.pnl, vlm: +v.vlm }]));
    return { addr: r.ethAddress.toLowerCase(), av: +r.accountValue, w };
  });
  const pre = rows.filter(x => !EXCLUDE.has(x.addr) && x.av >= CFG.minAV && x.w.allTime.pnl >= CFG.minPnl && x.w.month.vlm / Math.max(x.av, 1) <= CFG.maxTurnover)
    .sort((a, b) => b.w.allTime.pnl - a.w.allTime.pnl).slice(0, CFG.candidates);
  const out = [];
  for (const c of pre) { // paced to stay well under Hyperliquid's rate limit
    const t0 = Date.now();
    try {
      const [pf, ch] = await Promise.all([post({ type: 'portfolio', user: c.addr }), post({ type: 'clearinghouseState', user: c.addr })]);
      const s = score(pf);
      const eq = +ch.marginSummary.accountValue;
      if (s != null && eq >= CFG.minAV) out.push({ addr: c.addr, score: +s.toFixed(1), equity: Math.round(eq) });
    } catch (e) { console.log('skip', c.addr, e.message); }
    const el = Date.now() - t0; if (el < 1400) await sleep(1400 - el);
  }
  out.sort((a, b) => b.score - a.score);
  return { t: Date.now(), wallets: out.slice(0, CFG.track) };
}

const monthKey = t => new Date(t).toISOString().slice(0, 7);

async function main() {
  await fs.mkdir(DATA, { recursive: true });
  const now = Date.now();

  let auto = await readJson(`${DATA}/wallets-auto.json`, null);
  if (!auto || now - auto.t > DAY) {
    try { auto = await dailyScan(); await writeJson(`${DATA}/wallets-auto.json`, auto); }
    catch (e) { console.log('Scan failed, keeping previous list:', e.message); }
  }
  const extra = (await readJson('wallets.json', [])).map(a => String(a).toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a));
  const tracked = [...new Set([...(auto ? auto.wallets.map(w => w.addr) : []), ...extra])];
  console.log(`Tracking ${tracked.length} wallets`);

  const mids = await post({ type: 'allMids' });
  const snap = {};
  let ok = 0;
  for (let i = 0; i < tracked.length; i += 5) {
    await Promise.all(tracked.slice(i, i + 5).map(async a => {
      try {
        const ch = await post({ type: 'clearinghouseState', user: a });
        const p = { BTC: 0, HYPE: 0 };
        for (const ap of ch.assetPositions || []) if (COINS.includes(ap.position.coin)) p[ap.position.coin] = +ap.position.szi;
        snap[a] = p; ok++;
      } catch (e) { console.log('failed', a, e.message); }
    }));
  }
  const t = Date.now();

  // positions: append only when a position changed (>0.5% or sign change)
  const mk = monthKey(t);
  const month = await readJson(`${DATA}/${mk}.json`, { wallets: {} });
  const runs = await readJson(`${DATA}/runs.json`, { runs: [], first: {} });
  let changes = 0;
  for (const [a, p] of Object.entries(snap)) {
    const w = month.wallets[a] || (month.wallets[a] = { BTC: [], HYPE: [] });
    for (const c of COINS) {
      const arr = w[c]; const v = p[c];
      const last = arr.length ? arr[arr.length - 1][1] : null;
      const changed = last == null || Math.sign(last) !== Math.sign(v) || Math.abs(v - last) > 0.005 * Math.max(Math.abs(last), Math.abs(v));
      if (changed) { arr.push([t, v]); changes++; }
    }
    if (!runs.first[a]) runs.first[a] = t;
  }
  await writeJson(`${DATA}/${mk}.json`, month);

  // coverage
  const last = runs.runs[runs.runs.length - 1];
  if (last && t - last[1] <= GAP) last[1] = t; else runs.runs.push([t, t]);
  runs.runs = runs.runs.filter(r => r[1] >= t - CFG.keepDays * DAY);
  runs.lastRun = t; runs.tracked = tracked.length; runs.ok = ok;
  await writeJson(`${DATA}/runs.json`, runs);
  console.log(`Recorded ${ok}/${tracked.length} wallets, ${changes} position changes, BTC $${mids.BTC}, HYPE $${mids.HYPE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
