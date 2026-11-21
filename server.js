const express = require('express');
const cors = require('cors');
const { default: YahooFinance } = require('yahoo-finance2');

const yahooFinance = new YahooFinance();
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// רשימת ברירת מחדל של סימולים באנגלית (ניתן לשלוח רשימה מותאמת אישית ב-GET או POST)
const DEFAULT_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'AMD', 'AVGO', 'PLTR', 'COIN', 'NFLX', 'CRM', 'UBER'
];

function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calculateATR14(candles) {
  if (candles.length < 15) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const recent14 = trs.slice(-14);
  return recent14.reduce((sum, v) => sum + v, 0) / 14;
}

function cleanEnglishText(text, fallback) {
  const cleaned = String(text || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

async function analyzeSymbol(symbol) {
  const cleanSymbol = cleanEnglishText(symbol, '').toUpperCase();
  if (!cleanSymbol) return null;

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 420);

  const chart = await yahooFinance.chart(cleanSymbol, {
    period1: startDate.toISOString().split('T')[0],
    interval: '1d'
  });

  const quotes = (chart?.quotes || []).filter(
    q =>
      q &&
      typeof q.close === 'number' &&
      typeof q.high === 'number' &&
      typeof q.low === 'number'
  );

  if (quotes.length < 205) return null;

  let breakoutDaysAgo = null;
  let latestBreakoutLevel = null;
  let latestClose = quotes[quotes.length - 1].close;

  // בדיקת 1-3 הימים האחרונים לפריצה מעל קו TAO 2 (SMA 200 + 2 * ATR 14)
  for (let offset = 0; offset < 3; offset++) {
    const idx = quotes.length - 1 - offset;
    const historyUpToIdx = quotes.slice(0, idx + 1);
    const closes = historyUpToIdx.map(c => c.close);

    const sma200 = calculateSMA(closes, 200);
    const atr14 = calculateATR14(historyUpToIdx);

    if (sma200 === null || atr14 === null) continue;

    const breakoutLevel = sma200 + 2 * atr14;
    const closeAtDay = historyUpToIdx[historyUpToIdx.length - 1].close;

    if (offset === 0) {
      latestBreakoutLevel = breakoutLevel;
      latestClose = closeAtDay;
    }

    if (closeAtDay > breakoutLevel && breakoutDaysAgo === null) {
      breakoutDaysAgo = offset + 1;
      if (offset > 0) {
        latestBreakoutLevel = breakoutLevel;
      }
    }
  }

  if (latestBreakoutLevel === null || latestBreakoutLevel <= 0) return null;

  const diffPercent = ((latestClose - latestBreakoutLevel) / latestBreakoutLevel) * 100;

  let status = null;
  if (breakoutDaysAgo !== null && diffPercent >= 0 && diffPercent <= 4) {
    status = 'פריצה';
  } else if (latestClose <= latestBreakoutLevel && diffPercent >= -4 && diffPercent < 0) {
    status = 'קרובה לפריצה';
  }

  if (!status) return null;

  const rawName = chart?.meta?.shortName || chart?.meta?.longName || cleanSymbol;
  const englishName = cleanEnglishText(rawName, cleanSymbol);

  return {
    symbol: cleanSymbol,
    name: englishName,
    price: Number(latestClose.toFixed(2)),
    breakoutLevel: Number(latestBreakoutLevel.toFixed(2)),
    diffPercent: Number(diffPercent.toFixed(2)),
    breakoutDaysAgo,
    status
  };
}

async function handleScan(symbolsInput, res) {
  try {
    const symbolsList =
      Array.isArray(symbolsInput) && symbolsInput.length > 0
        ? symbolsInput
        : DEFAULT_SYMBOLS;

    const uniqueSymbols = [
      ...new Set(
        symbolsList
          .map(s => cleanEnglishText(s, '').toUpperCase())
          .filter(Boolean)
      )
    ];

    const results = await Promise.all(uniqueSymbols.map(analyzeSymbol));
    const filtered = results.filter(Boolean);

    res.json({
      appName: 'אוהד מניות',
      strategy: 'TAO 2',
      updatedAt: new Date().toISOString(),
      breakout: filtered.filter(item => item.status === 'פריצה'),
      nearBreakout: filtered.filter(item => item.status === 'קרובה לפריצה')
    });
  } catch (err) {
    res.status(500).json({
      error: 'שגיאה בביצוע הסריקה',
      details: err.message
    });
  }
}

app.get('/api/scan', async (req, res) => {
  const fromQuery = req.query.symbols
    ? String(req.query.symbols).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SYMBOLS;
  await handleScan(fromQuery, res);
});

app.post('/api/scan', async (req, res) => {
  await handleScan(req.body?.symbols, res);
});

app.listen(PORT, () => {
  console.log(`Ohad Stocks (TAO 2) server running on http://localhost:${PORT}`);
});