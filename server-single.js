import express from 'express';
import compression from 'compression';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, execFile } from 'child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage } from './lib/parse.js';

// Load ~/.env if present
try {
  const envFile = fs.readFileSync(path.join(process.env.HOME || '/home/user', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const DEEPGRAM_API_KEY = process.env.FEATHER_DEEPGRAM_API_KEY || '';

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME;
const STATIC_OVERRIDE = process.env.STATIC_OVERRIDE;
const STATIC_DIR = path.resolve(import.meta.dirname, STATIC_OVERRIDE || 'static');
const STAGING_DIR = path.resolve(import.meta.dirname, 'static-staging');
const MAX_SSE_PER_SESSION = 10;

// ── Per-user path helpers ───────────────────────────────────────────────────

function projectsDir() {
  return path.join(HOME, '.claude/projects');
}

function projectIdToCwd(projectId) {
  const segments = projectId.replace(/^-/, '').split('-');
  let cur = '';
  let rem = [...segments];
  while (rem.length > 0) {
    let found = false;
    for (let len = rem.length; len >= 1; len--) {
      const candidate = cur + '/' + rem.slice(0, len).join('-');
      try {
        if (fs.statSync(candidate).isDirectory()) {
          cur = candidate;
          rem = rem.slice(len);
          found = true;
          break;
        }
      } catch {}
    }
    if (!found) return null;
  }
  return cur;
}

function featherDir() {
  const d = path.join(HOME, '.feather');
  if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function uploadsDir() {
  const d = path.join(HOME, 'feather-uploads');
  if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function safePath(filePath) {
  const resolved = path.resolve(filePath);
  const home = path.resolve(HOME);
  return resolved === home || resolved.startsWith(home + '/');
}

// ── File reading ────────────────────────────────────────────────────────────

function readFileChunk(filePath, offset, length) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return null; }
}

// ── JSONL parsing ───────────────────────────────────────────────────────────

function findJsonlPath(sessionId) {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return null;
  for (const dir of fs.readdirSync(projDir)) {
    const p = path.join(projDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Session metadata ────────────────────────────────────────────────────────

function metaFilePath() {
  return path.join(featherDir(), 'session-meta.json');
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')); }
  catch { return {}; }
}

function writeMeta(meta) {
  fs.writeFileSync(metaFilePath(), JSON.stringify(meta, null, 2));
}

function getMessages(sessionId, limit = 100, before = 0) {
  const fpath = findJsonlPath(sessionId);
  if (!fpath) return { messages: [], hasMore: false };
  let content;
  try { content = fs.readFileSync(fpath, 'utf8'); } catch { return { messages: [], hasMore: false }; }
  const lines = content.split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    const m = parseMessage(line);
    if (m) msgs.push(m);
  }
  if (before > 0) {
    const end = Math.max(0, msgs.length - before);
    const start = Math.max(0, end - limit);
    return { messages: msgs.slice(start, end), hasMore: start > 0 };
  }
  const start = Math.max(0, msgs.length - limit);
  return { messages: msgs.slice(start), hasMore: start > 0 };
}

// ── Per-user JSON helpers ──────────────────────────────────────────────────

function readUserJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(featherDir(), filename), 'utf8')); }
  catch { return fallback; }
}

function writeUserJson(filename, data) {
  fs.writeFileSync(path.join(featherDir(), filename), JSON.stringify(data, null, 2));
}

// ── Tmux management ────────────────────────────────────────────────────────

function tmuxName(id) {
  return `f-${id.slice(0, 8)}`;
}

function getActiveTmuxSessions() {
  const prefix = 'f-';
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const active = new Set();
    for (const line of out.split('\n')) {
      if (line.startsWith(prefix)) active.add(line.slice(prefix.length));
    }
    return active;
  } catch { return new Set(); }
}

