const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CUSTOM_SYMBOLS_FILE = path.join(__dirname, 'custom-symbols.json');

app.use(express.json());

// אישור CORS לחיבור מ-Google AI Studio ומדפדפנים חיצוניים
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(__dirname));

// רשימת המניות הבסיסית לסריקה
const DEFAULT_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX',
  'AMD', 'QCOM', 'TXN', 'INTU', 'AMAT', 'MU', 'LRCX', 'KLAC', 'SNPS', 'CDNS',
  'ADBE', 'CRM', 'ORCL', 'PANW', 'CRWD', 'PLTR', 'SNOW', 'DDOG', 'NET', 'ZS',
  'ISRG', 'VRTX', 'REGN', 'GILD', 'AMGN', 'MRNA', 'PEP', 'SBUX', 'MDLZ', 'MNST',
  'BKNG', 'ABNB', 'UBER', 'DASH', 'PYPL', 'COIN', 'TTWO', 'EA', 'IONQ', 'QUBT'
];

// טעינה ושמירה של מניות שנוספו ידנית
function loadCustomSymbols() {
  try {
    if (!fs.existsSync(CUSTOM_SYMBOLS_FILE)) return [];
    const raw = fs.readFileSync(CUSTOM_SYMBOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(s => String(s).trim().toUpperCase()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function saveCustomSymbols(list) {
  try {
    const unique = [...new Set(list.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
    fs.writeFileSync(CUSTOM_SYMBOLS_FILE, JSON.stringify(unique, null, 2), 'utf8');
    return unique;
  } catch (err) {
    console.error('Failed saving custom symbols:', err.message);
    return list;
  }
}

function getAllSymbols(extraSymbols = []) {
  const custom = loadCustomSymbols();
  return [...new Set([
    ...DEFAULT_SYMBOLS,
    ...custom,
    ...extraSymbols.map(s => String(s).trim().toUpperCase()).filter(Boolean)
  ])];
}

// משיכת נתונים מ-Yahoo Finance
async function fetchStockData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  if (!res.ok) return null;
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0];
  const timestamps = result.timestamp || [];
  if (!quote || !quote.close || quote.close.length < 30) return null;

  const candles = [];
  for (let i = 0; i < quote.close.length; i++) {
    const close = quote.close[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const ts = timestamps[i];
    if (close != null && high != null && low != null) {
      candles.push({ close, high, low, timestamp: ts });
    }
  }

  if (candles.length < 30) return null;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    exchange: meta.exchangeName || meta.fullExchangeName || 'NASDAQ',
    candles
  };
}

// חישוב ממוצע נע (SMA)
function calculateSMA(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / period;
}

// חישוב ATR 14
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose)
    );
    trs.push(tr);
  }
  const recent = trs.slice(trs.length - period);
  return recent.reduce((acc, v) => acc + v, 0) / period;
}

