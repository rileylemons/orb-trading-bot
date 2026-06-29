'use strict';

/**
 * ORB Strategy Backtester
 * Usage: node backtest.js
 *
 * Screener proxy: uses opening gap (today open vs yesterday close) since
 * exact 9:15 AM pre-market snapshots are not available in historical data.
 * Volume filter uses previous day's total volume as a liquidity proxy.
 */

const alpaca = require('./alpaca');
const { SymbolStrategy, STATE } = require('./strategy');
const cfg = require('./config');

// ─── Universe ─────────────────────────────────────────────
// Curated list of commonly volatile, liquid stocks likely to appear
// as pre-market movers. Expand this list for broader coverage.
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMD','META','AMZN','GOOGL','GOOG','TSLA','NFLX',
  'INTC','QCOM','AVGO','MU','AMAT','LRCX','KLAC','TXN','ADI','MCHP',
  // Crypto / fintech
  'COIN','MARA','RIOT','MSTR','HOOD','SQ','PYPL','AFRM','UPST','SOFI',
  // Popular retail / momentum
  'PLTR','NIO','RIVN','LCID','XPEV','LI','BABA','JD','PDD','BIDU',
  'GME','AMC','BBBY','SPCE','CLOV','DKNG','PENN','FUBO','RBLX','SNAP',
  // Growth / SaaS
  'PINS','UBER','LYFT','DASH','ABNB','ETSY','W','CHWY','OPEN','LMND',
  'CRWD','ZS','S','DDOG','NET','SNOW','GTLB','MDB','ESTC','ELASTIC',
  // Healthcare / biotech
  'MRNA','BNTX','NVAX','PFE','BIIB','GILD','REGN','VRTX','SRPT','BEAM',
  // Energy
  'XOM','CVX','OXY','DVN','MRO','FANG','PXD','APA','HES','ENPH',
  'FSLR','SEDG','RUN','NOVA','SPWR','ARRY','BE','PLUG','FCEL','BLNK',
  // Financials
  'JPM','BAC','GS','MS','C','WFC','USB','PNC','KEY','RF',
  // Leveraged ETFs (very volatile, often gap)
  'TQQQ','SQQQ','UVXY','SOXL','SPXL','SPXS','LABU','LABD','FNGU','FNGD',
];

// ─── Helpers ──────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function etDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function etOffset(date) {
  const y = date.getUTCFullYear();
  const dstStart = new Date(`${y}-03-08T07:00:00Z`); // ~2nd Sun Mar at 2 AM ET
  const dstEnd   = new Date(`${y}-11-01T06:00:00Z`); // ~1st Sun Nov at 2 AM ET
  return (date >= dstStart && date < dstEnd) ? '-04:00' : '-05:00';
}

function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function usd(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

// ─── API wrappers ─────────────────────────────────────────
async function fetchDailyBars(symbols, start, end) {
  const result = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    try {
      const resp = await alpaca.getBars(batch, '1Day', { start, end, limit: 300, sort: 'asc' });
      Object.assign(result, resp.bars || {});
    } catch (e) {
      process.stderr.write(`Daily bars error: ${e.message}\n`);
    }
    await sleep(400);
  }
  return result;
}

async function fetchIntradayBars(symbols, date) {
  if (!symbols.length) return {};
  const off   = etOffset(new Date(date + 'T12:00:00Z'));
  const start = `${date}T09:30:00${off}`;
  const end   = `${date}T15:55:00${off}`; // match bot's EOD close time
  try {
    const resp = await alpaca.getBars(symbols, '1Min', { start, end, limit: 450, sort: 'asc' });
    return resp.bars || {};
  } catch (e) {
    process.stderr.write(`Intraday error (${date}): ${e.message}\n`);
    return {};
  }
}

// ─── Per-symbol day simulation ────────────────────────────
function simulateSymbol(symbol, allBars, orHigh, orLow, positionUSD) {
  const off     = etOffset(new Date(allBars[0].t));
  const orEndMs = new Date(allBars[0].t.slice(0, 10) + `T09:45:00${off}`).getTime();

  const sessionBars = allBars.filter(b => new Date(b.t).getTime() >= orEndMs);
  if (!sessionBars.length) return null;

  const strat = new SymbolStrategy(symbol, true /* silent */);
  strat.setOR(orHigh, orLow);

  let entryBar  = null;
  let entryQty  = 0;
  let tradeResult = null;

  for (const bar of sessionBars) {
    const signal = strat.processBar(bar);
    if (!signal) continue;

    if (signal.action === 'BUY' || signal.action === 'SELL_SHORT') {
      entryBar = bar;
      entryQty = Math.max(1, Math.floor(positionUSD / bar.c));
    } else if (signal.action === 'CLOSE' && entryBar) {
      tradeResult = buildTrade(symbol, strat, entryBar, entryQty, strat.stopPrice, 'STOP');
      break;
    }
  }

  // EOD exit: still in trade at 3:55 PM
  if (!tradeResult && entryBar && strat.state === STATE.IN_TRADE) {
    const lastBar = sessionBars[sessionBars.length - 1];
    tradeResult = buildTrade(symbol, strat, entryBar, entryQty, lastBar.c, 'EOD');
  }

  return tradeResult;
}

