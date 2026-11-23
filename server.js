const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CUSTOM_SYMBOLS_FILE = path.join(__dirname, 'custom-symbols.json');

// פרמטרים של אסטרטגיית TAO 2
const MA_LENGTH = 200;
const ATR_LENGTH = 14;
const ATR_MULT = 2.0;
const NEAR_BREAKOUT_THRESHOLD_PCT = -3.0; // עד 3% מתחת ל-upperBuffer
const BREAKOUT_WINDOW_DAYS = 3; // חלון פריצות פעילות בממשק (היום + 3 ימים אחרונים)
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 250;

app.use(express.json());

// אישור CORS לחיבור מ-Google AI Studio ומדפדפנים חיצוניים
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(__dirname));

// רשימת 100 המניות המעודכנות לסריקה
const DEFAULT_SYMBOLS = [
  // 1. ביג טק ו-AI (10)
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'ORCL', 'IBM', 'PLTR',
  // 2. שבבים וחומרה (12)
  'AVGO', 'AMD', 'ARM', 'TSM', 'QCOM', 'TXN', 'AMAT', 'MU', 'LRCX', 'KLAC', 'ASML', 'SMCI',
  // 3. סייבר, תוכנה וענן (12)
  'PANW', 'CRWD', 'CHKP', 'FTNT', 'ZS', 'NET', 'DDOG', 'SNOW', 'CRM', 'ADBE', 'INTU', 'NOW',
  // 4. גיימינג, מדיה ואינטרנט (10)
  'NFLX', 'TTWO', 'EA', 'SPOT', 'UBER', 'DASH', 'ABNB', 'BKNG', 'APP', 'RBLX',
  // 5. פיננסים, פינטק וקריפטו (10)
  'JPM', 'GS', 'V', 'MA', 'AXP', 'BLK', 'PYPL', 'COIN', 'HOOD', 'IBIT',
  // 6. צרכנות וקמעונאות (10)
  'ORLY', 'COST', 'WMT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'LULU', 'CMG',
  // 7. בריאות, פארמה וביוטק (10)
  'LLY', 'NVO', 'UNH', 'ISRG', 'VRTX', 'REGN', 'AMGN', 'GILD', 'SYK', 'TMO',
  // 8. תעשייה, ביטחון וחלל (10)
  'LMT', 'RTX', 'NOC', 'GE', 'CAT', 'DE', 'URI', 'CTAS', 'RKLB', 'ASTS',
  // 9. אנרגיה, תשתיות וחשמל ל-AI (8)
  'XOM', 'CVX', 'CEG', 'VST', 'NEE', 'ETN', 'VRT', 'GEV',
  // 10. צמיחה, קוונטים ומומנטום (8)
  'IONQ', 'QUBT', 'RGTI', 'SOFI', 'SHOP', 'MELI', 'DUOL', 'AXON'
];

// עזרי טעינה ושמירה של מניות ידניות
function normalizeSymbol(s) {
  return String(s || '').trim().toUpperCase();
}

function loadCustomSymbols() {
  try {
    if (!fs.existsSync(CUSTOM_SYMBOLS_FILE)) return [];
    const raw = fs.readFileSync(CUSTOM_SYMBOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeSymbol).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function saveCustomSymbols(list) {
  try {
    const unique = [...new Set(list.map(normalizeSymbol).filter(Boolean))];
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
    ...extraSymbols.map(normalizeSymbol).filter(Boolean)
  ])];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// משיכת נתוני נרות יומיים + הזרקת המחיר החי של הרגע (הווה)
async function fetchStockData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
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
    const open = quote.open?.[i];
    const ts = timestamps[i];
    if (close != null && high != null && low != null) {
      candles.push({
        open: open ?? close,
        high,
        low,
        close,
        timestamp: ts
      });
    }
  }

  if (candles.length < 30) return null;

  // הזרקת המחיר החי (הווה) לנר היומי כדי לתפוס פריצות בזמן אמת במהלך יום המסחר
  const regularPrice = meta.regularMarketPrice;
  const regularTime = meta.regularMarketTime;
  if (regularPrice != null && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const lastDay = lastCandle.timestamp ? Math.floor(lastCandle.timestamp / 86400) : null;
    const marketDay = regularTime ? Math.floor(regularTime / 86400) : null;

    if (lastDay !== null && marketDay !== null && marketDay > lastDay) {
      candles.push({
        open: regularPrice,
        high: regularPrice,
        low: regularPrice,
        close: regularPrice,
        timestamp: regularTime
      });
    } else {
      lastCandle.close = regularPrice;
      if (regularPrice > lastCandle.high) lastCandle.high = regularPrice;
      if (regularPrice < lastCandle.low) lastCandle.low = regularPrice;
    }
  }

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    exchange: meta.exchangeName || meta.fullExchangeName || 'US',
    candles
  };
}