function tmuxIsActive(id) {
  try { execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function spawnTmuxClaude(name, claudeArgs, dir) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  const claudeCmd = `claude ${claudeArgs} --dangerously-skip-permissions --disallowed-tools AskUserQuestion`;
  const shellCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash -lc '${claudeCmd}'" \\; set-option -t ${name} prefix M-a`;
  execFileSync('bash', ['-c', shellCmd], { stdio: 'ignore', encoding: 'utf8' });
  for (const delay of [3000, 5000, 8000]) {
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, delay);
  }
}

function spawnOrResume(id, cwd, resume = false) {
  const dir = cwd || HOME;
  const args = resume ? `--resume ${id}` : `--session-id ${id}`;
  spawnTmuxClaude(tmuxName(id), args, dir);
}

function sendText(name, text) {
  if (text.length > 500) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', name], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, 500);
  } else {
    execFileSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'ignore' });
    execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
  }
}

function isClaudeRunning(name) {
  try {
    const cmd = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_current_command}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return cmd === 'claude' || cmd === 'node';
  } catch { return false; }
}

function sendInputToSession(id, text) {
  const name = tmuxName(id);
  let needsResume = false;
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    if (!isClaudeRunning(name)) needsResume = true;
  } catch { needsResume = true; }

  if (needsResume) {
    spawnOrResume(id, null, true);
    setTimeout(() => { try { sendText(name, text); } catch {} }, 3000);
  } else {
    sendText(name, text);
  }
}

// ── Extract first user message from JSONL ─────────────────────────────────

function extractSessionInfo(fpath) {
  let firstUserText = null;
  let isTitleGen = false;
  try {
    const fd = fs.openSync(fpath, 'r');
    const size = Math.min(16384, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    const headText = buf.toString('utf8');
    isTitleGen = headText.includes('Generate a concise title');
    for (const line of headText.split('\n').filter(Boolean)) {
      try {
        const d = JSON.parse(line);
        if (d.type !== 'user' || d.isMeta || d.isSidechain || !d.message?.content) continue;
        let text = '';
        if (typeof d.message.content === 'string') text = d.message.content;
        else if (Array.isArray(d.message.content)) text = d.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.replace(/\[Attached (?:image|file): [^\]]+\]\s*(?:\([^)]*\))?/g, '').trim();
        if (text && text.length > 3 && !text.startsWith('<') && !text.startsWith('Generate a concise title')) {
          const cmdMatch = text.match(/<command-name>\/?([^<]+)</);
          firstUserText = cmdMatch ? '/' + cmdMatch[1].trim() : text.slice(0, 80);
          break;
        }
      } catch {}
    }
  } catch {}

  let cwd = null;
  try {
    const fd = fs.openSync(fpath, 'r');
    const totalSize = fs.fstatSync(fd).size;
    const readSize = Math.min(32768, totalSize);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, totalSize - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === 'user' && d.cwd) { cwd = d.cwd; break; }
      } catch {}
    }
  } catch {}

  return { firstUserText, cwd, isTitleGen };
}

// ── Session discovery ──────────────────────────────────────────────────────

function discoverSessions(limit = 50, projectFilter) {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return [];

  const candidates = [];
  const dirs = projectFilter ? [projectFilter] : fs.readdirSync(projDir);
  for (const dir of dirs) {
    const dirPath = path.join(projDir, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const fpath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(fpath);
          if (stat.size < 50) continue;
          candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, projectId: dir });
        } catch {}
      }
    } catch {}
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  // Pre-compute session info once per candidate to avoid double extraction
  const withInfo = candidates.map(c => ({ ...c, info: extractSessionInfo(c.fpath) }));
  const filtered = withInfo.filter(c => !c.info.isTitleGen);
  const top = filtered.slice(0, limit);
  const active = getActiveTmuxSessions();
  const meta = readMeta();
  const labels = readUserJson('project-labels.json', {});

  return top.map(({ id, fpath, mtime, projectId, info }) => ({
    id, title: meta[id]?.title || info.firstUserText || id.slice(0, 8),
    updatedAt: mtime.toISOString(),
    isActive: active.has(id.slice(0, 8)),
    projectId,
    projectLabel: labels[projectId] || null,
    cwd: info.cwd || projectIdToCwd(projectId) || null,
  }));
}

