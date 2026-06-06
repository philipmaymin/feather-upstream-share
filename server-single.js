import express from 'express';
import compression from 'compression';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, execFile, spawn } from 'child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';
import { generateRunSh, listPipelines } from './lib/auto-runsh.js';

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
const CODEX_SESSIONS_ROOT = path.join(HOME || '/home/user', '.codex/sessions');
const OMP_SESSIONS = path.join(HOME || '/home/user', '.feather/omp-sessions');
try { fs.mkdirSync(OMP_SESSIONS, { recursive: true }); } catch {}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function findClaudeJsonlPath(sessionId) {
  const projDir = projectsDir();
  if (!fs.existsSync(projDir)) return null;
  for (const dir of fs.readdirSync(projDir)) {
    const p = path.join(projDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Codex stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*-<UUID>.jsonl.
// idOrUuid may be the feather session id (mapped via session-meta.codexUuid)
// or the raw codex UUID itself.
function findCodexJsonlPath(idOrUuid) {
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return null;
  const meta = readMeta();
  const uuid = meta[idOrUuid]?.codexUuid || idOrUuid;
  const stack = [CODEX_SESSIONS_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith(`-${uuid}.jsonl`)) return full;
    }
  }
  return null;
}

function findJsonlPath(sessionId, agent) {
  if (agent === 'codex') return findCodexJsonlPath(sessionId);
  if (agent === 'omp') return findOmpJsonlPath(sessionId);
  if (agent === 'claude') return findClaudeJsonlPath(sessionId);
  // Unknown agent — try claude first (the common case), then codex, then omp
  return findClaudeJsonlPath(sessionId) || findCodexJsonlPath(sessionId) || findOmpJsonlPath(sessionId);
}

function getAgentForSession(sessionId) {
  const meta = readMeta();
  if (meta[sessionId]?.agent) return meta[sessionId].agent;
  // Auto-detect codex sessions discovered from disk (id is the codex UUID itself)
  if (UUID_RE.test(sessionId) && findCodexJsonlPath(sessionId)) return 'codex';
  return 'claude';
}

function findSessionCwd(sessionId) {
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath) return null;
  // Codex paths live under ~/.codex/sessions, not ~/.claude/projects, so the
  // projectId trick doesn't apply — read cwd from the file directly.
  if (jsonlPath.startsWith(CODEX_SESSIONS_ROOT)) {
    try {
      const buf = fs.readFileSync(jsonlPath).slice(0, 65536);
      return extractCodexCwd(buf);
    } catch { return null; }
  }
  const projectId = path.basename(path.dirname(jsonlPath));
  return projectIdToCwd(projectId);
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

// A message "counts" toward the page size only if it has visible user/assistant
// text. Internal-only messages (tool_use, tool_result, thinking) ride along for
// free so the UI can still group and collapse them without eating the window.
function hasVisibleText(msg) {
  return (msg.content || []).some(b => b.type === 'text' && (b.text || '').trim().length > 0);
}

function getMessages(sessionId, limit = 100, before = 0) {
  const agent = getAgentForSession(sessionId);
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath) return { messages: [], hasMore: false };
  let content;
  try { content = fs.readFileSync(fpath, 'utf8'); } catch { return { messages: [], hasMore: false }; }
  const lines = content.split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    const m = parseMessageForAgent(line, agent);
    if (m) msgs.push(m);
  }
  const end = Math.max(0, msgs.length - before);
  let start = end;
  let visibleCount = 0;
  for (let i = end - 1; i >= 0; i--) {
    const v = hasVisibleText(msgs[i]);
    if (v && visibleCount >= limit) break;
    start = i;
    if (v) visibleCount++;
  }
  const hasMore = start > 0;
  // Drop orphan internal messages at the head of the chunk — they'll come back
  // attached to their preceding visible message on the next "Load earlier".
  if (visibleCount > 0) {
    while (start < end && !hasVisibleText(msgs[start])) start++;
  }
  return { messages: msgs.slice(start, end), hasMore };
}

// ── Per-user JSON helpers ──────────────────────────────────────────────────

function readUserJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(featherDir(), filename), 'utf8')); }
  catch { return fallback; }
}

function writeUserJson(filename, data) {
  fs.writeFileSync(path.join(featherDir(), filename), JSON.stringify(data, null, 2));
}

// ── Codex helpers ──────────────────────────────────────────────────────────

function extractCodexUuid(filename) {
  const m = filename.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return m ? m[1] : null;
}

function listCodexJsonlFiles() {
  const out = [];
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return out;
  const stack = [CODEX_SESSIONS_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        const uuid = extractCodexUuid(ent.name);
        if (!uuid) continue;
        try { out.push({ uuid, fpath: full, mtime: fs.statSync(full).mtime }); } catch {}
      }
    }
  }
  return out;
}

// ── omp (oh-my-pi) helpers ───────────────────────────────────────────────────
// omp stores each session under ~/.feather/omp-sessions/<featherId>/, one or
// more {timestamp}_{snowflake}.jsonl rollouts. The feather session id is the
// directory name, so (unlike codex) no UUID adoption is needed.
function findOmpJsonlPath(sessionId) {
  const dir = path.join(OMP_SESSIONS, sessionId);
  if (!fs.existsSync(dir)) return null;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return null;
    files.sort().reverse(); // most recent first
    return path.join(dir, files[0]);
  } catch { return null; }
}

function extractOmpTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'session' && d.title) return d.title.slice(0, 80);
      if (d.type === 'message' && d.message?.role === 'user') {
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.trim();
        if (text) return text.slice(0, 80);
      }
    } catch {}
  }
  return null;
}

// omp's internal snowflake session id lives in the session header line; needed
// to resume the right conversation within a session dir.
function getOmpSessionId(featherId) {
  const fpath = findOmpJsonlPath(featherId);
  if (!fpath) return null;
  try {
    const fd = fs.openSync(fpath, 'r');
    const buf = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const d = JSON.parse(buf.toString('utf8').split('\n')[0]);
    if (d.type === 'session' && d.id) return d.id;
  } catch {}
  return null;
}

function extractCodexTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type !== 'response_item') continue;
      const p = d.payload;
      if (p?.type !== 'message' || p.role !== 'user') continue;
      const text = (p.content || [])
        .filter(b => b.type === 'input_text' && b.text)
        .map(b => b.text).join(' ').trim();
      if (!text) continue;
      if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>') || text.startsWith('<skills_instructions>') || text.startsWith('<user_instructions>')) continue;
      return text.slice(0, 80);
    } catch {}
  }
  return null;
}