// חישוב סדרת SMA לכל נר
function calculateSMASeries(closes, period) {
  const result = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) {
      sum -= closes[i - period];
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }
  return result;
}

// חישוב סדרת ATR (Wilder RMA - זהה ל-ta.atr ב-TradingView)
function calculateATRSeries(candles, period = ATR_LENGTH) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;

  const trs = new Array(candles.length).fill(0);
  trs[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    trs[i] = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose)
    );
  }

  // ממוצע ראשוני של period נרות
  let rma = 0;
  for (let i = 0; i < period; i++) {
    rma += trs[i];
  }
  rma /= period;
  result[period - 1] = rma;

  // החלקת Wilder (RMA)
  for (let i = period; i < candles.length; i++) {
    rma = ((rma * (period - 1)) + trs[i]) / period;
    result[i] = rma;
  }

  return result;
}

// פורמט תאריך DD/MM/YYYY תואם לממשק
function formatDateDDMMYYYY(unixSeconds) {
  if (!unixSeconds) return null;
  const d = new Date(unixSeconds * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ניתוח מניה לפי אלגוריתם TAO 2 המדויק
function buildStockAnalysis(stock, forSingleCheck = false) {
  const { symbol, name, candles } = stock;
  const closes = candles.map(c => c.close);

  const effectiveMaLen = Math.min(MA_LENGTH, closes.length);
  const smaSeries = calculateSMASeries(closes, effectiveMaLen);
  const atrSeries = calculateATRSeries(candles, ATR_LENGTH);

  // סימולציה היסטורית של כניסה וסטופ נגרר בדיוק כמו ב-Pine Script של TAO 2
  let inPosition = false;
  let trailStop = null;
  let entryIndex = null;

  for (let i = 1; i < candles.length; i++) {
    const ma = smaSeries[i];
    const atr = atrSeries[i];
    const prevMa = smaSeries[i - 1];
    const prevAtr = atrSeries[i - 1];

    if (ma == null || atr == null || prevMa == null || prevAtr == null) continue;

    const upperBuffer = ma + atr * ATR_MULT;
    const rawLowerBuffer = ma - atr * ATR_MULT;
    const prevUpperBuffer = prevMa + prevAtr * ATR_MULT;

    const curr = candles[i];
    const prev = candles[i - 1];

    // בדיקת יציאה בסטופ אם יש עסקה פתוחה
    if (inPosition) {
      if (trailStop != null && curr.low <= trailStop) {
        inPosition = false;
        trailStop = null;
        entryIndex = null;
      } else {
        trailStop = trailStop == null ? rawLowerBuffer : Math.max(trailStop, rawLowerBuffer);
      }
    }

    // כניסה חדשה רק כשאין עסקה פתוחה: ta.crossover(close, upperBuffer)
    const crossAbove = prev.close <= prevUpperBuffer && curr.close > upperBuffer;
    if (!inPosition && crossAbove) {
      inPosition = true;
      trailStop = rawLowerBuffer;
      entryIndex = i;
    }
  }

  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const lastMa = smaSeries[lastIdx] ?? last.close;
  const lastAtr = atrSeries[lastIdx] ?? Math.max(0.5, last.close * 0.02);

  const upperBuffer = lastMa + lastAtr * ATR_MULT;
  const rawLowerBuffer = lastMa - lastAtr * ATR_MULT;
  const activeTrailStop = inPosition && trailStop != null ? trailStop : rawLowerBuffer;

  const breakoutDaysAgo = inPosition && entryIndex !== null ? (lastIdx - entryIndex) : null;
  const breakoutDate = inPosition && entryIndex !== null
    ? formatDateDDMMYYYY(candles[entryIndex].timestamp)
    : null;

  // isFresh = פריצה חיה מהיום (breakoutDaysAgo === 0)
  const isFresh = Boolean(inPosition && breakoutDaysAgo === 0);
  const isRecentBreakout = Boolean(
    inPosition &&
    breakoutDaysAgo !== null &&
    breakoutDaysAgo <= BREAKOUT_WINDOW_DAYS &&
    last.close > upperBuffer
  );

  const diffPercent = upperBuffer > 0
    ? Number((((last.close - upperBuffer) / upperBuffer) * 100).toFixed(2))
    : 0;

  // קרוב לפריצה: עדיין לא בעסקה/לא מעל ה-upperBuffer, ובמרחק של עד 3% מתחתיו
  const isNearBreakout = Boolean(
    !isRecentBreakout &&
    last.close <= upperBuffer &&
    diffPercent >= NEAR_BREAKOUT_THRESHOLD_PCT &&
    diffPercent < 0
  );

  const stopLoss = Number(Math.max(0.01, activeTrailStop).toFixed(2));
  const riskPercent = last.close > 0
    ? Number((((last.close - stopLoss) / last.close) * 100).toFixed(1))
    : 0;

  const hebrewStatus = isRecentBreakout
    ? (isFresh ? 'פורצת עכשיו · היום (TAO 2)' : `פריצה פעילה (לפני ${breakoutDaysAgo} ימים)`)
    : inPosition
      ? 'בעסקת פריצה פעילה (מעל 3 ימים)'
      : isNearBreakout
        ? 'קרוב לפריצה · מתקרב ל-Upper Buffer'
        : (last.close > lastMa ? 'מעל SMA200 · ממתין לחציית Upper Buffer' : 'מתחת ל-SMA200');

  const enumStatus = isRecentBreakout
    ? 'BREAKOUT'
    : isNearBreakout
      ? 'NEAR_BREAKOUT'
      : 'OTHER';

  return {
    symbol,
    name,
    price: Number(last.close.toFixed(2)),
    breakoutLevel: Number(upperBuffer.toFixed(2)),
    upperBuffer: Number(upperBuffer.toFixed(2)),
    rawLowerBuffer: Number(Math.max(0.01, rawLowerBuffer).toFixed(2)),
    trailStop: stopLoss,
    stopLoss,
    sma200: Number(lastMa.toFixed(2)),
    atr14: Number(lastAtr.toFixed(2)),
    riskPercent,
    diffPercent,
    isBreakout: isRecentBreakout,
    isActiveBreakout: isRecentBreakout,
    isInPosition: inPosition,
    isNearBreakout,
    isFresh,
    breakoutDate: isRecentBreakout ? breakoutDate : null,
    breakoutDaysAgo: isRecentBreakout ? breakoutDaysAgo : null,
    status: forSingleCheck ? hebrewStatus : enumStatus,
    statusLabel: hebrewStatus
  };
}

// הרצת סריקה ב-Batches מקבילים (מהיר ויציב ל-100+ מניות)
async function runScan(symbols = []) {
  const targetList = getAllSymbols(symbols);
  const breakouts = [];
  const nearBreakouts = [];

  for (let i = 0; i < targetList.length; i += BATCH_SIZE) {
    const batch = targetList.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const stock = await fetchStockData(symbol);
          if (!stock) return null;
          return buildStockAnalysis(stock, false);
        } catch (err) {
          console.error(`Error scanning ${symbol}:`, err.message);
          return null;
        }
      })
    );

    for (const analysis of results) {
      if (!analysis) continue;
      if (analysis.isActiveBreakout) {
        breakouts.push(analysis);
      } else if (analysis.isNearBreakout) {
        nearBreakouts.push(analysis);
      }
    }

    if (i + BATCH_SIZE < targetList.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // מיון: פריצות מהיום (breakoutDaysAgo === 0) קודם, אחריהן 1..3 ימים, וקרוב לפריצה הכי קרוב ל-0% קודם
  breakouts.sort((a, b) => (a.breakoutDaysAgo ?? 99) - (b.breakoutDaysAgo ?? 99));
  nearBreakouts.sort((a, b) => b.diffPercent - a.diffPercent);

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

// דף הבית ובדיקת תקינות (להתעוררות מהירה ב-Render)
app.get('/', (req, res) => {
  res.send('TAO2 Scanner is running (100 stocks · Live Intraday + SMA200 + 2*ATR14)');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, symbolsCount: getAllSymbols().length, time: new Date().toISOString() });
});