// ── Auto-title generation ───────────────────────────────────────────────────

const titleQueue = new Set();
const MAX_CONCURRENT_TITLES = 2;

async function generateTitle(sessionId, firstMessage) {
  if (titleQueue.has(sessionId) || titleQueue.size >= MAX_CONCURRENT_TITLES) return;
  titleQueue.add(sessionId);
  try {
    const prompt = `Generate a concise title (3-6 words) for a conversation that starts with: "${firstMessage.slice(0, 200).replace(/"/g, '\\"')}". Reply with ONLY the title, no quotes, no explanation.`;
    const result = await new Promise((resolve, reject) => {
      execFile('claude', ['-p', prompt, '--model', 'haiku'], { encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });
    if (result && result.length < 60 && !result.includes('\n')) {
      const meta = readMeta();
      meta[sessionId] = { ...(meta[sessionId] || {}), title: result };
      writeMeta(meta);
    }
  } catch {}
  titleQueue.delete(sessionId);
}

setInterval(() => {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return;
  const meta = readMeta();
  for (const dir of fs.readdirSync(projDir)) {
    const dirPath = path.join(projDir, dir);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const file of files.slice(0, 20)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.replace('.jsonl', '');
      if (meta[id]?.title) continue;
      const { firstUserText } = extractSessionInfo(path.join(dirPath, file));
      if (firstUserText) generateTitle(id, firstUserText);
    }
  }
}, 60000);

// ── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Map();

function broadcast(sessionId, line, offset) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const parsed = parseMessage(line);
  if (!parsed) return;
  const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

// ── File watcher ───────────────────────────────────────────────────────────

const fileOffsets = new Map();
const watchedDirs = new Set();

function initFileOffsets() {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return;
  for (const dir of fs.readdirSync(projDir)) {
    const dp = path.join(projDir, dir);
    try {
      for (const f of fs.readdirSync(dp)) {
        if (!f.endsWith('.jsonl')) continue;
        try { fileOffsets.set(f.replace('.jsonl', ''), fs.statSync(path.join(dp, f)).size); } catch {}
      }
    } catch {}
  }
}

function processFileChange(filePath) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = path.basename(filePath, '.jsonl');
  const currentOffset = fileOffsets.get(sessionId) || 0;
  try {
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= currentOffset) return;
    const content = readFileChunk(filePath, currentOffset, stat.size - currentOffset);
    if (!content) return;
    const lastNL = content.lastIndexOf('\n');
    if (lastNL < 0) return;
    const complete = content.substring(0, lastNL + 1);
    let offset = currentOffset;
    for (const line of complete.split('\n').filter(Boolean)) {
      offset += Buffer.byteLength(line + '\n');
      broadcast(sessionId, line, offset);
    }
    fileOffsets.set(sessionId, currentOffset + Buffer.byteLength(complete));
  } catch {}
}

function watchDir(dp) {
  if (watchedDirs.has(dp)) return;
  watchedDirs.add(dp);
  try {
    fs.watch(dp, (event, filename) => {
      if (filename?.endsWith('.jsonl')) {
        const sid = filename.replace('.jsonl', '');
        if (!fileOffsets.has(sid)) fileOffsets.set(sid, 0);
        processFileChange(path.join(dp, filename));
      }
    });
  } catch {}
}

function watchProjectDir() {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return;
  for (const dir of fs.readdirSync(projDir)) {
    watchDir(path.join(projDir, dir));
  }
  try {
    fs.watch(projDir, (event, filename) => {
      if (!filename) return;
      const dp = path.join(projDir, filename);
      try { if (fs.statSync(dp).isDirectory()) watchDir(dp); } catch {}
    });
  } catch {}
}

initFileOffsets();
watchProjectDir();

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(compression({ filter: (req) => !req.headers.accept?.includes('text/event-stream') }));