// ניתוח מניה מלא
function buildStockAnalysis(stock) {
  const { symbol, name, candles } = stock;
  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const smaPeriod = Math.min(200, closes.length);
  const sma200 = calculateSMA(closes, smaPeriod) ?? last.close;
  const atr14 = calculateATR(candles, 14) ?? Math.max(0.5, last.close * 0.02);

  const lookbackStart = Math.max(0, candles.length - 21);
  const lookbackEnd = Math.max(lookbackStart + 1, candles.length - 1);
  const lookback = candles.slice(lookbackStart, lookbackEnd);
  const breakoutLevel = lookback.length > 0
    ? Math.max(...lookback.map(c => c.high))
    : last.high;

  const isActiveBreakout = Boolean(last.close > sma200 && last.close > breakoutLevel);
  const isFresh = prev.close <= breakoutLevel;

  const diffPercent = breakoutLevel > 0
    ? Number((((last.close - breakoutLevel) / breakoutLevel) * 100).toFixed(2))
    : 0;

  // קרוב לפריצה: מעל SMA200 ובטווח של עד 3% מתחת לרמת הפריצה
  const isNearBreakout = Boolean(
    !isActiveBreakout &&
    last.close > sma200 &&
    diffPercent >= -3 &&
    diffPercent < 0
  );

  const rawStop = sma200 - 2 * atr14;
  const stopLoss = Number(Math.max(0.01, rawStop).toFixed(2));
  const riskPercent = last.close > 0
    ? Number((((last.close - stopLoss) / last.close) * 100).toFixed(1))
    : 0;

  let breakoutDate = null;
  let breakoutDaysAgo = null;
  if (isActiveBreakout && last.timestamp) {
    const d = new Date(last.timestamp * 1000);
    breakoutDate = d.toISOString().slice(0, 10);
    breakoutDaysAgo = 0;
  }

  const status = isActiveBreakout
    ? (isFresh ? 'פריצה טרייה מעל SMA200' : 'פריצה פעילה מעל SMA200')
    : isNearBreakout
      ? 'קרוב לפריצה · מעל SMA200'
      : (last.close > sma200 ? 'מעל SMA200 · ממתין לפריצת שיא 20 ימים' : 'מתחת ל-SMA200');

  return {
    symbol,
    name,
    price: Number(last.close.toFixed(2)),
    breakoutLevel: Number(breakoutLevel.toFixed(2)),
    sma200: Number(sma200.toFixed(2)),
    atr14: Number(atr14.toFixed(2)),
    stopLoss,
    riskPercent,
    diffPercent,
    isBreakout: isActiveBreakout,
    isActiveBreakout,
    isNearBreakout,
    isFresh,
    breakoutDate,
    breakoutDaysAgo,
    status
  };
}

// הרצת סריקה — מחזירה פריצות פעילות וגם מניות קרוב לפריצה (עד 3%)
async function runScan(symbols = []) {
  const targetList = getAllSymbols(symbols);
  const breakouts = [];
  const nearBreakouts = [];

  for (const symbol of targetList) {
    try {
      const stock = await fetchStockData(symbol);
      if (!stock) continue;
      const analysis = buildStockAnalysis(stock);
      if (analysis.isActiveBreakout) {
        breakouts.push(analysis);
      } else if (analysis.isNearBreakout) {
        nearBreakouts.push(analysis);
      }
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err.message);
    }
  }

  return { breakouts, nearBreakouts, scannedCount: targetList.length };
}

