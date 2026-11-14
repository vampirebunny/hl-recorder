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
//        data/bigtrades-YYYY-MM.json  big single orders and multi-order position changes in BTC/HYPE
//   Wallets listed in wallets.json are always tracked, in addition to the scan's picks.
//   After recording positions it listens to the live trade stream for LISTEN_MIN minutes (default 11),
//   so with a run every 15 minutes it covers most of the day. Needs Node 22 (built-in WebSocket).

import fs from 'node:fs/promises';

const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const LB_URL = process.env.HL_LB || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const DATA = process.env.HL_DATA || 'data';
const COINS = ['BTC', 'HYPE'];
const DAY = 864e5;
const CFG = { minAV: 100000, minPnl: 250000, maxTurnover: 25, candidates: 120, minHistory: 180, track: 40, keepDays: 400 };
const EXCLUDE = new Set(['0xdfc24b077bc1425ad1dea75bcb6f8158e10df303']); // HLP vault
const GAP = 40 * 60e3; // runs further apart than this count as a gap in coverage
const LISTEN_MIN = +(process.env.LISTEN_MIN || 11);
const WS_URL = process.env.HL_WS || 'wss://api.hyperliquid.xyz/ws';
const BT_FLOORS = { BTC: 1e6, HYPE: 250e3 };

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

