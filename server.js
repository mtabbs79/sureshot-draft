// Sure Shot Supplemental Draft — tiny Node server
// State is one JSON blob, kept in Postgres when DATABASE_URL is set (Render), else in a local file.
const fs = require('fs');
const path = require('path');

const ROUNDS = 4;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'commish';
const PLAYERS = require('./data/players.json');
const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map(p => [p.id, p]));

// Round 1 order = reverse CBS power rankings (worst first). Snake after that.
const TEAMS = [
  { id: 3, name: 'Fins' },
  { id: 10, name: 'Bengo' },
  { id: 9, name: 'Juan Perez' },
  { id: 7, name: 'Something’s gotta give…..' },
  { id: 4, name: 'Lucky Lefty' },
  { id: 5, name: 'Under the Bus' },
  { id: 6, name: 'Raven One' },
  { id: 8, name: 'Santos' },
  { id: 1, name: 'Meet the Robinsons' },
  { id: 2, name: '#7' },
];
const TEAM_BY_ID = Object.fromEntries(TEAMS.map(t => [t.id, t]));
const N = TEAMS.length;
const TOTAL = ROUNDS * N;

function slot(i) { // i = 0-based overall pick index
  const round = Math.floor(i / N) + 1;
  const k = i % N;
  const team = round % 2 === 1 ? TEAMS[k] : TEAMS[N - 1 - k];
  return { overall: i + 1, round, pickInRound: k + 1, teamId: team.id };
}
const ORDER = Array.from({ length: TOTAL }, (_, i) => slot(i));

// ---------- storage ----------
let state = { picks: [], updatedAt: Date.now() };
let pool = null;
const FILE = path.join(__dirname, 'data', 'state.json');

async function load() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    // Render's internal URL (host like dpg-xxxx-a) needs no SSL; external URLs (with a domain) do.
    const host = new URL(process.env.DATABASE_URL).hostname;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: host.includes('.') ? { rejectUnauthorized: false } : false });
    await pool.query('CREATE TABLE IF NOT EXISTS draft_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    const r = await pool.query('SELECT data FROM draft_state WHERE id = 1');
    if (r.rows[0]) state = r.rows[0].data;
  } else if (fs.existsSync(FILE)) {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  }
}
async function save() {
  state.updatedAt = Date.now();
  if (pool) {
    await pool.query('INSERT INTO draft_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [state]);
  } else {
    fs.writeFileSync(FILE, JSON.stringify(state));
  }
}
// serialize all writes
let chain = Promise.resolve();
const locked = fn => (chain = chain.then(fn, fn));

// ---------- api (no framework) ----------
const http = require('http');
const PUBLIC = path.join(__dirname, 'public');
const routes = {};
const app = {
  get: (p, h) => (routes['GET ' + p] = h),
  post: (p, h) => (routes['POST ' + p] = h),
};
function wrapRes(res) {
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(o)); };
  res.send = t => res.end(String(t));
  return res;
}
const server = http.createServer((req, res) => {
  wrapRes(res);
  const url = new URL(req.url, 'http://x');
  const h = routes[req.method + ' ' + url.pathname];
  if (h) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; } h(req, res); });
    return;
  }
  if (req.method !== 'GET') return res.status(404).json({ error: 'Not found' });
  const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg' };
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});

function view() {
  const i = state.picks.length;
  return {
    rounds: ROUNDS,
    teams: TEAMS,
    order: ORDER,
    picks: state.picks.map(p => ({ ...p, player: PLAYER_BY_ID[p.playerId] })),
    onClock: i < TOTAL ? ORDER[i] : null,
    complete: i >= TOTAL,
    updatedAt: state.updatedAt,
  };
}

app.get('/api/players', (req, res) => res.json(PLAYERS));
app.get('/api/state', (req, res) => res.json(view()));

function makePick(teamId, playerId, byAdmin) {
  const i = state.picks.length;
  if (i >= TOTAL) throw new Error('The draft is complete.');
  const s = ORDER[i];
  if (!byAdmin && s.teamId !== teamId) throw new Error(`It's not your pick — ${TEAM_BY_ID[s.teamId].name} is on the clock.`);
  if (!PLAYER_BY_ID[playerId]) throw new Error('Unknown player.');
  if (state.picks.some(p => p.playerId === playerId)) throw new Error('That player was just taken.');
  state.picks.push({ ...s, playerId, at: Date.now(), byAdmin: !!byAdmin });
}

app.post('/api/pick', (req, res) => locked(async () => {
  try {
    const { teamId, playerId } = req.body || {};
    makePick(Number(teamId), String(playerId), false);
    await save();
    res.json(view());
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

function isAdmin(req) { return (req.body && req.body.password) === ADMIN_PASSWORD; }

app.post('/api/admin/check', (req, res) => isAdmin(req) ? res.json({ ok: true }) : res.status(403).json({ error: 'Wrong commissioner password.' }));

app.post('/api/admin/pick', (req, res) => locked(async () => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Wrong commissioner password.' });
  try {
    makePick(null, String(req.body.playerId), true);
    await save();
    res.json(view());
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.post('/api/admin/undo', (req, res) => locked(async () => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Wrong commissioner password.' });
  state.picks.pop();
  await save();
  res.json(view());
}));

app.post('/api/admin/reset', (req, res) => locked(async () => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Wrong commissioner password.' });
  state.picks = [];
  await save();
  res.json(view());
}));

app.get('/healthz', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
load().then(() => server.listen(PORT, () => console.log(`Draft running on :${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
