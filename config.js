module.exports = {
  KEY:    process.env.ALPACA_KEY    || 'PKMAUNWZP62ZCYGRKWMTC2F5W5',
  SECRET: process.env.ALPACA_SECRET || 'FDowHYegF8BxoHFaYvtiifxhUVoLNCr1uYkgqHAx4yXF',
  TRADE_URL: 'https://paper-api.alpaca.markets',
  DATA_URL:  'https://data.alpaca.markets',

  // ── Screener ─────────────────────────────────────────────
  MIN_PREMARKET_CHANGE_PCT: 2,    // >2% pre-market move
  MIN_VOLUME:               500_000, // 500k+ volume
  MIN_PRICE:                5,    // $5+ stock
  MAX_WATCHLIST:            20,   // max symbols to track at once

  // ── Position sizing ───────────────────────────────────────
  // Computed dynamically at 9:29 AM ET: equity / # screened stocks.
  // Used only as a fallback if the account fetch fails at sizing time.
  FALLBACK_POSITION_USD: 500,

  // ── Stop phases ───────────────────────────────────────────
  PHASE2_PROFIT_PCT: 5,           // % gain to activate trailing stop
  PHASE2_TRAIL_PCT:  2,           // 2% trailing stop (phase 2)
  PHASE3_HOURS:      3.5,         // hours in trade before time stop
  PHASE3_TRAIL_PCT:  1,           // 1% trailing stop (phase 3, time-based)

  // ── Timing ───────────────────────────────────────────────
  SCREEN_HOUR:   9,
  SCREEN_MINUTE: 15,
  EOD_HOUR:   parseInt(process.env.EOD_HOUR)   || 15,
  EOD_MINUTE: parseInt(process.env.EOD_MINUTE) || 55,
};
