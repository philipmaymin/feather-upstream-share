#!/usr/bin/env node
// Feather Remote Agent — runs on remote boxes, serves jsonl + tmux over HTTP
// Designed to be accessed via SSH tunnel from the Feather switchboard
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';

const PORT = parseInt(process.env.PORT || '9000');
const HOME = process.env.HOME || '/home/user';
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects');

// ── JSONL parsing (inline, no external deps) ──────────────────────────────

const STRIP_TAGS = ['local-command-caveat', 'command-name', 'command-message', 'command-args', 'persisted-output'];

function parseMessage(line) {
  try {
    const d = JSON.parse(line);
    if (d.type !== 'user' && d.type !== 'assistant') return null;
    if (d.isSidechain || d.isMeta || !d.message) return null;
    const content = d.message.content;
    if (!content) return null;
    if (Array.isArray(content) && content.length === 0) return null;
    if (typeof content === 'string' && content.trim() === '') return null;
    let blocks;
    if (typeof content === 'string') {
      let text = content;
      for (const tag of STRIP_TAGS) {
        text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
      }
      text = text.trim();
      if (!text) return null;
      blocks = [{ type: 'text', text }];
    } else {
      blocks = content;
    }
    const hasVisible = blocks.some(b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && b.thinking?.trim()) ||
      b.type === 'tool_use' || b.type === 'tool_result'
    );
    if (!hasVisible) return null;
    return { uuid: d.uuid, role: d.message.role, timestamp: d.timestamp, content: blocks };
  } catch { return null; }
}

// ── JSONL helpers ──────────────────────────────────────────────────────────

function findJsonlPath(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const p = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getMessages(sessionId, limit = 100, before = 0) {
  const fpath = findJsonlPath(sessionId);
  if (!fpath || !fs.existsSync(fpath)) return { messages: [], hasMore: false };
  const lines = fs.readFileSync(fpath, 'utf8').split('\n').filter(Boolean);
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

// ── Tmux management ───────────────────────────────────────────────────────

function tmuxName(id) { return `feather-${id.slice(0, 8)}`; }

function tmuxIsActive(id) {
  try { execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function getActiveTmuxSessions() {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    const active = new Set();
    for (const line of out.split('\n')) {
      if (line.startsWith('feather-')) active.add(line.slice(8));
    }
    return active;
  } catch { return new Set(); }
}

function launchClaude(name, claudeArgs, cwd) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  // Write a temp launch script to avoid quoting hell with nested bash/tmux
  const script = `${HOME}/feather-launch-${name}.sh`;
  console.log(`[launch] writing script: ${script}`);
  try {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    const envLine = token ? `export CLAUDE_CODE_OAUTH_TOKEN="${token}"\n` : '';
    fs.writeFileSync(script, `#!/bin/bash -l\n${envLine}exec claude ${claudeArgs} --dangerously-skip-permissions --disallowed-tools AskUserQuestion\n`, { mode: 0o755 });
    console.log(`[launch] script written OK`);
  } catch (e) {
    console.error(`[launch] writeFileSync FAILED: ${e.message}`);
  }
  console.log(`[launch] spawning tmux: ${name}`);
  execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" ${script} \\; set-option -t ${name} prefix M-a`, { stdio: 'ignore' });
  for (const delay of [3000, 5000, 8000]) {
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, delay);
  }
}

function spawnSession(id, cwd) { launchClaude(tmuxName(id), `--session-id ${id}`, cwd); }
function resumeSession(id, cwd) { launchClaude(tmuxName(id), `--resume ${id}`, cwd); }

async function sendInput(id, text) {
  if (!tmuxIsActive(id)) {
    resumeSession(id);
    await new Promise(r => setTimeout(r, 6000));
  }
  const target = tmuxName(id);
  if (text.length > 500) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', target], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, 500);
  } else {
    execFileSync('tmux', ['send-keys', '-t', target, '-l', text], { stdio: 'ignore' });
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
  }
}

// ── SSE streaming ─────────────────────────────────────────────────────────

const sseClients = new Map();
const fileOffsets = new Map();

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

function processFileChange(filePath) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = path.basename(filePath, '.jsonl');
  const currentOffset = fileOffsets.get(sessionId) || 0;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= currentOffset) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - currentOffset);
    fs.readSync(fd, buf, 0, buf.length, currentOffset);
    fs.closeSync(fd);
    const content = buf.toString('utf8');
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