function buildTrade(symbol, strat, entryBar, qty, exitPrice, exitReason) {
  const isLong     = strat.direction === 'LONG';
  const entryPrice = entryBar.c;
  const changePct  = isLong
    ? (exitPrice - entryPrice) / entryPrice * 100
    : (entryPrice - exitPrice) / entryPrice * 100;
  const pnlDollars = isLong
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;

  return {
    symbol,
    date:      entryBar.t.slice(0, 10),
    direction: strat.direction,
    entry:     entryPrice,
    exit:      exitPrice,
    qty,
    pct:       changePct,
    pnl:       pnlDollars,
    phase:     strat.phase,
    exitReason,
  };
}

// ─── Main ─────────────────────────────────────────────────
async function main() {
  const MONTHS          = 4;
  const STARTING_CAP    = 50_000;

  const now     = new Date();
  const start   = new Date(now);
  start.setMonth(start.getMonth() - MONTHS);

  const startStr = etDateStr(start);
  const endStr   = etDateStr(now);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         ORB Strategy Backtester         ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log(`  Period:           ${startStr}  →  ${endStr}`);
  console.log(`  Universe:         ${UNIVERSE.length} stocks`);
  console.log(`  Screener:         gap ≥${cfg.MIN_PREMARKET_CHANGE_PCT}%  prev-vol ≥${(cfg.MIN_VOLUME/1000).toFixed(0)}k  price ≥$${cfg.MIN_PRICE}`);
  console.log(`  Starting capital: $${STARTING_CAP.toLocaleString()}\n`);

  // 1. Fetch all daily bars for the universe (one batch per 100 symbols)
  process.stdout.write('  Fetching daily bars...');
  const dailyBars = await fetchDailyBars(UNIVERSE, startStr, endStr);
  process.stdout.write(` done (${Object.keys(dailyBars).length} symbols)\n`);

  // 2. Build a per-date index from the daily bars
  //    date → { symbol → { open, prevClose, prevVolume } }
  const dateIndex = {};
  for (const [sym, bars] of Object.entries(dailyBars)) {
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      const date = curr.t.slice(0, 10);
      if (!dateIndex[date]) dateIndex[date] = {};
      dateIndex[date][sym] = { open: curr.o, prevClose: prev.c, prevVolume: prev.v };
    }
  }

  const tradingDays = Object.keys(dateIndex).sort();
  console.log(`  Trading days:     ${tradingDays.length}\n`);

  // 3. Process each trading day
  const allTrades    = [];
  let capital        = STARTING_CAP;
  let totalScreened  = 0;

  for (let d = 0; d < tradingDays.length; d++) {
    const date    = tradingDays[d];
    const dayData = dateIndex[date];

    process.stdout.write(`\r  [${d + 1}/${tradingDays.length}] ${date}  capital=$${capital.toFixed(0).padStart(8)}  trades=${allTrades.length}   `);

    // Screen: gap%, prev volume, price
    const watchlist = Object.entries(dayData)
      .filter(([, d]) => {
        const gap = Math.abs((d.open - d.prevClose) / d.prevClose * 100);
        return gap >= cfg.MIN_PREMARKET_CHANGE_PCT
          && d.prevVolume >= cfg.MIN_VOLUME
          && d.open >= cfg.MIN_PRICE;
      })
      .map(([sym]) => sym);

    if (!watchlist.length) continue;
    totalScreened += watchlist.length;

    const positionUSD = capital / watchlist.length;

    // Fetch 1-min bars for qualifying stocks
    const intraday = await fetchIntradayBars(watchlist, date);
    await sleep(400);

    // Run strategy for each qualifying symbol
    for (const sym of watchlist) {
      const bars = intraday[sym];
      if (!bars || bars.length < 10) continue;

      const off     = etOffset(new Date(date + 'T12:00:00Z'));
      const orEndMs = new Date(`${date}T09:45:00${off}`).getTime();

      const orBars = bars.filter(b => new Date(b.t).getTime() < orEndMs);
      if (!orBars.length) continue;

      const orHigh = Math.max(...orBars.map(b => b.h));
      const orLow  = Math.min(...orBars.map(b => b.l));

      const trade = simulateSymbol(sym, bars, orHigh, orLow, positionUSD);
      if (!trade) continue;

      capital += trade.pnl;
      allTrades.push(trade);
    }
  }

  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // 4. Print report
  printReport(allTrades, tradingDays.length, totalScreened, STARTING_CAP, capital);
}

