const cfg = require('./config');

const STATE = {
  WATCHING_OR:      'WATCHING_OR',
  WAITING_BREAKOUT: 'WAITING_BREAKOUT',
  WAITING_RETEST:   'WAITING_RETEST',
  WAITING_RECLAIM:  'WAITING_RECLAIM',
  IN_TRADE:         'IN_TRADE',
  DONE:             'DONE',
};

class SymbolStrategy {
  constructor(symbol, silent = false) {
    this.symbol    = symbol;
    this.silent    = silent;
    this.state     = STATE.WATCHING_OR;
    this.orHigh    = null;
    this.orLow     = null;
    this.orMid     = null;
    this.direction = null;   // 'LONG' | 'SHORT'
    this.entryPrice = null;
    this.entryTime  = null;
    this.stopPrice  = null;
    this.hwm        = null;  // high-water mark (LONG trailing)
    this.lwm        = null;  // low-water mark  (SHORT trailing)
    this.phase      = 1;     // 1 = hard stop, 2 = 2% trail, 3 = time trail
    this.hit5pct    = false;
  }

  setOR(high, low) {
    this.orHigh = high;
    this.orLow  = low;
    this.orMid  = (high + low) / 2;
    this.state  = STATE.WAITING_BREAKOUT;
    this._log(`OR set  H=${high.toFixed(2)}  L=${low.toFixed(2)}  Mid=${this.orMid.toFixed(2)}`);
  }

  // Returns { action, price, stop } on a trade event, otherwise null.
  // action is 'BUY' | 'SELL_SHORT' | 'CLOSE'
  processBar(bar) {
    const green = bar.c >= bar.o;
    const red   = bar.c <  bar.o;
    switch (this.state) {
      case STATE.WAITING_BREAKOUT: return this._breakout(bar, green, red);
      case STATE.WAITING_RETEST:   return this._retest(bar, green, red);
      case STATE.WAITING_RECLAIM:  return this._reclaim(bar, green, red);
      case STATE.IN_TRADE:         return this._manage(bar);
      default: return null;
    }
  }

  // ── Breakout ──────────────────────────────────────────────
  _breakout(bar, green, red) {
    if (bar.c > this.orHigh && green) {
      this.direction = 'LONG';
      this.state     = STATE.WAITING_RETEST;
      this._log(`Breakout ABOVE ${bar.c.toFixed(2)}`);
    } else if (bar.c < this.orLow && red) {
      this.direction = 'SHORT';
      this.state     = STATE.WAITING_RETEST;
      this._log(`Breakout BELOW ${bar.c.toFixed(2)}`);
    }
    return null;
  }

  // ── Retest ────────────────────────────────────────────────
  _retest(bar, green, red) {
    const touched = this.direction === 'LONG'
      ? bar.l <= this.orHigh   // wick or full close back into range
      : bar.h >= this.orLow;

    if (!touched) return null;

    // Same bar can serve as retest AND reclaim (wick + close back outside)
    const sig = this._tryReclaim(bar, green, red);
    if (sig) return sig;

    this.state = STATE.WAITING_RECLAIM;
    this._log(`Retest of OR range`);
    return null;
  }

  // ── Reclaim ───────────────────────────────────────────────
  _reclaim(bar, green, red) {
    // Setup is dead if price breaks through the other side of the OR
    if (this.direction === 'LONG' && bar.c < this.orLow && red) {
      this._invalidate(); return null;
    }
    if (this.direction === 'SHORT' && bar.c > this.orHigh && green) {
      this._invalidate(); return null;
    }
    return this._tryReclaim(bar, green, red);
  }

  _tryReclaim(bar, green, red) {
    if (this.direction === 'LONG'  && bar.c > this.orHigh && green) return this._enter(bar);
    if (this.direction === 'SHORT' && bar.c < this.orLow  && red)   return this._enter(bar);
    return null;
  }

  _enter(bar) {
    this.state      = STATE.IN_TRADE;
    this.entryPrice = bar.c;
    this.entryTime  = new Date(bar.t);
    this.stopPrice  = this.orMid;
    this.phase      = 1;
    this.hit5pct    = false;
    this.hwm        = bar.h;
    this.lwm        = bar.l;

    const action = this.direction === 'LONG' ? 'BUY' : 'SELL_SHORT';
    this._log(`ENTER ${action}  price=${bar.c.toFixed(2)}  stop=${this.stopPrice.toFixed(2)}`);
    return { action, price: bar.c, stop: this.stopPrice };
  }