// ---------- big-trade detector (shared by the dashboard and the recorder) ----------
// Feed it trades from Hyperliquid's "trades" websocket channel. It emits two kinds of event:
//   order   — one aggressive order (all prints with the same taker in a short burst), big in absolute terms
//             AND relative to the last hour's volume in that coin
//   cluster — a wallet's NET position change over a rolling window (buys minus sells, as taker or maker),
//             spread over at least a few minutes. Market makers trade a lot but stay near flat, so they drop out.
function createBigTradeDetector(opts){
  const o=Object.assign({
    floors:{BTC:1e6,HYPE:250e3},          // single order: at least this many $
    shareOfHour:0.01,                      // ...and at least this share of the last hour's volume
    clusterFloors:{BTC:3e6,HYPE:750e3},   // cluster: net change of at least this many $
    clusterShare:0.02,                     // ...and at least this share of the last hour's volume
    clusterWindow:45*60e3,                 // net change measured over this rolling window
    clusterMinSpan:2*60e3,                 // and spread over at least this long (a single order is not a cluster)
    orderGap:3000,                         // prints by the same taker within 3s belong to one order
    orderMaxSpan:15000,                    // ...up to 15s; anything longer is a cluster, not one order
    maxChurn:3,                            // cluster only if total traded ≤ 3× net change (market makers churn far more)
    mergeGap:2*3600e3                      // a wallet's cluster keeps updating until it goes quiet this long
  },opts||{});
  const vol={};            // coin -> {b: Map(minute -> $), base: $/hour baseline, since}
  const open=new Map();    // taker|coin|side -> order being built
  const flows=new Map();   // wallet|coin -> {q:[[t,$signed,coinsSigned,px]], net, netSz}
  const clusters=new Map();// wallet|coin -> current cluster event
  const out=[];            // events emitted since the last drain()
  const recent=new Map();  // wallet|coin -> recent sizeable orders [[t,dir]], to spot round-tripping
  const minute=t=>Math.floor(t/60e3);
  function hourVol(coin,t){
    const v=vol[coin];if(!v)return 0;
    let s=0;const m=minute(t);for(const [k,x] of v.b){if(k>m-60)s+=x}
    const seen=Math.min(60,Math.max(1,(t-v.since)/60e3));
    return seen<60&&v.base?s+v.base*(60-seen)/60:s; // fill the unseen part of the hour with the baseline
  }
  function addVol(coin,t,usd){
    const v=vol[coin]||(vol[coin]={b:new Map(),base:0,since:t});
    const m=minute(t);v.b.set(m,(v.b.get(m)||0)+usd);
    if(v.b.size>90)for(const k of v.b.keys()){if(k<m-61)v.b.delete(k)}
  }
  function finalize(ord){
    const hv=hourVol(ord.coin,ord.t1);
    const floor=o.floors[ord.coin]||1e6;
    const f=flows.get(ord.wallet+'|'+ord.coin);
    const rk=ord.wallet+'|'+ord.coin;let r=recent.get(rk)||[];r=r.filter(x=>ord.t1-x[0]<10*60e3);
    const flipFlop=r.some(x=>x[1]!==ord.dir);              // sizeable orders both ways within 10 min: round-tripping
    if(ord.usd>=0.2*floor){r.push([ord.t1,ord.dir]);}
    if(r.length)recent.set(rk,r);else recent.delete(rk);
    const churner=flipFlop||(f&&f.gross>5*Math.abs(f.net)&&f.gross>5*floor); // a market maker or arb bot, not a view
    if(!churner&&ord.usd>=floor&&ord.usd>=o.shareOfHour*hv){
      out.push({id:`o-${ord.hash||ord.t0}-${ord.wallet.slice(2,10)}`,type:'order',coin:ord.coin,wallet:ord.wallet,dir:ord.dir,
        usd:ord.usd,sz:ord.sz*ord.dir,n:ord.n,t0:ord.t0,t1:ord.t1,px0:ord.px0,px1:ord.px1,share:hv?ord.usd/hv:null});
    }
  }
  function addFlow(wallet,coin,t,usd,sz,px,isTaker){
    const k=wallet+'|'+coin;let f=flows.get(k);
    if(!f){f={q:[],net:0,netSz:0,gross:0,tnet:0};flows.set(k,f)}
    const tu=isTaker?usd:0;
    f.q.push([t,usd,sz,px,tu]);f.net+=usd;f.netSz+=sz;f.gross+=Math.abs(usd);f.tnet+=tu;
    while(f.q.length&&f.q[0][0]<t-o.clusterWindow){const x=f.q.shift();f.net-=x[1];f.netSz-=x[2];f.gross-=Math.abs(x[1]);f.tnet-=x[4]}
    checkCluster(wallet,coin,f,t);
  }
  function checkCluster(wallet,coin,f,t){
    if(!f.q.length)return;
    const span=t-f.q[0][0];
    const hv=hourVol(coin,t);
    const thr=Math.max(o.clusterFloors[coin]||3e6,o.clusterShare*hv);
    if(Math.abs(f.net)<thr||span<o.clusterMinSpan||f.gross>o.maxChurn*Math.abs(f.net))return;
    if(f.tnet*f.net<=0||Math.abs(f.tnet)<0.5*Math.abs(f.net))return; // mostly passive fills: someone else's flow, not a view
    const dir=Math.sign(f.net),k=wallet+'|'+coin;
    let c=clusters.get(k);
    if(c&&(c.dir!==dir||t-c.t1>o.mergeGap))c=null;
    const first=f.q.find(x=>Math.sign(x[1])===dir)||f.q[0];
    if(!c){c={id:`c-${coin}-${wallet.slice(2,10)}-${f.q[0][0]}`,type:'cluster',coin,wallet,dir,t0:f.q[0][0],px0:first[3]};clusters.set(k,c)}
    const grew=!c.usd||Math.abs(f.net)>c.usd*1.1||t-(c.emitted||0)>60e3;  // re-emit when it grows 10%+, or once a minute while active
    c.usd=Math.max(c.usd||0,Math.abs(f.net));c.sz=f.netSz;c.n=f.q.length;c.t1=t;c.px1=f.q[f.q.length-1][3];c.share=hv?c.usd/hv:null;
    if(grew){c.emitted=t;out.push(Object.assign({},c))}
  }
  return {
    setBaseline(coin,usdPerHour){const v=vol[coin]||(vol[coin]={b:new Map(),base:0,since:Date.now()});v.base=usdPerHour},
    feed(tr){
      const px=+tr.px,sz=+tr.sz,usd=px*sz,t=tr.time,coin=tr.coin;
      const buyer=tr.users[0],seller=tr.users[1];
      const taker=tr.side==='B'?buyer:seller,dir=tr.side==='B'?1:-1;
      addVol(coin,t,usd);
      const k=taker+'|'+coin+'|'+dir;let ord=open.get(k);
      if(ord&&(t-ord.t1>o.orderGap||t-ord.t0>o.orderMaxSpan)){finalize(ord);ord=null}
      if(!ord){ord={wallet:taker,coin,dir,usd:0,sz:0,n:0,t0:t,t1:t,px0:px,px1:px,hash:tr.hash};open.set(k,ord)}
      ord.usd+=usd;ord.sz+=sz;ord.n++;ord.t1=t;ord.px1=px;
      addFlow(buyer,coin,t,usd,sz,px,taker===buyer);addFlow(seller,coin,t,-usd,-sz,px,taker===seller);
    },
    tick(now){ // call every second or so: closes finished orders, forgets idle wallets
      for(const [k,ord] of open){if(now-ord.t1>o.orderGap){finalize(ord);open.delete(k)}}
      if(Math.random()<0.02)for(const [k,f] of flows){while(f.q.length&&f.q[0][0]<now-o.clusterWindow){const x=f.q.shift();f.net-=x[1];f.netSz-=x[2];f.gross-=Math.abs(x[1]);f.tnet-=x[4]}if(!f.q.length)flows.delete(k)}
      for(const [k,c] of clusters){if(now-c.t1>o.mergeGap)clusters.delete(k)}
      if(Math.random()<0.02)for(const [k,r] of recent){if(!r.length||now-r[r.length-1][0]>10*60e3)recent.delete(k)}
    },
    flush(){for(const ord of open.values())finalize(ord);open.clear()},
    drain(){return out.splice(0,out.length)},
    hourVol,
    stats(){return {wallets:flows.size,openOrders:open.size}}
  };
}
// ---------- end big-trade detector ----------

