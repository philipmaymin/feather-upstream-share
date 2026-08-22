import express from 'express';
import compression from 'compression';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFileSync, execFile, spawn } from 'child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';
import * as sidecar from './lib/sidecar.js';
import { createKeyedLock } from './lib/sendlock.js';
import { codexPasteBufferArgs } from './lib/tmux-input.js';
import { sessionIsActive, lastMessageMs, latestSessionActivityMs } from './lib/sessions.js';
import { resolveCodexWatchId, codexAdoptionPending } from './lib/codex-watch.js';
import * as webpush from './lib/webpush.js';
import { createSnapshotCache } from './lib/snapshot-cache.js';
import { paneHasReadyPrompt } from './lib/terminal-ready.js';
import { ensureStateLayout, resolveStatePaths } from './lib/state-paths.js';
import { createJsonState, isJsonRecord } from './lib/json-state.js';
import { encodeProjectPath, groupRoomSessions } from './lib/rooms.js';

// Load ~/.env if present
try {
  const envFile = fs.readFileSync(path.join(process.env.HOME || '/home/user', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// Let an instance-scoped key authenticate Feather-launched Codex sessions
// without overriding an explicitly configured standard OpenAI key.
if (!process.env.OPENAI_API_KEY && process.env.FEATHER_OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.FEATHER_OPENAI_API_KEY;
}

const DEEPGRAM_API_KEY = process.env.FEATHER_DEEPGRAM_API_KEY || '';
const envEnabled = value => /^(1|true|yes|on)$/i.test(String(value || '').trim());
const READ_ONLY_MODE = envEnabled(process.env.FEATHER_READ_ONLY);
const ROOM_PULSES_ENABLED = !READ_ONLY_MODE && !/^(0|false|no|off)$/i.test(String(process.env.FEATHER_ROOM_PULSES || '').trim());
const configuredPulseInterval = Number(process.env.FEATHER_ROOM_PULSE_INTERVAL_MS);
const ROOM_PULSE_INTERVAL_MS = Math.max(60_000, Number.isFinite(configuredPulseInterval) && configuredPulseInterval > 0
  ? configuredPulseInterval : 15 * 60 * 1000);
const configuredPulseCheck = Number(process.env.FEATHER_ROOM_PULSE_CHECK_MS);
const ROOM_PULSE_CHECK_MS = Math.max(50, Number.isFinite(configuredPulseCheck) && configuredPulseCheck > 0
  ? configuredPulseCheck : 60_000);
const configuredPulseMax = Number(process.env.FEATHER_ROOM_PULSE_MAX_CONCURRENT);
const ROOM_PULSE_MAX_CONCURRENT = Math.max(1, Number.isFinite(configuredPulseMax) && configuredPulseMax > 0
  ? Math.floor(configuredPulseMax) : 3);
const ROOM_PULSE_STARTED_AT = Date.now();
const READ_ONLY_ERROR = Object.freeze({ error: 'read-only canary', code: 'FEATHER_READ_ONLY' });
const SESSION_READ_ROUTE = /^\/api\/sessions\/[^/]+\/(messages|stream|export)$/;

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME || '/home/user';
const LEGACY_STATE_ROOT = path.join(HOME, '.feather');
const STATE_PATHS = resolveStatePaths({
  releaseDir: import.meta.dirname,
  stateDir: process.env.FEATHER_STATE_DIR || LEGACY_STATE_ROOT,
  homeDir: HOME,
});
const INSTANCE_UPLOADS_DIR = process.env.FEATHER_STATE_DIR
  ? STATE_PATHS.instance.uploadsDir
  : path.join(HOME, 'feather-uploads');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(STATE_PATHS.release.versionFile, 'utf8')).version; }
  catch { return 'unknown'; }
})();
const STATIC_OVERRIDE = process.env.STATIC_OVERRIDE;
const STATIC_DIR = path.resolve(import.meta.dirname, STATIC_OVERRIDE || 'static');
const STAGING_DIR = path.join(STATE_PATHS.release.root, 'static-staging');
const MAX_SSE_PER_SESSION = 10;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const CODEX_SESSIONS_ROOT = STATE_PATHS.harness.codexSessionsDir;
// Codex now writes large context/permissions preambles before the first real
// prompt. Keep enough headroom to find cwd, titles, and worker markers.
const CODEX_HEAD_BYTES = 256 * 1024;
const OMP_SESSIONS = STATE_PATHS.harness.ompSessionsDir;
if (!READ_ONLY_MODE && process.env.FEATHER_STATE_DIR) ensureStateLayout(STATE_PATHS);
if (!READ_ONLY_MODE) {
  try { fs.mkdirSync(OMP_SESSIONS, { recursive: true }); } catch {}
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isMessageReceiptState(value) {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every(session => isJsonRecord(session)
    && Object.values(session).every(receipt => isJsonRecord(receipt)
      && /^[0-9a-f]{64}$/.test(receipt.textHash)
      && isJsonRecord(receipt.response)
      && receipt.response.ok === true
      && typeof receipt.response.sentAt === 'string'));
}

const MESSAGE_RECEIPTS_STATE = createJsonState({
  file: path.join(INSTANCE_UPLOADS_DIR, '.message-receipts.json'),
  root: INSTANCE_UPLOADS_DIR,
  document: 'message delivery receipts',
  defaultValue: {},
  validate: isMessageReceiptState,
  mode: 0o600,
});

// ── Per-user path helpers ───────────────────────────────────────────────────

function projectsDir() {
  return STATE_PATHS.harness.claudeProjectsDir;
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
  const d = STATE_PATHS.instance.root;
  if (!READ_ONLY_MODE && !fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function uploadsDir() {
  const d = INSTANCE_UPLOADS_DIR;
  if (!READ_ONLY_MODE && !fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
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
  return STATE_PATHS.instance.metaFile;
}

const META_STATE = createJsonState({
  file: metaFilePath(), root: featherDir(), document: 'session metadata',
  defaultValue: {}, validate: isJsonRecord,
});

function readMeta() {
  return META_STATE.read();
}

function writeMeta(meta) {
  return META_STATE.write(meta);
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
  const start = Math.max(0, end - limit);
  const hasMore = start > 0;
  return { messages: msgs.slice(start, end), hasMore };
}

// ── Per-user JSON helpers ──────────────────────────────────────────────────

const USER_JSON_STATES = new Map([
  ['project-labels.json', createJsonState({ file: STATE_PATHS.instance.projectLabelsFile, root: featherDir(), document: 'project labels', defaultValue: {}, validate: isJsonRecord })],
  ['quick-links.json', createJsonState({ file: STATE_PATHS.instance.quickLinksFile, root: featherDir(), document: 'quick links', defaultValue: [], validate: Array.isArray })],
  ['starred.json', createJsonState({ file: STATE_PATHS.instance.starredFile, root: featherDir(), document: 'starred messages', defaultValue: {}, validate: isJsonRecord })],
  ['muted.json', createJsonState({ file: STATE_PATHS.instance.mutedFile, root: featherDir(), document: 'muted sessions', defaultValue: [], validate: Array.isArray })],
  ['push-keys.json', createJsonState({ file: STATE_PATHS.instance.pushKeysFile, root: featherDir(), document: 'push signing keys', defaultValue: {}, validate: isJsonRecord, mode: 0o600 })],
  ['push-subscriptions.json', createJsonState({ file: STATE_PATHS.instance.pushSubscriptionsFile, root: featherDir(), document: 'push subscriptions', defaultValue: [], validate: Array.isArray })],
]);

function readUserJson(filename, fallback) {
  const state = USER_JSON_STATES.get(filename);
  if (!state) throw new Error(`unclassified JSON state: ${filename}`);
  return state.read();
}

function writeUserJson(filename, data) {
  const state = USER_JSON_STATES.get(filename);
  if (!state) throw new Error(`unclassified JSON state: ${filename}`);
  return state.write(data);
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
        try {
          const stat = fs.statSync(full);
          out.push({ uuid, fpath: full, mtime: stat.mtime, size: stat.size });
        } catch {}
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
      if (d.type === 'session' && d.title) return d.title.slice(0, 240);
      if (d.type === 'message' && d.message?.role === 'user') {
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.trim();
        if (text) return text.slice(0, 240);
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
      if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>') || text.startsWith('<skills_instructions>') || text.startsWith('<user_instructions>') || text.startsWith('<recommended_plugins>') || text.startsWith('# AGENTS.md instructions for ')) continue;
      return text.slice(0, 240);
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
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const active = new Map();
    for (const line of out.split('\n')) {
      const [name, created] = line.split('|');
      if (name?.startsWith(prefix)) active.set(name.slice(prefix.length), Number(created) * 1000 || 0);
    }
    return active;
  } catch { return new Map(); }
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
  const codexCmd = `codex -c check_for_update_on_startup=false ${codexArgs} --dangerously-bypass-approvals-and-sandbox`;
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
function adoptNewCodexUuid(featherId, beforeUuids, spawnCwd = null, attempts = 320) {
  let n = 0;
  const tick = () => {
    if (!codexAdoptionPending(readMeta(), featherId)) return;
    n++;
    const after = listCodexJsonlFiles();
    let fresh = after.filter(f => !beforeUuids.has(f.uuid));
    if (spawnCwd && fresh.length > 0) {
      fresh = fresh.filter(file => {
        let fd;
        try {
          fd = fs.openSync(file.fpath, 'r');
          const buf = Buffer.alloc(Math.min(CODEX_HEAD_BYTES, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          return extractCodexCwd(buf) === spawnCwd;
        } catch { return false; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
      });
    }
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
    if (n < attempts) setTimeout(tick, n < 20 ? 500 : 2000);
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
        try { sessionCwd = extractCodexCwd(fs.readFileSync(fpath).slice(0, CODEX_HEAD_BYTES)); } catch {}
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
      meta[id] = { ...(meta[id] || {}), agent: 'codex', cwd: dir };
      writeMeta(meta);
      spawnTmuxCodex(name, '', dir);
      adoptNewCodexUuid(id, before, dir);
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
      meta[id] = { ...(meta[id] || {}), agent: 'omp', cwd: cwd || HOME };
      writeMeta(meta);
      spawnTmuxOmp(name, `--session-dir ${sessionDir}`, cwd || HOME);
    }
    return;
  }

  const dir = cwd || (resume ? findSessionCwd(id) : null) || HOME;
  const args = resume ? `--resume ${id}` : `--session-id ${id}`;
  spawnTmuxClaude(name, args, dir);
}

// Read only the text in Claude Code's input box. A submitted or queued message
// clears that box; looking for the marker in the whole pane can mistake the
// queued-message echo for unsent text and press Enter several more times.
function inputBoxText(name) {
  try {
    const content = execFileSync('tmux', ['capture-pane', '-t', name, '-p'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 });
    const lines = content.replace(/\s+$/, '').split('\n');
    const borders = [];
    for (let i = 0; i < lines.length; i++) if (/^\s*─{10,}/.test(lines[i])) borders.push(i);
    if (borders.length < 2) return null;
    const top = borders[borders.length - 2];
    const bottom = borders[borders.length - 1];
    let text = lines.slice(top + 1, bottom).join('\n').replace(/^\s*[>❯]\s?/, '').trim();
    if (/^Try ["“]/.test(text)) text = '';
    return text;
  } catch { return null; }
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

  // Re-send Enter only while the exact text remains in the input box. Once the
  // box clears, the message has either submitted or queued and must not be sent
  // again.
  const marker = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 500));
    const box = inputBoxText(name);
    if (!box || !marker || !box.replace(/\s+/g, ' ').includes(marker)) return;
  }
}

function isAgentRunning(name) {
  try {
    const cmd = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_current_command}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return cmd === 'claude' || cmd === 'codex' || cmd === 'omp' || cmd === 'node';
  } catch { return false; }
}

function isAgentAtPrompt(name, agent = 'claude') {
  try {
    const content = execFileSync('tmux', ['capture-pane', '-t', name, '-p'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return paneHasReadyPrompt(content, agent);
  } catch { return false; }
}

function waitForAgentReady(name, agent = 'claude', timeoutMs = 30000) {
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
      if (!processDetected && isAgentRunning(name)) {
        processDetected = true;
      }
      if (processDetected && isAgentAtPrompt(name, agent)) {
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

// Codex needs real terminal bracketed paste for every message. Without tmux's
// -p flag a large message is delivered as ordinary keystrokes in chunks, so
// the following Enter can land before the paste is complete and never submit.
async function sendCodexText(name, text) {
  const tmp = `/tmp/feather-send-${Date.now()}.txt`;
  fs.writeFileSync(tmp, text);
  try {
    execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
    execFileSync('tmux', codexPasteBufferArgs(name), { stdio: 'ignore' });
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
}

// Serialize the complete paste-and-submit sequence for each session. Rooms can
// fan several peer replies into one driver at once; without a keyed lock their
// tmux writes can interleave. Different sessions still send concurrently.
const sendLock = createKeyedLock();

async function sendInputToSession(id, text) {
  return sendLock(id, () => sendInputToSessionUnlocked(id, text));
}

async function sendInputToSessionIdempotent(id, text, messageId) {
  return sendLock(id, async () => {
    const textHash = createHash('sha256').update(String(text)).digest('hex');
    const existing = MESSAGE_RECEIPTS_STATE.read()[id]?.[messageId];
    if (existing) {
      if (existing.textHash !== textHash) throw httpError(409, 'message id already used with different text');
      return existing.response;
    }
    await sendInputToSessionUnlocked(id, text);
    const response = { ok: true, sentAt: new Date().toISOString() };
    MESSAGE_RECEIPTS_STATE.update(current => ({
      ...current,
      [id]: {
        ...(isJsonRecord(current[id]) ? current[id] : {}),
        [messageId]: { textHash, response },
      },
    }));
    return response;
  });
}

async function sendInputToSessionUnlocked(id, text) {
  const name = tmuxName(id);
  const agent = getAgentForSession(id);
  let sessionExists = false;
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    sessionExists = true;
  } catch {}

  if (!sessionExists) {
    spawnOrResume(id, null, true, agent);
    if (agent === 'codex') await waitForAgentReady(name, agent);
  }

  if (agent === 'codex') {
    await sendCodexText(name, text);
    return;
  }

  // Complete all readiness retries before delivery. Retrying this whole block
  // after a partially successful send can create a second distinct turn.
  try {
    await waitForAgentReady(name, agent);
  } catch {
    spawnOrResume(id, null, true, agent);
    try {
      await waitForAgentReady(name, agent);
    } catch {
      throw new Error('Failed to resume session after retry');
    }
  }
  await sendText(name, text);
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
          firstUserText = cmdMatch ? '/' + cmdMatch[1].trim() : text.slice(0, 240);
          break;
        }
      } catch {}
    }
  } catch {}

  let cwd = null;
  let outcome = null;
  let summary = null;
  try {
    const fd = fs.openSync(fpath, 'r');
    const totalSize = fs.fstatSync(fd).size;
    const readSize = Math.min(32768, totalSize);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, totalSize - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let sawError = false;
    let sawAssistant = false;
    let turnDone = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      let d;
      try { d = JSON.parse(lines[i]); } catch { continue; }
      if (!cwd && d.type === 'user' && d.cwd) cwd = d.cwd;
      if (!turnDone) {
        const content = d.message?.content;
        const blocks = Array.isArray(content) ? content : [];
        if (blocks.some(block => block.is_error)) sawError = true;
        if (d.type === 'assistant' && !d.isSidechain) {
          sawAssistant = true;
          const text = blocks.filter(block => block.type === 'text' && block.text).map(block => block.text).join(' ');
          if (/^API Error/i.test(text.trim())) sawError = true;
          if (!summary) summary = summarizeReply(text);
        }
        const isHumanPrompt = d.type === 'user' && !d.isMeta && !d.isSidechain
          && (typeof content === 'string' || (blocks.length > 0 && !blocks.some(block => block.type === 'tool_result')));
        if (isHumanPrompt) turnDone = true;
      }
      if (cwd && turnDone) break;
    }
    if (sawError) outcome = 'errored';
    else if (sawAssistant) outcome = 'finished';
  } catch {}

  return { firstUserText, cwd, isTitleGen, isWorker, outcome, summary };
}

function summarizeReply(text) {
  if (!text) return null;
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1');
  for (let line of body.split('\n')) {
    line = line.replace(/^\s*(?:[#>]+|[-*+]|\d+\.)\s*/, '').replace(/\*\*|__|\*|_/g, '').trim();
    if (line.length < 8) continue;
    const stop = line.search(/[.!?](?:\s|$)/);
    const sentence = stop > 0 ? line.slice(0, stop + 1) : line;
    return sentence.length > 100 ? sentence.slice(0, 97).trimEnd() + '...' : sentence;
  }
  return null;
}

// ── Session discovery ──────────────────────────────────────────────────────

const SESSION_SOURCE_MTIME = Symbol('sessionSourceMtime');

function discoverSessions(limit = 50, projectFilter, requiredIds = []) {
  const projDir = projectsDir();
  const candidates = [];
  const meta = readMeta();
  const codexLocalIds = new Map();
  for (const [localId, entry] of Object.entries(meta)) {
    if (entry?.codexUuid) codexLocalIds.set(entry.codexUuid, localId);
  }

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
    for (const { uuid, fpath, mtime, size } of listCodexJsonlFiles()) {
      if (size < 50) continue;
      candidates.push({ id: codexLocalIds.get(uuid) || uuid, fpath, mtime, projectId: null, agent: 'codex' });
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
        try {
          buf = Buffer.alloc(Math.min(CODEX_HEAD_BYTES, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
          fs.closeSync(fd);
        }
      } catch { buf = Buffer.alloc(0); }
      const cwd = extractCodexCwd(buf) || meta[c.id]?.cwd || null;
      const isWorker = buf.includes('AUTO_WORKER=TRUE')
        || /^\/home\/[^/]+\/(?:auto|autoweb)-/.test(cwd || '')
        || /^\/home\/[^/]+\/\.feather\/room-runs\//.test(cwd || '');
      return { ...c, info: { firstUserText: extractCodexTitle(buf), cwd, isTitleGen: false, isWorker } };
    }
    if (c.agent === 'omp') {
      let buf;
      try { buf = fs.readFileSync(c.fpath).slice(0, 65536); } catch { buf = Buffer.alloc(0); }
      const cwd = meta[c.id]?.cwd || null;
      const isWorker = /^\/home\/[^/]+\/(?:auto|autoweb)-/.test(cwd || '')
        || /^\/home\/[^/]+\/\.feather\/room-runs\//.test(cwd || '');
      return { ...c, info: { firstUserText: extractOmpTitle(buf), cwd, isTitleGen: false, isWorker } };
    }
    const info = extractSessionInfo(c.fpath);
    if (/^\/home\/[^/]+\/\.feather\/room-runs\//.test(info.cwd || '')) info.isWorker = true;
    return { ...c, info };
  });

  const filtered = withInfo.filter(c => !c.info.isTitleGen && !c.info.isWorker);
  const required = new Set(requiredIds);
  const top = filtered
    .filter((candidate, index) => index < limit || required.has(candidate.id))
    .sort((a, b) => b.mtime - a.mtime);
  const active = getActiveTmuxSessions();
  const now = Date.now();
  const labels = readUserJson('project-labels.json', {});

  const sessions = top.map(({ id, fpath, mtime, projectId: candidateProjectId, agent, info }) => {
    const cwd = info.cwd || meta[id]?.cwd || (candidateProjectId ? projectIdToCwd(candidateProjectId) : null) || null;
    const projectId = candidateProjectId || (cwd ? encodeProjectPath(cwd) : null);
    const activityMs = lastActivityMs(fpath, agent, mtime.getTime());
    const session = {
      id, title: meta[id]?.title || info.firstUserText || id.slice(0, 8),
      updatedAt: new Date(activityMs).toISOString(),
      isActive: sessionIsActive(active, id, activityMs, now),
      projectId,
      projectLabel: projectId ? (labels[projectId] || null) : null,
      cwd,
      agent,
      outcome: info.outcome || null,
      summary: info.summary || null,
    };
    // Keep the transcript's filesystem recency for reproducing the historical
    // `limit` behavior from a larger shared snapshot. Symbols never leak into
    // the JSON response.
    session[SESSION_SOURCE_MTIME] = mtime.getTime();
    return session;
  });
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return sessions;
}

// Session discovery is shared by the sidebar and Rooms home, and scans every
// supported agent transcript. Serve the common unfiltered index from a warm
// snapshot so app startup can mount Rooms before deferred refresh work runs.
const sessionsSnapshotCache = createSnapshotCache(
  () => discoverSessions(300, null),
  { ttlMs: 10_000 },
);
let roomSnapshotCache = null;

// A Claude transcript can also be created outside Feather (or by a test
// fixture). Patch that one item into the warm index instead of rescanning every
// historical transcript on the request path or briefly hiding the new chat.
function cacheNewClaudeSession(filePath, id, projectId, attempt = 0) {
  setTimeout(() => {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size < 50) {
      if (attempt < 5) cacheNewClaudeSession(filePath, id, projectId, attempt + 1);
      return;
    }

    const info = extractSessionInfo(filePath);
    if (info.isTitleGen || info.isWorker
      || /-home-user-(?:auto|autoweb)-/.test(projectId)
      || /^\/home\/[^/]+\/\.feather\/room-runs\//.test(info.cwd || '')) return;

    const meta = readMeta();
    const labels = readUserJson('project-labels.json', {});
    const cwd = info.cwd || meta[id]?.cwd || projectIdToCwd(projectId) || null;
    const activityMs = lastActivityMs(filePath, 'claude', stat.mtimeMs);
    const item = {
      id,
      title: meta[id]?.title || info.firstUserText || id.slice(0, 8),
      updatedAt: new Date(activityMs).toISOString(),
      isActive: sessionIsActive(getActiveTmuxSessions(), id, activityMs, Date.now()),
      projectId,
      projectLabel: labels[projectId] || null,
      cwd,
      agent: 'claude',
      outcome: info.outcome || null,
      summary: info.summary || null,
    };
    item[SESSION_SOURCE_MTIME] = stat.mtimeMs;
    sessionsSnapshotCache.update(sessions => [
      item,
      ...sessions.filter(session => session.id !== id),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 300));
    if (roomSnapshotCache) roomSnapshotCache.refresh();
  }, 100);
}

// Agents can append status/bookkeeping for days after their last real message.
// Grow the tail until a user/assistant timestamp is found so activity dots,
// ordering, Rooms, and the idle reaper agree on actual conversation activity.
const ACTIVITY_TAILS = [512 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];
function lastActivityMs(fpath, agent, fallbackMs) {
  try {
    const size = fs.statSync(fpath).size;
    const fd = fs.openSync(fpath, 'r');
    try {
      for (const tail of ACTIVITY_TAILS) {
        const readLength = Math.min(size, tail);
        const buf = Buffer.alloc(readLength);
        fs.readSync(fd, buf, 0, readLength, size - readLength);
        const timestamp = lastMessageMs(buf.toString('utf8'), agent, size > readLength);
        if (timestamp) return timestamp;
        if (readLength >= size) break;
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  return fallbackMs;
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

if (!READ_ONLY_MODE) setInterval(() => {
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

if (!READ_ONLY_MODE) setInterval(() => {
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
        const filePath = path.join(dp, filename);
        if (!fileOffsets.has(sid)) {
          fileOffsets.set(sid, 0);
          cacheNewClaudeSession(filePath, sid, path.basename(dp));
        }
        processFileChange(filePath);
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
  const meta = readMeta();
  for (const { uuid, fpath } of recent) {
    try {
      const featherId = resolveCodexWatchId(uuid, meta);
      fileOffsets.set(featherId, fs.statSync(fpath).size);
      watchCodexFile(fpath, featherId);
    } catch {}
  }
}

initFileOffsets();
watchProjectDir();
initCodexWatchers();

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// An allowlist keeps future GET handlers with side effects closed until they
// are explicitly classified, while static and non-API reads remain available.
const READ_ONLY_API_ROUTES = [
  /^\/api\/health$/,
  /^\/api\/(agents|rooms|version|projects|search|sessions|running|usage|digest|me)$/,
  SESSION_READ_ROUTE,
  /^\/api\/sidecar$/,
  /^\/api\/sidecar\/[^/]+$/,
  /^\/api\/sidecar\/[^/]+\/stream$/,
  /^\/api\/quick-links$/,
  /^\/api\/mute$/,
  /^\/api\/push\/subscribe$/,
  /^\/api\/starred$/,
  /^\/api\/starred\/album$/,
  /^\/api\/files\/(list|raw|html)$/,
];

function readOnlyRequestAllowed(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!req.path.startsWith('/api')) return true;
  return READ_ONLY_API_ROUTES.some(pattern => pattern.test(req.path));
}

app.use((req, res, next) => {
  if (!READ_ONLY_MODE || readOnlyRequestAllowed(req)) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(403).json(READ_ONLY_ERROR);
});
app.use(compression({ filter: req => {
  if (req.headers.accept?.includes('text/event-stream')) return false;
  let pathname = req.path;
  try { pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname; } catch {}
  return !/(?:^|\/)api\/sessions\/[^/]+\/stream$/.test(pathname);
} }));

app.use(express.static(STATIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else if (filePath.startsWith(path.join(STATIC_DIR, 'assets') + path.sep)) {
      // Vite fingerprints everything under assets/, so it is safe to keep
      // bundles locally until a new index points at a new filename.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.use('/uploads', express.static(path.resolve(import.meta.dirname, 'uploads')));
app.use('/opt/feather/uploads', express.static(path.resolve(import.meta.dirname, 'uploads')));
app.use('/home/user/feather-uploads', express.static('/home/user/feather-uploads'));

// ── API routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', version: VERSION, uptime: process.uptime(),
  capabilities: {
    readOnly: READ_ONLY_MODE,
    mutations: !READ_ONLY_MODE,
    terminal: !READ_ONLY_MODE,
    shell: !READ_ONLY_MODE,
    backgroundControllers: !READ_ONLY_MODE,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxAudioBytes: MAX_AUDIO_BYTES,
  },
}));

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

// ── Rooms: durable workspaces backed by ~/rooms/<name> ─────────────────

const ROOMS_HOME_DIR = STATE_PATHS.workspace.roomsDir;
const ROOM_ASSIGN_FILE = STATE_PATHS.coordination.roomAssignmentsFile;
const ROOM_PULSES_FILE = STATE_PATHS.coordination.roomPulsesFile;
const ROOM_ASSIGN_STATE = createJsonState({
  file: ROOM_ASSIGN_FILE, root: path.dirname(ROOM_ASSIGN_FILE), document: 'Room assignments',
  defaultValue: {}, validate: isJsonRecord,
});
const ROOM_PULSE_STATUSES = new Set(['waiting', 'working', 'paused', 'error']);
function isRoomPulseState(value) {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every(pulse => {
    if (!isJsonRecord(pulse) || typeof pulse.enabled !== 'boolean' || !ROOM_PULSE_STATUSES.has(pulse.status)) return false;
    if (pulse.lastRunAt !== null && (typeof pulse.lastRunAt !== 'string' || !Number.isFinite(Date.parse(pulse.lastRunAt)))) return false;
    if (pulse.sessionId !== null && (typeof pulse.sessionId !== 'string' || !UUID_RE.test(pulse.sessionId))) return false;
    if (pulse.error !== null && typeof pulse.error !== 'string') return false;
    return pulse.nextRunAtMs === null || (Number.isFinite(pulse.nextRunAtMs) && pulse.nextRunAtMs >= 0 && pulse.nextRunAtMs <= 8.64e15);
  });
}
const ROOM_PULSES_STATE = createJsonState({
  file: ROOM_PULSES_FILE, root: path.dirname(ROOM_PULSES_FILE), document: 'Room keep-working state',
  defaultValue: {}, validate: isRoomPulseState,
});

function pulseRecord(current, changes = {}) {
  return {
    enabled: true, status: 'waiting', lastRunAt: null, nextRunAtMs: null,
    sessionId: null, error: null,
    ...(isJsonRecord(current) ? current : {}),
    ...changes,
  };
}

function roomPulse(name, now = Date.now(), pulseState = ROOM_PULSES_STATE.read()) {
  const saved = pulseState[name];
  const enabled = saved?.enabled !== false;
  const nextRunAtMs = Number(saved?.nextRunAtMs) || (ROOM_PULSE_STARTED_AT + ROOM_PULSE_INTERVAL_MS);
  return {
    enabled,
    status: enabled ? (saved?.status || 'waiting') : 'paused',
    lastRunAt: saved?.lastRunAt || null,
    nextRunAt: enabled ? new Date(Math.max(now, nextRunAtMs)).toISOString() : null,
    sessionId: saved?.sessionId || null,
    error: saved?.error || null,
  };
}
const ROOM_TAILS = [512 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readRoomAssignments() {
  return ROOM_ASSIGN_STATE.read();
}

function listRoomDirs() {
  try {
    return fs.readdirSync(ROOMS_HOME_DIR).filter(name => {
      if (name.startsWith('_') || name.startsWith('.')) return false;
      try {
        return fs.statSync(path.join(ROOMS_HOME_DIR, name)).isDirectory()
          && fs.existsSync(path.join(ROOMS_HOME_DIR, name, 'AGENTS.md'));
      } catch { return false; }
    }).sort();
  } catch { return []; }
}

function ensureRoomsDoctrine() {
  fs.mkdirSync(ROOMS_HOME_DIR, { recursive: true });
  const doctrinePath = path.join(ROOMS_HOME_DIR, '_doctrine.md');
  if (fs.existsSync(doctrinePath)) return;
  fs.writeFileSync(doctrinePath, [
    '# Shared room doctrine',
    '',
    '- Read the room\'s `AGENTS.md` and `notes.md` before acting.',
    '- Treat `notes.md` as durable memory: record decisions, state, and open threads as work proceeds.',
    '- Verify important claims mechanically and keep evidence close to the decision.',
    '- Delegate only when it materially helps. A `WORKER:` is a focused hand and must not recursively delegate.',
    '',
  ].join('\n'));
}

// Last normalized user/assistant text in a session. Tail reads grow only when
// bookkeeping appended after the real conversation hides the final message.
function lastRoomMessageSnippet(sessionId, agent) {
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath) return null;
  let fd;
  try {
    const size = fs.statSync(fpath).size;
    fd = fs.openSync(fpath, 'r');
    for (const tail of ROOM_TAILS) {
      const start = Math.max(0, size - tail);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (start > 0) lines = lines.slice(1);
      for (let index = lines.length - 1; index >= 0; index--) {
        let message;
        try { message = parseMessageForAgent(lines[index], agent); } catch { continue; }
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
        const text = (message.content || [])
          .filter(block => block && block.type === 'text' && block.text)
          .map(block => block.text).join(' ')
          .replace(/\s+/g, ' ').trim();
        if (text) return { role: message.role, text: text.slice(0, 200) };
      }
      if (start === 0) break;
    }
  } catch {} finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function buildRoomsSnapshot() {
  const names = listRoomDirs();
  const assignments = readRoomAssignments();
  const pulseState = ROOM_PULSES_STATE.read();
  const recentSessions = sessionsSnapshotCache.get();
  const recentIds = new Set(recentSessions.map(session => session.id));
  const missingAssignedIds = Object.keys(assignments).filter(id => !recentIds.has(id));
  const assignedHistory = missingAssignedIds.length
    ? discoverSessions(0, null, missingAssignedIds)
    : [];
  const allSessions = [...recentSessions, ...assignedHistory];
  const byRoom = groupRoomSessions({
    roomNames: names,
    roomsRoot: ROOMS_HOME_DIR,
    sessions: allSessions,
    assignments,
  });

  const rooms = names.map(name => {
    const sessions = byRoom.get(name);
    const newest = sessions[0] || null;
    let latest = newest ? lastRoomMessageSnippet(newest.id, newest.agent || 'claude') : null;
    let updatedAt = newest?.updatedAt || null;
    if (!latest) {
      try {
        const notesPath = path.join(ROOMS_HOME_DIR, name, 'notes.md');
        const noteLines = fs.readFileSync(notesPath, 'utf8').split('\n')
          .map(line => line.trim())
          .filter(line => /^- \d{4}-\d{2}-\d{2}/.test(line));
        if (noteLines.length) latest = { role: 'notes', text: noteLines[noteLines.length - 1].slice(0, 200) };
        if (!updatedAt) updatedAt = fs.statSync(notesPath).mtime.toISOString();
      } catch {}
    }
    return {
      name,
      cwd: path.join(ROOMS_HOME_DIR, name),
      sessions,
      active: sessions.some(session => session.isActive),
      pulse: roomPulse(name, Date.now(), pulseState),
      latest,
      updatedAt,
    };
  });
  rooms.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return rooms;
}

// Room discovery scans many transcripts across all supported agents. Keep the
// view current without making every warm request wait for the synchronous scan.
roomSnapshotCache = createSnapshotCache(buildRoomsSnapshot, { ttlMs: 10_000 });

app.get('/api/rooms', (_req, res) => {
  try { res.json({ rooms: roomSnapshotCache.get() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/rooms', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      throw httpError(400, 'bad room name (lowercase, digits, dashes)');
    }
    ensureRoomsDoctrine();
    const dir = path.join(ROOMS_HOME_DIR, name);
    if (fs.existsSync(dir)) throw httpError(409, 'room exists');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), [
      `# Room: #${name}`,
      '',
      '<!-- Two lines on what this room is about. Edit me. -->',
      '',
      'Follow the shared room doctrine: read ~/rooms/_doctrine.md now.',
      'On start, read notes.md — it is the room\'s memory; this chat is not.',
      '',
    ].join('\n'));
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(dir, 'notes.md'),
      `# #${name} — notes\n\nWorking memory for this room. Sessions append decisions and open\nthreads as they happen (\`room note "..."\`). Newest at the bottom.\n`);
    roomSnapshotCache.refresh();
    res.json({ name, cwd: dir });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/rooms/:name/assign', (req, res) => {
  try {
    const { name } = req.params;
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId required');
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const assignments = ROOM_ASSIGN_STATE.update(current => {
      const next = { ...current };
      if (req.body?.remove) {
        if (current[sessionId] !== name) throw httpError(409, `session is not assigned to #${name}`);
        delete next[sessionId];
      }
      else next[sessionId] = name;
      return next;
    });
    roomSnapshotCache.refresh();
    res.json({ ok: true, assignments });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/rooms/:name/pulse', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
    const now = Date.now();
    ROOM_PULSES_STATE.update(current => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: req.body.enabled,
        status: req.body.enabled ? 'waiting' : 'paused',
        nextRunAtMs: req.body.enabled ? now + ROOM_PULSE_INTERVAL_MS : null,
        error: null,
      }),
    }));
    const pulse = roomPulse(name, now);
    roomSnapshotCache.update(rooms => rooms.map(room => room.name === name ? { ...room, pulse } : room));
    res.json({ ok: true, pulse });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

const ROOM_PULSE_PROMPT = `Keep working on this room. Read AGENTS.md, notes.md, and the recent chats in this room. Then do the next useful thing fully autonomously. Do not ask the user to choose routine steps. Use tools and agents if useful. Append what you did and any open thread to notes.md. If you hit a recurring annoyance, run: room complain "describe it plainly". If this room genuinely has no useful next action, run: room pause. Then stop.`;

function launchRoomPulse(name) {
  try {
    const now = Date.now();
    const saved = ROOM_PULSES_STATE.read()[name] || {};
    const id = saved.sessionId || randomUUID();
    const cwd = path.join(ROOMS_HOME_DIR, name);
    const sessionDir = path.join(OMP_SESSIONS, id);
    const promptFile = path.join(sessionDir, 'pulse.md');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(promptFile, ROOM_PULSE_PROMPT, { mode: 0o600 });
    ROOM_PULSES_STATE.update(current => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: true, status: 'working', sessionId: id,
        lastRunAt: new Date(now).toISOString(), nextRunAtMs: now + ROOM_PULSE_INTERVAL_MS, error: null,
      }),
    }));
    const meta = readMeta();
    meta[id] = { ...(meta[id] || {}), agent: 'omp', cwd, title: `Keep working: #${name}` };
    writeMeta(meta);
    ROOM_ASSIGN_STATE.update(current => ({ ...current, [id]: name }));
    watchOmpSessionDir(sessionDir, id);
    const ompId = findOmpJsonlPath(id) ? getOmpSessionId(id) : null;
    const resumeArg = ompId ? `--resume ${ompId}` : (findOmpJsonlPath(id) ? '--continue' : '');
    spawnTmuxOmp(tmuxName(id), `${resumeArg} -p --auto-approve @${promptFile} --session-dir ${sessionDir}`.trim(), cwd);
  } catch (error) {
    ROOM_PULSES_STATE.update(current => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: true, status: 'error', error: error.message,
        nextRunAtMs: Date.now() + ROOM_PULSE_INTERVAL_MS,
      }),
    }));
    console.warn(`[room pulse] #${name}:`, error.message);
  }
}

function checkRoomPulses() {
  if (!ROOM_PULSES_ENABLED) return;
  const now = Date.now();
  const pulseState = ROOM_PULSES_STATE.read();
  const due = [];
  let inFlight = 0;
  for (const name of listRoomDirs()) {
    let saved = isJsonRecord(pulseState[name]) ? pulseState[name] : {};
    if (saved.status === 'working' && saved.sessionId && !tmuxIsActive(saved.sessionId)) {
      ROOM_PULSES_STATE.update(current => ({
        ...current,
        [name]: pulseRecord(current[name], { status: 'waiting' }),
      }));
      saved = { ...saved, status: 'waiting' };
    }
    // A run whose tmux is still alive holds a concurrency slot; never relaunch it.
    if (saved.status === 'working') { inFlight++; continue; }
    if (saved.enabled === false || now < (Number(saved.nextRunAtMs) || ROOM_PULSE_STARTED_AT + ROOM_PULSE_INTERVAL_MS)) continue;
    due.push({ name, nextRunAtMs: Number(saved.nextRunAtMs) || 0 });
  }
  if (!due.length) return;
  due.sort((a, b) => (a.nextRunAtMs - b.nextRunAtMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const rooms = new Map(roomSnapshotCache.refresh().map(room => [room.name, room]));
  for (const { name } of due) {
    const room = rooms.get(name);
    if (!room || room.active) {
      ROOM_PULSES_STATE.update(current => ({
        ...current,
        [name]: pulseRecord(current[name], { enabled: true, status: 'waiting', nextRunAtMs: now + ROOM_PULSE_INTERVAL_MS }),
      }));
      continue;
    }
    // Deferred rooms stay due, so later ticks drain a synchronized batch fairly.
    if (inFlight >= ROOM_PULSE_MAX_CONCURRENT) continue;
    launchRoomPulse(name);
    inFlight++;
  }
  const latestPulseState = ROOM_PULSES_STATE.read();
  roomSnapshotCache.update(snapshot => snapshot.map(room => ({
    ...room,
    pulse: roomPulse(room.name, Date.now(), latestPulseState),
  })));
  roomSnapshotCache.invalidate();
}

// Validate every durable JSON document before accepting traffic. Missing
// documents use their documented defaults; malformed state fails startup.
META_STATE.read();
for (const state of USER_JSON_STATES.values()) state.read();
ROOM_ASSIGN_STATE.read();
ROOM_PULSES_STATE.read();
MESSAGE_RECEIPTS_STATE.read();

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
  try {
    const limit = parseInt(req.query.limit) || 50;
    const project = req.query.project || null;
    const sessions = project
      ? discoverSessions(limit, project)
      : [...sessionsSnapshotCache.get()]
          .sort((a, b) => (b[SESSION_SOURCE_MTIME] || 0) - (a[SESSION_SOURCE_MTIME] || 0))
          .slice(0, limit)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    res.json({ sessions });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-project live queue retained from the deployed tree.
app.get('/api/running', (req, res) => {
  try {
    const items = [];
    for (const session of discoverSessions(parseInt(req.query.limit) || 100, null)) {
      if (!session.isActive) continue;
      let question = null;
      let activity = null;
      try {
        const { lines } = capturePaneLines(tmuxName(session.id));
        activity = extractActivity(lines);
        question = extractQuestion(lines, !!activity);
      } catch {}
      items.push({
        ...session,
        status: question ? 'waiting' : activity ? 'working' : 'idle',
        question: question?.question,
        activity: !question ? activity || undefined : undefined,
      });
    }
    const counts = items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    res.json({ counts, items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const USAGE_RATES = [
  ['opus', { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['haiku', { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['sonnet', { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
];
const rateFor = model => (USAGE_RATES.find(([key]) => (model || '').includes(key)) || USAGE_RATES[2])[1];
const usageCache = new Map();
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'messages'];
const usageBucket = extra => ({ ...extra, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 });

function usageForFile(fpath) {
  let stat;
  try { stat = fs.statSync(fpath); } catch { return []; }
  const key = `${fpath}:${stat.mtimeMs}:${stat.size}`;
  const cached = usageCache.get(fpath);
  if (cached?.key === key) return cached.days;
  const byDay = new Map();
  try {
    for (const line of fs.readFileSync(fpath, 'utf8').split('\n')) {
      if (!line || !line.includes('"usage"')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const usage = event.type === 'assistant' && event.message?.usage;
      if (!usage) continue;
      const day = (event.timestamp || stat.mtime.toISOString()).slice(0, 10);
      const rate = rateFor(event.message.model);
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheWrite = usage.cache_creation_input_tokens || 0;
      const bucket = byDay.get(day) || usageBucket({ day });
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheWrite += cacheWrite;
      bucket.cost += (input * rate.in + output * rate.out + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite) / 1e6;
      bucket.messages += 1;
      byDay.set(day, bucket);
    }
  } catch { return []; }
  const days = [...byDay.values()];
  usageCache.set(fpath, { key, days });
  return days;
}

app.get('/api/usage', (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
    const cutoff = Date.now() - days * 86400000;
    const labels = readUserJson('project-labels.json', {});
    const byProject = new Map();
    const byDay = new Map();
    const total = usageBucket({});
    for (const dir of fs.existsSync(projectsDir()) ? fs.readdirSync(projectsDir()) : []) {
      let files;
      try { files = fs.readdirSync(path.join(projectsDir(), dir)); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const fpath = path.join(projectsDir(), dir, file);
        try { if (fs.statSync(fpath).mtimeMs < cutoff) continue; } catch { continue; }
        for (const entry of usageForFile(fpath)) {
          if (Date.parse(entry.day + 'T23:59:59Z') < cutoff) continue;
          const buckets = [
            byProject.get(dir) || usageBucket({ projectId: dir, label: labels[dir] || null }),
            byDay.get(entry.day) || usageBucket({ day: entry.day }),
            total,
          ];
          for (const bucket of buckets) for (const field of USAGE_FIELDS) bucket[field] += entry[field];
          byProject.set(dir, buckets[0]);
          byDay.set(entry.day, buckets[1]);
        }
      }
    }
    res.json({
      days,
      total,
      projects: [...byProject.values()].sort((a, b) => b.cost - a.cost),
      daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

function digestItems(since, limit) {
  const items = [];
  for (const session of discoverSessions(limit || 50, null)) {
    let question = null;
    let working = false;
    if (session.isActive) {
      try {
        const { lines } = capturePaneLines(tmuxName(session.id));
        const activity = extractActivity(lines);
        question = extractQuestion(lines, !!activity);
        working = !question && !!activity;
      } catch {}
    }
    if (question) items.push({ ...session, status: 'waiting', question: question.question });
    else if (working) items.push({ ...session, status: 'working' });
    else if (Number.isNaN(since) || Date.parse(session.updatedAt) > since) {
      items.push({ ...session, status: session.outcome === 'errored' ? 'errored' : 'finished' });
    }
  }
  return items;
}

app.get('/api/digest', (req, res) => {
  try {
    const items = digestItems(Date.parse(req.query.since || ''), parseInt(req.query.limit));
    const counts = items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    res.json({ since: req.query.since || null, counts, items });
  } catch (error) { res.status(500).json({ error: error.message }); }
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
            const parsed = parseMessageForAgent(line, getAgentForSession(sid));
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
  try {
    spawnOrResume(req.body.id, req.body.cwd, false, req.body.agent);
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ id: req.body.id, status: 'starting' });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', async (req, res) => {
  try {
    const messageId = req.get('X-Feather-Message-ID');
    if (messageId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) {
      return res.status(400).json({ error: 'invalid message id' });
    }
    const response = messageId
      ? await sendInputToSessionIdempotent(req.params.id, req.body.text, messageId)
      : (await sendInputToSession(req.params.id, req.body.text), { ok: true, sentAt: new Date().toISOString() });
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    // Reset pane stability so question detection doesn't fire on stale state
    paneStableCount.set(req.params.id, 0);
    res.json(response);
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', async (req, res) => {
  try {
    const agent = getAgentForSession(req.params.id);
    spawnOrResume(req.params.id, req.body?.cwd, true, agent);
    try { await waitForAgentReady(tmuxName(req.params.id), agent); } catch {}
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' });
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true });
  }
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
    MESSAGE_RECEIPTS_STATE.update(receipts => {
      if (!(id in receipts)) return receipts;
      const next = { ...receipts };
      delete next[id];
      return next;
    });
    sseClients.delete(id);
    fileOffsets.delete(id);
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/rename', (req, res) => {
  try {
    const meta = readMeta();
    meta[req.params.id] = { ...(meta[req.params.id] || {}), title: req.body.title };
    writeMeta(meta);
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/fork', (req, res) => {
  try {
    const id = req.params.id;
    const cwd = req.body?.cwd || HOME;
    const forkName = `f-f${Date.now().toString(36)}`;
    spawnTmuxClaude(forkName, `--resume ${id} --fork-session`, cwd);
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true, tmux: forkName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rooms (upstream Sidecar): grouped agent threads with a chat channel ──

const sidecarClients = new Map(); // groupId -> Set<res>

function sidecarBroadcast(groupId, msg) {
  const clients = sidecarClients.get(groupId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const client of clients) {
    try { client.write(chunk); } catch { clients.delete(client); }
  }
}

function sidecarGcIfDriverGone(group) {
  if (READ_ONLY_MODE) return false;
  const driver = group.members.find(member => !member.spawned);
  if (!driver || tmuxIsActive(driver.sessionId)) return false;
  for (const member of group.members) {
    if (!member.spawned) continue;
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(member.sessionId)], { stdio: 'ignore' }); } catch {}
  }
  sidecar.teardownGroup(group.id);
  sidecarClients.delete(group.id);
  console.log(`[sidecar] GC'd group ${group.id} — driver gone`);
  return true;
}

function sidecarDeliver(group, fromRole, to, text) {
  const { targets, missing } = sidecar.resolveRecipients(group, to, fromRole);
  if (missing.length) return { error: `unknown recipient role(s): ${missing.join(', ')}` };
  if (!targets.length) return { error: `no recipients for "${to}"` };
  const message = sidecar.appendMessage(group.id, { from: fromRole, to, text });
  sidecarBroadcast(group.id, message);
  for (const target of targets) {
    sendInputToSession(target.sessionId, sidecar.formatInbound(fromRole, text))
      .catch(error => console.warn('[sidecar] route failed:', error.message));
  }
  return { ok: true, message };
}

app.get('/api/sidecar', (_req, res) => {
  res.json({ groups: sidecar.listGroups() });
});

app.get('/api/sidecar/:id', (req, res) => {
  const group = sidecar.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'not found' });
  res.json({ group, thread: sidecar.readThread(group.id) });
});

app.get('/api/sidecar/:id/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  const id = req.params.id;
  for (const message of sidecar.readThread(id)) {
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  if (!sidecarClients.has(id)) sidecarClients.set(id, new Set());
  sidecarClients.get(id).add(res);
  const heartbeat = setInterval(() => {
    try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    sidecarClients.get(id)?.delete(res);
  });
});

// Create one room with a driver plus one or more newly spawned peers.
app.post('/api/sidecar', (req, res) => {
  const body = req.body || {};
  const {
    driverSessionId,
    driverRole = 'driver',
    agent = 'claude',
    task = '',
  } = body;
  if (!driverSessionId) return res.status(400).json({ error: 'driverSessionId required' });
  const peerSpecs = Array.isArray(body.peers) && body.peers.length
    ? body.peers
    : [{ role: body.peerRole || 'peer', task, agent }];
  const peers = peerSpecs.map(peer => ({
    id: crypto.randomUUID(),
    role: peer.role || 'peer',
    task: peer.task || task || '',
    agent: peer.agent || agent,
  }));
  const members = [
    { sessionId: driverSessionId, role: driverRole, spawned: false },
    ...peers.map(peer => ({ sessionId: peer.id, role: peer.role, spawned: true })),
  ];
  let group;
  try {
    group = sidecar.createGroup({ id: crypto.randomUUID(), members, agent, task });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const cwd = body.cwd || findSessionCwd(driverSessionId) || HOME;
  const roster = members.map(member => member.role);
  for (const peer of peers) {
    try { spawnOrResume(peer.id, cwd, false, peer.agent); }
    catch (error) { console.warn('[sidecar] spawn failed:', error.message); }
    const prime = sidecar.priming({ selfRole: peer.role, roster, task: peer.task });
    setTimeout(() => {
      sendInputToSession(peer.id, prime).catch(error => console.warn('[sidecar] prime failed:', error.message));
    }, 7000);
  }
  res.json({
    group,
    peerSessionId: peers[0]?.id || null,
    peers: peers.map(peer => ({ role: peer.role, sessionId: peer.id })),
  });
});

// CLI entrypoint: resolve the sender by its f-<8-char> tmux prefix.
app.post('/api/sidecar/post', (req, res) => {
  try {
    const { group: groupId, fromPrefix, from, to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    const group = groupId
      ? sidecar.getGroup(groupId)
      : (fromPrefix ? sidecar.groupForSenderAndRole(fromPrefix, to) : null);
    if (!group || group.status !== 'active') {
      return res.status(404).json({ error: 'no active room for sender (you may be in several — pass --group)' });
    }
    if (sidecarGcIfDriverGone(group)) return res.status(410).json({ error: 'driver gone; room torn down' });
    const fromRole = from || (fromPrefix ? sidecar.roleForPrefix(group, fromPrefix) : null) || 'unknown';
    const result = sidecarDeliver(group, fromRole, to, text);
    if (result.error) return res.status(400).json(result);
    res.json({ ok: true, group: group.id, seq: result.message.seq });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Browser entrypoint: the group and sender role are already known.
app.post('/api/sidecar/:id/post', (req, res) => {
  try {
    const { from, to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    const group = sidecar.getGroup(req.params.id);
    if (!group || group.status !== 'active') return res.status(404).json({ error: 'no active room' });
    if (sidecarGcIfDriverGone(group)) return res.status(410).json({ error: 'driver gone; room torn down' });
    const result = sidecarDeliver(group, from || 'driver', to, text);
    if (result.error) return res.status(400).json(result);
    res.json({ ok: true, group: group.id, seq: result.message.seq });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/sidecar/:id/peers', (req, res) => {
  try {
    const group = sidecar.getGroup(req.params.id);
    if (!group || group.status !== 'active') return res.status(404).json({ error: 'no active room' });
    const { role = 'peer', agent = group.agent || 'claude', task = '' } = req.body || {};
    const peerId = crypto.randomUUID();
    sidecar.addMember(group.id, { sessionId: peerId, role, spawned: true });
    const driver = group.members.find(member => !member.spawned);
    const cwd = req.body?.cwd || (driver ? findSessionCwd(driver.sessionId) : null) || HOME;
    spawnOrResume(peerId, cwd, false, agent);
    const roster = sidecar.getGroup(group.id).members.map(member => member.role);
    setTimeout(() => {
      sendInputToSession(peerId, sidecar.priming({ selfRole: role, roster, task }))
        .catch(error => console.warn('[sidecar] prime failed:', error.message));
    }, 7000);
    res.json({ ok: true, role, sessionId: peerId });
  } catch (error) {
    res.status(/role/.test(error.message) ? 400 : 500).json({ error: error.message });
  }
});

app.post('/api/sidecar/:id/peers/:role/delete', (req, res) => {
  try {
    const group = sidecar.getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'not found' });
    const member = group.members.find(candidate => candidate.role === req.params.role);
    if (!member) return res.status(404).json({ error: `no member with role ${req.params.role}` });
    if (!member.spawned) return res.status(400).json({ error: 'the driver cannot be removed' });
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(member.sessionId)], { stdio: 'ignore' }); } catch {}
    sidecar.removeMember(group.id, req.params.role);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/sidecar/:id/delete', (req, res) => {
  try {
    const group = sidecar.getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'not found' });
    for (const member of group.members) {
      if (!member.spawned) continue;
      try { execFileSync('tmux', ['kill-session', '-t', tmuxName(member.sessionId)], { stdio: 'ignore' }); } catch {}
    }
    sidecar.teardownGroup(group.id);
    sidecarClients.delete(group.id);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function readBoundedBody(req, maxBytes, limitMessage) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, limitMessage);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

app.post('/api/upload', async (req, res) => {
  try {
    const dir = uploadsDir();
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100);
    const requestedId = String(req.headers['x-upload-id'] || '');
    if (requestedId && !/^[a-zA-Z0-9_-]{8,80}$/.test(requestedId)) {
      return res.status(400).json({ error: 'invalid upload id' });
    }
    const uploadId = requestedId || randomUUID();
    const dest = `${uploadId}-${safe || 'upload'}`;
    const fpath = path.join(dir, dest);
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'upload exceeds 50 MB limit' });
    const body = await readBoundedBody(req, MAX_UPLOAD_BYTES, 'upload exceeds 50 MB limit');
    const existingBody = () => {
      try {
        return fs.readFileSync(fpath);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };
    const existing = existingBody();
    if (existing) {
      if (!existing.equals(body)) return res.status(409).json({ error: 'upload id already exists with different content' });
      return res.json({ path: fpath, reused: true });
    }
    const tmp = path.join(dir, `.${uploadId}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
      fs.linkSync(tmp, fpath);
    } catch (e) {
      const racedBody = e.code === 'EEXIST' ? existingBody() : null;
      if (e.code !== 'EEXIST' || !racedBody?.equals(body)) {
        if (e.code === 'EEXIST') return res.status(409).json({ error: 'upload id already exists with different content' });
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    res.json({ path: fpath });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/transcribe', async (req, res) => {
  try {
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > MAX_AUDIO_BYTES) throw httpError(413, 'audio exceeds 25 MB limit');
    const audio = await readBoundedBody(req, MAX_AUDIO_BYTES, 'audio exceeds 25 MB limit');
    if (!DEEPGRAM_API_KEY) throw httpError(500, 'No Deepgram API key configured');
    const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true', {
      method: 'POST',
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': req.headers['content-type'] || 'audio/webm' },
      body: audio,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });
    const data = await response.json();
    res.json({ transcript: data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '' });
  } catch (e) {
    res.status(e.status || (e.name === 'TimeoutError' ? 504 : 500)).json({ error: e.message });
  }
});

app.get('/api/quick-links', (_req, res) => res.json(readUserJson('quick-links.json', [])));

app.post('/api/quick-links', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected array' });
  writeUserJson('quick-links.json', req.body);
  res.json({ ok: true });
});

app.get('/api/mute', (_req, res) => res.json({ muted: readUserJson('muted.json', []) }));

app.put('/api/mute', (req, res) => {
  const list = req.body?.muted;
  if (!Array.isArray(list) || list.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: 'expected { muted: string[] }' });
  }
  const muted = [...new Set(list)];
  try { writeUserJson('muted.json', muted); res.json({ ok: true, muted }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

function pushKeys() {
  const stored = readUserJson('push-keys.json', {});
  if (stored.publicKey && stored.privateKey) return stored;
  const keys = webpush.generateKeys();
  writeUserJson('push-keys.json', keys);
  return keys;
}

app.get('/api/push/key', (_req, res) => {
  try { res.json({ key: pushKeys().publicKey }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/push/subscribe', (_req, res) => {
  res.json({ subscriptions: readUserJson('push-subscriptions.json', []) });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint) {
    return res.status(400).json({ error: 'expected { endpoint, keys }' });
  }
  const subs = readUserJson('push-subscriptions.json', []).filter(item => item.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: sub.keys || {}, at: new Date().toISOString() });
  try { writeUserJson('push-subscriptions.json', subs); res.json({ ok: true, count: subs.length }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/push/subscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'expected { endpoint }' });
  const subs = readUserJson('push-subscriptions.json', []).filter(item => item.endpoint !== endpoint);
  try { writeUserJson('push-subscriptions.json', subs); res.json({ ok: true, count: subs.length }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

async function pushToAll(payload) {
  const subs = readUserJson('push-subscriptions.json', []);
  if (!subs.length) return [];
  const results = await Promise.all(subs.map(sub => webpush.send(sub, payload, pushKeys())));
  const gone = new Set(results.filter(result => result.gone).map(result => result.endpoint));
  if (gone.size) {
    try { writeUserJson('push-subscriptions.json', subs.filter(sub => !gone.has(sub.endpoint))); } catch {}
  }
  return results;
}

app.post('/api/push/test', async (_req, res) => {
  try {
    const results = await pushToAll({ title: 'Feather', body: 'Push notifications are working.', tag: 'feather-test' });
    res.json({ sent: results.filter(result => result.ok).length, results });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

let pushSeen = {};
async function pushCheck() {
  try {
    if (!readUserJson('push-subscriptions.json', []).length) return;
    const muted = new Set(readUserJson('muted.json', []));
    const items = digestItems(Date.now() - 5 * 60000, 30)
      .filter(item => item.status !== 'working' && !muted.has(item.id));
    const seen = {};
    for (const item of items) {
      seen[item.id] = item.status;
      if (pushSeen[item.id] === item.status) continue;
      const body = item.status === 'waiting' ? item.question || 'Waiting on you'
        : item.status === 'errored' ? 'Session errored' : 'Session finished';
      await pushToAll({ title: item.title || 'Feather session', body, tag: `feather-${item.id}`, url: `./?session=${item.id}` });
    }
    pushSeen = seen;
  } catch {}
}

if (!READ_ONLY_MODE && process.env.FEATHER_PUSH_POLL !== '0') setInterval(pushCheck, 60000).unref();

app.get('/api/starred', (_req, res) => res.json(readUserJson('starred.json', {})));

app.post('/api/starred', (req, res) => {
  try { writeUserJson('starred.json', req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function starPreview(blocks) {
  for (const block of blocks || []) {
    const text = block.text || block.thinking || '';
    if (text.trim()) return text.trim().slice(0, 240);
  }
  const tool = (blocks || []).find(block => block.type === 'tool_use');
  return tool ? `[${tool.name}]` : '';
}

app.get('/api/starred/album', (_req, res) => {
  try {
    const starred = readUserJson('starred.json', {});
    const meta = readMeta();
    const labels = readUserJson('project-labels.json', {});
    const items = [];
    for (const [sessionId, uuids] of Object.entries(starred)) {
      if (!Array.isArray(uuids) || !uuids.length) continue;
      const agent = getAgentForSession(sessionId, meta);
      const fpath = findJsonlPath(sessionId, agent);
      if (!fpath) continue;
      let content;
      try { content = fs.readFileSync(fpath, 'utf8'); } catch { continue; }
      const wanted = new Set(uuids);
      const projectId = agent === 'claude' ? path.basename(path.dirname(fpath)) : null;
      let info = { firstUserText: null, cwd: meta[sessionId]?.cwd || null };
      if (agent === 'claude') info = extractSessionInfo(fpath);
      else {
        let buf;
        try { buf = fs.readFileSync(fpath).slice(0, CODEX_HEAD_BYTES); } catch { buf = Buffer.alloc(0); }
        info = {
          firstUserText: agent === 'codex' ? extractCodexTitle(buf) : extractOmpTitle(buf),
          cwd: agent === 'codex' ? extractCodexCwd(buf) : meta[sessionId]?.cwd || null,
        };
      }
      const title = meta[sessionId]?.title || info.firstUserText || sessionId.slice(0, 8);
      for (const line of content.split('\n')) {
        if (!line) continue;
        const message = parseMessageForAgent(line, agent);
        if (!message || !wanted.has(message.uuid)) continue;
        items.push({
          uuid: message.uuid,
          sessionId,
          sessionTitle: title,
          projectId,
          projectLabel: projectId ? labels[projectId] || null : null,
          cwd: info.cwd || (projectId ? projectIdToCwd(projectId) : null) || null,
          role: message.role,
          timestamp: message.timestamp || null,
          snippet: starPreview(message.content),
        });
      }
    }
    items.sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
    res.json({ count: items.length, items });
  } catch (error) { res.status(500).json({ error: error.message }); }
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
    const meta = readMeta();
    for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
      const id = resolveCodexWatchId(uuid, meta);
      if (!active.has(id.slice(0, 8))) continue;
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'codex', mtime.getTime()),
        active.get(id.slice(0, 8)) || 0,
      );
      if (now - activity > IDLE_MS) {
        const name = tmuxName(id);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle Codex session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
      }
    }
  } catch {}

  // Reap omp sessions.
  try {
    for (const id of fs.readdirSync(OMP_SESSIONS)) {
      if (!active.has(id.slice(0, 8))) continue;
      const dirPath = path.join(OMP_SESSIONS, id);
      const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.jsonl')).sort().reverse();
      if (!files.length) continue;
      const fpath = path.join(dirPath, files[0]);
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'omp', fs.statSync(fpath).mtimeMs),
        active.get(id.slice(0, 8)) || 0,
      );
      if (now - activity > IDLE_MS) {
        const name = tmuxName(id);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle OMP session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
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
        const fpath = path.join(dirPath, file);
        const activity = latestSessionActivityMs(
          lastActivityMs(fpath, 'claude', fs.statSync(fpath).mtimeMs),
          active.get(id.slice(0, 8)) || 0,
        );
        if (now - activity > IDLE_MS) {
          const name = tmuxName(id);
          try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
          console.log(`[reaper] killed idle Claude session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
        }
      }
    } catch {}
  }
}

if (!READ_ONLY_MODE) setInterval(reapIdleSessions, 5 * 60 * 1000);

// ── File browser API ──────────────────────────────────────────────────────

const ALLOWED_ROOTS = [HOME, '/tmp', '/opt'];
const expandTilde = value => value === '~'
  ? HOME
  : (typeof value === 'string' && value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value);

function isPathAllowed(p) {
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

app.get('/api/files/list', (req, res) => {
  try {
    const dir = expandTilde(req.query.dir) || HOME;
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
    const requestedPath = req.query.path;
    if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) {
      return res.status(400).json({ error: 'valid path required' });
    }
    if (!path.isAbsolute(requestedPath) && !requestedPath.startsWith('~/') && requestedPath !== '~') {
      return res.status(400).json({ error: 'absolute path required' });
    }
    const filePath = expandTilde(requestedPath);
    if (!isPathAllowed(filePath)) return res.status(403).json({ error: 'Access denied' });
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (stat.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>10MB)' });
    if (req.query.download === '1') return res.download(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const textExts = new Set(['.txt', '.md', '.js', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.rb', '.go', '.rs', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini', '.env', '.sql', '.csv', '.xml', '.log', '.jsonl', '.svelte', '.vue', '.astro', '.mjs', '.cjs']);
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
    // .pdf inline (no attachment disposition): iOS standalone PWA renders the
    // attachment variant as garbled bytes in the target=_blank overlay
    if (imageExts.has(ext) || ext === '.pdf') {
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

// Opt-in HTML artifact preview. A restrictive sandbox permits styling and
// outbound links without giving the artifact access to Feather's origin.
app.get('/api/files/html', (req, res) => {
  try {
    const filePath = expandTilde(req.query.path);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!isPathAllowed(filePath)) return res.status(403).json({ error: 'Access denied' });
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>10MB)' });
    if (!['.html', '.htm'].includes(path.extname(resolved).toLowerCase())) {
      return res.status(415).json({ error: 'Only HTML files can be previewed' });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; object-src 'none'; base-uri 'none'; form-action 'none'");
    return res.sendFile(resolved);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Delete a file or directory. Gated by isPathAllowed (stricter than upstream,
// which only required a leading slash) so deletes stay within ALLOWED_ROOTS.
app.delete('/api/files/delete', (req, res) => {
  const fpath = expandTilde(req.query.path);
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

// ── Legacy route redirects ──────────────────────────────────────────────────
app.get('/code', (_req, res) => res.redirect('/'));
app.get('/terminal', (_req, res) => res.redirect('/'));

// ── SPA catch-all ───────────────────────────────────────────────────────────

// Unknown API paths must remain machine-readable failures instead of being
// mistaken for successful SPA navigation.
app.all(['/api', '/api/{*path}'], (_req, res) => res.status(404).json({ error: 'not found' }));

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
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
  if (READ_ONLY_MODE) {
    const body = JSON.stringify(READ_ONLY_ERROR);
    socket.end([
      'HTTP/1.1 403 Forbidden',
      'Content-Type: application/json',
      'Cache-Control: no-store',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '', body,
    ].join('\r\n'));
    return;
  }
  if (/(?:^|\/)api\/(terminal|shell)$/.test(pathname)) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (/(?:^|\/)api\/stt$/.test(pathname)) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Feather (single-user) on http://0.0.0.0:${PORT}`);
  // Warm shared discovery first; Rooms then reuses it instead of scanning all
  // transcripts a second time before the first interactive request.
  setTimeout(() => {
    try { sessionsSnapshotCache.get(); } catch {}
    try { roomSnapshotCache.get(); } catch {}
  }, 0);
  if (ROOM_PULSES_ENABLED) {
    setTimeout(checkRoomPulses, Math.min(ROOM_PULSE_CHECK_MS, ROOM_PULSE_INTERVAL_MS));
    setInterval(checkRoomPulses, ROOM_PULSE_CHECK_MS);
  }
});

// Graceful shutdown: close server so port is released before systemd restarts us
function shutdown(sig) {
  console.log(`${sig} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