  _invalidate() {
    this._log('Setup invalidated — reversal through OR; back to watching breakouts');
    this.direction = null;
    this.state     = STATE.WAITING_BREAKOUT;
  }

  // ── Position management ───────────────────────────────────
  _manage(bar) {
    const hoursHeld = (new Date(bar.t) - this.entryTime) / 3_600_000;
    return this.direction === 'LONG'
      ? this._manageLong(bar, hoursHeld)
      : this._manageShort(bar, hoursHeld);
  }

  _manageLong(bar, hours) {
    if (bar.h > this.hwm) this.hwm = bar.h;

    const pct = (bar.c - this.entryPrice) / this.entryPrice * 100;

    // Phase 1 → 2: hit 5% profit
    if (!this.hit5pct && pct >= cfg.PHASE2_PROFIT_PCT) {
      this.hit5pct = true;
      this.phase   = 2;
      this._log(`Phase 2: 2% trailing stop activated  (up ${pct.toFixed(1)}%)`);
    }

    // Phase 1/2 → 3: time limit without 5% hit
    if (this.phase < 3 && !this.hit5pct && hours >= cfg.PHASE3_HOURS) {
      this.phase = 3;
      const ts = bar.c * (1 - cfg.PHASE3_TRAIL_PCT / 100);
      this.stopPrice = Math.max(ts, this.orMid);
      this._log(`Phase 3: time stop @ ${this.stopPrice.toFixed(2)}  (held ${hours.toFixed(1)}h)`);
    }

    // Update trailing stop price per phase
    if (this.phase === 2) {
      const ts = this.hwm * (1 - cfg.PHASE2_TRAIL_PCT / 100);
      if (ts > this.stopPrice) this.stopPrice = ts;
    } else if (this.phase === 3) {
      const ts = this.hwm * (1 - cfg.PHASE3_TRAIL_PCT / 100);
      this.stopPrice = Math.max(ts, this.orMid);
    }

    if (bar.l <= this.stopPrice) {
      this.state = STATE.DONE;
      this._log(`STOP OUT  stop=${this.stopPrice.toFixed(2)}`);
      return { action: 'CLOSE' };
    }
    return null;
  }

  _manageShort(bar, hours) {
    if (bar.l < this.lwm) this.lwm = bar.l;

    const pct = (this.entryPrice - bar.c) / this.entryPrice * 100;

    if (!this.hit5pct && pct >= cfg.PHASE2_PROFIT_PCT) {
      this.hit5pct = true;
      this.phase   = 2;
      this._log(`Phase 2: 2% trailing stop activated  (up ${pct.toFixed(1)}%)`);
    }

    if (this.phase < 3 && !this.hit5pct && hours >= cfg.PHASE3_HOURS) {
      this.phase = 3;
      const ts = bar.c * (1 + cfg.PHASE3_TRAIL_PCT / 100);
      this.stopPrice = Math.min(ts, this.orMid);
      this._log(`Phase 3: time stop @ ${this.stopPrice.toFixed(2)}  (held ${hours.toFixed(1)}h)`);
    }

    if (this.phase === 2) {
      const ts = this.lwm * (1 + cfg.PHASE2_TRAIL_PCT / 100);
      if (ts < this.stopPrice) this.stopPrice = ts;
    } else if (this.phase === 3) {
      const ts = this.lwm * (1 + cfg.PHASE3_TRAIL_PCT / 100);
      this.stopPrice = Math.min(ts, this.orMid);
    }

    if (bar.h >= this.stopPrice) {
      this.state = STATE.DONE;
      this._log(`STOP OUT  stop=${this.stopPrice.toFixed(2)}`);
      return { action: 'CLOSE' };
    }
    return null;
  }

  _log(msg) {
    if (this.silent) return;
    const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${t} ET] [${this.symbol}] ${msg}`);
  }
}

module.exports = { SymbolStrategy, STATE };