function extractCodexCwd(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'session_meta' && d.payload?.cwd) return d.payload.cwd;
      if (d.type === 'turn_context' && d.payload?.cwd) return d.payload.cwd;
    } catch {}
  }
  return null;
}

// Codex persists per-cwd trust in ~/.codex/config.toml. Without this entry it
// shows a "Do you trust the contents of this directory?" prompt that runtime
// flags can't skip — we pre-mark cwd as trusted before launch.
function ensureCodexTrust(cwd) {
  if (!cwd) return;
  const cfg = path.join(HOME, '.codex/config.toml');
  let body = '';
  try { body = fs.readFileSync(cfg, 'utf8'); } catch {}
  const header = `[projects."${cwd}"]`;
  if (body.includes(header)) return;
  const block = `\n${header}\ntrust_level = "trusted"\n`;
  try {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.appendFileSync(cfg, block);
  } catch (e) { console.warn(`[codex] could not write trust for ${cwd}:`, e.message); }
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
  const claudeCmd = `claude ${claudeArgs} --dangerously-skip-permissions --disallowed-tools "AskUserQuestion,EnterPlanMode,ExitPlanMode"`;
  const shellCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash -lc '${claudeCmd}'" \\; set-option -t ${name} prefix M-a`;
  execFileSync('bash', ['-c', shellCmd], { stdio: 'ignore', encoding: 'utf8' });
}

function spawnTmuxCodex(name, codexArgs, dir) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  // codex installs to ~/.npm-global/bin, which is only on the interactive-rc
  // PATH (not the login-shell PATH claude uses) — launch via --rcfile -i so the
  // binary resolves and gets its full environment, same as omp.
  const codexCmd = `codex ${codexArgs} --dangerously-bypass-approvals-and-sandbox`;
  const shellCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash --rcfile ~/.bashrc -ic '${codexCmd}'" \\; set-option -t ${name} prefix M-a`;
  execFileSync('bash', ['-c', shellCmd], { stdio: 'ignore', encoding: 'utf8' });
}

// omp is launched via an interactive rc shell so it resolves on PATH the same
// way upstream invokes it (oh-my-pi installs add themselves to ~/.bashrc).
function spawnTmuxOmp(name, ompArgs, dir) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  const ompCmd = `omp ${ompArgs} --allow-home`;
  const shellCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash --rcfile ~/.bashrc -ic '${ompCmd}'" \\; set-option -t ${name} prefix M-a`;
  execFileSync('bash', ['-c', shellCmd], { stdio: 'ignore', encoding: 'utf8' });
}

// Codex doesn't accept a preset session id. We snapshot existing rollout files,
// spawn codex, then poll for the new rollout file and adopt its UUID into
// session-meta so future messages/resumes can find it.
function adoptNewCodexUuid(featherId, beforeUuids, attempts = 30) {
  let n = 0;
  const tick = () => {
    n++;
    const after = listCodexJsonlFiles();
    const fresh = after.filter(f => !beforeUuids.has(f.uuid));
    if (fresh.length > 0) {
      fresh.sort((a, b) => b.mtime - a.mtime);
      const uuid = fresh[0].uuid;
      const meta = readMeta();
      meta[featherId] = { ...(meta[featherId] || {}), agent: 'codex', codexUuid: uuid };
      writeMeta(meta);
      fileOffsets.set(featherId, 0);
      watchCodexFile(fresh[0].fpath, featherId);
      return;
    }
    if (n < attempts) setTimeout(tick, 500);
    else console.warn(`[codex] failed to adopt UUID for ${featherId} after ${attempts} attempts`);
  };
  setTimeout(tick, 500);
}

function spawnOrResume(id, cwd, resume = false, agent = null) {
  const resolvedAgent = agent || (resume ? getAgentForSession(id) : 'claude');
  const name = tmuxName(id);

  if (resolvedAgent === 'codex') {
    if (resume) {
      const meta = readMeta();
      const codexUuid = meta[id]?.codexUuid || (UUID_RE.test(id) ? id : null);
      const fpath = findCodexJsonlPath(id);
      let sessionCwd = cwd;
      if (!sessionCwd && fpath) {
        try { sessionCwd = extractCodexCwd(fs.readFileSync(fpath).slice(0, 65536)); } catch {}
      }
      sessionCwd = (sessionCwd || HOME).replace(/[^a-zA-Z0-9._\-/]/g, '');
      ensureCodexTrust(sessionCwd);
      if (fpath) { fileOffsets.set(id, fs.statSync(fpath).size); watchCodexFile(fpath, id); }
      const resumeArg = codexUuid ? `resume ${codexUuid}` : 'resume --last';
      spawnTmuxCodex(name, `${resumeArg} --cd ${sessionCwd}`, cwd || sessionCwd);
    } else {
      const dir = cwd || HOME;
      ensureCodexTrust(dir);
      const before = new Set(listCodexJsonlFiles().map(f => f.uuid));
      const meta = readMeta();
      meta[id] = { ...(meta[id] || {}), agent: 'codex' };
      writeMeta(meta);
      spawnTmuxCodex(name, '', dir);
      adoptNewCodexUuid(id, before);
    }
    return;
  }

  if (resolvedAgent === 'omp') {
    const sessionDir = path.join(OMP_SESSIONS, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    watchOmpSessionDir(sessionDir, id);
    if (resume) {
      const ompId = getOmpSessionId(id);
      const resumeArg = ompId ? `--resume ${ompId}` : '--continue';
      spawnTmuxOmp(name, `${resumeArg} --session-dir ${sessionDir}`, cwd || HOME);
    } else {
      const meta = readMeta();
      meta[id] = { ...(meta[id] || {}), agent: 'omp' };
      writeMeta(meta);
      spawnTmuxOmp(name, `--session-dir ${sessionDir}`, cwd || HOME);
    }
    return;
  }

  const dir = cwd || (resume ? findSessionCwd(id) : null) || HOME;
  const args = resume ? `--resume ${id}` : `--session-id ${id}`;
  spawnTmuxClaude(name, args, dir);
}

function inputStillContainsMarker(name, marker) {
  try {
    const content = execFileSync('tmux', ['capture-pane', '-t', name, '-p'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 });
    const lines = content.trimEnd().split('\n');
    const tail = lines.slice(Math.max(0, lines.length - 8));
    for (const line of tail) {
      if (line.includes(marker) && /[>❯│]/.test(line)) return true;
    }
    return false;
  } catch { return false; }
}

async function sendText(name, text) {
  // Use file-based paste for long text OR text with newlines (crossterm TUI
  // doesn't handle literal newlines from send-keys -l; they become line breaks
  // in the input area instead of being submitted)
  const isLong = text.length > 500 || text.includes('\n');
  if (isLong) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', name], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    await new Promise(r => setTimeout(r, 500));
  } else {
    execFileSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));
  }

  // Send Enter with retry verification: if text is still visible in input box,
  // re-send Enter. Handles the race where TUI isn't fully ready post-spawn.
  const marker = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 500));
    if (!marker || !inputStillContainsMarker(name, marker)) return;
  }
}