// ניהול מניות ידניות (צפייה / הוספה / הסרה)
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

  const normalized = incoming.map(normalizeSymbol).filter(Boolean);
  if (normalized.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing symbol' });
  }

  const current = loadCustomSymbols();
  const updated = saveCustomSymbols([...current, ...normalized]);
  res.json({ ok: true, customSymbols: updated, allSymbols: getAllSymbols() });
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const target = normalizeSymbol(req.params.symbol);
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
        symbol: normalizeSymbol(item.symbol),
        name: item.shortname || item.longname || normalizeSymbol(item.symbol),
        exchange: item.exchDisp || item.exchange || 'US'
      }));

    res.json(filtered);
  } catch (err) {
    console.error('Search error:', err.message);
    res.json([]);
  }
});

// עזר לבניית תשובת סריקה תואמת לכל השדות שהממשק מצפה להם
function buildScanResponse(breakouts, nearBreakouts, scannedCount) {
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    count: breakouts.length,
    nearCount: nearBreakouts.length,
    scannedCount,
    // מפתחות ביחיד (תואם stockLogic.ts)
    breakout: breakouts,
    nearBreakout: nearBreakouts,
    // מפתחות ברבים (לתאימות לאחור)
    breakouts,
    nearBreakouts
  };
}

// נתיב סריקה (GET)
app.get('/api/scan', async (req, res) => {
  try {
    const querySymbols = req.query.symbols
      ? String(req.query.symbols).split(',').map(normalizeSymbol).filter(Boolean)
      : [];
    const { breakouts, nearBreakouts, scannedCount } = await runScan(querySymbols);
    res.json(buildScanResponse(breakouts, nearBreakouts, scannedCount));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// נתיב סריקה (POST - קולט גם מניות שנוספו ידנית מהאפליקציה)
app.post('/api/scan', async (req, res) => {
  try {
    const manualSymbols = Array.isArray(req.body?.symbols)
      ? req.body.symbols.map(normalizeSymbol).filter(Boolean)
      : [];

    if (manualSymbols.length > 0) {
      const extraOnly = manualSymbols.filter(s => !DEFAULT_SYMBOLS.includes(s));
      if (extraOnly.length > 0) {
        const current = loadCustomSymbols();
        saveCustomSymbols([...current, ...extraOnly]);
      }
    }

    const { breakouts, nearBreakouts, scannedCount } = await runScan(manualSymbols);
    res.json(buildScanResponse(breakouts, nearBreakouts, scannedCount));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// בדיקת מניה בודדת
async function handleSingleStock(req, res) {
  try {
    const rawSymbol = req.params.symbol || req.query.symbol || req.body?.symbol || '';
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
      return res.status(400).json({ ok: false, error: 'Missing symbol' });
    }

    const stock = await fetchStockData(symbol);
    if (!stock) {
      return res.status(404).json({ ok: false, error: 'Symbol not found' });
    }

    const analysis = buildStockAnalysis(stock, true);
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
      await sendTelegramMessage('<b>TAO 2</b>\nהודעת בדיקה — הבוט מחובר וסורק 100 מניות בזמן אמת!');
      return res.json({ ok: true, message: 'Test alert sent!' });
    }

    const freshOnly = req.query.freshOnly === 'true';
    const { breakouts: allBreakouts, nearBreakouts, scannedCount } = await runScan();
    const breakouts = freshOnly ? allBreakouts.filter(b => b.isFresh) : allBreakouts;

    if (breakouts.length === 0) {
      await sendTelegramMessage('<b>TAO 2</b>\nאוהד ערב טוב, אין פריצה — אתה יכול לישון בשקט');
      return res.json({
        ok: true,
        sent: 0,
        scannedCount,
        nearCount: nearBreakouts.length,
        message: 'No breakouts found (evening message sent)'
      });
    }

    const cards = breakouts.map(s => {
      const safeName = String(s.name || s.symbol)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(s.symbol)}`;
      const freshTag = s.isFresh ? ' · פורצת היום' : (s.breakoutDaysAgo ? ` · לפני ${s.breakoutDaysAgo} ימים` : '');

      return [
        '<blockquote>',
        `<b>${s.symbol}</b> · ${safeName}${freshTag}`,
        '',
        `<b>מחיר</b> — $${s.price.toFixed(2)}`,
        `<b>Upper Buffer</b> — $${s.breakoutLevel.toFixed(2)}`,
        `<b>סטופ נגרר</b> — $${s.stopLoss.toFixed(2)}`,
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

    res.json({ ok: true, sent: breakouts.length, scannedCount });
  } catch (err) {
    console.error('Alert error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
// ==========================================
// חיבור למסחר דמה אוטומטי ב-Alpaca (Paper Trading)
// ==========================================

function getAlpacaConfig() {
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const baseUrl = (process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
  const tradeAmountUsd = Number(process.env.TRADE_AMOUNT_USD || 1000);
  return { apiKey, secretKey, baseUrl, tradeAmountUsd };
}

async function alpacaRequest(endpoint, options = {}) {
  const { apiKey, secretKey, baseUrl } = getAlpacaConfig();
  if (!apiKey || !secretKey) {
    throw new Error('Missing ALPACA_API_KEY or ALPACA_SECRET_KEY');
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Alpaca API ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

// שליחת פקודות דמה למניות שפורצות היום (עם הגנת כפילויות וסטופ-לוס מובנה)
async function executePaperTrades(breakouts) {
  const { tradeAmountUsd } = getAlpacaConfig();
  const freshBreakouts = breakouts.filter(b => b.isFresh);
  const results = [];

  if (freshBreakouts.length === 0) return results;

  // משיכת פוזיציות ופקודות פתוחות כדי למנוע קנייה כפולה
  const [positions, openOrders] = await Promise.all([
    alpacaRequest('/v2/positions'),
    alpacaRequest('/v2/orders?status=open')
  ]);

  const activeSymbols = new Set([
    ...positions.map(p => p.symbol),
    ...openOrders.map(o => o.symbol)
  ]);

  for (const stock of freshBreakouts) {
    if (activeSymbols.has(stock.symbol)) {
      results.push({ symbol: stock.symbol, status: 'SKIPPED', reason: 'כבר קיימת פוזיציה או פקודה פתוחה' });
      continue;
    }

    // Alpaca דורשת כמות מניות שלמה (Integer) לפקודות עם Stop Loss מובנה
    const qty = Math.floor(tradeAmountUsd / stock.price);
    if (qty < 1) {
      results.push({ symbol: stock.symbol, status: 'SKIPPED', reason: `מחיר מניה ($${stock.price}) גבוה מתקציב העסקה ($${tradeAmountUsd})` });
      continue;
    }

    try {
      const order = await alpacaRequest('/v2/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol: stock.symbol,
          qty: String(qty),
          side: 'buy',
          type: 'market',
          time_in_force: 'day',
          order_class: 'oto',
          stop_loss: {
            stop_price: Number(stock.stopLoss.toFixed(2))
          }
        })
      });

      activeSymbols.add(stock.symbol);
      results.push({
        symbol: stock.symbol,
        status: 'EXECUTED',
        qty,
        price: stock.price,
        stopLoss: stock.stopLoss,
        orderId: order.id
      });
    } catch (err) {
      results.push({ symbol: stock.symbol, status: 'ERROR', reason: err.message });
    }
  }

  return results;
}

// נתיב בדיקת חיבור לחשבון הדמה ב-Alpaca
app.get('/api/alpaca/status', async (req, res) => {
  try {
    const [account, positions, openOrders] = await Promise.all([
      alpacaRequest('/v2/account'),
      alpacaRequest('/v2/positions'),
      alpacaRequest('/v2/orders?status=open')
    ]);

    res.json({
      ok: true,
      accountNumber: account.account_number,
      status: account.status,
      cash: account.cash,
      buyingPower: account.buying_power,
      equity: account.equity,
      openPositionsCount: positions.length,
      openOrdersCount: openOrders.length
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// נתיב סריקה + ביצוע מסחר דמה אוטומטי + דיווח לטלגרם
app.get('/api/trade', async (req, res) => {
  try {
    const { breakouts, scannedCount } = await runScan();
    const tradeResults = await executePaperTrades(breakouts);

    if (tradeResults.length > 0) {
      const lines = tradeResults.map(r => {
        if (r.status === 'EXECUTED') {
          return `✅ <b>${r.symbol}</b> — נקנו ${r.qty} מניות (~$${r.price}) | סטופ: $${r.stopLoss}`;
        }
        if (r.status === 'SKIPPED') {
          return `⏭️ <b>${r.symbol}</b> — דולג (${r.reason})`;
        }
        return `❌ <b>${r.symbol}</b> — שגיאה: ${r.reason}`;
      });

      await sendTelegramMessage(`<b>TAO 2 · דוח מסחר דמה (Alpaca)</b>\n\n${lines.join('\n')}`);
    }

    res.json({ ok: true, scannedCount, breakoutsFound: breakouts.length, tradeResults });
  } catch (err) {
    console.error('Trade error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`TAO2 Scanner listening on port ${PORT}`);
});