// Init watchers
function initWatchers() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dp = path.join(CLAUDE_PROJECTS, dir);
    try {
      for (const f of fs.readdirSync(dp)) {
        if (f.endsWith('.jsonl')) fileOffsets.set(f.replace('.jsonl', ''), fs.statSync(path.join(dp, f)).size);
      }
      fs.watch(dp, (event, filename) => {
        if (filename?.endsWith('.jsonl')) {
          const sid = filename.replace('.jsonl', '');
          if (!fileOffsets.has(sid)) fileOffsets.set(sid, 0);
          processFileChange(path.join(dp, filename));
        }
      });
    } catch {}
  }
  fs.watch(CLAUDE_PROJECTS, (event, filename) => {
    if (!filename) return;
    const dp = path.join(CLAUDE_PROJECTS, filename);
    try {
      if (fs.statSync(dp).isDirectory()) {
        fs.watch(dp, (ev, fn) => {
          if (fn?.endsWith('.jsonl')) {
            const sid = fn.replace('.jsonl', '');
            if (!fileOffsets.has(sid)) fileOffsets.set(sid, 0);
            processFileChange(path.join(dp, fn));
          }
        });
      }
    } catch {}
  });
}
initWatchers();

// ── Session discovery ─────────────────────────────────────────────────────

function discoverSessions(limit = 50) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const candidates = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const fpath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(fpath);
          if (stat.size < 50) continue;
          candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime });
        } catch {}
      }
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);
  const active = getActiveTmuxSessions();
  const sessions = [];
  for (const { id, fpath, mtime } of top) {
    try {
      const fd = fs.openSync(fpath, 'r');
      const buf = Buffer.alloc(Math.min(16384, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let title = null;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message?.content) {
            let text = '';
            if (typeof d.message.content === 'string') text = d.message.content;
            else if (Array.isArray(d.message.content)) text = d.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
            text = text.replace(/\[Attached (?:image|file): [^\]]+\]\s*(?:\([^)]*\))?/g, '').trim();
            if (text.startsWith('<command-message>')) {
              const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
              const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
              if (argsMatch?.[1]?.trim()) { title = `${nameMatch?.[1] || '/cmd'} ${argsMatch[1].trim()}`.slice(0, 80); break; }
              continue;
            }
            if (text && !text.startsWith('<')) { title = text.slice(0, 80); break; }
          }
        } catch {}
      }
      sessions.push({ id, title: title || id.slice(0, 8), updatedAt: mtime.toISOString(), isActive: active.has(id.slice(0, 8)) });
    } catch {}
  }
  return sessions;
}

// ── Express ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(HOME, 'static')));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', box: process.env.BOX_NAME || 'unknown', uptime: process.uptime() }));

app.get('/api/sessions', (req, res) => {
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore });
});

app.get('/api/sessions/:id/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');
  const sid = req.params.id;
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
  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  sseClients.get(sid).add(res);
  const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(hb); } }, 15000);
  res.on('close', () => { clearInterval(hb); sseClients.get(sid)?.delete(res); });
});

app.post('/api/sessions', (req, res) => {
  try { spawnSession(req.body.id, req.body.cwd); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', async (req, res) => {
  try { await sendInput(req.params.id, req.body.text); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', (req, res) => {
  try { resumeSession(req.params.id, req.body?.cwd); res.json({ ok: true }); }
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
    sseClients.delete(id);
    fileOffsets.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Terminal WebSocket ────────────────────────────────────────────────────

import http from 'http';
import { WebSocketServer } from 'ws';

let ptyModule;
try { ptyModule = await import('node-pty'); } catch { ptyModule = null; }

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/api/terminal')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  if (!ptyModule) { ws.close(1008, 'node-pty not installed'); return; }
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session');
  if (!sessionId) { ws.close(1008, 'session required'); return; }
  const name = tmuxName(sessionId);
  if (!tmuxIsActive(sessionId)) { ws.close(1000, 'Session not active'); return; }

  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX; delete cleanEnv.TMUX_PANE;
  cleanEnv.TERM = 'xterm-256color';

  const term = ptyModule.spawn('tmux', ['attach', '-t', name], {
    name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
  });

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

server.listen(PORT, '127.0.0.1', () => console.log(`Feather remote agent on http://127.0.0.1:${PORT} [${process.env.BOX_NAME || 'unnamed'}]`));