app.use(express.static(STATIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

app.use('/uploads', express.static(path.resolve(import.meta.dirname, 'uploads')));
app.use('/opt/feather/uploads', express.static('/opt/feather/uploads'));
app.use('/home/user/feather-uploads', express.static('/home/user/feather-uploads'));

// ── API routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/version', (_req, res) => {
  try {
    // Check staging for a newer version
    const stagingHtml = path.join(STAGING_DIR, 'index.html');
    if (!fs.existsSync(stagingHtml)) return res.json({ stagingJs: null, changes: '' });
    const html = fs.readFileSync(stagingHtml, 'utf8');
    const match = html.match(/assets\/(index-[^.]+\.js)/);
    const changelog = path.join(import.meta.dirname, 'CHANGELOG.md');
    const changes = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '';
    res.json({ stagingJs: match ? match[1] : null, changes });
  } catch { res.json({ stagingJs: null, changes: '' }); }
});

app.post('/api/update', (_req, res) => {
  try {
    // Backup current static to rollback
    const rollbackDir = path.join(STATIC_DIR, 'rollback', Date.now().toString());
    fs.mkdirSync(rollbackDir, { recursive: true });
    for (const f of fs.readdirSync(STATIC_DIR)) {
      if (f === 'rollback') continue;
      const src = path.join(STATIC_DIR, f);
      const dest = path.join(rollbackDir, f);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    // Copy staging to static
    if (!fs.existsSync(STAGING_DIR)) return res.status(400).json({ error: 'No staging build' });
    for (const f of fs.readdirSync(STAGING_DIR)) {
      const src = path.join(STAGING_DIR, f);
      const dest = path.join(STATIC_DIR, f);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    res.json({ ok: true, rollback: rollbackDir });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects', (_req, res) => {
  const projDir = projectsDir();
  const labels = readUserJson('project-labels.json', {});
  const hidden = new Set(['memory', 'dashboards', '.claude', 'projects']);
  const projects = [];
  if (!fs.existsSync(projDir)) return res.json({ projects });
  for (const dir of fs.readdirSync(projDir)) {
    const segments = dir.replace(/^-/, '').split('-');
    const basename = (segments.length > 2 ? segments.slice(2).join('-') : segments[segments.length - 1]) || dir;
    if (hidden.has(basename)) continue;
    projects.push({ id: dir, label: labels[dir] || basename || dir, cwd: projectIdToCwd(dir) });
  }
  res.json({ projects });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json({ results: [] });
  const projectFilter = req.query.project || null;
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return res.json({ results: [] });

  const dirs = projectFilter ? [projectFilter] : fs.readdirSync(projDir);
  const results = [];
  const labels = readUserJson('project-labels.json', {});
  const meta = readMeta();
  const active = getActiveTmuxSessions();
  const maxResults = 30;

  for (const dir of dirs) {
    const dirPath = path.join(projDir, dir);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fpath = path.join(dirPath, file);
      const sessionId = file.replace('.jsonl', '');
      let content;
      try { content = fs.readFileSync(fpath, 'utf8'); } catch { continue; }

      let snippet = null;
      let matchCount = 0;
      for (const line of content.split('\n')) {
        if (!line) continue;
        const m = parseMessage(line);
        if (!m) continue;
        for (const block of m.content) {
          const text = block.text || block.thinking || '';
          if (!text) continue;
          const idx = text.toLowerCase().indexOf(q);
          if (idx >= 0) {
            matchCount++;
            if (!snippet) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + q.length + 60);
              snippet = (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '');
            }
          }
        }
      }

      if (snippet) {
        let stat;
        try { stat = fs.statSync(fpath); } catch { continue; }
        const info = extractSessionInfo(fpath);
        results.push({
          id: sessionId,
          title: meta[sessionId]?.title || info.firstUserText || sessionId.slice(0, 8),
          snippet, matchCount,
          updatedAt: stat.mtime.toISOString(),
          isActive: active.has(sessionId.slice(0, 8)),
          projectId: dir,
          projectLabel: labels[dir] || null,
          cwd: info.cwd || projectIdToCwd(dir) || null,
        });
        if (results.length >= maxResults) break;
      }
    }
    if (results.length >= maxResults) break;
  }

  results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ results });
});

