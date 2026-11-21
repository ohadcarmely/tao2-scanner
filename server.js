const express = require('express');
const cors = require('cors');
const { default: YahooFinance } = require('yahoo-finance2');

const yahooFinance = new YahooFinance();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 50 המניות הגדולות בנאסד"ק (ברירת מחדל)
const DEFAULT_SYMBOLS = [
  'AAPL', 'NVDA', 'MSFT', 'AMZN', 'META', 'AVGO', 'GOOGL', 'TSLA', 'COST', 'NFLX',
  'TMUS', 'ASML', 'CSCO', 'PLTR', 'AMD', 'PEP', 'LIN', 'AZN', 'ADBE', 'QCOM',
  'TXN', 'INTU', 'ISRG', 'AMGN', 'BKNG', 'HON', 'CMCSA', 'AMAT', 'PDD', 'ARM',
  'PANW', 'VRTX', 'ADP', 'GILD', 'MU', 'SBUX', 'MELI', 'ADI', 'LRCX', 'KLAC',
  'INTC', 'MDLZ', 'CTAS', 'CRWD', 'SNPS', 'CDNS', 'REGN', 'PYPL', 'MAR', 'ORLY'
];

// זיכרון מטמון קצר (5 דקות) למניעת שליפות כפולות וחסימות מ-Yahoo Finance
const CACHE_TTL_MS = 5 * 60 * 1000;
const symbolCache = new Map();

function cleanEnglishText(text, fallback) {
  const cleaned = String(text || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function formatDateYMD(dateObj) {
  const d = new Date(dateObj);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calcCalendarDaysAgo(dateObj) {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const d = new Date(dateObj);
  const candleUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(0, Math.round((todayUTC - candleUTC) / (1000 * 60 * 60 * 24)));
}

// חישוב סדרת SMA 200 ו-ATR 14 (RMA - Wilder's Smoothing כמו ב-TradingView)
function computeIndicatorsSeries(quotes, smaPeriod = 200, atrPeriod = 14) {
  const n = quotes.length;
  const sma = new Array(n).fill(null);
  const atr = new Array(n).fill(null);
  const tr = new Array(n).fill(0);

  let closeSum = 0;

  for (let i = 0; i < n; i++) {
    closeSum += quotes[i].close;
    if (i >= smaPeriod) {
      closeSum -= quotes[i - smaPeriod].close;
    }
    if (i >= smaPeriod - 1) {
      sma[i] = closeSum / smaPeriod;
    }

    if (i === 0) {
      tr[i] = quotes[i].high - quotes[i].low;
    } else {
      const cur = quotes[i];
      const prevClose = quotes[i - 1].close;
      tr[i] = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prevClose),
        Math.abs(cur.low - prevClose)
      );
    }

    if (i === atrPeriod) {
      let trSum = 0;
      for (let k = 1; k <= atrPeriod; k++) trSum += tr[k];
      atr[i] = trSum / atrPeriod;
    } else if (i > atrPeriod) {
      atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
    }
  }

  return quotes.map((q, i) => {
    const hasBoth = sma[i] !== null && atr[i] !== null;
    return {
      date: q.date,
      close: q.close,
      low: q.low,
      sma200: sma[i],
      atr14: atr[i],
      upperBuffer: hasBoth ? sma[i] + 2 * atr[i] : null,
      rawLowerBuffer: hasBoth ? sma[i] - 2 * atr[i] : null
    };
  });
}

async function analyzeSymbol(symbol, { includeAllStatuses = false } = {}) {
  const cleanSymbol = cleanEnglishText(symbol, '').toUpperCase();
  if (!cleanSymbol) return null;

  // בדיקת Cache
  const cached = symbolCache.get(cleanSymbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const data = cached.data;
    if (!data) return null;
    if (!includeAllStatuses && data.status !== 'פריצה' && data.status !== 'קרובה לפריצה') {
      return null;
    }
    return data;
  }

  try {
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
        q.date &&
        typeof q.close === 'number' &&
        typeof q.high === 'number' &&
        typeof q.low === 'number'
    );

    if (quotes.length < 205) {
      symbolCache.set(cleanSymbol, { timestamp: Date.now(), data: null });
      return null;
    }

    const series = computeIndicatorsSeries(quotes, 200, 14);
    const lastIdx = series.length - 1;
    const latest = series[lastIdx];

    if (!latest || latest.upperBuffer === null || latest.upperBuffer <= 0) {
      symbolCache.set(cleanSymbol, { timestamp: Date.now(), data: null });
      return null;
    }

    // סימולציית עסקאות TAO 2 על ההיסטוריה (תואם ל-strategy.position_size == 0 ב-TradingView)
    let inPosition = false;
    let entryIdx = null;
    let trailStop = null;

    for (let i = 1; i <= lastIdx; i++) {
      const curr = series[i];
      const prev = series[i - 1];
      if (curr.upperBuffer === null || prev.upperBuffer === null) continue;

      if (inPosition) {
        if (curr.low <= trailStop) {
          inPosition = false;
          entryIdx = null;
          trailStop = null;
        } else {
          trailStop = Math.max(trailStop, curr.rawLowerBuffer);
        }
      }

      if (!inPosition && curr.close > curr.upperBuffer && prev.close <= prev.upperBuffer) {
        inPosition = true;
        entryIdx = i;
        trailStop = curr.rawLowerBuffer;
      }
    }

    const diffPercent = ((latest.close - latest.upperBuffer) / latest.upperBuffer) * 100;

    let breakoutDate = null;
    let breakoutDaysAgo = null;
    let breakoutTradingDaysAgo = null;
    const activeStop = inPosition && trailStop !== null ? trailStop : latest.rawLowerBuffer;

    if (inPosition && entryIdx !== null) {
      breakoutDate = formatDateYMD(series[entryIdx].date);
      breakoutDaysAgo = calcCalendarDaysAgo(series[entryIdx].date);
      breakoutTradingDaysAgo = lastIdx - entryIdx;
    }

    // סיווג סטטוס: פריצה נקייה = 0 עד 3 ימי מסחר וגם מרחק של עד 4% מעל הרמה
    let status = 'ניטרלי';
    if (
      inPosition &&
      breakoutTradingDaysAgo !== null &&
      breakoutTradingDaysAgo <= 3 &&
      diffPercent >= 0 &&
      diffPercent <= 4
    ) {
      status = 'פריצה';
    } else if (!inPosition && latest.close <= latest.upperBuffer && diffPercent >= -4 && diffPercent < 0) {
      status = 'קרובה לפריצה';
    } else if (inPosition) {
      status = 'בעסקה פעילה (מעל הטווח)';
    }

    const riskPercent =
      latest.close > 0 ? ((latest.close - activeStop) / latest.close) * 100 : 0;

    const rawName = chart?.meta?.shortName || chart?.meta?.longName || cleanSymbol;
    const englishName = cleanEnglishText(rawName, cleanSymbol);

    const result = {
      symbol: cleanSymbol,
      name: englishName,
      price: Number(latest.close.toFixed(2)),
      breakoutLevel: Number(latest.upperBuffer.toFixed(2)),
      diffPercent: Number(diffPercent.toFixed(2)),
      stopLoss: Number(activeStop.toFixed(2)),
      riskPercent: Number(riskPercent.toFixed(1)),
      breakoutDate: status === 'פריצה' || includeAllStatuses ? breakoutDate : null,
      breakoutDaysAgo: status === 'פריצה' || includeAllStatuses ? breakoutDaysAgo : null,
      breakoutTradingDaysAgo: status === 'פריצה' || includeAllStatuses ? breakoutTradingDaysAgo : null,
      isFreshToday: status === 'פריצה' && breakoutTradingDaysAgo === 0,
      status
    };

    symbolCache.set(cleanSymbol, { timestamp: Date.now(), data: result });

    if (!includeAllStatuses && status !== 'פריצה' && status !== 'קרובה לפריצה') {
      return null;
    }

    return result;
  } catch (err) {
    console.error(`Failed to analyze ${cleanSymbol}:`, err.message);
    return null;
  }
}

