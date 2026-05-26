/**
 * StockNavi 本地伺服器 (零依賴，Node.js 22+)
 * 啟動: node server.js
 * 開啟: http://localhost:5000
 *
 * ⚠️  TOKEN 是私人金鑰，請勿上傳至 GitHub 或分享
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

// ── SQLite（Node 22+ 內建，零外部依賴）────────────────
const { DatabaseSync } = require('node:sqlite');
// 雲端用 /data（Render 掛載磁碟），本機用 ./data
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'stocknavi.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    tribe       TEXT NOT NULL,
    stock_id    TEXT NOT NULL,
    stock_name  TEXT NOT NULL,
    score       INTEGER NOT NULL,
    signal      TEXT NOT NULL,
    tag         TEXT,
    close_price REAL,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(date, tribe, stock_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ds_date_tribe ON daily_signals(date, tribe);
  CREATE INDEX IF NOT EXISTS idx_ds_stock ON daily_signals(stock_id, date);
`);

const _insertSignal = db.prepare(`
  INSERT INTO daily_signals(date, tribe, stock_id, stock_name, score, signal, tag, close_price)
  VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(date, tribe, stock_id) DO UPDATE SET
    score=excluded.score, signal=excluded.signal, tag=excluded.tag,
    close_price=excluded.close_price, created_at=datetime('now','localtime')
`);

function saveSignals(date, tribe, stocks) {
  try {
    for (const s of stocks) {
      _insertSignal.run(date, tribe, s.id, s.name, s.score ?? 0, s.signal ?? 'gray', s.tag ?? '', s.close ?? null);
    }
  } catch (e) { addLog(`⚠️ DB save: ${e.message}`); }
}

// ── 設定 ──────────────────────────────────────────────
// TOKEN 從環境變數讀取（本機開發可建 .env 或直接 export）
const TOKEN = process.env.FINMIND_TOKEN || '';
const PORT  = parseInt(process.env.PORT) || 5000;
const CACHE_TTL = 4 * 3600 * 1000; // 4 小時

if (!TOKEN) console.warn('⚠️  FINMIND_TOKEN 未設定，FinMind API 將無法使用');

// ── 快取 ──────────────────────────────────────────────
const _cache = new Map();
function fromCache(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(k); return null; }
  return e.data;
}
function toCache(k, d) { _cache.set(k, { data: d, ts: Date.now() }); }

// ── API 呼叫計數（用於速率監控）──────────────────────
const _stats = {
  apiCalls: 0,         // 今日總呼叫次數
  apiCallsToday: 0,
  cacheHits: 0,
  lastReset: new Date().toDateString(),
  tribeLastUpdate: {},  // tribe → ISO timestamp
  log: [],              // 最近 50 筆 log
};
function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (_stats.lastReset !== today) {
    _stats.apiCallsToday = 0;
    _stats.lastReset = today;
  }
}
function addLog(msg) {
  const ts = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  _stats.log.unshift(`[${ts}] ${msg}`);
  if (_stats.log.length > 50) _stats.log.pop();
  console.log(`[${ts}] ${msg}`);
}

// ── TWSE 個股月行情（免費無上限，優先使用）─────────────
async function twseStockPrice(stockId, monthsBack = 4) {
  const allRows = [];
  const now = new Date();

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
    const key = `twse_day:${stockId}:${dateStr}`;
    const cached = fromCache(key);
    if (cached) { allRows.push(...cached); continue; }

    try {
      const url = `https://www.twse.com.tw/rwd/zh/exchangeReport/STOCK_DAY?date=${dateStr}&stockNo=${stockId}&response=json`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) break; // TWSE 封鎖/限流 → 直接 fallback
      const j = await r.json();

      if (j.stat === 'OK' && j.data?.length) {
        const rows = j.data.map(row => {
          const parts = row[0].split('/');
          const isoDate = `${parseInt(parts[0]) + 1911}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
          const n = s => parseFloat(String(s).replace(/,/g,'')) || 0;
          return { date: isoDate, open: n(row[3]), max: n(row[4]), min: n(row[5]),
                   close: n(row[6]), Trading_Volume: parseInt(String(row[1]).replace(/,/g,''))||0 };
        }).filter(r => r.close > 0);
        toCache(key, rows);
        allRows.push(...rows);
      } else if (j.stat && j.stat !== 'OK') {
        break; // 此股票 TWSE 無資料，停止嘗試
      }
    } catch (e) {
      // JSON parse 失敗通常代表 TWSE 回了 HTML，跳出 loop
      break;
    }
    await sleep(100);
  }
  return allRows.sort((a, b) => a.date.localeCompare(b.date));
}

// ── TWSE 三大法人（全市場一次取得，免費）──────────────
let _twseInstAll = null, _twseInstTs = 0;
async function twseInstAll() {
  if (_twseInstAll && Date.now() - _twseInstTs < CACHE_TTL) return _twseInstAll;
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  try {
    const url = `https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=${dateStr}&selectType=ALL&response=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.stat === 'OK' && j.data?.length) {
      const result = {};
      for (const row of j.data) {
        const n = s => parseInt(String(s).replace(/,/g,'')) || 0;
        result[row[0]] = { foreignNet: n(row[4]), trustNet: n(row[7]), dealerNet: n(row[10]), totalNet: n(row[11]) };
      }
      _twseInstAll = result; _twseInstTs = Date.now();
      addLog(`✅ TWSE三大法人 取得 ${Object.keys(result).length} 支股票`);
      return result;
    }
  } catch (e) { addLog(`⚠️ TWSE機構資料: ${e.message}`); }
  return {};
}

// ── TWSE 加權指數（市場情緒）──────────────────────────
async function twseTaiex() {
  const key = 'twse_taiex';
  const cached = fromCache(key);
  if (cached) return cached;
  try {
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG?date=${dateStr}&stockNo=Y9999&response=json`;
    const url2 = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateStr}&type=IND&response=json`;
    const r = await fetch(url2, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    // type=IND: each row is an array [指數名, 收盤指數, 漲跌HTML, 漲跌點數, 漲跌%, 備註]
    const parseTaiexTables = (tables) => {
      if (!tables?.length) return null;
      const allRows = tables.flatMap(t => t.data ?? []);
      const row = allRows.find(r => Array.isArray(r) && String(r[0]).includes('發行量加權'));
      if (!row) return null;
      const close  = parseFloat(String(row[1]).replace(/,/g,''));
      const changePct = parseFloat(String(row[4])) || 0;
      const sign   = String(row[2]).includes('+') ? 1 : -1;
      const change = parseFloat(String(row[3]).replace(/,/g,'')) * sign;
      return { close, change, changePct: +changePct.toFixed(2) };
    };

    const todayResult = parseTaiexTables(j.tables);
    if (todayResult) { toCache(key, todayResult); return todayResult; }

    // Retry with previous trading day if today has no data yet (market still open / holiday)
    {
      const yest = new Date(today); yest.setDate(yest.getDate() - 1);
      const y = `${yest.getFullYear()}${String(yest.getMonth()+1).padStart(2,'0')}${String(yest.getDate()).padStart(2,'0')}`;
      const r2 = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${y}&type=IND&response=json`, { signal: AbortSignal.timeout(8000) });
      const j2 = await r2.json();
      if (j2.stat === 'OK') {
        const result = parseTaiexTables(j2.tables);
        if (result) { toCache(key, result); return result; }
      }
    }
  } catch (e) { addLog(`⚠️ TWSE加權指數: ${e.message}`); }
  return null;
}

// ── FinMind API ───────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function finmind(dataset, stockId, start) {
  const key = `${dataset}:${stockId}:${start}`;
  const hit = fromCache(key);
  if (hit) { _stats.cacheHits++; return hit; }

  resetDailyIfNeeded();
  _stats.apiCalls++;
  _stats.apiCallsToday++;

  const p = new URLSearchParams({ dataset, data_id: stockId, start_date: start, token: TOKEN });
  try {
    const r  = await fetch(`https://api.finmindtrade.com/api/v4/data?${p}`, { signal: AbortSignal.timeout(15000) });
    const j  = await r.json();
    if (j.status === 200 && j.data?.length) {
      toCache(key, j.data);
      return j.data;
    }
    if (j.status === 402) addLog(`⚠️  FinMind 達到每日上限 (${stockId} ${dataset})`);
  } catch (e) {
    addLog(`❌ API 錯誤 ${dataset} ${stockId}: ${e.message}`);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 股票清單 ──────────────────────────────────────────
const SECTOR = {
  '3231':'AI伺服器','6669':'AI伺服器','2376':'AI伺服器','3017':'散熱',
  '2308':'電源/電動車','2382':'AI伺服器','2330':'半導體','2317':'ODM',
  '2395':'工業電腦','2454':'IC設計','3711':'封測','3034':'IC設計',
  '2327':'被動元件','2379':'IC設計','6415':'IC設計','3443':'IC設計',
  '2412':'電信','3045':'電信','2881':'金控','2882':'金控',
  '2886':'金控','2891':'金控','2884':'金控','1301':'石化',
  '1303':'石化','2002':'鋼鐵','2303':'半導體','2357':'NB/顯卡',
  '2409':'面板','3481':'面板','2603':'航運','2615':'航運','2609':'航運',
  '4938':'ODM','2356':'EMS','2344':'記憶體',
};

const TRIBE_STOCKS = {
  growth: {
    '3231':'緯創','6669':'緯穎','2376':'技嘉','3017':'奇鋐','2308':'台達電',
    '2382':'廣達','2330':'台積電','2317':'鴻海','2395':'研華','2454':'聯發科',
    '3711':'日月光投控','3034':'聯詠','2327':'國巨','2379':'瑞昱','6415':'矽力-KY',
  },
  trend: {
    '2330':'台積電','2303':'聯電','2454':'聯發科','3034':'聯詠','2379':'瑞昱',
    '3711':'日月光投控','6669':'緯穎','2382':'廣達','2357':'華碩','2376':'技嘉',
    '3231':'緯創','3017':'奇鋐','2317':'鴻海','2308':'台達電',
  },
  dividend: {
    '2412':'中華電','3045':'台灣大','2881':'富邦金','2882':'國泰金','2886':'兆豐金',
    '2891':'中信金','2884':'玉山金','1301':'台塑','1303':'南亞','2002':'中鋼',
  },
  momentum: {
    '2330':'台積電','2454':'聯發科','2382':'廣達','2308':'台達電','2317':'鴻海',
    '2395':'研華','2376':'技嘉','3034':'聯詠','2379':'瑞昱','6415':'矽力-KY',
    '3231':'緯創','6669':'緯穎','3017':'奇鋐','2327':'國巨','3711':'日月光投控',
  },
};

// ── 輔助函式 ──────────────────────────────────────────
function sortedBy(arr, key) { return [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key]))); }

function thermoInfo(pePct) {
  if (pePct == null) return { pct: 50, label: '資料不足', color: 'amber' };
  const pct = Math.min(Math.max(pePct, 2), 96);
  if (pePct <= 20) return { pct, label: '非常便宜', color: 'green' };
  if (pePct <= 35) return { pct, label: '估值偏低', color: 'green' };
  if (pePct <= 55) return { pct, label: '估值合理', color: 'amber' };
  if (pePct <= 75) return { pct, label: '估值偏高', color: 'amber' };
  return { pct, label: '估值偏熱', color: 'red' };
}

function scoreLabel(score) {
  if (score >= 85) return { signal: 'green', tag: '強勢成長', tagColor: 'green' };
  if (score >= 70) return { signal: 'yellow', tag: '成長中', tagColor: 'green' };
  if (score >= 50) return { signal: 'amber', tag: '觀察中', tagColor: 'amber' };
  return { signal: 'red', tag: '暫不符合', tagColor: 'amber' };
}

// ── 成長族評分 ────────────────────────────────────────
async function scoreGrowth(sid, name) {
  let score = 0;
  const det  = {};

  // 收盤價（TWSE 免費；快取命中則無額外 API 消耗）
  const priceRows = await twseStockPrice(sid, 1);
  const close = priceRows.length ? priceRows.at(-1).close : null;

  // 1. 營收 YoY（35分） — 近12個月 vs 前12個月
  const revRaw = await finmind('TaiwanStockMonthRevenue', sid, daysAgo(800));
  await sleep(250);
  if (revRaw && revRaw.length >= 24) {
    const sorted = sortedBy(revRaw, 'date');
    const r12 = sorted.slice(-12).reduce((s, r) => s + +r.revenue, 0);
    const p12 = sorted.slice(-24, -12).reduce((s, r) => s + +r.revenue, 0);
    if (p12 > 0) {
      const yoy = Math.min((r12 - p12) / p12 * 100, 80);
      det.revYoy = +yoy.toFixed(1);
      if (yoy >= 30) score += 35;
      else if (yoy >= 15) score += 25;
      else if (yoy >= 5)  score += 15;
    }
  }

  // 2. 毛利率趨勢（20分） + EPS成長（20分）
  const finRaw = await finmind('TaiwanStockFinancialStatements', sid, daysAgo(1000));
  await sleep(250);
  if (finRaw) {
    // 毛利率
    const revFin = sortedBy(finRaw.filter(r => r.type === 'Revenue'), 'date');
    const gpFin  = sortedBy(finRaw.filter(r => r.type === 'GrossProfit'), 'date');
    if (revFin.length >= 2 && gpFin.length >= 2) {
      const gm  = (i) => +gpFin.at(i).value / +revFin.at(i).value * 100;
      const chg = gm(-1) - gm(-2);
      det.marginChg = +chg.toFixed(2);
      if (chg >= 2)  score += 20;
      else if (chg >= 0)  score += 14;
      else if (chg >= -3) score += 8;
    } else {
      score += 10; // 資料不足給中間分
    }

    // EPS 成長
    const epsFin = sortedBy(finRaw.filter(r => r.type === 'EPS'), 'date');
    if (epsFin.length >= 8) {
      const r4 = epsFin.slice(-4).reduce((s, r) => s + +r.value, 0);
      const p4 = epsFin.slice(-8, -4).reduce((s, r) => s + +r.value, 0);
      if (p4 !== 0) {
        const gr = (r4 - p4) / Math.abs(p4) * 100;
        det.epsGrowth = +gr.toFixed(1);
        if (gr >= 30) score += 20;
        else if (gr >= 10) score += 14;
        else if (gr >= 0)  score += 8;
      }
    }
  }

  // 3. PE 百分位（15分）
  const peRaw = await finmind('TaiwanStockPER', sid, daysAgo(730));
  await sleep(250);
  if (peRaw) {
    const pers = peRaw.map(r => +r.PER).filter(v => v > 0);
    if (pers.length >= 20) {
      const cur = pers.at(-1);
      const pePct = Math.round(pers.filter(v => v < cur).length / pers.length * 100);
      det.pePct = pePct;
      if (pePct <= 30) score += 15;
      else if (pePct <= 50) score += 11;
      else if (pePct <= 70) score += 6;
    }
  }

  // 4. 法人近15日（10分）
  const instRaw = await finmind('TaiwanStockInstitutionalInvestorsBuySell', sid, daysAgo(25));
  await sleep(250);
  if (instRaw) {
    const net = instRaw.reduce((s, r) => s + (+r.buy - +r.sell), 0);
    det.instOk = net > 0;
    if (net > 0) score += 10;
  }

  // 組合輸出
  const thermo = thermoInfo(det.pePct);
  const lbl    = scoreLabel(score);

  const parts = [];
  if (det.revYoy != null) parts.push(`營收YoY ${det.revYoy > 0 ? '+' : ''}${det.revYoy}%`);
  if (det.epsGrowth != null) parts.push(`EPS成長 ${det.epsGrowth > 0 ? '+' : ''}${det.epsGrowth}%`);
  const desc = parts.join('，') || '計算中...';

  let aiNote = null;
  if (det.pePct != null && det.pePct > 85 && score < 70)
    aiNote = `${name}估值偏高（PE歷史${det.pePct}百分位），可等待回調後再考慮進場。`;

  return { id: sid, name, sector: SECTOR[sid] || '', score, ...lbl,
           thermoPct: thermo.pct, thermoLabel: thermo.label, thermoColor: thermo.color,
           desc, aiNote, revYoy: det.revYoy ?? null, epsGrowth: det.epsGrowth ?? null,
           pePct: det.pePct ?? null, close };
}

// ── 趨勢族評分（TWSE優先，PRD v1.2 邏輯）─────────────
async function scoreTrend(sid, name) {
  // 1. 價格資料 → TWSE（免費），失敗才用 FinMind
  let priceRows = await twseStockPrice(sid, 4);   // ~80 交易日
  if (priceRows.length < 65) {
    addLog(`  TWSE price not enough for ${sid}, trying FinMind...`);
    const fm = await finmind('TaiwanStockPrice', sid, daysAgo(110));
    await sleep(300);
    if (fm) priceRows = sortedBy(fm, 'date').map(r => ({ ...r, close: +r.close, max: +r.max, min: +r.min, Trading_Volume: +r.Trading_Volume }));
  }

  if (priceRows.length < 65)
    return { id: sid, name, sector: SECTOR[sid]||'', score: 0, signal: 'gray',
             tag: '資料不足', tagColor: 'amber', thermoPct: 50, thermoLabel: '—',
             thermoColor: 'amber', desc: '價格資料不足', aiNote: null };

  const sorted = priceRows;
  const closes = sorted.map(r => r.close);
  const vols   = sorted.map(r => r.Trading_Volume);
  const last   = closes.at(-1);

  // MA扣抵：今日收盤 > 20/60 交易日前收盤
  const deduct20 = last > closes.at(-21);
  const deduct60 = last > closes.at(-61);
  const maOk = deduct20 && deduct60;

  // MA下彎（RED條件）：股價 < MA20扣抵值 且 < MA20當前值
  const ma20now = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const maRed = last < ma20now && !deduct20;

  // 量能 ≥ 20日均量 × 1.2（PRD Green條件）
  const vol20avg = vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const volOk = vols.at(-1) >= vol20avg * 1.2;
  const volMultiple = vol20avg > 0 ? +(vols.at(-1) / vol20avg).toFixed(2) : 0;

  // 2. 法人：TWSE 批次資料優先（今日），失敗用 FinMind
  let instScore = 0;
  const twseInst = await twseInstAll();
  if (twseInst[sid]) {
    const d = twseInst[sid];
    const netW = d.trustNet * 0.5 + d.foreignNet * 0.3 + d.dealerNet * 0.2;
    instScore = netW > 0 ? 1 : (netW < 0 ? -1 : 0);
  } else {
    const instRaw = await finmind('TaiwanStockInstitutionalInvestorsBuySell', sid, daysAgo(10));
    await sleep(250);
    if (instRaw) {
      const W = { Investment_Trust:0.5, Foreign_Investor:0.3, Dealer_self:0.2 };
      let ws = 0;
      for (const [n, w] of Object.entries(W)) {
        const net = instRaw.filter(r => r.name === n).slice(-3).reduce((s,r)=>s+(+r.buy - +r.sell),0);
        ws += (net > 0 ? w : net < 0 ? -w : 0);
      }
      instScore = ws;
    }
  }
  const instOk = instScore > 0;

  // 3. 燈號（PRD §4.3）
  let score, signal, tag, tagColor;
  if (maRed) {
    score = 15; signal = 'red'; tag = '跌破均線'; tagColor = 'amber';
  } else if (maOk && instOk && volOk) {
    score = 90; signal = 'green'; tag = '多方動能'; tagColor = 'green';
  } else if (maOk && (instOk || volOk)) {
    score = 65; signal = 'yellow'; tag = '趨勢在，待確認'; tagColor = 'green';
  } else if (maOk) {
    score = 50; signal = 'yellow'; tag = '均線上彎'; tagColor = 'green';
  } else {
    score = 25; signal = 'gray'; tag = '無明顯訊號'; tagColor = 'amber';
  }

  const today = sorted.at(-1);
  const chgP = today.open > 0 ? ((today.close - today.open) / today.open * 100).toFixed(2) : '0.00';
  const desc = [
    `MA扣抵: ${deduct20 ? '月✓' : '月✗'} ${deduct60 ? '季✓' : '季✗'}`,
    `量 ${volMultiple}x`,
    `漲${Number(chgP) >= 0 ? '+' : ''}${chgP}%`,
    `法人: ${instOk ? '買超' : '賣超'}`,
  ].join(' | ');

  return { id: sid, name, sector: SECTOR[sid]||'', score, signal, tag, tagColor,
           thermoPct: 50, thermoLabel: '—', thermoColor: 'amber',
           desc, aiNote: null, volMultiple, chgPct: Number(chgP), close: sorted.at(-1).close };
}

// ── 短線族評分（TWSE優先，PRD Phase 1）──────────────
async function scoreMomentum(sid, name) {
  const base = { id: sid, name, sector: SECTOR[sid]||'', score: 0, signal: 'gray',
                 tag: '無訊號', tagColor: 'amber', thermoPct: 50,
                 thermoLabel: '—', thermoColor: 'amber', desc: '今日未觸發訊號', aiNote: null, close: null };

  // 價格資料 → TWSE 優先（最近 2 個月即可）
  let rows = await twseStockPrice(sid, 2);
  if (rows.length < 6) {
    const fm = await finmind('TaiwanStockPrice', sid, daysAgo(40));
    await sleep(250);
    if (fm) rows = sortedBy(fm, 'date').map(r => ({ ...r, close:+r.close, open:+r.open, max:+r.max, min:+r.min, Trading_Volume:+r.Trading_Volume }));
  }
  if (rows.length < 6) return base;

  const today  = rows.at(-1);
  const vol5   = rows.slice(-6,-1).reduce((s,r)=>s+r.Trading_Volume,0) / 5;
  const volRat = vol5 > 0 ? rows.at(-1).Trading_Volume / vol5 : 0;
  const vol2x  = volRat >= 2;
  const chgP   = today.open > 0 ? (today.close - today.open) / today.open * 100 : 0;
  const rng    = today.max - today.min;
  const cpct   = rng > 0 ? (today.close - today.min) / rng : 0;
  const sig    = vol2x && chgP >= 3 && cpct >= 0.6;

  const desc = [
    `量${vol2x ? '✓' : '✗'} ${volRat.toFixed(1)}x均量`,
    `漲${chgP >= 3 ? '✓' : '✗'} ${chgP >= 0 ? '+' : ''}${chgP.toFixed(1)}%`,
    `收${cpct >= 0.6 ? '✓' : '✗'} ${(cpct*100).toFixed(0)}%`,
  ].join(' | ');

  let score = 0, signal = 'gray', tag = '無訊號', tagColor = 'gray';
  if (vol2x)    score += 33;
  if (chgP>=3)  score += 34;
  if (cpct>=0.6) score += 33;

  if (sig) {
    signal = 'green';  tag = `⚡ 爆量突破 ${volRat.toFixed(1)}x`; tagColor = 'green';
  } else if (vol2x && chgP >= 3) {
    signal = 'yellow'; tag = '⚡ 量增留意'; tagColor = 'green';
  } else if (vol2x) {
    signal = 'yellow'; tag = '量增，漲幅不足'; tagColor = 'amber';
  } else if (chgP >= 3 && cpct >= 0.6) {
    // 漲幅+收盤位置OK，只缺量能 → 黃燈提示
    signal = 'yellow'; tag = '漲強，待量能確認'; tagColor = 'amber';
  } else {
    // 顯示缺少哪些條件，讓使用者知道差在哪
    const miss = [];
    if (!vol2x)     miss.push('量能');
    if (chgP < 3)   miss.push('漲幅');
    if (cpct < 0.6) miss.push('收位');
    tag      = miss.length === 3 ? '今日無訊號' : `待${miss.join('+')}`;
    tagColor = 'gray';
    score    = Math.min(score, 35);
  }

  return { ...base, score, signal, tag, tagColor,
           thermoPct: Math.min(Math.round(cpct*100), 96), thermoLabel: `收盤位置 ${(cpct*100).toFixed(0)}%`,
           thermoColor: cpct >= 0.6 ? 'green' : cpct >= 0.4 ? 'amber' : 'red',
           desc, volRatio: +volRat.toFixed(2), chgPct: +chgP.toFixed(2), close: today.close };
}

// ── 存股族評分 ────────────────────────────────────────
async function scoreDividend(sid, name) {
  let score = 0;

  // 收盤價
  const priceRows = await twseStockPrice(sid, 1);
  const close = priceRows.length ? priceRows.at(-1).close : null;

  const peRaw = await finmind('TaiwanStockPER', sid, daysAgo(730));
  await sleep(250);
  let pePct = null;
  if (peRaw) {
    const pers = peRaw.map(r => +r.PER).filter(v => v > 0);
    if (pers.length >= 20) {
      const cur = pers.at(-1);
      pePct = Math.round(pers.filter(v => v < cur).length / pers.length * 100);
      if (pePct <= 20) score += 30;
      else if (pePct <= 40) score += 20;
      else if (pePct <= 60) score += 10;
    }
  }

  const revRaw = await finmind('TaiwanStockMonthRevenue', sid, daysAgo(800));
  await sleep(250);
  let revYoy = null;
  if (revRaw && revRaw.length >= 24) {
    const sorted = sortedBy(revRaw, 'date');
    const r12 = sorted.slice(-12).reduce((s, r) => s + +r.revenue, 0);
    const p12 = sorted.slice(-24, -12).reduce((s, r) => s + +r.revenue, 0);
    if (p12 > 0) {
      revYoy = (r12 - p12) / p12 * 100;
      if (revYoy >= 0)   score += 40;
      else if (revYoy >= -5)  score += 25;
      else if (revYoy >= -10) score += 10;
    }
  }

  const instRaw = await finmind('TaiwanStockInstitutionalInvestorsBuySell', sid, daysAgo(25));
  await sleep(250);
  if (instRaw) {
    const net = instRaw.reduce((s, r) => s + (+r.buy - +r.sell), 0);
    score += net > 0 ? 30 : 10;
  }

  const thermo = thermoInfo(pePct);
  let tag = '觀察中', tagColor = 'amber', signal = 'gray';
  if (score >= 85)       { signal = 'green'; tag = '高品質存股'; tagColor = 'green'; }
  else if (score >= 65)  { signal = 'yellow'; tag = '穩健配息'; tagColor = 'green'; }
  else if (score >= 45)  { signal = 'amber'; tag = '估值待觀察'; tagColor = 'amber'; }

  const desc = [
    revYoy != null ? `營收YoY ${revYoy > 0 ? '+' : ''}${revYoy.toFixed(1)}%` : null,
    pePct != null  ? `PE百分位 ${pePct}th` : null,
  ].filter(Boolean).join('，') || '計算中...';

  return { id: sid, name, sector: SECTOR[sid] || '', score, signal, tag, tagColor,
           thermoPct: thermo.pct, thermoLabel: thermo.label, thermoColor: thermo.color,
           desc, aiNote: null, pePct, close };
}

// ── 計算整族 ──────────────────────────────────────────
const scorerMap = { growth: scoreGrowth, trend: scoreTrend, momentum: scoreMomentum, dividend: scoreDividend };

async function computeTribe(tribe) {
  const stocks   = TRIBE_STOCKS[tribe] || TRIBE_STOCKS.growth;
  const scoreFn  = scorerMap[tribe] || scoreGrowth;
  const tribeName = { growth:'成長族', trend:'趨勢族', momentum:'短線族', dividend:'存股族' }[tribe] || tribe;
  const entries  = Object.entries(stocks);

  addLog(`🔄 開始計算 ${tribeName}（${entries.length} 支股票，並行）`);

  // 並行，每批 6 支，避免對 TWSE/FinMind 瞬間打太多請求
  const BATCH = 6;
  const results = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async ([sid, name]) => {
      try {
        const r = await scoreFn(sid, name);
        return r;
      } catch (e) {
        addLog(`  ✗ ${name}(${sid}): ${e.message}`);
        return null;
      }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  _stats.tribeLastUpdate[tribe] = new Date().toISOString();
  addLog(`✅ ${tribeName} 完成，今日 API 呼叫: ${_stats.apiCallsToday} 次`);
  const sorted = results.sort((a, b) => b.score - a.score);
  // 每次計算完自動存入 SQLite
  const today = new Date().toISOString().slice(0, 10);
  saveSignals(today, tribe, sorted);
  return sorted;
}

// ── HTTP 伺服器 ───────────────────────────────────────
const MIME = { '.html':'text/html;charset=utf-8', '.css':'text/css', '.js':'application/javascript',
               '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon' };

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8',
                         'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u    = new URL(req.url, `http://localhost:${PORT}`);
  const p    = u.pathname;
  const qs   = u.searchParams;

  // ── /api/kpi?tribe=growth  (依目前族群顯示對應統計)
  if (p === '/api/kpi') {
    const tribeFilter = qs.get('tribe');  // 前端切換族群時帶入
    const TRIBE_ZH = { growth:'成長族', trend:'趨勢族', momentum:'短線族', dividend:'存股族' };
    const tribes = (tribeFilter && TRIBE_ZH[tribeFilter])
      ? [tribeFilter]
      : ['growth','trend','momentum','dividend'];

    let greenCount = 0, redCount = 0, topStock = null, topTribe = null;
    for (const t of tribes) {
      const data = fromCache(`tribe:${t}`);
      if (!data) continue;
      greenCount += data.filter(s => s.signal === 'green').length;
      redCount   += data.filter(s => s.signal === 'red').length;
      if (!topStock) {
        const top = data.find(s => s.signal === 'green');
        if (top) { topStock = top; topTribe = t; }
      }
    }

    // 市場情緒：TWSE 加權指數（永遠是全市場，不跟著族群切換）
    const taiex = await twseTaiex();
    let sentimentText = '市場資料更新中', sentimentSub = '今日資料載入中', sentimentTrend = 'neutral';
    if (taiex) {
      const cp = taiex.changePct;
      if (cp > 0.8)       { sentimentText = '市場偏多'; sentimentSub = `加權指數 +${cp.toFixed(2)}%`; sentimentTrend = 'up'; }
      else if (cp < -0.8) { sentimentText = '市場偏空'; sentimentSub = `加權指數 ${cp.toFixed(2)}%`; sentimentTrend = 'down'; }
      else if (cp >= 0)   { sentimentText = '市場平穩偏多'; sentimentSub = `加權指數 +${cp.toFixed(2)}%`; sentimentTrend = 'up'; }
      else                { sentimentText = '市場小幅整理'; sentimentSub = `加權指數 ${cp.toFixed(2)}%`; sentimentTrend = 'down'; }
    }

    const label = tribeFilter ? TRIBE_ZH[tribeFilter] : '全族群';
    const noDataSub = tribeFilter ? `載入${label}後顯示` : '請先選擇族群';

    return sendJson(res, {
      tribe: tribeFilter || null,
      topStock: topStock ? {
        value: `${topStock.name} 領跑`,
        sub:   `${TRIBE_ZH[topTribe]} ${topStock.score}分 · ${topStock.sector}`,
      } : {
        value: greenCount > 0 ? `${greenCount} 檔綠燈` : label,
        sub:   greenCount > 0 ? `${label}偏強 ↑` : noDataSub,
      },
      sentiment: { value: sentimentText, sub: sentimentSub, trend: sentimentTrend },
      signals: {
        value: greenCount > 0 ? `${greenCount} 個綠燈` : '暫無綠燈',
        sub:   greenCount > 0 ? `${label}綠燈合計` : '等待訊號觸發',
      },
      warning: {
        value: redCount > 0 ? `${redCount} 個紅燈` : '無警示訊號',
        sub:   redCount > 0 ? `${label}請注意風險` : '風險可控',
      },
      dataReady: greenCount + redCount > 0,
    });
  }

  // ── /api/dashboard
  if (p === '/api/dashboard') {
    const today = new Date();
    return sendJson(res, {
      date:     `${today.getMonth() + 1}月${today.getDate()}日`,
      headline: '今日市場偏多',
      subtitle: '成長股有機會，但別急著追高',
      chip:     'AI / 伺服器族群動能偏強',
    });
  }

  // ── /api/stocks?tribe=growth
  if (p === '/api/stocks') {
    const tribe  = qs.get('tribe') || 'growth';
    const cKey   = `tribe:${tribe}`;
    const cached = fromCache(cKey);
    if (cached) {
      console.log(`[cache hit] ${tribe}`);
      return sendJson(res, cached);
    }
    console.log(`\n計算 ${tribe} 族...`);
    const data = await computeTribe(tribe);
    toCache(cKey, data);
    return sendJson(res, data);
  }

  // ── /api/refresh  (清除快取)
  if (p === '/api/refresh') {
    _cache.clear();
    addLog('🗑️  快取已手動清除');
    return sendJson(res, { ok: true, msg: '快取已清除，下次請求將重新從 FinMind 取得資料' });
  }

  // ── /api/status  (後台狀態)
  if (p === '/api/status') {
    resetDailyIfNeeded();
    const tribeNames = { growth:'成長族', trend:'趨勢族', momentum:'短線族', dividend:'存股族' };
    const cacheEntries = _cache.size;
    const tribes = Object.entries(_stats.tribeLastUpdate).map(([k, v]) => ({
      tribe: tribeNames[k] || k,
      lastUpdate: new Date(v).toLocaleString('zh-TW', { hour12: false }),
      age: Math.round((Date.now() - new Date(v).getTime()) / 60000) + ' 分鐘前',
      cacheValid: (Date.now() - new Date(v).getTime()) < CACHE_TTL,
    }));
    return sendJson(res, {
      server:       'StockNavi 本地伺服器',
      status:       'online',
      nodeVersion:  process.version,
      uptime:       Math.round(process.uptime() / 60) + ' 分鐘',
      dataSource:   'FinMind API (finmindtrade.com)',
      dailyLimit:   600,
      apiCallsToday: _stats.apiCallsToday,
      apiCallsTotal: _stats.apiCalls,
      cacheHits:    _stats.cacheHits,
      cacheEntries,
      cacheTTL:     '4 小時',
      tribes,
      recentLog:    _stats.log.slice(0, 20),
    });
  }

  // ── /api/history/:stock_id  個股歷史燈號（近 60 日）
  const histMatch = p.match(/^\/api\/history\/(\w+)$/);
  if (histMatch) {
    const sid = histMatch[1];
    const rows = db.prepare(`
      SELECT date, tribe, score, signal, tag, close_price
      FROM daily_signals WHERE stock_id=?
      ORDER BY date DESC, tribe
      LIMIT 240
    `).all(sid);
    // 按日期分組
    const byDate = {};
    for (const r of rows) {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date };
      byDate[r.date][r.tribe] = { score: r.score, signal: r.signal, tag: r.tag, close: r.close_price };
    }
    return sendJson(res, Object.values(byDate).sort((a,b) => b.date.localeCompare(a.date)));
  }

  // ── /api/signals?ids=2330,2454  取各股最新燈號（供前端自選清單用）
  if (p === '/api/signals') {
    const ids = (qs.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
    const result = {};
    for (const sid of ids) {
      const sigs = {};
      for (const tribe of ['growth','trend','momentum','dividend']) {
        const row = db.prepare(
          'SELECT signal, score, tag FROM daily_signals WHERE stock_id=? AND tribe=? ORDER BY date DESC LIMIT 1'
        ).get(sid, tribe);
        if (row) sigs[tribe] = row;
      }
      if (Object.keys(sigs).length) result[sid] = sigs;
    }
    return sendJson(res, result);
  }

  // ── 靜態檔案
  let file = p === '/' ? 'stocknavi.html' : p.slice(1);
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    return fs.createReadStream(filePath).pipe(res);
  }

  sendJson(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log('║   StockNavi 本地伺服器已啟動      ║');
  console.log(`║   http://localhost:${PORT}          ║`);
  console.log('╚══════════════════════════════════╝');
  console.log('');
  console.log('第一次開啟股票頁面時，伺服器會下載真實資料');
  console.log('(需要約 30 秒，之後 4 小時內快取)');
  console.log('');
});
