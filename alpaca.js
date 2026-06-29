const { KEY, SECRET, TRADE_URL, DATA_URL } = require('./config');

const H = {
  'APCA-API-KEY-ID':     KEY,
  'APCA-API-SECRET-KEY': SECRET,
  'Content-Type':        'application/json',
};

async function req(url, method = 'GET', body = null) {
  const opts = { method, headers: H };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${url.replace(/https:\/\/[^/]+/, '')}: ${text.slice(0, 300)}`);
  return data;
}

const trade = (path, m, b) => req(`${TRADE_URL}${path}`, m, b);
const data  = (path)        => req(`${DATA_URL}${path}`);

module.exports = {
  getAccount:       ()    => trade('/v2/account'),
  getClock:         ()    => trade('/v2/clock'),
  placeOrder:       (p)   => trade('/v2/orders', 'POST', p),
  cancelOrder:      (id)  => trade(`/v2/orders/${id}`, 'DELETE'),
  cancelAllOrders:  ()    => trade('/v2/orders', 'DELETE'),
  getPositions:     ()    => trade('/v2/positions'),
  closePosition:    (sym) => trade(`/v2/positions/${encodeURIComponent(sym)}`, 'DELETE'),
  closeAllPositions:()    => trade('/v2/positions', 'DELETE'),

  getSnapshots: (symbols) => {
    const qs = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
    return data(`/v2/stocks/snapshots?${qs}`);
  },

  getMovers: () => data('/v1beta1/screener/stocks/movers?top=50'),

  getBars: (symbols, timeframe, { start, end, limit = 3, sort = 'desc' } = {}) => {
    const qs = new URLSearchParams({ symbols: symbols.join(','), timeframe, feed: 'iex' });
    if (start)  qs.set('start', start);
    if (end)    qs.set('end',   end);
    qs.set('limit', String(limit));
    qs.set('sort',  sort);
    return data(`/v2/stocks/bars?${qs}`);
  },
};