// סריקה בקבוצות (Batches) למניעת Rate Limit מ-Yahoo Finance
async function analyzeInBatches(symbols, batchSize = 5) {
  const results = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(s => analyzeSymbol(s)));
    results.push(...batchResults);
  }
  return results.filter(Boolean);
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

    const filtered = await analyzeInBatches(uniqueSymbols, 5);

    const breakout = filtered
      .filter(item => item.status === 'פריצה')
      .sort((a, b) => (a.breakoutTradingDaysAgo ?? 99) - (b.breakoutTradingDaysAgo ?? 99));

    const nearBreakout = filtered
      .filter(item => item.status === 'קרובה לפריצה')
      .sort((a, b) => b.diffPercent - a.diffPercent);

    res.json({
      appName: 'אוהד מניות',
      strategy: 'TAO 2',
      updatedAt: new Date().toISOString(),
      scannedCount: uniqueSymbols.length,
      breakout,
      nearBreakout
    });
  } catch (err) {
    res.status(500).json({
      error: 'שגיאה בביצוע הסריקה',
      details: err.message
    });
  }
}

// נתיב בדיקת תקינות (שימושי גם ל-UptimeRobot כדי שהשרת לא יירדם)
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TAO 2 Scanner', defaultSymbolsCount: DEFAULT_SYMBOLS.length });
});

// סריקה מלאה (GET)
app.get('/api/scan', async (req, res) => {
  const fromQuery = req.query.symbols
    ? String(req.query.symbols).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SYMBOLS;
  await handleScan(fromQuery, res);
});

// סריקה מלאה (POST)
app.post('/api/scan', async (req, res) => {
  await handleScan(req.body?.symbols, res);
});

// בדיקה מהירה למניה בודדת (למשל: /api/check?symbol=QUBT)
app.get('/api/check', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'נא לספק סימול מניה (symbol)' });
  }
  const result = await analyzeSymbol(symbol, { includeAllStatuses: true });
  if (!result) {
    return res.status(404).json({ error: `לא נמצאו מספיק נתונים עבור ${symbol}` });
  }
  res.json(result);
});

// חיפוש והשלמה אוטומטית למניות אמיתיות (למשל: /api/search?q=palantir)
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json([]);
  try {
    const searchRes = await yahooFinance.search(q, { quotesCount: 6, newsCount: 0 });
    const items = (searchRes?.quotes || [])
      .filter(item => item.symbol && (item.quoteType === 'EQUITY' || item.quoteType === 'ETF'))
      .map(item => ({
        symbol: item.symbol,
        name: cleanEnglishText(item.shortname || item.longname || item.symbol, item.symbol),
        exchange: item.exchDisp || ''
      }));
    res.json(items);
  } catch (err) {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`Ohad Stocks (TAO 2) server running on port ${PORT}`);
});