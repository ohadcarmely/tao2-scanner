const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

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

// רשימת המניות לסריקה
const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX',
  'AMD', 'QCOM', 'TXN', 'INTU', 'AMAT', 'MU', 'LRCX', 'KLAC', 'SNPS', 'CDNS',
  'ADBE', 'CRM', 'ORCL', 'PANW', 'CRWD', 'PLTR', 'SNOW', 'DDOG', 'NET', 'ZS',
  'ISRG', 'VRTX', 'REGN', 'GILD', 'AMGN', 'MRNA', 'PEP', 'SBUX', 'MDLZ', 'MNST',
  'BKNG', 'ABNB', 'UBER', 'DASH', 'PYPL', 'COIN', 'TTWO', 'EA', 'IONQ', 'QUBT'
];

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
  if (!quote || !quote.close || quote.close.length < 205) return null;

  const candles = [];
  for (let i = 0; i < quote.close.length; i++) {
    const close = quote.close[i];
    const high = quote.high[i];
    const low = quote.low[i];
    if (close != null && high != null && low != null) {
      candles.push({ close, high, low });
    }
  }

  if (candles.length < 205) return null;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    candles
  };
}

// חישוב ממוצע נע (SMA)
function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / period;
}

// חישוב ATR 14
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
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

// ניתוח מניה לפי TAO 2
function analyzeStock(stock) {
  const { symbol, name, candles } = stock;
  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const sma200 = calculateSMA(closes, 200);
  const atr14 = calculateATR(candles, 14);
  if (!sma200 || !atr14) return null;

  // רמת פריצה: שיא של 20 ימי המסחר הקודמים (ללא היום האחרון)
  const lookback = candles.slice(candles.length - 21, candles.length - 1);
  const breakoutLevel = Math.max(...lookback.map(c => c.high));

  // תנאי פריצה: מחיר מעל SMA 200 ומעל רמת הפריצה
  const isBreakout = last.close > sma200 && last.close > breakoutLevel;
  if (!isBreakout) return null;

  // האם הפריצה טרייה מהיום האחרון
  const isFresh = prev.close <= breakoutLevel;

  // סטופ לוס: SMA 200 פחות 2 ATR
  const stopLoss = Math.max(0.01, sma200 - 2 * atr14);
  const riskPercent = Number((((last.close - stopLoss) / last.close) * 100).toFixed(1));

  return {
    symbol,
    name,
    price: last.close,
    breakoutLevel,
    sma200,
    atr14,
    stopLoss,
    riskPercent,
    isFresh
  };
}

// הרצת סריקה על כל המניות
async function runScan(symbols = SYMBOLS) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const stock = await fetchStockData(symbol);
      if (!stock) continue;
      const analysis = analyzeStock(stock);
      if (analysis) results.push(analysis);
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err.message);
    }
  }
  return results;
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

// דף הבית / בדיקת זמינות
app.get('/', (req, res) => {
  res.send('TAO2 Scanner is running');
});

// נתיב סריקה (GET)
app.get('/api/scan', async (req, res) => {
  try {
    const breakouts = await runScan();
    res.json({ ok: true, count: breakouts.length, breakouts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// נתיב סריקה (POST - לרשימות מניות מותאמות מהאפליקציה)
app.post('/api/scan', async (req, res) => {
  try {
    const symbols = Array.isArray(req.body?.symbols) && req.body.symbols.length > 0
      ? req.body.symbols
      : SYMBOLS;
    const breakouts = await runScan(symbols);
    res.json({ ok: true, count: breakouts.length, breakouts });
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

    const { name, candles } = stock;
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const sma200 = calculateSMA(closes, 200);
    const atr14 = calculateATR(candles, 14);
    const lookback = candles.slice(candles.length - 21, candles.length - 1);
    const breakoutLevel = Math.max(...lookback.map(c => c.high));

    const isBreakout = Boolean(sma200 && atr14 && last.close > sma200 && last.close > breakoutLevel);
    const isFresh = prev.close <= breakoutLevel;
    const stopLoss = sma200 && atr14 ? Math.max(0.01, sma200 - 2 * atr14) : null;
    const riskPercent = stopLoss != null
      ? Number((((last.close - stopLoss) / last.close) * 100).toFixed(1))
      : null;

    res.json({
      ok: true,
      symbol,
      name,
      price: last.close,
      breakoutLevel,
      sma200,
      atr14,
      stopLoss,
      riskPercent,
      isBreakout,
      isFresh
    });
  } catch (err) {
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
    let breakouts = await runScan();

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