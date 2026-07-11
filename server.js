const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3010;

const AGENTS_FILE  = path.join(__dirname, 'agents.json');
const PLUGINS_FILE = path.join(__dirname, 'plugins.json');
const COUNTS_FILE  = path.join(__dirname, 'execution-counts.json');
const EXEC_FILE    = path.join(__dirname, 'executions.jsonl');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

app.get('/api/agents', (req, res) => {
  const agents = readJSON(AGENTS_FILE) || [];
  const counts = readJSON(COUNTS_FILE) || {};

  const result = agents.map(a => {
    let skillPreview = null;
    try {
      const content = fs.readFileSync(a.skillFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      skillPreview = lines.slice(0, 5).join('\n');
    } catch {}

    return {
      ...a,
      executions: counts[a.id] || 0,
      skillPreview,
      skillExists: fs.existsSync(a.skillFile),
    };
  });

  res.json({
    agents: result,
    lastUpdated: counts.lastUpdated || null,
    totalExecutions: result.reduce((s, a) => s + a.executions, 0),
  });
});

let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

app.post('/api/track', (req, res) => {
  const agentId = req.query.agent;
  if (!agentId) return res.status(400).json({ error: 'agent query param required' });

  const agents = readJSON(AGENTS_FILE) || [];
  const plugins = readJSON(PLUGINS_FILE) || [];
  const known = agents.some(a => a.id === agentId) || plugins.some(p => p.id === agentId);
  if (!known) return res.status(400).json({ error: 'unknown agent id' });

  withWriteLock(() => {
    const now = new Date().toISOString();
    const counts = readJSON(COUNTS_FILE) || {};
    counts[agentId] = (counts[agentId] || 0) + 1;
    counts.lastUpdated = now;
    writeJSON(COUNTS_FILE, counts);
    // 追記オンリーの時系列ログ(グラフ用)。カウンタとは独立に per-event で残す。
    try { fs.appendFileSync(EXEC_FILE, JSON.stringify({ id: agentId, ts: now }) + '\n'); } catch {}
    res.json({ success: true, agent: agentId, count: counts[agentId] });
  });
});

/* ── 時系列(グラフ用) ──
   executions.jsonl を都度読み込み、JST 基準で日次・曜日×時間帯に集計する。
   データ量が小さいためキャッシュは持たない。 */
const JST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const JST_HW = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', hour12: false,
});
const WD = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

function readEvents() {
  let raw = '';
  try { raw = fs.readFileSync(EXEC_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && e.id && e.ts) out.push(e);
    } catch {}
  }
  return out;
}

app.get('/api/timeseries', (req, res) => {
  const DAYS = 60;
  const events = readEvents();

  const perDay = {};            // date -> { total, byId:{} }
  const perId  = {};            // id   -> { total, lastUsed }
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const e of events) {
    const d = new Date(e.ts);
    if (isNaN(d)) continue;
    const date = JST_DATE.format(d);              // YYYY-MM-DD (JST)
    (perDay[date] || (perDay[date] = { total: 0, byId: {} }));
    perDay[date].total++;
    perDay[date].byId[e.id] = (perDay[date].byId[e.id] || 0) + 1;

    const p = perId[e.id] || (perId[e.id] = { total: 0, lastUsed: null });
    p.total++;
    if (!p.lastUsed || e.ts > p.lastUsed) p.lastUsed = e.ts;

    const parts = JST_HW.formatToParts(d);
    const wd = WD[parts.find(x => x.type === 'weekday')?.value];
    let hr = parseInt(parts.find(x => x.type === 'hour')?.value, 10);
    if (hr === 24) hr = 0;
    if (wd != null && hr >= 0 && hr < 24) heatmap[wd][hr]++;
  }

  // 直近 DAYS 日の連続した日付列(欠損日はゼロ埋め)を JST 基準で生成
  const todayStr = JST_DATE.format(new Date());
  const cursor = new Date(todayStr + 'T00:00:00Z');
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const dd = new Date(cursor.getTime() - i * 86400000);
    const key = dd.toISOString().slice(0, 10);
    const rec = perDay[key];
    days.push({ date: key, total: rec ? rec.total : 0, byId: rec ? rec.byId : {} });
  }

  res.json({
    days,
    perId,
    heatmap,
    totalEvents: events.length,
    range: events.length
      ? { from: events[0].ts, to: events[events.length - 1].ts }
      : { from: null, to: null },
  });
});

app.get('/api/plugins', (req, res) => {
  const plugins = readJSON(PLUGINS_FILE) || [];
  const counts  = readJSON(COUNTS_FILE)  || {};
  const result  = plugins.map(p => ({ ...p, executions: counts[p.id] || 0 }));
  res.json({
    plugins: result,
    totalExecutions: result.reduce((s, p) => s + p.executions, 0),
  });
});

app.get('/api/skill/:id', (req, res) => {
  const agents = readJSON(AGENTS_FILE) || [];
  const agent = agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  try {
    const content = fs.readFileSync(agent.skillFile, 'utf8');
    res.type('text/plain').send(content);
  } catch {
    res.status(404).json({ error: 'skill file not found' });
  }
});

app.get('/api/stats', (req, res) => {
  const agents  = readJSON(AGENTS_FILE)  || [];
  const plugins = readJSON(PLUGINS_FILE) || [];
  const counts  = readJSON(COUNTS_FILE)  || {};

  const all = [
    ...agents.map(a  => ({ id: a.id,  name: a.name,  count: counts[a.id]  || 0 })),
    ...plugins.map(p => ({ id: p.id,  name: p.name,  count: counts[p.id]  || 0 })),
  ];
  const top = [...all].sort((a, b) => b.count - a.count)[0] || null;

  res.json({
    agentCount:      agents.length,
    pluginCount:     plugins.length,
    totalExecutions: all.reduce((s, x) => s + x.count, 0),
    topAgent: top,
    lastUpdated: counts.lastUpdated,
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Manager (CREW) listening on http://127.0.0.1:${PORT}`);
});