function isClaudeRunning(name) {
  try {
    const cmd = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_current_command}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return cmd === 'claude' || cmd === 'node';
  } catch { return false; }
}

function isClaudeAtPrompt(name) {
  try {
    const content = execFileSync('tmux', ['capture-pane', '-t', name, '-p'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = content.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
      const line = lines[i];
      // Claude Code prompt: line starts with ❯ or > (input prompt)
      if (/^\s*[>❯]\s*$/.test(line)) return true;
      // Welcome screen with `Try "..."` placeholder — CC is ready, paste replaces the placeholder
      if (/^\s*[>❯]\s+Try\s+"/.test(line)) return true;
    }
    return false;
  } catch { return false; }
}

function waitForClaudeReady(name, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let processDetected = false;
    let firstPromptSeenAt = 0;
    const STABILITY_MS = 800; // prompt must be present this long before we trust it
    function check() {
      try {
        execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
      } catch {
        return reject(new Error('session_gone'));
      }
      if (!processDetected && isClaudeRunning(name)) {
        processDetected = true;
      }
      if (processDetected && isClaudeAtPrompt(name)) {
        if (!firstPromptSeenAt) firstPromptSeenAt = Date.now();
        if (Date.now() - firstPromptSeenAt >= STABILITY_MS) return resolve();
      } else {
        firstPromptSeenAt = 0;
      }
      if (Date.now() - start > timeoutMs) {
        if (processDetected) return resolve();
        return reject(new Error('timeout'));
      }
      setTimeout(check, 250);
    }
    setTimeout(check, 250);
  });
}

// Codex needs paste-buffer for every message. After the first turn, Enter
// inserts a newline instead of submitting if you used send-keys -l, so we
// route through bracketed paste with a 300ms delay before Enter.
async function sendCodexText(name, text) {
  const tmp = `/tmp/feather-send-${Date.now()}.txt`;
  fs.writeFileSync(tmp, text);
  try {
    execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
    execFileSync('tmux', ['paste-buffer', '-t', name], { stdio: 'ignore' });
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
}

async function sendInputToSession(id, text) {
  const name = tmuxName(id);
  const agent = getAgentForSession(id);
  let sessionExists = false;
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    sessionExists = true;
  } catch {}

  if (!sessionExists) {
    spawnOrResume(id, null, true, agent);
    // Codex doesn't have a "claude ready" prompt detector — give it a fixed
    // settle window before sending input.
    if (agent === 'codex') await new Promise(r => setTimeout(r, 6000));
  }

  if (agent === 'codex') {
    await sendCodexText(name, text);
    return;
  }

  try {
    await waitForClaudeReady(name);
    await sendText(name, text);
  } catch {
    spawnOrResume(id, null, true, agent);
    try {
      await waitForClaudeReady(name);
      await sendText(name, text);
    } catch {
      throw new Error('Failed to resume session after retry');
    }
  }
}

// ── Extract first user message from JSONL ─────────────────────────────────