app.get('/api/sessions', (req, res) => {
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50, req.query.project || null) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auth (trust Authelia Remote-User header) ────────────────────────────────

app.get('/api/me', (req, res) => {
  const remoteUser = req.headers['remote-user'];
  if (remoteUser) return res.json({ username: remoteUser.toLowerCase(), admin: true });
  // No Authelia header = direct localhost access, allow as default user
  res.json({ username: 'philip', admin: true });
});

app.post('/api/login', (req, res) => {
  // Login is handled by Authelia, just return success
  res.json({ ok: true, username: 'philip', admin: true });
});

app.post('/api/logout', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore });
});

app.get('/api/sessions/:id/stream', (req, res) => {
  const sid = req.params.id;

  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  const clients = sseClients.get(sid);
  if (clients.size >= MAX_SSE_PER_SESSION) {
    const oldest = clients.values().next().value;
    try { oldest.end(); } catch {}
    clients.delete(oldest);
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');

  const lastId = parseInt(req.query.lastEventId || req.headers['last-event-id'] || '0');
  if (lastId > 0) {
    const fpath = findJsonlPath(sid);
    if (fpath) {
      try {
        const stat = fs.statSync(fpath);
        if (stat.size > lastId) {
          const fd = fs.openSync(fpath, 'r');
          const buf = Buffer.alloc(stat.size - lastId);
          fs.readSync(fd, buf, 0, buf.length, lastId);
          fs.closeSync(fd);
          let offset = lastId;
          for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
            offset += Buffer.byteLength(line + '\n');
            const parsed = parseMessage(line);
            if (parsed) res.write(`id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`);
          }
        }
      } catch {}
    }
  }

  clients.add(res);
  const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(hb); } }, 15000);
  res.on('close', () => { clearInterval(hb); clients.delete(res); });
});