const monthKey = t => new Date(t).toISOString().slice(0, 7);

// Listen to the live trade stream and return the big-trade events seen.
async function listenBigTrades(minutes) {
  if (!minutes || typeof WebSocket === 'undefined') { console.log('Big trades: skipped (no WebSocket in this Node)'); return []; }
  const det = createBigTradeDetector({ floors: BT_FLOORS, clusterFloors: { BTC: 3 * BT_FLOORS.BTC, HYPE: 3 * BT_FLOORS.HYPE } });
  for (const c of COINS) {
    try {
      const cs = await post({ type: 'candleSnapshot', req: { coin: c, interval: '1h', startTime: Date.now() - 3 * 36e5, endTime: Date.now() } });
      const done = cs.slice(-3, -1); if (done.length) det.setBaseline(c, mean(done.map(x => +x.v * +x.c)));
    } catch (e) { }
  }
  const events = new Map(); let trades = 0;
  const end = Date.now() + minutes * 60e3;
  await new Promise(resolve => {
    let ws, stopped = false;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { for (const c of COINS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: c } })); };
      ws.onmessage = ev => { let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; } if (m.channel !== 'trades') return; for (const t of m.data) { det.feed(t); trades++; } };
      ws.onclose = () => { if (!stopped && Date.now() < end - 5000) setTimeout(connect, 2000); };
      ws.onerror = () => { try { ws.close(); } catch { } };
    };
    connect();
    const tick = setInterval(() => { det.tick(Date.now()); for (const e of det.drain()) events.set(e.id, Object.assign(events.get(e.id) || {}, e)); }, 1000);
    const ping = setInterval(() => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ method: 'ping' })); } catch { } }, 50000);
    setTimeout(() => { stopped = true; det.flush(); for (const e of det.drain()) events.set(e.id, Object.assign(events.get(e.id) || {}, e)); clearInterval(tick); clearInterval(ping); try { ws.close(); } catch { } resolve(); }, Math.max(0, end - Date.now()));
  });
  const list = [...events.values()];
  for (const e of list.filter(x => x.type === 'order').slice(0, 40)) { // was a big order a liquidation?
    try { const f = await post({ type: 'userFillsByTime', user: e.wallet, startTime: e.t0 - 2000, endTime: e.t1 + 2000 }); e.liq = f.some(x => x.coin === e.coin && x.liquidation); if (e.liq) e.type = 'liq'; } catch { }
  }
  console.log(`Big trades: ${trades} trades seen over ${minutes} min, ${list.length} events`);
  return list;
}
async function saveBigTrades(list) {
  if (!list.length) return;
  const byMonth = {};
  for (const e of list) (byMonth[monthKey(e.t1)] ||= []).push(e);
  for (const [mk, evs] of Object.entries(byMonth)) {
    const path = `${DATA}/bigtrades-${mk}.json`;
    const cur = await readJson(path, { events: [] });
    const m = new Map(cur.events.map(e => [e.id, e]));
    for (const e of evs) m.set(e.id, e);
    const all = [...m.values()].sort((a, b) => a.t1 - b.t1).slice(-20000);
    await writeJson(path, { events: all });
  }
}

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

  const big = await listenBigTrades(LISTEN_MIN);
  await saveBigTrades(big);
}

main().catch(e => { console.error(e); process.exit(1); });
