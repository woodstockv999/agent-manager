const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3010;

const AGENTS_FILE  = path.join(__dirname, 'agents.json');
const PLUGINS_FILE = path.join(__dirname, 'plugins.json');
const COUNTS_FILE  = path.join(__dirname, 'execution-counts.json');

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
    const counts = readJSON(COUNTS_FILE) || {};
    counts[agentId] = (counts[agentId] || 0) + 1;
    counts.lastUpdated = new Date().toISOString();
    writeJSON(COUNTS_FILE, counts);
    res.json({ success: true, agent: agentId, count: counts[agentId] });
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