function extractSessionInfo(fpath) {
  let firstUserText = null;
  let isTitleGen = false;
  let isWorker = false;
  try {
    const fd = fs.openSync(fpath, 'r');
    const size = Math.min(16384, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    const headText = buf.toString('utf8');
    isTitleGen = headText.includes('Generate a concise title');
    isWorker = headText.includes('AUTO_WORKER=TRUE')
      || headText.includes('/home/user/auto-')
      || headText.includes('/home/user/autoweb-');
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

  return { firstUserText, cwd, isTitleGen, isWorker };
}

// ── Session discovery ──────────────────────────────────────────────────────

function discoverSessions(limit = 50, projectFilter) {
  const projDir = projectsDir();
  const candidates = [];

  if (fs.existsSync(projDir)) {
    const dirs = projectFilter ? [projectFilter] : fs.readdirSync(projDir);
    for (const dir of dirs) {
      // Path-based worker exclusion: ~/auto-* / ~/autoweb-* projects
      if (!projectFilter && /-home-user-(?:auto|autoweb)-/.test(dir)) continue;
      const dirPath = path.join(projDir, dir);
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const fpath = path.join(dirPath, file);
          try {
            const stat = fs.statSync(fpath);
            if (stat.size < 50) continue;
            candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, projectId: dir, agent: 'claude' });
          } catch {}
        }
      } catch {}
    }
  }

  // Codex sessions, only when not filtering by a specific Claude project
  if (!projectFilter) {
    for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
      try {
        const stat = fs.statSync(fpath);
        if (stat.size < 50) continue;
        candidates.push({ id: uuid, fpath, mtime, projectId: null, agent: 'codex' });
      } catch {}
    }
  }

  // omp sessions, likewise only in the unfiltered (all-projects) view
  if (!projectFilter && fs.existsSync(OMP_SESSIONS)) {
    for (const dir of fs.readdirSync(OMP_SESSIONS)) {
      const dirPath = path.join(OMP_SESSIONS, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        if (files.length === 0) continue;
        files.sort().reverse();
        const fpath = path.join(dirPath, files[0]);
        const stat = fs.statSync(fpath);
        if (stat.size < 50) continue;
        candidates.push({ id: dir, fpath, mtime: stat.mtime, projectId: null, agent: 'omp' });
      } catch {}
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  // Pre-compute session info once per candidate. Codex needs a bigger read
  // window than claude — its session_meta + permissions block alone is ~15KB.
  const withInfo = candidates.map(c => {
    if (c.agent === 'codex') {
      let buf;
      try {
        const fd = fs.openSync(c.fpath, 'r');
        buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
      } catch { buf = Buffer.alloc(0); }
      const isWorker = buf.includes('AUTO_WORKER=TRUE')
        || buf.includes('/home/user/auto-')
        || buf.includes('/home/user/autoweb-');
      return { ...c, info: { firstUserText: extractCodexTitle(buf), cwd: extractCodexCwd(buf), isTitleGen: false, isWorker } };
    }
    if (c.agent === 'omp') {
      let buf;
      try { buf = fs.readFileSync(c.fpath).slice(0, 65536); } catch { buf = Buffer.alloc(0); }
      return { ...c, info: { firstUserText: extractOmpTitle(buf), cwd: null, isTitleGen: false, isWorker: false } };
    }
    return { ...c, info: extractSessionInfo(c.fpath) };
  });

  const filtered = withInfo.filter(c => !c.info.isTitleGen && !c.info.isWorker);
  const top = filtered.slice(0, limit).sort((a, b) => b.mtime - a.mtime);
  const active = getActiveTmuxSessions();
  const meta = readMeta();
  const labels = readUserJson('project-labels.json', {});

  return top.map(({ id, fpath, mtime, projectId, agent, info }) => ({
    id, title: meta[id]?.title || info.firstUserText || id.slice(0, 8),
    updatedAt: mtime.toISOString(),
    isActive: active.has(id.slice(0, 8)),
    projectId,
    projectLabel: projectId ? (labels[projectId] || null) : null,
    cwd: info.cwd || (projectId ? projectIdToCwd(projectId) : null) || null,
    agent,
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
  // Parse by agent so codex/omp-format lines stream live (claude parser alone
  // returns null for their shapes, silently dropping live updates).
  const parsed = parseMessageForAgent(line, getAgentForSession(sessionId));
  if (!parsed) return;
  const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

// ── Activity + question polling (single tmux capture per session) ───────────

const lastActivity = new Map(); // sessionId -> last broadcast activity string
const lastQuestion = new Map(); // sessionId -> last broadcast question JSON
const lastPaneHash = new Map(); // sessionId -> hash of last pane content
const paneStableCount = new Map(); // sessionId -> consecutive polls with same content

function capturePaneLines(tmuxName) {
  const content = execFileSync('tmux', ['capture-pane', '-t', tmuxName, '-p'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 });
  return { lines: content.split('\n'), raw: content };
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h;
}

// Build a stability key: strip lines that change every second (status bar,
// spinner animations, runtime/cost counters) so pane-stability polling can
// actually converge. Without this, Claude's live status bar flips the hash
// every poll and question detection never fires.
function paneStabilityKey(raw) {
  return raw.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return false;
    if (/bypass permissions/i.test(t)) return false;
    if (/\bctx\s*[\[(]/i.test(t)) return false;
    if (/\$\d+(\.\d+)?(\s|$)/.test(t)) return false;
    if (/\b\d+h\s*\d+(\.\d+)?m\b/.test(t)) return false;
    if (/\b\d+(\.\d+)?s\b.*tokens?\b/i.test(t)) return false;
    if (/\(esc to interrupt\)/i.test(t)) return false;
    if (/^[✻·●✶⧫◆▸►▹☆★✦⏳◉⊛+*]\s+\S.*(ing\.{3}|…)/.test(t)) return false;
    return true;
  }).join('\n');
}

function extractActivity(lines) {
  // Anchor-based search: walk back from the empty input prompt looking for
  // a spinner/activity line. Works in the common case (idle prompt visible).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯>]\s*$/.test(lines[i])) {
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const line = lines[j].trim();
        if (!line || /^[─━═─]+$/.test(line)) continue;
        if (/^⎿/.test(line) || /^Tip:/.test(line) || /bypass permissions/.test(line)) continue;
        if (/^[✻·*●✶⧫◆▸►▹☆★✦⏳◉⊛]/.test(line) || /\(\d+[sm]\s/.test(line)) {
          return line;
        }
        break;
      }
      break;
    }
  }
  // Fallback: when there's no idle ❯ (queued input, typed text in box, or
  // compaction has redrawn the input area), scan the bottom of the pane for
  // a spinner line. The activity is always near the bottom, just above the
  // input/status area.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/bypass permissions/.test(line) || /\bctx\s*[\[(]/.test(line)) continue;
    if (/Claude Code v\d/.test(line) || /^Tip:/.test(line)) continue;
    if (/^[✻·*●✶⧫◆▸►▹☆★✦⏳◉⊛]\s+\S.*(ing\.{3}|…|\(\d+[sm]\s)/.test(line)) {
      return line;
    }
  }
  return null;
}

function extractQuestion(lines, hasActivity) {
  // If Claude is actively working (spinner visible), it's not asking a question
  if (hasActivity) return null;

  // If at normal input prompt (empty ❯ or >), no question
  // Note: bypass permissions is part of Claude's status bar and is always visible,
  // so it should NOT prevent question detection.
  // Check a wider window (25 lines) to handle status bar content below the prompt
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    const line = lines[i];
    if (/^\s*[❯>]\s*$/.test(line)) return null;
    if (/^⎿/.test(line.trim())) return null;
    // User message display lines ("> text") in scrollback mean we're in conversation, not a menu
    if (/^\s*>\s+\S/.test(line) && line.trim().length > 10) return null;
  }

  const tail = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 20; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // Skip Claude's status bar lines (always present at bottom of pane)
    if (/bypass permissions/.test(trimmed)) continue;
    if (/\bctx\s*\[/.test(trimmed)) continue;
    if (/^⏵⏵/.test(trimmed)) continue;
    if (/^Opus|^Sonnet|^Haiku/.test(trimmed) && /\bctx\b|\$\d/.test(trimmed)) continue;
    if (/weekly limit|resets \d/.test(trimmed)) continue;
    if (/^Claude Code v\d/.test(trimmed)) continue;
    if (/^Tip:/.test(trimmed)) continue;
    tail.unshift(lines[i]);
  }
  if (tail.length === 0) return null;

  const tailJoined = tail.join('\n');
  // Queued-input state: idle prompt is replaced by this indicator. Not a menu.
  if (/Press up to edit queued messages/i.test(tailJoined)) return null;
  // Spinner/activity text that extractActivity's anchor-based logic may miss
  if (/\(thinking\b|\(esc to interrupt\)|tokens?\)/i.test(tailJoined)) return null;
  if (/^[✻·●✶⧫◆▸►▹☆★✦⏳◉⊛+*]\s+\S.*(ing\.{3}|…)/m.test(tailJoined)) return null;

  // Pattern 1: Interactive selector (❯ followed by text = CLI menu)
  // Distinguished from empty prompt (bare ❯) by the \S after whitespace
  // Only check the last 8 tail lines to avoid matching ❯ in scrolled output
  const bottomTail = tail.slice(-8);
  // Reject if the input-box placeholder is visible, that's not a menu
  const tailText = tail.join('\n');
  if (/Send a message/i.test(tailText)) return null;
  if (bottomTail.some(l => /^\s*❯\s+\S/.test(l))) {
    // Real selector menus are wrapped in a box (vertical bars + corners).
    // CC's welcome screen and input prompt use only horizontal `─` separators,
    // which look like a menu but aren't. Require corners or vertical bars.
    const hasBoxDrawing = tail.some(l => /[╭╮╰╯│┌┐└┘┤├┬┴┼║╔╗╚╝]/.test(l));
    if (!hasBoxDrawing) return null;
    // Reject CC's welcome-screen tip: a single "❯ Try \"...\"" line between
    // horizontal separators with no question text or other options.
    if (bottomTail.some(l => /^\s*❯\s+Try\s+"/.test(l))) return null;

    // Real selector menus have exactly ONE ❯ line (the selected option).
    // Multiple ❯ lines means we're seeing conversation scrollback (user messages), not a menu.
    const cursorLineCount = tail.filter(l => /^\s*❯\s+\S/.test(l)).length;
    if (cursorLineCount > 1) return null;

    let questionLines = [];
    const options = [];
    let inOptions = false;
    let numberedFormat = false;
    // Strip a leading "N." or "N. " so the prose-detector doesn't trip on the
    // numbered prefix (e.g. "1. Yes" has ". " but isn't prose).
    const stripNum = (s) => s.replace(/^\d+\.\s*/, '');
    for (const line of tail) {
      const trimmed = line.trim();
      if (/^❯\s+/.test(trimmed)) {
        inOptions = true;
        const optText = trimmed.replace(/^❯\s+/, '');
        const body = stripNum(optText);
        // The selected option in a real menu is a short label, not prose.
        if (body.length > 50 || /[.!?]\s/.test(body)) return null;
        numberedFormat = /^\d+\.\s*\S/.test(optText);
        options.push(optText);
      } else if (inOptions) {
        // Footer / chrome terminates option parsing.
        if (/^Esc\s/.test(trimmed)) break;
        if (/^[▐▛▜▌▝▘█]/.test(trimmed)) break;
        if (!trimmed) continue;
        if (numberedFormat) {
          // Numbered format: a new option starts with "N.", everything else
          // is a wrapped continuation of the previous option.
          if (/^\d+\.\s*\S/.test(trimmed)) {
            options.push(trimmed);
          } else if (options.length > 0) {
            options[options.length - 1] += ' ' + trimmed;
          }
        } else {
          // Plain format: each non-empty line is its own option.
          options.push(trimmed);
        }
      } else if (!inOptions && trimmed) {
        // Box-drawing separator marks the top of the question box; anything
        // above it is scrollback (e.g. heredoc content) and not the question.
        if (/^[╭╮╰╯│─┌┐└┘┤├┬┴┼═║╔╗╚╝╌]+$/.test(trimmed)) {
          questionLines = [];
          continue;
        }
        questionLines.push(trimmed);
      }
    }
    // Require at least 2 options for a real selector (❯ selected + at least one more)
    if (options.length >= 2) {
      // Real Claude Code menu options are short, single-phrase lines. If any
      // "option" looks like prose (too long, or sentence punctuation mid-line), bail.
      const looksLikeProse = (s) => {
        const body = stripNum(s);
        return body.length > 100 || /[.!?]\s+[A-Z]/.test(body);
      };
      if (options.some(looksLikeProse)) return null;
      // Menu questions are brief. Reject if aggregated question text is prose-length.
      const questionText = questionLines.slice(-3).join('\n');
      if (questionText.length > 200) return null;
      return { type: 'selector', question: questionText, options, selectedIndex: 0 };
    }
  }

  // Pattern 2: Y/n or y/N prompt (must be at the very end of the last line)
  const lastLine = tail[tail.length - 1].trim();
  if (/\([Yy]\/[Nn]\)\s*$/.test(lastLine)) {
    return { type: 'yesno', question: tail.join('\n').trim() };
  }

  return null;
}

function broadcastActivity(sessionId, activity) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: activity\ndata: ${JSON.stringify({ activity })}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

function broadcastQuestion(sessionId, question) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: question\ndata: ${JSON.stringify({ question })}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

setInterval(() => {
  try {
    for (const [sid, clients] of sseClients.entries()) {
      if (clients.size === 0) continue;
      const name = tmuxName(sid);
      let pane;
      try { pane = capturePaneLines(name); } catch { continue; }
      const lines = pane.lines;

      // Track pane stability: only detect questions when pane is unchanged for 2+ polls.
      // Hash only the non-dynamic content (status bar timer/cost/ctx updates every
      // second and would otherwise prevent stability from ever being reached).
      const hash = simpleHash(paneStabilityKey(pane.raw));
      const prevHash = lastPaneHash.get(sid);
      if (hash === prevHash) {
        paneStableCount.set(sid, (paneStableCount.get(sid) || 0) + 1);
      } else {
        paneStableCount.set(sid, 0);
        lastPaneHash.set(sid, hash);
      }

      // Activity
      const activity = extractActivity(lines);
      const prevAct = lastActivity.get(sid);
      if (activity !== prevAct) {
        lastActivity.set(sid, activity);
        broadcastActivity(sid, activity);
      }

      // Question: only when not actively working AND pane has been stable (not mid-generation)
      const stable = (paneStableCount.get(sid) || 0) >= 2;
      const question = stable ? extractQuestion(lines, !!activity) : null;
      const qJson = question ? JSON.stringify(question) : null;
      const prevQ = lastQuestion.get(sid);
      if (qJson !== prevQ) {
        lastQuestion.set(sid, qJson);
        broadcastQuestion(sid, question);
      }
    }
  } catch (e) { console.error('Activity poll error:', e.message); }
}, 2000);

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

function processFileChange(filePath, sessionIdOverride) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = sessionIdOverride || path.basename(filePath, '.jsonl');
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

// Codex session watching. Codex rollout files live under ~/.codex/sessions/
// in date-partitioned dirs. The featherId for a session may either equal the
// codex UUID (sessions discovered from disk) or be a feather-generated id
// mapped via session-meta.codexUuid (sessions we spawned).
const watchedCodexDirs = new Map(); // dirPath -> Map<filename, featherId>

function watchCodexFile(fpath, featherId) {
  const dirPath = path.dirname(fpath);
  const filename = path.basename(fpath);
  if (!watchedCodexDirs.has(dirPath)) {
    watchedCodexDirs.set(dirPath, new Map());
    try {
      fs.watch(dirPath, (event, fn) => {
        if (!fn) return;
        const map = watchedCodexDirs.get(dirPath);
        const fid = map?.get(fn);
        if (!fid) return;
        const full = path.join(dirPath, fn);
        if (!fileOffsets.has(fid)) fileOffsets.set(fid, 0);
        processFileChange(full, fid);
      });
    } catch {}
  }
  watchedCodexDirs.get(dirPath).set(filename, featherId);
}

// omp session dirs hold their rollouts directly, so we watch the dir and stream
// any .jsonl change through the same SSE path codex uses.
const watchedOmpDirs = new Set();
function watchOmpSessionDir(dirPath, featherId) {
  if (watchedOmpDirs.has(dirPath)) return;
  watchedOmpDirs.add(dirPath);
  try {
    fs.watch(dirPath, (event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      const full = path.join(dirPath, filename);
      if (!fileOffsets.has(featherId)) fileOffsets.set(featherId, 0);
      processFileChange(full, featherId);
    });
  } catch {}
}

function initCodexWatchers() {
  // Watch the most recent ~100 codex sessions on startup. Limiting fanout
  // because fs.watch on every historical date dir is wasteful.
  const recent = listCodexJsonlFiles().sort((a, b) => b.mtime - a.mtime).slice(0, 100);
  for (const { uuid, fpath } of recent) {
    try {
      fileOffsets.set(uuid, fs.statSync(fpath).size);
      watchCodexFile(fpath, uuid);
    } catch {}
  }
}

initFileOffsets();
watchProjectDir();
initCodexWatchers();

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
app.use('/opt/feather/uploads', express.static(path.resolve(import.meta.dirname, 'uploads')));
app.use('/home/user/feather-uploads', express.static('/home/user/feather-uploads'));

// ── API routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Detect an optional agent's version via the interactive-rc shell so binaries
// under ~/.npm-global/bin (codex, omp) resolve the same way they do when spawned
// (the systemd PATH the server runs under doesn't include them). Returns the
// last non-empty output line, or null if the binary is absent.
function agentVersion(bin) {
  try {
    const out = execFileSync('bash', ['--rcfile', path.join(HOME || '/home/user', '.bashrc'), '-ic', `${bin} --version`], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(s => s.trim()).filter(Boolean).pop() || null;
  } catch { return null; }
}

app.get('/api/agents', (_req, res) => {
  const agents = [{ id: 'claude', label: 'Claude Code', available: true }];
  const codexVer = agentVersion('codex');
  agents.push(codexVer ? { id: 'codex', label: `Codex ${codexVer}`, available: true } : { id: 'codex', label: 'Codex', available: false });
  const ompVer = agentVersion('omp');
  agents.push(ompVer ? { id: 'omp', label: `oh-my-pi ${ompVer}`, available: true } : { id: 'omp', label: 'oh-my-pi', available: false });
  res.json({ agents });
});

// Verify that staging is a coherent build: index.html points to a JS bundle
// that actually exists in staging/assets. Returns the matched JS filename, or null.
function validateStaging() {
  const stagingHtml = path.join(STAGING_DIR, 'index.html');
  if (!fs.existsSync(stagingHtml)) return { ok: false, reason: 'no index.html' };
  const html = fs.readFileSync(stagingHtml, 'utf8');
  const match = html.match(/assets\/(index-[^.]+\.js)/);
  if (!match) return { ok: false, reason: 'no JS bundle in index.html' };
  const jsPath = path.join(STAGING_DIR, 'assets', match[1]);
  if (!fs.existsSync(jsPath)) return { ok: false, reason: `missing asset ${match[1]}` };
  return { ok: true, stagingJs: match[1] };
}

app.get('/api/version', (_req, res) => {
  try {
    const v = validateStaging();
    const changelog = path.join(import.meta.dirname, 'CHANGELOG.md');
    const changes = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '';
    // Only advertise staging if it's coherent (assets exist to match index.html)
    res.json({ stagingJs: v.ok ? v.stagingJs : null, changes });
  } catch { res.json({ stagingJs: null, changes: '' }); }
});

app.post('/api/update', (_req, res) => {
  try {
    if (!fs.existsSync(STAGING_DIR)) return res.status(400).json({ error: 'No staging build' });
    const v = validateStaging();
    if (!v.ok) return res.status(400).json({ error: `Staging invalid: ${v.reason}` });
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
    // Replace assets wholesale (remove stale hashed bundles that staging doesn't have)
    const staticAssets = path.join(STATIC_DIR, 'assets');
    if (fs.existsSync(staticAssets)) fs.rmSync(staticAssets, { recursive: true, force: true });
    // Copy staging to static
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

  // Send current activity immediately on connect
  const curActivity = lastActivity.get(sid) ?? extractActivity(tmuxName(sid));
  if (curActivity) {
    res.write(`event: activity\ndata: ${JSON.stringify({ activity: curActivity })}\n\n`);
    if (!lastActivity.has(sid)) lastActivity.set(sid, curActivity);
  }

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
  try { spawnOrResume(req.body.id, req.body.cwd, false, req.body.agent); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', async (req, res) => {
  try {
    await sendInputToSession(req.params.id, req.body.text);
    // Reset pane stability so question detection doesn't fire on stale state
    paneStableCount.set(req.params.id, 0);
    res.json({ ok: true, sentAt: new Date().toISOString() });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', async (req, res) => {
  try {
    spawnOrResume(req.params.id, req.body?.cwd, true);
    try { await waitForClaudeReady(tmuxName(req.params.id)); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/answer', (req, res) => {
  try {
    const name = tmuxName(req.params.id);
    const { type, index, text } = req.body;
    if (type === 'selector' && typeof index === 'number') {
      // For selector: send Down arrow `index` times, then Enter
      for (let i = 0; i < index; i++) {
        execFileSync('tmux', ['send-keys', '-t', name, 'Down'], { stdio: 'ignore' });
      }
      execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
    } else if (type === 'numbered' && typeof index === 'number') {
      // For numbered choices: type the number + Enter
      execFileSync('tmux', ['send-keys', '-t', name, '-l', String(index + 1)], { stdio: 'ignore' });
      execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
    } else if (type === 'yesno') {
      execFileSync('tmux', ['send-keys', '-t', name, '-l', text || 'y'], { stdio: 'ignore' });
      execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
    } else if (text) {
      execFileSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'ignore' });
      execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
    }
    // Clear the cached question and reset pane stability so it doesn't re-broadcast
    lastQuestion.delete(req.params.id);
    paneStableCount.set(req.params.id, 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

  // Reap codex sessions
  try {
    for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
      if (!active.has(uuid.slice(0, 8))) continue;
      if (now - mtime.getTime() > IDLE_MS) {
        const name = tmuxName(uuid);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}

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

// ── File browser API ──────────────────────────────────────────────────────

const ALLOWED_ROOTS = [HOME, '/tmp', '/opt'];

function isPathAllowed(p) {
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved.startsWith(root));
}

app.get('/api/files/list', (req, res) => {
  try {
    const dir = req.query.dir || HOME;
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
    if (!isPathAllowed(dir)) return res.status(403).json({ error: 'Access denied' });
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const entries = [];
    for (const name of fs.readdirSync(resolved)) {
      if (!showHidden && name.startsWith('.')) continue;
      try {
        const full = path.join(resolved, name);
        const s = fs.statSync(full);
        entries.push({
          name,
          path: full,
          isDir: s.isDirectory(),
          size: s.isDirectory() ? null : s.size,
          mtime: s.mtime.toISOString(),
        });
      } catch {}
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ dir: resolved, parent: path.dirname(resolved), entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files/raw', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!isPathAllowed(filePath)) return res.status(403).json({ error: 'Access denied' });
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (stat.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>10MB)' });
    const ext = path.extname(resolved).toLowerCase();
    const textExts = new Set(['.txt', '.md', '.js', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.rb', '.go', '.rs', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini', '.env', '.sql', '.csv', '.xml', '.log', '.jsonl', '.svelte', '.vue', '.astro', '.mjs', '.cjs']);
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
    if (imageExts.has(ext)) {
      return res.sendFile(resolved);
    }
    if (textExts.has(ext) || ext === '') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.sendFile(resolved);
    }
    // Default: download
    res.download(resolved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a file or directory. Gated by isPathAllowed (stricter than upstream,
// which only required a leading slash) so deletes stay within ALLOWED_ROOTS.
app.delete('/api/files/delete', (req, res) => {
  const fpath = req.query.path;
  if (!fpath || !isPathAllowed(fpath)) return res.status(403).json({ error: 'Access denied' });
  const resolved = path.resolve(fpath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'not found' });
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) fs.rmSync(resolved, { recursive: true });
    else fs.unlinkSync(resolved);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /api/auto: instances ────────────────────────────────────────────────────

// New instances live at ~/auto-NAME/. Legacy instances (created before the
// rename) live at ~/autoweb-NAME/ and are still resolved for back-compat.
const AUTO_PREFIX = 'auto-';
const LEGACY_PREFIX = 'autoweb-';

function autoDir(name) {
  const fresh = path.join(HOME, AUTO_PREFIX + name);
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(HOME, LEGACY_PREFIX + name);
  if (fs.existsSync(legacy)) return legacy;
  return fresh;
}

const safeAutoName = (n) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(n);

function readSafe(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function isAutoRunning(pidPath) {
  const pid = parseInt(readSafe(pidPath).trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function summarizeAutoInstance(name) {
  const dir = autoDir(name);
  if (!fs.existsSync(path.join(dir, 'run.sh'))) return null;
  const tsv = readSafe(path.join(dir, 'results.tsv'));
  const rows = tsv.split('\n').slice(1).filter(Boolean);
  let keeps = 0, reverts = 0, crashes = 0, skips = 0;
  for (const r of rows) {
    const status = r.split('\t')[1];
    if (status === 'keep') keeps++;
    else if (status === 'revert') reverts++;
    else if (status === 'crash') crashes++;
    else if (status === 'skip') skips++;
  }
  const last = rows.slice(-1)[0]?.split('\t') || [];
  const mainChat = readSafe(path.join(dir, 'main_chat.txt')).trim() || null;
  return {
    name,
    dir,
    running: isAutoRunning(path.join(dir, 'auto.pid')),
    current: readSafe(path.join(dir, 'current.txt')).trim(),
    keeps, reverts, crashes, skips,
    iterations: rows.length,
    last: last.length ? { timestamp: last[0], status: last[1], description: last[2] } : null,
    mainChat,
  };
}

function listAutoInstances() {
  const out = [];
  const seen = new Set();
  let entries;
  try { entries = fs.readdirSync(HOME); } catch { return out; }
  for (const entry of entries) {
    let name;
    if (entry.startsWith(AUTO_PREFIX)) name = entry.slice(AUTO_PREFIX.length);
    else if (entry.startsWith(LEGACY_PREFIX)) name = entry.slice(LEGACY_PREFIX.length);
    else continue;
    if (!safeAutoName(name) || seen.has(name)) continue;
    seen.add(name);
    const s = summarizeAutoInstance(name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listAutoWorkerSessions(name, limit = 20) {
  const out = [];
  const projDir = projectsDir();
  const projDirs = [
    path.join(projDir, `-home-user-${AUTO_PREFIX}${name}`),
    path.join(projDir, `-home-user-${LEGACY_PREFIX}${name}`),
  ];
  for (const pd of projDirs) {
    if (!fs.existsSync(pd)) continue;
    try {
      for (const f of fs.readdirSync(pd)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pd, f);
        const st = fs.statSync(fp);
        if (st.size < 50) continue;
        out.push({ id: f.replace('.jsonl', ''), agent: 'claude', mtime: st.mtime.toISOString() });
      }
    } catch {}
  }
  for (const { uuid, fpath, mtime } of listCodexJsonlFiles().slice(0, 200)) {
    try {
      const fd = fs.openSync(fpath, 'r');
      const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (buf.includes(`${AUTO_PREFIX}${name}`) || buf.includes(`${LEGACY_PREFIX}${name}`)) {
        out.push({ id: uuid, agent: 'codex', mtime: mtime.toISOString() });
      }
    } catch {}
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, limit);
}

app.get('/api/auto/instances', (_req, res) => {
  res.json({ instances: listAutoInstances() });
});

app.get('/api/auto/instances/:name', (req, res) => {
  const { name } = req.params;
  if (!safeAutoName(name)) return res.status(400).json({ error: 'bad name' });
  const s = summarizeAutoInstance(name);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.program = readSafe(path.join(s.dir, 'program.md'));
  s.results = readSafe(path.join(s.dir, 'results.tsv'));
  s.workerSessions = listAutoWorkerSessions(name);
  res.json(s);
});

app.get('/api/auto/pipelines', (_req, res) => {
  res.json({ pipelines: listPipelines() });
});

function resolveAutoPipelineName({ pipeline, template }) {
  if (pipeline) return pipeline;
  if (!template || template === 'full') return 'claude-codex';
  if (template === 'simple') return 'simple';
  return template;
}

app.post('/api/auto/instances', express.json(), (req, res) => {
  const { name, target, url, repo, template, pipeline, goal } = req.body || {};
  if (!safeAutoName(name)) return res.status(400).json({ error: 'bad name (lowercase, digits, dashes)' });

  const dir = path.join(HOME, AUTO_PREFIX + name);
  const legacyDir = path.join(HOME, LEGACY_PREFIX + name);
  if (fs.existsSync(dir) || fs.existsSync(legacyDir)) {
    return res.status(409).json({ error: 'already exists' });
  }

  const pipelineName = resolveAutoPipelineName({ pipeline, template });
  const available = listPipelines();
  if (!available.includes(pipelineName)) {
    return res.status(400).json({ error: `unknown pipeline: ${pipelineName}. Available: ${available.join(', ')}` });
  }

  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  let runSh;
  try {
    runSh = generateRunSh({ pipelineName, instanceName: name, instanceDir: dir, repo });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const programParts = [
    `# auto — ${name}`,
    `Pipeline: ${pipelineName}`,
    '',
    '## Goal',
    goal || target || '(set me)',
    '',
  ];
  if (target) programParts.push('## Target file', target, '');
  if (url) programParts.push('## Target URL', url, '');
  if (repo) programParts.push('## Repo', repo, '');
  programParts.push(
    '## CURRENT FOCUS',
    'general',
    '',
    '## Known issues',
    '(none)',
    '',
    '## CAN',
    '- (list)',
    '',
    '## CANNOT',
    '- Break the page',
    '',
    '## How to verify',
    url ? 'Screenshot the URL, sanity check.' : 'Run tests, check sanity conditions.',
    '',
  );

  fs.writeFileSync(path.join(dir, 'run.sh'), runSh, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'program.md'), programParts.join('\n'));
  fs.writeFileSync(path.join(dir, 'results.tsv'), 'timestamp\tstatus\tdescription\n');
  res.json({ ok: true, instance: summarizeAutoInstance(name) });
});

app.post('/api/auto/instances/:name/start', (req, res) => {
  const { name } = req.params;
  if (!safeAutoName(name)) return res.status(400).json({ error: 'bad name' });
  const dir = autoDir(name);
  if (!fs.existsSync(path.join(dir, 'run.sh'))) return res.status(404).json({ error: 'not found' });
  const pidPath = path.join(dir, 'auto.pid');
  if (isAutoRunning(pidPath)) return res.json({ ok: true, alreadyRunning: true });
  const out = fs.openSync(path.join(dir, 'auto.log'), 'a');
  const child = spawn('bash', [path.join(dir, 'run.sh')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: dir,
  });
  fs.writeFileSync(pidPath, String(child.pid));
  child.unref();
  res.json({ ok: true, pid: child.pid });
});

app.post('/api/auto/instances/:name/stop', (req, res) => {
  const { name } = req.params;
  if (!safeAutoName(name)) return res.status(400).json({ error: 'bad name' });
  const pidPath = path.join(autoDir(name), 'auto.pid');
  const pid = parseInt(readSafe(pidPath).trim());
  if (!pid) return res.json({ ok: true, alreadyStopped: true });
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  try { process.kill(pid, 'SIGTERM'); } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/focus', express.json(), (req, res) => {
  const { name } = req.params;
  const { focus } = req.body || {};
  if (!safeAutoName(name) || !focus) return res.status(400).json({ error: 'bad input' });
  const programPath = path.join(autoDir(name), 'program.md');
  let p = readSafe(programPath);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (/^## CURRENT FOCUS\n.*$/m.test(p)) {
    p = p.replace(/^## CURRENT FOCUS\n.*$/m, `## CURRENT FOCUS\n${focus}`);
  } else {
    p += `\n## CURRENT FOCUS\n${focus}\n`;
  }
  fs.writeFileSync(programPath, p);
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/btw', express.json(), (req, res) => {
  const { name } = req.params;
  const { note } = req.body || {};
  if (!safeAutoName(name) || !note) return res.status(400).json({ error: 'bad input' });
  const programPath = path.join(autoDir(name), 'program.md');
  let p = readSafe(programPath);
  if (!p) return res.status(404).json({ error: 'not found' });
  const stamp = new Date().toISOString();
  const line = `- (${stamp}) ${note}`;
  if (/^## Known issues\n/m.test(p)) {
    p = p.replace(/^## Known issues\n(\(none\)\n)?/m, `## Known issues\n${line}\n`);
  } else {
    p += `\n## Known issues\n${line}\n`;
  }
  fs.writeFileSync(programPath, p);
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/link', express.json(), (req, res) => {
  const { name } = req.params;
  const { sessionId } = req.body || {};
  if (!safeAutoName(name) || !sessionId) return res.status(400).json({ error: 'bad input' });
  const dir = autoDir(name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  fs.writeFileSync(path.join(dir, 'main_chat.txt'), sessionId);
  res.json({ ok: true });
});

app.delete('/api/auto/instances/:name', (req, res) => {
  const { name } = req.params;
  if (!safeAutoName(name)) return res.status(400).json({ error: 'bad name' });
  const dir = autoDir(name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  if (isAutoRunning(path.join(dir, 'auto.pid'))) return res.status(409).json({ error: 'still running, stop first' });
  res.json({ ok: true, hint: 'rm -rf ' + dir + ' to remove on disk (server does not delete)' });
});

// ── Legacy route redirects ──────────────────────────────────────────────────
app.get('/code', (_req, res) => res.redirect('/'));
app.get('/terminal', (_req, res) => res.redirect('/'));

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

// Graceful shutdown: close server so port is released before systemd restarts us
function shutdown(sig) {
  console.log(`${sig} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
