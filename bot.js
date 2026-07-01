/**
 * Opening Range Breakout (ORB) Automated Trader
 *
 * Schedule:
 *   9:15 AM ET  — pre-market screener runs
 *   9:30 AM ET  — market opens, OR tracking begins
 *   9:45 AM ET  — OR confirmed, 1-min signal loop starts
 *   3:55 PM ET  — all positions closed end-of-day
 *
 * Stop phases per trade:
 *   Phase 1  — hard stop at OR midpoint
 *   Phase 2  — 2% trailing stop (activates after +5% gain)
 *   Phase 3  — 1% trailing stop, floor = OR midpoint (activates after 3.5 h)
 */

'use strict';

const alpaca = require('./alpaca');
const cfg    = require('./config');
const { SymbolStrategy, STATE } = require('./strategy');

// ─── Global state ─────────────────────────────────────────
const strategies = new Map();  // symbol → SymbolStrategy
const positions  = new Map();  // symbol → { qty, stopOrderId }

// Set at 9:29 AM ET: account equity / number of screened stocks
let perPositionUSD = cfg.FALLBACK_POSITION_USD;

// Fallback universe when movers API is unavailable
const FALLBACK = [
  'AAPL','MSFT','NVDA','AMD','TSLA','META','AMZN','GOOGL','NFLX','COIN',
  'MARA','RIOT','PLTR','SOFI','NIO','RIVN','HOOD','GME','AMC','SNAP',
  'PINS','RBLX','UPST','AFRM','UBER','LYFT','DASH','MSTR','BABA','SHOP',
];

// ─── Time helpers ─────────────────────────────────────────
function etNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = t => parseInt(parts.find(p => p.type === t).value);
  return { year: g('year'), month: g('month'), day: g('day'), h: g('hour') % 24, m: g('minute'), s: g('second') };
}