app.post('/api/sessions', (req, res) => {
  try { spawnOrResume(req.body.id, req.body.cwd); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', (req, res) => {
  try { sendInputToSession(req.params.id, req.body.text); res.json({ ok: true, sentAt: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', (req, res) => {
  try { spawnOrResume(req.params.id, req.body?.cwd, true); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/delete', (req, res) => {
  try {
    const id = req.params.id;
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(id)], { stdio: 'ignore' }); } catch {}
    const fpath = findJsonlPath(id);
    if (fpath) fs.unlinkSync(fpath);
    const meta = readMeta();
    delete meta[id];
    writeMeta(meta);
    sseClients.delete(id);
    fileOffsets.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/rename', (req, res) => {
  try {
    const meta = readMeta();
    meta[req.params.id] = { ...(meta[req.params.id] || {}), title: req.body.title };
    writeMeta(meta);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/fork', (req, res) => {
  try {
    const id = req.params.id;
    const cwd = req.body?.cwd || HOME;
    const forkName = `f-f${Date.now().toString(36)}`;
    spawnTmuxClaude(forkName, `--resume ${id} --fork-session`, cwd);
    res.json({ ok: true, tmux: forkName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  try {
    const dir = uploadsDir();
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100);
    const dest = `${Date.now()}-${safe || 'upload'}`;
    const fpath = path.join(dir, dest);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    fs.writeFileSync(fpath, Buffer.concat(chunks));
    res.json({ path: fpath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quick-links', (_req, res) => res.json(readUserJson('quick-links.json', [])));

app.post('/api/quick-links', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected array' });
  writeUserJson('quick-links.json', req.body);
  res.json({ ok: true });
});

app.get('/api/starred', (_req, res) => res.json(readUserJson('starred.json', {})));

app.post('/api/starred', (req, res) => {
  try { writeUserJson('starred.json', req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/export', (req, res) => {
  try {
    const { messages } = getMessages(req.params.id, 10000, 0);
    const lines = [];
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'You' : 'Claude';
      lines.push(`## ${role} — ${msg.timestamp}\n`);
      for (const block of msg.content || []) {
        if (block.type === 'text' && block.text) lines.push(block.text);
        else if (block.type === 'tool_use') lines.push(`> **${block.name}** ${block.input?.file_path || block.input?.command?.split('\\n')[0] || ''}\n`);
      }
      lines.push('');
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id.slice(0, 8)}.md"`);
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-in-editor', (req, res) => {
  try {
    const fpath = req.body?.path;
    if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    if (!safePath(fpath)) return res.status(403).json({ error: 'access denied' });
    execFileSync('code-server', [fpath], { stdio: 'ignore', timeout: 3000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/label', (req, res) => {
  try {
    const labels = readUserJson('project-labels.json', {});
    labels[req.params.id] = req.body.label;
    writeUserJson('project-labels.json', labels);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Idle session reaper ────────────────────────────────────────────────────

const IDLE_MS = 60 * 60 * 1000;

function reapIdleSessions() {
  const now = Date.now();
  const active = getActiveTmuxSessions();
  if (active.size === 0) return;
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return;
  for (const dir of fs.readdirSync(projDir)) {
    const dirPath = path.join(projDir, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const id = file.replace('.jsonl', '');
        if (!active.has(id.slice(0, 8))) continue;
        const stat = fs.statSync(path.join(dirPath, file));
        if (now - stat.mtimeMs > IDLE_MS) {
          const name = tmuxName(id);
          try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        }
      }
    } catch {}
  }
}

setInterval(reapIdleSessions, 5 * 60 * 1000);

// ── SPA catch-all ───────────────────────────────────────────────────────────

app.get('/{*path}', (_req, res) => {
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
});

// ── HTTP server + WebSocket ────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sttWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/api/terminal') || req.url?.startsWith('/api/shell')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (req.url?.startsWith('/api/stt')) {
    sttWss.handleUpgrade(req, socket, head, (ws) => sttWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Deepgram STT WebSocket proxy ────────────────────────────────────────────

sttWss.on('connection', (client) => {
  if (!DEEPGRAM_API_KEY) {
    client.send(JSON.stringify({ error: 'No Deepgram API key configured' }));
    client.close();
    return;
  }

  const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&interim_results=true&endpointing=300&smart_format=true&encoding=linear16&sample_rate=16000&channels=1';
  const dg = new WS(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

  dg.on('open', () => client.send(JSON.stringify({ type: 'ready' })));

  dg.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        client.send(JSON.stringify({
          type: 'transcript',
          text: alt.transcript || '',
          is_final: msg.is_final,
          speech_final: msg.speech_final,
        }));
      }
    } catch {}
  });

  dg.on('close', () => { if (client.readyState === WS.OPEN) client.close(); });
  dg.on('error', () => { if (client.readyState === WS.OPEN) client.close(); });

  client.on('message', (data) => {
    if (dg.readyState === WS.OPEN) dg.send(data);
  });

  client.on('close', () => {
    if (dg.readyState === WS.OPEN) {
      dg.send(JSON.stringify({ type: 'CloseStream' }));
      dg.close();
    }
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const isShell = url.pathname === '/api/shell';

  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX; delete cleanEnv.TMUX_PANE;
  cleanEnv.TERM = 'xterm-256color';

  let term;
  if (isShell) {
    term = pty.spawn('bash', ['-l'], {
      name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv, cwd: HOME,
    });
  } else {
    const sessionId = url.searchParams.get('session');
    if (!sessionId) { ws.close(1008, 'session required'); return; }
    if (!tmuxIsActive(sessionId)) { ws.close(1000, 'Session not active'); return; }

    term = pty.spawn('tmux', ['attach', '-t', tmuxName(sessionId)], {
      name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
    });
  }

  term.onData(data => { try { ws.send(data); } catch {} });
  term.onExit(() => { try { ws.close(); } catch {} });

  ws.on('message', (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize') { term.resize(parsed.cols, parsed.rows); return; }
    } catch {}
    term.write(str);
  });

  ws.on('close', () => { try { term.kill(); } catch {} });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Feather (single-user) on http://0.0.0.0:${PORT}`));