// ─── Report ───────────────────────────────────────────────
function printReport(trades, days, totalScreened, startCap, endCap) {
  if (!trades.length) {
    console.log('  No trades generated.\n');
    return;
  }

  const wins   = trades.filter(t => t.pct > 0);
  const losses = trades.filter(t => t.pct <= 0);
  const longs  = trades.filter(t => t.direction === 'LONG');
  const shorts = trades.filter(t => t.direction === 'SHORT');

  const avg = arr => arr.reduce((s, t) => s + t.pct, 0) / (arr.length || 1);

  const best  = trades.reduce((b, t) => t.pct > b.pct ? t : b);
  const worst = trades.reduce((w, t) => t.pct < w.pct ? t : w);

  const netPnL   = endCap - startCap;
  const netRet   = netPnL / startCap * 100;

  // Exit breakdown
  const stopExits = trades.filter(t => t.exitReason === 'STOP');
  const eodExits  = trades.filter(t => t.exitReason === 'EOD');
  const ph1 = stopExits.filter(t => t.phase === 1);
  const ph2 = stopExits.filter(t => t.phase === 2);
  const ph3 = stopExits.filter(t => t.phase === 3);

  // Monthly
  const monthly = {};
  for (const t of trades) {
    const m = t.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { n: 0, wins: 0, pnl: 0 };
    monthly[m].n++;
    if (t.pct > 0) monthly[m].wins++;
    monthly[m].pnl += t.pnl;
  }

  const bar = '═'.repeat(52);
  console.log(bar);
  console.log('  BACKTEST RESULTS');
  console.log(bar);
  console.log(`  Days:               ${days}`);
  console.log(`  Avg stocks/day:     ${(totalScreened / days).toFixed(1)}`);
  console.log(`  Total trades:       ${trades.length}  (${(trades.length / days).toFixed(2)}/day)`);
  console.log('');
  console.log(`  Starting capital:   $${startCap.toLocaleString()}`);
  console.log(`  Ending capital:     $${endCap.toFixed(2)}`);
  console.log(`  Net P&L:            ${usd(netPnL)}  (${pct(netRet)})`);
  console.log('');
  console.log('  ── Win / Loss ──────────────────────────');
  console.log(`  Win rate:           ${(wins.length / trades.length * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg winner:         ${pct(avg(wins))}`);
  console.log(`  Avg loser:          ${pct(avg(losses))}`);
  console.log(`  Avg trade:          ${pct(avg(trades))}`);
  console.log(`  Best:               ${best.symbol} ${pct(best.pct)}  on ${best.date}`);
  console.log(`  Worst:              ${worst.symbol} ${pct(worst.pct)}  on ${worst.date}`);
  console.log('');
  console.log('  ── Direction ───────────────────────────');
  console.log(`  Long  trades:  ${String(longs.length).padStart(4)}  WR=${longs.length ? (longs.filter(t=>t.pct>0).length/longs.length*100).toFixed(0) : 0}%  avg=${pct(avg(longs))}`);
  console.log(`  Short trades:  ${String(shorts.length).padStart(4)}  WR=${shorts.length ? (shorts.filter(t=>t.pct>0).length/shorts.length*100).toFixed(0) : 0}%  avg=${pct(avg(shorts))}`);
  console.log('');
  console.log('  ── Exit reasons ────────────────────────');
  console.log(`  OR midpoint stop (phase 1):  ${String(ph1.length).padStart(4)}  WR=${ph1.length ? (ph1.filter(t=>t.pct>0).length/ph1.length*100).toFixed(0) : 0}%`);
  console.log(`  2% trailing stop (phase 2):  ${String(ph2.length).padStart(4)}  WR=${ph2.length ? (ph2.filter(t=>t.pct>0).length/ph2.length*100).toFixed(0) : 0}%`);
  console.log(`  Time stop 3.5h  (phase 3):  ${String(ph3.length).padStart(4)}  WR=${ph3.length ? (ph3.filter(t=>t.pct>0).length/ph3.length*100).toFixed(0) : 0}%`);
  console.log(`  EOD close at 3:55 PM:        ${String(eodExits.length).padStart(4)}  WR=${eodExits.length ? (eodExits.filter(t=>t.pct>0).length/eodExits.length*100).toFixed(0) : 0}%`);
  console.log('');
  console.log('  ── Monthly ─────────────────────────────');
  for (const [month, m] of Object.entries(monthly).sort()) {
    const wr = (m.wins / m.n * 100).toFixed(0);
    console.log(`  ${month}:  ${String(m.n).padStart(3)} trades  WR=${wr.padStart(3)}%  PnL=${usd(m.pnl)}`);
  }
  console.log(bar);

  // Recent 15 trades
  console.log('\n  Last 15 trades:');
  console.log('  ' + '─'.repeat(74));
  console.log('  Date        Symbol  Dir    Entry     Exit      Return  P&L');
  console.log('  ' + '─'.repeat(74));
  for (const t of trades.slice(-15)) {
    const row = [
      t.date,
      t.symbol.padEnd(7),
      t.direction.padEnd(6),
      ('$' + t.entry.toFixed(2)).padStart(8),
      ('$' + t.exit.toFixed(2)).padStart(9),
      pct(t.pct).padStart(8),
      usd(t.pnl).padStart(9),
    ].join('  ');
    console.log('  ' + row);
  }
  console.log('');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