function etDateStr() {
  const { year, month, day } = etNow();
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function etOffsetStr() {
  const utcH = new Date().getUTCHours();
  const etH  = etNow().h;
  const diff  = (utcH - etH + 24) % 24;
  return diff <= 4 ? '-04:00' : '-05:00';
}

function isAfterET(h, m, s = 0) {
  const et = etNow();
  return (et.h * 3600 + et.m * 60 + et.s) >= (h * 3600 + m * 60 + s);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitUntilET(h, m, s = 0, label = '') {
  while (!isAfterET(h, m, s)) {
    const et = etNow();
    const secLeft = Math.max(0, (h * 3600 + m * 60 + s) - (et.h * 3600 + et.m * 60 + et.s));
    process.stdout.write(`\r  ⏳  ${label || `${h}:${String(m).padStart(2,'0')} ET`} in ${Math.floor(secLeft/60)}m ${secLeft%60}s   `);
    await sleep(Math.min(secLeft * 1000, 20_000));
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

function log(msg) {
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  console.log(`[${t} ET] ${msg}`);
}

// ─── Screener ─────────────────────────────────────────────
async function runScreener() {
  let candidates = [];

  try {
    const movers = await alpaca.getMovers();
    const all = [...(movers.gainers || []), ...(movers.losers || [])];
    const moverSyms = all.map(m => m.symbol);
    // Always combine movers with the liquid fallback list — movers API
    // tends to return micro-caps; fallback catches liquid names that moved
    candidates = [...new Set([...moverSyms, ...FALLBACK])];
    log(`Movers API: ${moverSyms.length} movers + ${FALLBACK.length} liquid universe = ${candidates.length} candidates`);
  } catch (e) {
    log(`Movers API unavailable (${e.message.slice(0,60)}) — using fallback universe`);
    candidates = FALLBACK;
  }

  // Batch snapshot requests (API max 100 per request)
  const batches = [];
  for (let i = 0; i < candidates.length; i += 100) batches.push(candidates.slice(i, i + 100));

  const qualifying = [];

  for (const batch of batches) {
    try {
      const snaps = await alpaca.getSnapshots(batch);
      for (const [sym, snap] of Object.entries(snaps)) {
        const prevClose   = snap.prevDailyBar?.c;
        const price       = snap.latestTrade?.p ?? snap.minuteBar?.c;
        // Use PREVIOUS day's volume — today's pre-market volume is tiny before open.
        // prevDailyBar.v tells us if the stock is normally liquid (500k+ day).
        const prevVolume  = snap.prevDailyBar?.v ?? 0;
        if (!prevClose || !price) continue;

        const changePct = Math.abs((price - prevClose) / prevClose * 100);
        if (changePct >= cfg.MIN_PREMARKET_CHANGE_PCT && prevVolume >= cfg.MIN_VOLUME && price >= cfg.MIN_PRICE) {
          qualifying.push({ symbol: sym, price, changePct, volume: prevVolume });
        }
      }
    } catch (e) {
      log(`Snapshot error: ${e.message}`);
    }
  }

  qualifying.sort((a, b) => b.changePct - a.changePct);
  const watchlist = qualifying.slice(0, cfg.MAX_WATCHLIST);

  console.log(`\n  Screener results (${watchlist.length} qualify):`);
  watchlist.forEach(s =>
    console.log(`    ${s.symbol.padEnd(6)} ${s.changePct.toFixed(1).padStart(5)}% move  vol=${s.volume.toLocaleString().padStart(12)}  $${s.price.toFixed(2)}`)
  );
  console.log('');

  return watchlist.map(s => s.symbol);
}

// ─── Opening Range ─────────────────────────────────────────
async function fetchOR(symbols) {
  const date   = etDateStr();
  const offset = etOffsetStr();
  const start  = `${date}T09:30:00${offset}`;
  const end    = `${date}T09:44:59${offset}`;

  try {
    const resp = await alpaca.getBars(symbols, '1Min', { start, end, limit: 20, sort: 'asc' });
    const result = {};
    for (const [sym, bars] of Object.entries(resp.bars || {})) {
      if (bars.length === 0) continue;
      result[sym] = {
        h: Math.max(...bars.map(b => b.h)),
        l: Math.min(...bars.map(b => b.l)),
      };
    }
    return result;
  } catch (e) {
    log(`OR fetch error: ${e.message}`);
    return {};
  }
}

// ─── Orders ───────────────────────────────────────────────
function calcQty(price) {
  return Math.max(1, Math.floor(perPositionUSD / price));
}

async function cancelSafe(orderId) {
  if (!orderId) return;
  try { await alpaca.cancelOrder(orderId); } catch (_) { /* already filled/cancelled */ }
}

async function enterTrade(symbol, direction, qty, stopPrice) {
  const entrySide = direction === 'LONG' ? 'buy' : 'sell';
  const stopSide  = direction === 'LONG' ? 'sell' : 'buy';
  const intent    = direction === 'LONG' ? 'sell_to_close' : 'buy_to_close';

  await alpaca.placeOrder({ symbol, qty, side: entrySide, type: 'market', time_in_force: 'day' });

  // Safety-net stop order at OR midpoint (backup if bot crashes)
  let stopOrderId = null;
  try {
    const stopOrd = await alpaca.placeOrder({
      symbol, qty, side: stopSide, type: 'stop', time_in_force: 'day',
      stop_price: stopPrice.toFixed(2), position_intent: intent,
    });
    stopOrderId = stopOrd.id;
  } catch (e) {
    log(`[${symbol}] Warning: could not place safety stop — ${e.message}`);
  }

  return stopOrderId;
}

async function exitTrade(symbol) {
  const info = positions.get(symbol);
  if (!info) return;
  await cancelSafe(info.stopOrderId);
  await sleep(300); // brief pause so cancel processes first
  try {
    await alpaca.closePosition(symbol);
  } catch (e) {
    // Position may have already been closed by the safety stop — that's fine
    log(`[${symbol}] Close position: ${e.message}`);
  }
  positions.delete(symbol);
}

// ─── Process one bar pushed from the WebSocket ────────────
async function processIncomingBar(symbol, bar) {
  const strat = strategies.get(symbol);
  if (!strat || strat.state === STATE.DONE) return;
  if (!isAfterET(9, 45)) return; // ignore bars that arrive before OR is set

  const signal = strat.processBar(bar);
  if (!signal) return;

  if (signal.action === 'BUY' || signal.action === 'SELL_SHORT') {
    if (positions.has(symbol)) return;
    const qty = calcQty(signal.price);
    try {
      const stopId = await enterTrade(symbol, strat.direction, qty, signal.stop);
      positions.set(symbol, { qty, stopOrderId: stopId });
      log(`[${symbol}] ${signal.action}  ${qty} shares @ ~$${signal.price.toFixed(2)}  stop=$${signal.stop.toFixed(2)}`);
    } catch (e) {
      log(`[${symbol}] Entry failed: ${e.message}`);
      strat.state = STATE.DONE;
    }
  } else if (signal.action === 'CLOSE') {
    if (!positions.has(symbol)) { strat.state = STATE.DONE; return; }
    try {
      await exitTrade(symbol);
      log(`[${symbol}] Position closed`);
    } catch (e) {
      log(`[${symbol}] Close failed: ${e.message}`);
    }
  }
}

// ─── Real-time WebSocket data stream ─────────────────────
function startDataStream(watchlist) {
  const WS_URL = 'wss://stream.data.alpaca.markets/v2/iex';
  let ws          = null;
  let reconnectMs = 1_000;
  let closing     = false;

  function connect() {
    if (closing) return;
    log('WebSocket: connecting...');
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'auth', key: cfg.KEY, secret: cfg.SECRET }));
    };

    ws.onmessage = async (event) => {
      let msgs;
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        msgs = JSON.parse(raw);
      } catch { return; }

      for (const msg of msgs) {
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          ws.send(JSON.stringify({ action: 'subscribe', bars: watchlist }));
          log(`WebSocket: live — subscribed to bars for ${watchlist.length} symbols`);
          reconnectMs = 1_000; // reset backoff after successful auth
        } else if (msg.T === 'b') {
          // Completed 1-min bar pushed by Alpaca (~1 s after bar close)
          await processIncomingBar(msg.S, msg);
        } else if (msg.T === 'error') {
          log(`WebSocket server error: ${msg.msg} (code ${msg.code})`);
        }
      }
    };

    ws.onclose = (event) => {
      if (closing) return;
      log(`WebSocket: closed (code=${event.code}) — reconnecting in ${reconnectMs / 1000}s`);
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 30_000);
    };

    ws.onerror = () => log('WebSocket: connection error');
  }

  connect();
  return () => { closing = true; ws?.close(1000, 'EOD'); };
}

