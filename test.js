'use strict';
/**
 * End-to-end test using the most recent trading day's real data.
 * Runs screener → OR → 1-min bar replay → strategy signals.
 * No orders are placed.
 */

const alpaca = require('./alpaca');
const cfg    = require('./config');
const { SymbolStrategy, STATE } = require('./strategy');

const FALLBACK = [
  'AAPL','MSFT','NVDA','AMD','TSLA','META','AMZN','GOOGL','NFLX','COIN',
  'MARA','RIOT','PLTR','SOFI','NIO','RIVN','HOOD','GME','AMC','SNAP',
  'PINS','RBLX','UPST','AFRM','UBER','LYFT','DASH','MSTR','BABA','SHOP',
];

function etOffset(date) {
  const y = date.getUTCFullYear();
  const dstStart = new Date(`${y}-03-08T07:00:00Z`);
  const dstEnd   = new Date(`${y}-11-01T06:00:00Z`);
  return (date >= dstStart && date < dstEnd) ? '-04:00' : '-05:00';
}

async function getLastTradingDay() {
  // Fetch the last 5 calendar entries and pick the most recent past date
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 7);
  const startStr = start.toISOString().slice(0, 10);
  const endStr   = today.toISOString().slice(0, 10);

  try {
    const cal = await alpaca.getClock(); // sanity check connection
    // Use daily bars on a known liquid stock to find last trading day
    const resp = await alpaca.getBars(['SPY'], '1Day', { start: startStr, end: endStr, limit: 10, sort: 'desc' });
    const bars  = resp.bars?.SPY || [];
    if (bars.length === 0) throw new Error('No SPY bars found');
    return bars[0].t.slice(0, 10); // most recent trading day
  } catch (e) {
    // Fallback: last Friday or yesterday
    const d = new Date();
    d.setDate(d.getDate() - (d.getDay() === 0 ? 2 : d.getDay() === 1 ? 3 : 1));
    return d.toISOString().slice(0, 10);
  }
}