// שליחת הודעה לטלגרם
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: false
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram API error: ${errText}`);
  }
}

// דף הבית
app.get('/', (req, res) => {
  res.send('TAO2 Scanner is running');
});

// ניהול מניות ידניות (הוספה / צפייה / הסרה)
app.get('/api/watchlist', (req, res) => {
  res.json({
    ok: true,
    defaultSymbols: DEFAULT_SYMBOLS,
    customSymbols: loadCustomSymbols(),
    allSymbols: getAllSymbols()
  });
});

app.post('/api/watchlist', (req, res) => {
  const incoming = Array.isArray(req.body?.symbols)
    ? req.body.symbols
    : (req.body?.symbol ? [req.body.symbol] : []);

  const normalized = incoming.map(s => String(s).trim().toUpperCase()).filter(Boolean);
  if (normalized.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing symbol' });
  }

  const current = loadCustomSymbols();
  const updated = saveCustomSymbols([...current, ...normalized]);
  res.json({ ok: true, customSymbols: updated, allSymbols: getAllSymbols() });
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const target = String(req.params.symbol || '').trim().toUpperCase();
  const current = loadCustomSymbols().filter(s => s !== target);
  const updated = saveCustomSymbols(current);
  res.json({ ok: true, customSymbols: updated, allSymbols: getAllSymbols() });
});

// חיפוש מניות להשלמה אוטומטית (/api/search?q=...)
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!response.ok) return res.json([]);
    const data = await response.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

    const filtered = quotes
      .filter(item => item.symbol && (item.quoteType === 'EQUITY' || item.quoteType === 'ETF'))
      .map(item => ({
        symbol: String(item.symbol).toUpperCase(),
        name: item.shortname || item.longname || String(item.symbol).toUpperCase(),
        exchange: item.exchDisp || item.exchange || 'US'
      }));

    res.json(filtered);
  } catch (err) {
    console.error('Search error:', err.message);
    res.json([]);
  }
});

// נתיב סריקה (GET)
app.get('/api/scan', async (req, res) => {
  try {
    const { breakouts, nearBreakouts, scannedCount } = await runScan();
    res.json({
      ok: true,
      count: breakouts.length,
      nearCount: nearBreakouts.length,
      scannedCount,
      breakouts,
      nearBreakouts
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// נתיב סריקה (POST - קולט כל מניה שהוספת ידנית באפליקציה וסורק אותה)
app.post('/api/scan', async (req, res) => {
  try {
    const manualSymbols = Array.isArray(req.body?.symbols)
      ? req.body.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean)
      : [];

    // אם האפליקציה שולחת את הרשימה הידנית שלה, נשמור אותה גם כרשימה הידנית הפעילה
    if (Array.isArray(req.body?.symbols)) {
      saveCustomSymbols(manualSymbols);
    }

    const { breakouts, nearBreakouts, scannedCount } = await runScan(manualSymbols);
    res.json({
      ok: true,
      count: breakouts.length,
      nearCount: nearBreakouts.length,
      scannedCount,
      breakouts,
      nearBreakouts
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// בדיקת מניה בודדת
async function handleSingleStock(req, res) {
  try {
    const rawSymbol = req.params.symbol || req.query.symbol || req.body?.symbol || '';
    const symbol = String(rawSymbol).trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ ok: false, error: 'Missing symbol' });
    }

    const stock = await fetchStockData(symbol);
    if (!stock) {
      return res.status(404).json({ ok: false, error: 'Symbol not found' });
    }

    const analysis = buildStockAnalysis(stock);
    res.json(analysis);
  } catch (err) {
    console.error('Single stock error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.get('/api/check/:symbol', handleSingleStock);
app.get('/api/stock/:symbol', handleSingleStock);
app.get('/api/check', handleSingleStock);
app.get('/api/stock', handleSingleStock);

// נתיב התראות לטלגרם
app.get('/api/alert', async (req, res) => {
  try {
    if (req.query.test === 'true') {
      await sendTelegramMessage('<b>TAO 2</b>\nהודעת בדיקה — הבוט מחובר ועובד!');
      return res.json({ ok: true, message: 'Test alert sent!' });
    }

    const freshOnly = req.query.freshOnly === 'true';
    const { breakouts: allBreakouts } = await runScan();
    let breakouts = allBreakouts;

    if (freshOnly) {
      breakouts = breakouts.filter(b => b.isFresh);
    }

    if (breakouts.length === 0) {
      await sendTelegramMessage('<b>TAO 2</b>\nאוהד ערב טוב, אין פריצה — אתה יכול לישון בשקט');
      return res.json({ ok: true, sent: 0, message: 'No breakouts found (evening message sent)' });
    }

    const cards = breakouts.map(s => {
      const safeName = String(s.name || s.symbol)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(s.symbol)}`;

      return [
        '<blockquote>',
        `<b>${s.symbol}</b> · ${safeName}`,
        '',
        `<b>מחיר</b> — $${s.price.toFixed(2)}`,
        `<b>פריצה</b> — $${s.breakoutLevel.toFixed(2)}`,
        `<b>סטופ</b> — $${s.stopLoss.toFixed(2)}`,
        `<b>מרחק לסטופ</b> — ${s.riskPercent}%`,
        '',
        `<a href="${tvUrl}">פתח גרף ↗</a>`,
        '</blockquote>'
      ].join('\n');
    });

    const title = breakouts.length === 1
      ? '<b>TAO 2 · פריצה חדשה</b>'
      : `<b>TAO 2 · ${breakouts.length} פריצות חדשות</b>`;

    const message = `${title}\n\n${cards.join('\n\n')}`;
    await sendTelegramMessage(message);

    res.json({ ok: true, sent: breakouts.length });
  } catch (err) {
    console.error('Alert error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TAO2 Scanner listening on port ${PORT}`);
});