// ─── End-of-day liquidation ────────────────────────────────
async function endOfDay() {
  log('End of day — liquidating all open positions...');
  for (const sym of [...positions.keys()]) {
    try {
      await exitTrade(sym);
      log(`[${sym}] EOD closed`);
    } catch (e) {
      log(`[${sym}] EOD close error: ${e.message}`);
    }
  }
  for (const s of strategies.values()) s.state = STATE.DONE;
}

// ─── Main ──────────────────────────────────────────────────
async function run() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  ORB Trader — Alpaca Paper Trading Bot  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Verify connection
  try {
    const acct = await alpaca.getAccount();
    log(`Connected  account=${acct.account_number}  buying_power=$${parseFloat(acct.buying_power).toLocaleString()}`);
  } catch (e) {
    console.error('❌ Failed to connect to Alpaca:', e.message);
    process.exit(1);
  }

  // Bail out if already past EOD — nothing to trade today
  if (isAfterET(cfg.EOD_HOUR, cfg.EOD_MINUTE)) {
    log(`Past end-of-day (${cfg.EOD_HOUR}:${String(cfg.EOD_MINUTE).padStart(2,'0')} ET) — market session over. Exiting.`);
    process.exit(0);
  }

  // 1. Pre-market screen
  if (!isAfterET(cfg.SCREEN_HOUR, cfg.SCREEN_MINUTE)) {
    await waitUntilET(cfg.SCREEN_HOUR, cfg.SCREEN_MINUTE, 0, '9:15 AM ET screener');
  }
  log('Running pre-market screener...');
  const watchlist = await runScreener();

  if (watchlist.length === 0) {
    log('No stocks qualified today. Exiting.');
    process.exit(0);
  }
  for (const sym of watchlist) strategies.set(sym, new SymbolStrategy(sym));

  // 2. At 9:29 AM ET — size positions: equity ÷ number of qualifying stocks
  if (!isAfterET(9, 29)) await waitUntilET(9, 29, 0, 'Position sizing at 9:29 AM ET');
  try {
    const acct   = await alpaca.getAccount();
    const equity = parseFloat(acct.equity);
    perPositionUSD = equity / watchlist.length;
    log(`Position size: $${equity.toFixed(2)} equity / ${watchlist.length} stocks = $${perPositionUSD.toFixed(2)} per trade`);
  } catch (e) {
    log(`Warning: could not fetch equity — using fallback $${perPositionUSD.toFixed(2)} per trade`);
  }

  // 3. Wait for market open
  if (!isAfterET(9, 30)) await waitUntilET(9, 30, 0, 'Market open 9:30 AM ET');

  // 4. Wait for OR to complete (9:45 + 10s for Alpaca to finalize the bar)
  if (!isAfterET(9, 45, 10)) await waitUntilET(9, 45, 10, 'OR complete 9:45 AM ET');

  // 5. Fetch and set OR for each symbol
  log('Fetching opening range bars...');
  const orBars = await fetchOR(watchlist);
  let ready = 0;
  for (const sym of watchlist) {
    if (orBars[sym]) {
      strategies.get(sym).setOR(orBars[sym].h, orBars[sym].l);
      ready++;
    } else {
      log(`[${sym}] No OR data — skipping`);
      strategies.get(sym).state = STATE.DONE;
    }
  }
  log(`\nWatching ${ready} symbols for breakout → retest → reclaim setups\n`);

  // 6. Start real-time WebSocket stream + schedule EOD close
  log('Starting real-time data stream...\n');
  const stopStream = startDataStream(watchlist);

  const et = etNow();
  const secsToEOD = Math.max(0,
    (cfg.EOD_HOUR * 3600 + cfg.EOD_MINUTE * 60) -
    (et.h * 3600 + et.m * 60 + et.s)
  );
  setTimeout(async () => {
    stopStream();
    await endOfDay();
    process.exit(0);
  }, secsToEOD * 1000);
}

// Handle unexpected shutdown — close all positions
process.on('SIGINT',  async () => { await endOfDay(); process.exit(0); });
process.on('SIGTERM', async () => { await endOfDay(); process.exit(0); });

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