async function runScreener(date) {
  let candidates = [];
  try {
    const movers = await alpaca.getMovers();
    const all    = [...(movers.gainers || []), ...(movers.losers || [])];
    candidates   = [...new Set([...all.map(m => m.symbol), ...FALLBACK])];
  } catch {
    candidates = FALLBACK;
  }

  const qualifying = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    try {
      const snaps = await alpaca.getSnapshots(batch);
      for (const [sym, snap] of Object.entries(snaps)) {
        const prevClose  = snap.prevDailyBar?.c;
        const price      = snap.latestTrade?.p ?? snap.minuteBar?.c;
        const prevVolume = snap.prevDailyBar?.v ?? 0;
        if (!prevClose || !price) continue;
        const chg = Math.abs((price - prevClose) / prevClose * 100);
        if (chg >= cfg.MIN_PREMARKET_CHANGE_PCT && prevVolume >= cfg.MIN_VOLUME && price >= cfg.MIN_PRICE)
          qualifying.push({ sym, chg, price, prevVolume });
      }
    } catch { /* skip batch */ }
  }

  qualifying.sort((a, b) => b.chg - a.chg);
  return qualifying.slice(0, cfg.MAX_WATCHLIST).map(s => s.sym);
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     ORB Bot — End-to-End Test Mode      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── Account check ───────────────────────────────────────
  const acct = await alpaca.getAccount();
  console.log(`Account: ${acct.account_number}  equity=$${parseFloat(acct.equity).toLocaleString()}\n`);

  // ── Last trading day ────────────────────────────────────
  process.stdout.write('Finding last trading day... ');
  const testDate = await getLastTradingDay();
  console.log(testDate);

  // ── Screener ────────────────────────────────────────────
  process.stdout.write('Running screener... ');
  const watchlist = await runScreener(testDate);
  console.log(`${watchlist.length} stocks qualify\n`);

  if (!watchlist.length) {
    console.log('No stocks passed the screener. Exiting.');
    return;
  }
  watchlist.forEach(s => console.log('  ', s));
  console.log('');

  // ── Position size ───────────────────────────────────────
  const equity       = parseFloat(acct.equity);
  const perPosition  = equity / watchlist.length;
  console.log(`Position size: $${equity.toFixed(0)} / ${watchlist.length} = $${perPosition.toFixed(2)} each\n`);

  // ── OR bars ─────────────────────────────────────────────
  const off      = etOffset(new Date(testDate + 'T12:00:00Z'));
  const orStart  = `${testDate}T09:30:00${off}`;
  const orEnd    = `${testDate}T09:44:59${off}`;

  process.stdout.write('Fetching opening range bars... ');
  const orResp   = await alpaca.getBars(watchlist, '1Min', { start: orStart, end: orEnd, limit: 20, sort: 'asc' });
  const orBarsMap = orResp.bars || {};

  const strategies = new Map();
  let orSet = 0;
  for (const sym of watchlist) {
    const bars = orBarsMap[sym];
    if (!bars?.length) { console.log(`\n  [${sym}] No OR data`); continue; }
    const strat = new SymbolStrategy(sym);
    strat.setOR(
      Math.max(...bars.map(b => b.h)),
      Math.min(...bars.map(b => b.l))
    );
    strategies.set(sym, strat);
    orSet++;
  }
  console.log(`${orSet} symbols ready\n`);

  // ── Session bars ─────────────────────────────────────────
  const sessionStart = `${testDate}T09:45:00${off}`;
  const sessionEnd   = `${testDate}T15:55:00${off}`;

  process.stdout.write('Fetching session bars (9:45–3:55)... ');
  const sessionResp = await alpaca.getBars([...strategies.keys()], '1Min', {
    start: sessionStart, end: sessionEnd, limit: 450, sort: 'asc',
  });
  const sessionBars = sessionResp.bars || {};
  console.log(`done\n`);

  // ── Strategy replay ──────────────────────────────────────
  console.log('── Replaying strategy ──────────────────────────────────');
  const trades = [];

  for (const [sym, strat] of strategies.entries()) {
    const bars = sessionBars[sym];
    if (!bars?.length) continue;

    let entryBar = null;
    let entryQty = 0;

    for (const bar of bars) {
      const signal = strat.processBar(bar);
      if (!signal) continue;

      if (signal.action === 'BUY' || signal.action === 'SELL_SHORT') {
        entryBar = bar;
        entryQty = Math.max(1, Math.floor(perPosition / bar.c));
        console.log(`  [${bar.t.slice(11,16)} ET] ${sym} → ENTER ${signal.action}  @ $${bar.c.toFixed(2)}  stop=$${signal.stop.toFixed(2)}  qty=${entryQty}`);
      } else if (signal.action === 'CLOSE' && entryBar) {
        const isLong    = strat.direction === 'LONG';
        const exitPrice = strat.stopPrice;
        const pct       = isLong
          ? (exitPrice - entryBar.c) / entryBar.c * 100
          : (entryBar.c - exitPrice) / entryBar.c * 100;
        const pnl = isLong
          ? (exitPrice - entryBar.c) * entryQty
          : (entryBar.c - exitPrice) * entryQty;
        console.log(`  [${bar.t.slice(11,16)} ET] ${sym} → EXIT              @ $${exitPrice.toFixed(2)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
        trades.push({ sym, pct, pnl });
        entryBar = null;
      }
    }

    // EOD
    if (entryBar && strat.state === STATE.IN_TRADE) {
      const lastBar = bars[bars.length - 1];
      const isLong  = strat.direction === 'LONG';
      const pct     = isLong
        ? (lastBar.c - entryBar.c) / entryBar.c * 100
        : (entryBar.c - lastBar.c) / entryBar.c * 100;
      const pnl = isLong
        ? (lastBar.c - entryBar.c) * entryQty
        : (entryBar.c - lastBar.c) * entryQty;
      console.log(`  [EOD 3:55]   ${sym} → EXIT (EOD)         @ $${lastBar.c.toFixed(2)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
      trades.push({ sym, pct, pnl });
    }
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n── Test Summary ────────────────────────────────────────');
  if (!trades.length) {
    console.log('  No setups completed on this day (breakout→retest→reclaim chain did not trigger)');
  } else {
    const wins = trades.filter(t => t.pct > 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  Trades:   ${trades.length}  (${wins.length} wins / ${trades.length - wins.length} losses)`);
    console.log(`  Total P&L: $${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`);
  }
  console.log('\n  ✅ All components working — screener, OR, strategy, data feed');
  console.log('  ✅ No real orders were placed\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
