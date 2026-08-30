import express from 'express';
import compression from 'compression';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { execFileSync, execFile, spawn } from 'child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';
import * as sidecar from './lib/sidecar.js';
import { createKeyedLock } from './lib/sendlock.js';
import { codexPasteBufferArgs } from './lib/tmux-input.js';
import { activeTmuxCreatedAt, activeTmuxHas, sessionIsActive, sessionIsRoomPulse, lastMessageMs, latestSessionActivityMs } from './lib/sessions.js';
import { resolveCodexWatchId, codexAdoptionPending } from './lib/codex-watch.js';
import { codexSessionIsWorkerFromHead } from './lib/codex-session.js';
import * as webpush from './lib/webpush.js';
import { createSnapshotCache } from './lib/snapshot-cache.js';
import { paneHasReadyPrompt } from './lib/terminal-ready.js';
import { ensureStateLayout, resolveStatePaths } from './lib/state-paths.js';
import { createJsonState, isJsonRecord } from './lib/json-state.js';
import { encodeProjectPath, groupRoomSessions } from './lib/rooms.js';
import { parseFrictionNotes } from './lib/friction.js';
import { resolveOmpModel, resolveOmpThinking, ompLaunchCommand, ompTmuxArgs } from './lib/omp.js';
import { ompSessionCwdFromHead, ompSessionIdFromHead, ompTurnBoundaryFromLine } from './lib/omp-session.js';
import { inferLegacyTmuxOwner, legacyTmuxSessionName, tmuxSessionName } from './lib/tmux-session.js';
import { extractOsc8HttpUrls } from './lib/terminal-hyperlinks.js';
import { prepareTmuxTerminal } from './lib/terminal-attach.js';
import { createProtocolRunStore } from './lib/protocol-runs.js';

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
const SUPPORTED_AGENTS = new Set(['claude', 'codex', 'omp']);
const DEFAULT_AGENT = SUPPORTED_AGENTS.has(process.env.FEATHER_DEFAULT_AGENT)
  ? process.env.FEATHER_DEFAULT_AGENT
  : 'omp';
const OMP_MODEL = resolveOmpModel(process.env);
const OMP_THINKING = resolveOmpThinking(process.env);
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
const SESSION_READ_ROUTE = /^\/api\/sessions\/[^/]+\/(messages|stream|export|protocol-runs)$/;

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
const OMP_BRIDGE_EXTENSION = path.join(import.meta.dirname, 'omp-extensions', 'feather-bridge.js');
const OMP_PROTOCOL_EXTENSION = path.join(import.meta.dirname, 'omp-tools', 'feather-protocol-tools.js');
const OMP_COUNCIL_SKILL = path.join(import.meta.dirname, 'skills', 'council');
const OMP_FEATHER_CONFIG = path.join(import.meta.dirname, 'omp-feather.yml');
const OMP_BRIDGE_TOKENS_DIR = path.join(OMP_SESSIONS, '.feather-bridge-tokens');
const ompBridgeTokens = new Map();
const ompBridgeLastSeen = new Map();
const OMP_DISCOVERED_BRIDGE = path.join(HOME, '.omp/agent/extensions/feather-bridge.js');
const OMP_DISCOVERED_PROTOCOL = path.join(HOME, '.omp/agent/extensions/feather-protocol-tools.js');
const OMP_DISCOVERED_COUNCIL = path.join(HOME, '.omp/agent/skills/council');
// Older bridge payloads remain accepted for compatibility, but only v4 marks
// the complete execution mirror live for migration purposes.
const OMP_BRIDGE_VERSION = 4;
const OMP_WORK_THINKING_CHARS = 3_000;
const OMP_BRIDGE_MAX_EVENT_BYTES = 120_000;
const OMP_BRIDGE_JSON_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 500,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxKeyBytes: 240,
  maxStringBytes: 20_000,
  maxTotalBytes: 80_000,
});
const OMP_REPLAY_MAX_SESSIONS = 64;
const OMP_REPLAY_MAX_EVENTS = 128;
const OMP_REPLAY_MAX_BYTES = 512_000;
const OMP_BRIDGE_EVENT_TYPES = Object.freeze({
  assistant_snapshot: true,
  work_snapshot: true,
  assistant_end: true,
  assistant_cancel: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  agent_start: true,
  agent_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  credential_disabled: true,
  todo: true,
  tool_approval_requested: true,
  tool_approval_resolved: true,
  subagent_lifecycle: true,
  subagent_progress: true,
  async_jobs: true,
  session_state: true,
});
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
  if (findOmpJsonlPath(sessionId)) return 'omp';
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

const MESSAGE_TAIL_CHUNK_BYTES = 1024 * 1024;

function readLatestMessages(fpath, agent, count) {
  const wanted = Math.max(1, count);
  const reverse = [];
  const fd = fs.openSync(fpath, 'r');
  let position = fs.fstatSync(fd).size;
  let suffix = Buffer.alloc(0);
  try {
    while (position > 0 && reverse.length <= wanted) {
      const length = Math.min(MESSAGE_TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      const data = suffix.length ? Buffer.concat([chunk, suffix]) : chunk;
      let end = data.length;
      while (reverse.length <= wanted) {
        const newline = data.lastIndexOf(10, end - 1);
        if (newline < 0) break;
        const line = data.subarray(newline + 1, end);
        end = newline;
        if (!line.length) continue;
        const message = parseMessageForAgent(line.toString('utf8'), agent);
        if (message) reverse.push(message);
      }
      suffix = Buffer.from(data.subarray(0, end));
    }
    if (position === 0 && reverse.length <= wanted && suffix.length) {
      const message = parseMessageForAgent(suffix.toString('utf8'), agent);
      if (message) reverse.push(message);
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    messages: reverse.slice(0, wanted).reverse(),
    hasEarlier: reverse.length > wanted,
  };
}

function getMessages(sessionId, limit = 100, before = 0) {
  const agent = getAgentForSession(sessionId);
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath || !fs.existsSync(fpath)) return { messages: [], hasMore: false };
  const pageSize = Math.max(1, limit);
  const offset = Math.max(0, before);
  const tail = readLatestMessages(fpath, agent, pageSize + offset);
  const end = Math.max(0, tail.messages.length - offset);
  const start = Math.max(0, end - pageSize);
  return {
    messages: tail.messages.slice(start, end),
    hasMore: tail.hasEarlier || start > 0,
  };
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

function readOmpSessionHead(featherId) {
  const fpath = findOmpJsonlPath(featherId);
  if (!fpath) return null;
  try {
    const fd = fs.openSync(fpath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }
}

// omp's internal snowflake session id and original cwd live in the session
// header. Resume must use that exact durable metadata, never a guessed session.
function getOmpSessionId(featherId) {
  return ompSessionIdFromHead(readOmpSessionHead(featherId));
}

function getOmpSessionCwd(featherId) {
  return ompSessionCwdFromHead(readOmpSessionHead(featherId));
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
  return tmuxSessionName(id);
}

const legacyTmuxOwners = new Map();

function tmuxSessionExists(name) {
  // tmux otherwise accepts a unique prefix as a target. That would let a
  // missing legacy f-<id8> name resolve to the wrong full-id sibling.
  try { execFileSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function existingTmuxName(id) {
  const canonical = tmuxName(id);
  if (tmuxSessionExists(canonical)) return canonical;
  const legacy = legacyTmuxSessionName(id);
  return tmuxSessionExists(legacy) && legacyTmuxOwners.get(legacy) === String(id) ? legacy : canonical;
}

function terminalHyperlinkTargets(name) {
  try {
    const pane = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', name, '-S', '-500'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
    return [...new Set(extractOsc8HttpUrls(pane))].slice(-20).reverse();
  } catch { return []; }
}

function killTmuxSessions(id) {
  for (const name of new Set([tmuxName(id), legacyTmuxSessionName(id)])) {
    try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); } catch {}
  }
}

function getActiveTmuxSessions() {
  const prefix = 'f-';
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const active = new Map();
    for (const line of out.split('\n')) {
      const [name, created] = line.split('|');
      if (!name?.startsWith(prefix)) continue;
      const legacyOwner = /^f-[A-Za-z0-9_-]{8}$/.test(name) ? legacyTmuxOwners.get(name) : null;
      // An unowned legacy prefix is ambiguous by definition. Ignoring it is
      // safer than marking every same-prefix chat active.
      if (/^f-[A-Za-z0-9_-]{8}$/.test(name) && !legacyOwner) continue;
      active.set(legacyOwner || name.slice(prefix.length), Number(created) * 1000 || 0);
    }
    return active;
  } catch { return new Map(); }
}

function tmuxIsActive(id) {
  return tmuxSessionExists(tmuxName(id)) || existingTmuxName(id) !== tmuxName(id);
}

function listClaudeSessionIds() {
  const ids = [];
  const root = projectsDir();
  if (!fs.existsSync(root)) return ids;
  for (const project of fs.readdirSync(root)) {
    try {
      for (const file of fs.readdirSync(path.join(root, project))) {
        if (file.endsWith('.jsonl')) ids.push(file.slice(0, -6));
      }
    } catch {}
  }
  return ids;
}

function migrateLegacyTmuxSessions(renameSessions) {
  const knownIds = new Set([
    ...Object.keys(readMeta()),
    ...(fs.existsSync(OMP_SESSIONS) ? fs.readdirSync(OMP_SESSIONS) : []),
    ...listCodexJsonlFiles().map(file => file.uuid),
    ...listClaudeSessionIds(),
  ]);
  let names = [];
  try {
    names = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
  } catch { return; }
  for (const name of names) {
    if (!/^f-[A-Za-z0-9_-]{8}$/.test(name)) continue;
    let startCommand = '';
    try {
      startCommand = execFileSync('tmux', ['display-message', '-p', '-t', name, '#{pane_start_command}'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
    const owner = inferLegacyTmuxOwner(name, startCommand, knownIds);
    if (!owner) {
      if (renameSessions) console.warn(`[tmux] could not safely migrate ambiguous legacy session ${name}`);
      continue;
    }
    legacyTmuxOwners.set(name, owner);
    if (!renameSessions) continue;
    const canonical = tmuxName(owner);
    if (tmuxSessionExists(canonical)) {
      console.warn(`[tmux] kept legacy session ${name}; canonical ${canonical} already exists`);
      continue;
    }
    try {
      execFileSync('tmux', ['rename-session', '-t', name, canonical], { stdio: 'ignore' });
      console.log(`[tmux] migrated ${name} -> ${canonical}`);
    } catch (error) { console.warn(`[tmux] could not migrate ${name}:`, error.message); }
  }
}

const shouldMigrateTmux = !READ_ONLY_MODE
  && !/^(0|false|no|off)$/i.test(String(process.env.FEATHER_MIGRATE_TMUX || '').trim());
migrateLegacyTmuxSessions(shouldMigrateTmux);

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
function spawnTmuxOmp(name, ompArgs, dir, options = {}) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  const sessionId = options.sessionId || name.replace(/^f-/, '');
  const bridgeToken = randomUUID();
  const bridgeUrl = `http://127.0.0.1:${PORT}/api/internal/sessions/${sessionId}/events`;
  ompBridgeTokens.set(sessionId, bridgeToken);
  ompBridgeLastSeen.delete(sessionId);
  ensureOmpBridgeDiscovery();
  ensureOmpCouncilDiscovery();
  fs.mkdirSync(OMP_BRIDGE_TOKENS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ompBridgeTokenPath(sessionId), bridgeToken, { mode: 0o600 });
  const sessionDir = path.join(OMP_SESSIONS, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessionDir, '.feather-bridge.json'), JSON.stringify({
    url: bridgeUrl, token: bridgeToken, sessionId,
  }), { mode: 0o600 });
  const extensionArg = ` --extension ${shellQuote(OMP_BRIDGE_EXTENSION)}`;
  const configArg = ` --config ${shellQuote(OMP_FEATHER_CONFIG)}`;
  const launch = ompLaunchCommand(`${ompArgs}${extensionArg}${configArg}`, OMP_MODEL, OMP_THINKING, options);
  const ompCmd = [
    `export FEATHER_BRIDGE_URL=${shellQuote(bridgeUrl)}`,
    `FEATHER_BRIDGE_TOKEN=${shellQuote(bridgeToken)}`,
    `FEATHER_SESSION_ID=${shellQuote(sessionId)}`,
    `; ${launch}`,
  ].join(' ');
  // Pass tmux arguments directly. The device-auth wrapper includes a quoted
  // status message; interpolating it into a second `bash -c` command corrupts
  // the nested quoting and makes the new pane exit immediately.
  execFileSync('tmux', ompTmuxArgs(name, dir, ompCmd), { stdio: 'ignore', encoding: 'utf8' });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function ompBridgeTokenPath(sessionId) {
  const file = createHash('sha256').update(String(sessionId)).digest('hex');
  return path.join(OMP_BRIDGE_TOKENS_DIR, file);
}

function ensureManagedOmpSymlink(discoveredPath, targetPath, expectedSuffix, label) {
  fs.mkdirSync(path.dirname(discoveredPath), { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(discoveredPath);
    if (!stat.isSymbolicLink()) {
      console.warn(`[omp ${label}] discovery path is occupied: ${discoveredPath}`);
      return false;
    }
    const currentTarget = path.resolve(path.dirname(discoveredPath), fs.readlinkSync(discoveredPath));
    if (currentTarget === targetPath) return true;
    if (!currentTarget.endsWith(expectedSuffix)) {
      console.warn(`[omp ${label}] refusing to replace unrelated symlink: ${discoveredPath}`);
      return false;
    }
    const replacement = `${discoveredPath}.tmp-${process.pid}`;
    try { fs.unlinkSync(replacement); } catch {}
    fs.symlinkSync(targetPath, replacement);
    fs.renameSync(replacement, discoveredPath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.symlinkSync(targetPath, discoveredPath);
  return true;
}

function ensureOmpBridgeDiscovery() {
  return ensureManagedOmpSymlink(
    OMP_DISCOVERED_BRIDGE,
    OMP_BRIDGE_EXTENSION,
    path.join('omp-extensions', 'feather-bridge.js'),
    'bridge',
  );
}

function ensureOmpCouncilDiscovery() {
  ensureManagedOmpSymlink(
    OMP_DISCOVERED_PROTOCOL,
    OMP_PROTOCOL_EXTENSION,
    path.join('omp-tools', 'feather-protocol-tools.js'),
    'protocols',
  );
  ensureManagedOmpSymlink(
    OMP_DISCOVERED_COUNCIL,
    OMP_COUNCIL_SKILL,
    path.join('skills', 'council'),
    'council',
  );
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
  const resolvedAgent = agent || (resume ? getAgentForSession(id) : DEFAULT_AGENT);
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
    if (!resume) resetOmpBridgeSessionState(id);
    const sessionDir = path.join(OMP_SESSIONS, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    watchOmpSessionDir(sessionDir, id);
    if (resume) {
      const ompId = getOmpSessionId(id);
      if (!ompId) throw new Error(`Cannot resume OMP session ${id}: exact OMP session id not found`);
      spawnTmuxOmp(name, `--resume ${ompId} --session-dir ${sessionDir}`, cwd || getOmpSessionCwd(id) || HOME);
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
  // Use bracketed, literal file-based paste for long text or text with
  // newlines so the TUI receives the entire prompt as one paste event instead
  // of treating attachment-separating linefeeds as individual Enter presses.
  const isLong = text.length > 500 || text.includes('\n');
  if (isLong) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', codexPasteBufferArgs(name), { stdio: 'ignore' });
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
  let name = existingTmuxName(id);
  const agent = getAgentForSession(id);
  const sessionExists = tmuxSessionExists(name);

  if (!sessionExists) {
    spawnOrResume(id, null, true, agent);
    name = tmuxName(id);
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
// Parsing transcript heads/tails dominates session discovery. Most transcripts
// are immutable, so retain the parsed fields and last real-message timestamp
// until either size or mtime changes. A warm refresh then stats the catalog and
// reparses only chats that actually received data.
const sessionParseCache = new Map();

function readFileHead(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } catch { return Buffer.alloc(0); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function cachedCandidateInfo(candidate, meta) {
  const mtimeMs = candidate.mtime.getTime();
  let cached = sessionParseCache.get(candidate.fpath);
  if (cached && cached.agent === candidate.agent && candidate.size >= cached.size) {
    if (cached.mtimeMs !== mtimeMs || cached.size !== candidate.size) {
      let activityMs = cached.activityMs;
      const appendedBytes = candidate.size - cached.size;
      if (appendedBytes > 0) {
        if (appendedBytes <= 4 * 1024 * 1024) {
          let fd;
          try {
            fd = fs.openSync(candidate.fpath, 'r');
            const appended = Buffer.allocUnsafe(appendedBytes);
            fs.readSync(fd, appended, 0, appendedBytes, cached.size);
            activityMs = Math.max(activityMs || 0, lastMessageMs(appended.toString('utf8'), candidate.agent) || 0) || null;
          } catch {
            activityMs = null;
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
        } else {
          activityMs = lastActivityMs(candidate.fpath, candidate.agent, mtimeMs);
        }
      }
      const info = candidate.agent === 'claude' ? extractSessionInfo(candidate.fpath) : cached.info;
      cached = { ...cached, mtimeMs, size: candidate.size, info, activityMs };
      sessionParseCache.set(candidate.fpath, cached);
    }
  } else {
    let info;
    if (candidate.agent === 'codex') {
      const buffer = readFileHead(candidate.fpath, CODEX_HEAD_BYTES);
      info = {
        firstUserText: extractCodexTitle(buffer), cwd: extractCodexCwd(buffer),
        isTitleGen: false, isWorker: codexSessionIsWorkerFromHead(buffer),
      };
    } else if (candidate.agent === 'omp') {
      const buffer = readFileHead(candidate.fpath, 65536);
      info = { firstUserText: extractOmpTitle(buffer), cwd: null, isTitleGen: false, isWorker: false };
    } else {
      info = extractSessionInfo(candidate.fpath);
    }
    cached = { agent: candidate.agent, mtimeMs, size: candidate.size, info, activityMs: null };
    sessionParseCache.set(candidate.fpath, cached);
  }

  const info = { ...cached.info };
  const cwd = meta[candidate.id]?.cwdOverride || info.cwd || meta[candidate.id]?.cwd || null;
  if (candidate.agent !== 'claude' || !info.isWorker) {
    info.isWorker = info.isWorker
      || /^\/home\/[^/]+\/(?:auto|autoweb)-/.test(cwd || '')
      || /^\/home\/[^/]+\/\.feather\/room-runs\//.test(cwd || '');
  }
  return info;
}

function cachedCandidateActivity(candidate) {
  const cached = sessionParseCache.get(candidate.fpath);
  if (cached?.activityMs) return cached.activityMs;
  const activityMs = lastActivityMs(candidate.fpath, candidate.agent, candidate.mtime.getTime());
  if (cached) cached.activityMs = activityMs;
  return activityMs;
}

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
            candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, size: stat.size, projectId: dir, agent: 'claude' });
          } catch {}
        }
      } catch {}
    }
  }

  // Codex sessions, only when not filtering by a specific Claude project
  if (!projectFilter) {
    for (const { uuid, fpath, mtime, size } of listCodexJsonlFiles()) {
      if (size < 50) continue;
      candidates.push({ id: codexLocalIds.get(uuid) || uuid, fpath, mtime, size, projectId: null, agent: 'codex' });
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
        candidates.push({ id: dir, fpath, mtime: stat.mtime, size: stat.size, projectId: null, agent: 'omp' });
      } catch {}
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const required = new Set(requiredIds);
  const top = [];
  const addedPaths = new Set();
  const include = candidate => {
    if (addedPaths.has(candidate.fpath)) return;
    const info = cachedCandidateInfo(candidate, meta);
    if (info.isTitleGen || info.isWorker || sessionIsRoomPulse(meta[candidate.id])) return;
    top.push({ ...candidate, info });
    addedPaths.add(candidate.fpath);
  };
  // Parse only as far into the mtime-sorted catalog as needed. The old code
  // parsed every historical transcript before slicing to the newest 300.
  for (const candidate of candidates) {
    if (top.length >= Math.max(0, limit)) break;
    include(candidate);
  }
  // Portable Room assignments can require an older chat outside that window.
  if (required.size) {
    for (const candidate of candidates) if (required.has(candidate.id)) include(candidate);
  }
  top.sort((a, b) => b.mtime - a.mtime);
  if (!projectFilter) {
    const existingPaths = new Set(candidates.map(candidate => candidate.fpath));
    for (const filePath of sessionParseCache.keys()) if (!existingPaths.has(filePath)) sessionParseCache.delete(filePath);
  }
  const active = getActiveTmuxSessions();
  const now = Date.now();
  const labels = readUserJson('project-labels.json', {});

  const sessions = top.map(({ id, fpath, mtime, size, projectId: candidateProjectId, agent, info }) => {
    const cwd = meta[id]?.cwdOverride || info.cwd || meta[id]?.cwd || (candidateProjectId ? projectIdToCwd(candidateProjectId) : null) || null;
    const projectId = candidateProjectId || (cwd ? encodeProjectPath(cwd) : null);
    const activityMs = cachedCandidateActivity({ id, fpath, mtime, size, agent });
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
const ssePendingWrites = new WeakMap();
const SSE_WRITE_QUEUE_MAX_BYTES = 1_048_576;

function closeSseClient(clients, res) {
  clients.delete(res);
  ssePendingWrites.delete(res);
  try { res.end(); } catch {}
}

function flushSseWrites(clients, res, state) {
  try {
    while (!state.waiting && state.queue.length > 0) {
      const chunk = state.queue.shift();
      state.bytes -= Buffer.byteLength(chunk);
      if (!res.write(chunk)) {
        state.waiting = true;
        res.once('drain', () => {
          state.waiting = false;
          flushSseWrites(clients, res, state);
        });
      }
    }
  } catch {
    closeSseClient(clients, res);
  }
}

function writeSse(clients, res, chunk) {
  let state = ssePendingWrites.get(res);
  if (!state) {
    state = { queue: [], bytes: 0, waiting: false };
    ssePendingWrites.set(res, state);
  }
  if (state.waiting) {
    const bytes = Buffer.byteLength(chunk);
    if (state.bytes + bytes > SSE_WRITE_QUEUE_MAX_BYTES) {
      closeSseClient(clients, res);
      return false;
    }
    state.queue.push(chunk);
    state.bytes += bytes;
    return true;
  }
  try {
    if (!res.write(chunk)) {
      state.waiting = true;
      res.once('drain', () => {
        state.waiting = false;
        flushSseWrites(clients, res, state);
      });
    }
    return true;
  } catch {
    closeSseClient(clients, res);
    return false;
  }
}

function broadcast(sessionId, line, offset) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  // Parse by agent so codex/omp-format lines stream live (claude parser alone
  // returns null for their shapes, silently dropping live updates).
  const parsed = parseMessageForAgent(line, getAgentForSession(sessionId));
  if (!parsed) return;
  const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
  for (const res of clients) writeSse(clients, res, chunk);
}

function broadcastNamedEvent(sessionId, eventName, data) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) writeSse(clients, res, chunk);
}

const protocolRuns = createProtocolRunStore({
  root: path.join(LEGACY_STATE_ROOT, 'protocol-runs'),
  onSnapshot: (sessionId, snapshot) => broadcastNamedEvent(sessionId, 'protocol_run', snapshot),
  readOnly: READ_ONLY_MODE,
});

function replayProtocolRuns(sessionId, clients, res) {
  for (const snapshot of protocolRuns.list(sessionId, 50)) {
    const chunk = `event: protocol_run\ndata: ${JSON.stringify(snapshot)}\n\n`;
    if (!writeSse(clients, res, chunk)) break;
  }
}

function ompTranscriptLines(sessionId, cache) {
  if (cache?.has(sessionId)) return cache.get(sessionId);
  const file = findOmpJsonlPath(sessionId);
  let lines = [];
  try { lines = file ? fs.readFileSync(file, 'utf8').split('\n') : []; } catch {}
  cache?.set(sessionId, lines);
  return lines;
}

function ompOwnerExecutionIsTerminal(sessionId, ownerExecutionId, cache) {
  const lines = ompTranscriptLines(sessionId, cache);
  if (lines.length === 0) return false;
  let found = false;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (!found) {
      found = entry?.type === 'message' && entry.id === ownerExecutionId && entry.message?.role === 'user';
      continue;
    }
    if (entry?.type === 'message' && entry.message?.role === 'user') return true;
    if (entry?.type === 'custom' && entry.customType === 'session_exit') return true;
    if (ompTurnBoundaryFromLine(line) === 'completed') return true;
  }
  return false;
}

function ompUserText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function ompAdvisoryOwnerForRun(run, cache) {
  const lines = ompTranscriptLines(run.sessionId, cache);
  if (lines.length === 0) return null;
  const expected = `Run Advisory: ${run.question}`;
  const createdAt = Date.parse(run.createdAt || '');
  let owner = null;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry?.type !== 'message' || entry.message?.role !== 'user' || ompUserText(entry.message) !== expected) continue;
    if (Number.isFinite(createdAt) && Number.isFinite(Date.parse(entry.timestamp)) && Date.parse(entry.timestamp) + 5_000 < createdAt) continue;
    if (typeof entry.id === 'string' && entry.id) owner = entry.id;
  }
  return owner;
}

async function bindUnclaimedProtocolOwner(sessionId, ownerExecutionId, cache) {
  const run = protocolRuns.unclaimedStarting(sessionId)
    .find(candidate => ompAdvisoryOwnerForRun(candidate, cache) === ownerExecutionId);
  if (!run) return false;
  try {
    await protocolRuns.claim(sessionId, { ownerExecutionId, invocationMessageId: ownerExecutionId });
    return true;
  } catch (error) {
    if (error.code === 'PROTOCOL_CLAIM_AMBIGUOUS') return false;
    throw error;
  }
}

async function reconcileProtocolRunOwners() {
  const transcriptCache = new Map();
  for (const initial of protocolRuns.active()) {
    let run = initial;
    if (!run.ownerExecutionId) {
      const ownerExecutionId = ompAdvisoryOwnerForRun(run, transcriptCache);
      if (!ownerExecutionId) continue;
      if (!await bindUnclaimedProtocolOwner(run.sessionId, ownerExecutionId, transcriptCache)) continue;
      run = protocolRuns.get(run.sessionId, run.runId);
    }
    if (ompOwnerExecutionIsTerminal(run.sessionId, run.ownerExecutionId, transcriptCache)) {
      await protocolRuns.ownerTerminated(run.sessionId, run.ownerExecutionId);
    }
  }
}

const ompBridgeReplay = new Map();
let ompBridgeReplaySequence = 0;

function resetOmpBridgeSessionState(sessionId) {
  cancelOmpBridgeMigration(sessionId);
  ompBridgeReplay.delete(sessionId);
  ompBridgeLastSeen.delete(sessionId);
  const clients = sseClients.get(sessionId);
  if (clients) {
    for (const res of clients) closeSseClient(clients, res);
    sseClients.delete(sessionId);
  }
}

function replayOwner(event) {
  return event.subagentId || 'parent';
}

function replayKey(event) {
  const owner = replayOwner(event);
  if (event.type === 'agent_start' && !event.subagentId) return 'run:parent';
  if (event.type === 'session_state' || event.type === 'async_jobs') return `singleton:${event.type}`;
  if (event.type === 'todo') return `todo:${owner}`;
  if (event.type === 'tool_approval_requested') return `approval:${event.toolCallId}`;
  if (event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') return `subagent:${event.id}`;
  if (event.type.startsWith('tool_execution_')) return `tool:${owner}:${event.toolCallId}`;
  if (event.type === 'assistant_snapshot' || event.type === 'work_snapshot') return `${event.type}:${owner}:${event.messageId}`;
  if (event.type === 'assistant_cancel' && event.willContinue) return null;
  if ((event.type === 'assistant_end' || event.type === 'assistant_cancel') && event.subagentId) {
    return `terminal:${owner}:${event.messageId}`;
  }
  if (event.type === 'assistant_end' || event.type === 'assistant_cancel') return 'terminal:parent';
  return null;
}

function replayStoreFor(sessionId) {
  let store = ompBridgeReplay.get(sessionId);
  if (store) {
    store.touchedAt = Date.now();
    return store;
  }
  if (ompBridgeReplay.size >= OMP_REPLAY_MAX_SESSIONS) {
    let oldestId;
    let oldestAt = Infinity;
    for (const [id, candidate] of ompBridgeReplay) {
      if (candidate.touchedAt < oldestAt) {
        oldestId = id;
        oldestAt = candidate.touchedAt;
      }
    }
    if (oldestId) ompBridgeReplay.delete(oldestId);
  }
  store = { entries: new Map(), bytes: 0, touchedAt: Date.now() };
  ompBridgeReplay.set(sessionId, store);
  return store;
}

function deleteReplayEntries(store, predicate) {
  for (const [key, entry] of store.entries) {
    if (!predicate(entry.event)) continue;
    store.entries.delete(key);
    store.bytes -= entry.bytes;
  }
}

function isTransientReplayEventForOwner(event, owner) {
  return replayOwner(event) === owner && (
    event.type === 'assistant_snapshot' ||
    event.type === 'work_snapshot' ||
    event.type.startsWith('tool_execution_')
  );
}

function isParentTransientReplayEvent(event) {
  return isTransientReplayEventForOwner(event, 'parent');
}

function pruneSettledSubagentReplay(store) {
  const running = new Set();
  for (const { event } of store.entries.values()) {
    if (event.type !== 'subagent_lifecycle' && event.type !== 'subagent_progress') continue;
    if (event.status === 'started' || event.status === 'running' || event.status === 'working') running.add(event.id);
  }
  deleteReplayEntries(store, event => {
    const childId = event.subagentId || ((event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') ? event.id : null);
    return childId && !running.has(childId);
  });
}

function rememberOmpBridgeEvent(sessionId, event) {
  const store = replayStoreFor(sessionId);
  if (event.type === 'assistant_cancel' && event.willContinue) {
    const owner = replayOwner(event);
    deleteReplayEntries(store, candidate => isTransientReplayEventForOwner(candidate, owner));
    return;
  }
  if (event.type === 'tool_approval_resolved') {
    const key = `approval:${event.toolCallId}`;
    const existing = store.entries.get(key);
    if (existing) {
      store.entries.delete(key);
      store.bytes -= existing.bytes;
    }
    return;
  }

  if (event.type === 'agent_start' && !event.subagentId) {
    deleteReplayEntries(store, candidate => isParentTransientReplayEvent(candidate)
      || (!candidate.subagentId && (candidate.type === 'assistant_end' || candidate.type === 'assistant_cancel')));
    pruneSettledSubagentReplay(store);
  }

  const parentTerminal = !event.subagentId
    && (event.type === 'assistant_end' || event.type === 'assistant_cancel')
    && !event.willContinue;
  if (parentTerminal) {
    deleteReplayEntries(store, isParentTransientReplayEvent);
  } else if (isParentTransientReplayEvent(event)) {
    const terminal = store.entries.get('terminal:parent');
    if (terminal) {
      store.entries.delete('terminal:parent');
      store.bytes -= terminal.bytes;
    }
  }

  const key = replayKey(event);
  if (!key) return;
  const previous = store.entries.get(key);
  const mergePrevious = event.type.startsWith('tool_execution_')
    || event.type === 'subagent_lifecycle'
    || event.type === 'subagent_progress';
  const replayEvent = previous && mergePrevious ? { ...previous.event, ...event, type: event.type } : event;
  const bytes = Buffer.byteLength(JSON.stringify(replayEvent));
  if (bytes > OMP_REPLAY_MAX_BYTES) return;
  if (previous) store.bytes -= previous.bytes;
  const updatedSequence = ++ompBridgeReplaySequence;
  store.entries.set(key, {
    event: replayEvent,
    bytes,
    sequence: previous?.sequence ?? updatedSequence,
    updatedSequence,
  });
  store.bytes += bytes;

  while (store.entries.size > OMP_REPLAY_MAX_EVENTS || store.bytes > OMP_REPLAY_MAX_BYTES) {
    let oldestKey;
    let oldestUpdatedSequence = Infinity;
    for (const [candidateKey, entry] of store.entries) {
      if (entry.updatedSequence < oldestUpdatedSequence) {
        oldestKey = candidateKey;
        oldestUpdatedSequence = entry.updatedSequence;
      }
    }
    if (!oldestKey) break;
    const oldest = store.entries.get(oldestKey);
    store.entries.delete(oldestKey);
    store.bytes -= oldest.bytes;
  }
}

function replayOmpBridgeEvents(sessionId, clients, res) {
  const store = ompBridgeReplay.get(sessionId);
  if (!store) return;
  store.touchedAt = Date.now();
  const entries = [...store.entries.values()].sort((left, right) => left.sequence - right.sequence);
  for (const { event } of entries) {
    const chunk = `event: omp_event\ndata: ${JSON.stringify(event)}\n\n`;
    if (!writeSse(clients, res, chunk)) break;
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
      const name = existingTmuxName(sid);
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
const pendingOmpBridgeMigrations = new Map();

function ompBridgeIsLive(sessionId, now = Date.now()) {
  const live = ompBridgeLastSeen.get(sessionId);
  return Number.isFinite(live?.seenAt) && live.version >= OMP_BRIDGE_VERSION && now - live.seenAt < 30_000;
}

function ompBridgeOwnedElsewhere(sessionId) {
  try {
    const metadata = JSON.parse(fs.readFileSync(
      path.join(OMP_SESSIONS, sessionId, '.feather-bridge.json'),
      'utf8',
    ));
    if (metadata?.sessionId !== sessionId || typeof metadata.url !== 'string') return false;
    return new URL(metadata.url).origin !== `http://127.0.0.1:${PORT}`;
  } catch {
    // Missing metadata identifies a legacy pre-bridge session. Preserve the
    // existing completed-turn migration path for those sessions.
    return false;
  }
}

function cancelOmpBridgeMigration(sessionId) {
  const timer = pendingOmpBridgeMigrations.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingOmpBridgeMigrations.delete(sessionId);
}

function observeOmpTurnBoundary(sessionId, line) {
  const boundary = ompTurnBoundaryFromLine(line);
  if (!boundary) return;
  if (boundary === 'active') {
    cancelOmpBridgeMigration(sessionId);
    return;
  }
  if (getAgentForSession(sessionId) !== 'omp') return;
  if (ompBridgeIsLive(sessionId) || ompBridgeOwnedElsewhere(sessionId)
    || !tmuxIsActive(sessionId) || pendingOmpBridgeMigrations.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingOmpBridgeMigrations.delete(sessionId);
    if (ompBridgeIsLive(sessionId) || ompBridgeOwnedElsewhere(sessionId)
      || !tmuxIsActive(sessionId) || getAgentForSession(sessionId) !== 'omp') return;
    try {
      spawnOrResume(sessionId, getOmpSessionCwd(sessionId), true, 'omp');
      console.log(`[omp bridge] migrated completed session ${sessionId}`);
    } catch (error) {
      console.warn(`[omp bridge] migration failed for ${sessionId}:`, error.message);
    }
  }, 1500);
  timer.unref();
  pendingOmpBridgeMigrations.set(sessionId, timer);
}

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
      observeOmpTurnBoundary(sessionId, line);
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

function initOmpWatchers() {
  if (!fs.existsSync(OMP_SESSIONS)) return;
  for (const dir of fs.readdirSync(OMP_SESSIONS)) {
    if (dir.startsWith('.')) continue;
    const dirPath = path.join(OMP_SESSIONS, dir);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.jsonl')).sort().reverse();
      if (files.length > 0) fileOffsets.set(dir, fs.statSync(path.join(dirPath, files[0])).size);
      watchOmpSessionDir(dirPath, dir);
    } catch {}
  }
  // Sessions may be created by another Feather process or by OMP itself. Keep
  // those discoverable sessions live without requiring a server restart.
  try {
    fs.watch(OMP_SESSIONS, (_event, filename) => {
      if (!filename || filename.startsWith('.')) return;
      const dirPath = path.join(OMP_SESSIONS, filename);
      try { if (fs.statSync(dirPath).isDirectory()) watchOmpSessionDir(dirPath, filename); } catch {}
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
initOmpWatchers();

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '512kb' }));

// An allowlist keeps future GET handlers with side effects closed until they
// are explicitly classified, while static and non-API reads remain available.
const READ_ONLY_API_ROUTES = [
  /^\/api\/health$/,
  /^\/api\/(agents|rooms|version|projects|search|sessions|running|usage|digest|me)$/,
  /^\/api\/rooms\/[^/]+\/(updates|friction)$/,
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

function bridgeTokenValid(sessionId, value) {
  if (typeof value !== 'string') return false;
  let expected = ompBridgeTokens.get(sessionId);
  if (!expected) {
    try {
      expected = fs.readFileSync(ompBridgeTokenPath(sessionId), 'utf8').trim();
      if (expected) ompBridgeTokens.set(sessionId, expected);
    } catch {
      return false;
    }
  }
  if (!expected) return false;
  const givenHash = createHash('sha256').update(value).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(givenHash, expectedHash);
}

function bridgeString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function bridgeNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

const INVALID_BRIDGE_JSON = Symbol('invalid-bridge-json');

function revalidateBridgeJson(value) {
  const state = { nodes: 0, bytes: 0 };

  function visit(candidate, depth) {
    if (state.nodes >= OMP_BRIDGE_JSON_LIMITS.maxNodes) return INVALID_BRIDGE_JSON;
    state.nodes += 1;
    state.bytes += 8;
    if (state.bytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) return INVALID_BRIDGE_JSON;

    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : INVALID_BRIDGE_JSON;
    if (typeof candidate === 'string') {
      const bytes = Buffer.byteLength(candidate);
      if (bytes > OMP_BRIDGE_JSON_LIMITS.maxStringBytes || state.bytes + bytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) return INVALID_BRIDGE_JSON;
      state.bytes += bytes;
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object' || depth >= OMP_BRIDGE_JSON_LIMITS.maxDepth) return INVALID_BRIDGE_JSON;
    if (Array.isArray(candidate)) {
      if (candidate.length > OMP_BRIDGE_JSON_LIMITS.maxArrayItems) return INVALID_BRIDGE_JSON;
      const clean = [];
      for (const item of candidate) {
        const normalized = visit(item, depth + 1);
        if (normalized === INVALID_BRIDGE_JSON) return INVALID_BRIDGE_JSON;
        clean.push(normalized);
      }
      return clean;
    }

    const entries = Object.entries(candidate);
    if (entries.length > OMP_BRIDGE_JSON_LIMITS.maxObjectKeys) return INVALID_BRIDGE_JSON;
    const clean = Object.create(null);
    for (const [key, item] of entries) {
      const keyBytes = Buffer.byteLength(key);
      if (!key || keyBytes > OMP_BRIDGE_JSON_LIMITS.maxKeyBytes || state.bytes + keyBytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) return INVALID_BRIDGE_JSON;
      state.bytes += keyBytes;
      const normalized = visit(item, depth + 1);
      if (normalized === INVALID_BRIDGE_JSON) return INVALID_BRIDGE_JSON;
      clean[key] = normalized;
    }
    return clean;
  }

  const clean = visit(value, 0);
  return clean === INVALID_BRIDGE_JSON ? null : { value: clean };
}

function bridgeSubagentId(event) {
  if (event.subagentId === undefined) return {};
  const subagentId = bridgeString(event.subagentId, 128);
  return subagentId ? { subagentId } : null;
}

function normalizeTodoEvent(event) {
  const owner = bridgeSubagentId(event);
  if (owner === null) return null;
  if (!Array.isArray(event.phases) || event.phases.length > 30) return null;
  const allowedStatuses = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']);
  const phases = [];
  for (const phase of event.phases) {
    const name = bridgeString(phase?.name, 120);
    if (!name || !Array.isArray(phase.tasks) || phase.tasks.length > 200) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      const content = bridgeString(task?.content, 500);
      if (!content || !allowedStatuses.has(task.status)) return null;
      tasks.push({
        content,
        status: task.status,
        ...(bridgeString(task.blocker, 300) !== undefined ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name, tasks });
  }
  return {
    type: 'todo',
    phases,
    ...(bridgeString(event.op, 20) !== undefined ? { op: event.op } : {}),
    isError: !!event.isError,
    ...owner,
  };
}

function normalizeAsyncJob(job) {
  const id = bridgeString(job?.id, 120);
  const type = bridgeString(job?.type, 20);
  const status = bridgeString(job?.status, 20);
  const startTime = bridgeNumber(job?.startTime, 0);
  if (!id || !type || !status || startTime === undefined) return null;
  return {
    id,
    type,
    status,
    startTime,
    ...(type === 'task' && bridgeString(job.label, 160) !== undefined ? { label: job.label } : {}),
  };
}

function normalizeOmpBridgeEvent(event) {
  if (!event || typeof event !== 'object' || !OMP_BRIDGE_EVENT_TYPES[event.type]) return null;
  const type = event.type;
  const owner = bridgeSubagentId(event);
  if (owner === null) return null;
  if (type === 'assistant_snapshot') {
    const messageId = bridgeString(event.messageId, 128);
    const text = bridgeString(event.text, 100_000);
    return messageId && text !== undefined ? { type, messageId, text, ...owner } : null;
  }
  if (type === 'work_snapshot') {
    const messageId = bridgeString(event.messageId, 128);
    if (!messageId || !Array.isArray(event.blocks) || event.blocks.length > 40) return null;
    let thinkingChars = 0;
    const blocks = [];
    for (const block of event.blocks) {
      if (block?.type === 'thinking') {
        const thinking = bridgeString(block.thinking, OMP_WORK_THINKING_CHARS - thinkingChars);
        if (thinking === undefined) return null;
        thinkingChars += thinking.length;
        blocks.push({ type: 'thinking', thinking });
      } else if (block?.type === 'tool_use') {
        const id = bridgeString(block.id, 128);
        const name = bridgeString(block.name, 80);
        if (!id || !name) return null;
        blocks.push({ type: 'tool_use', id, name, ...(bridgeString(block.intent, 300) !== undefined ? { intent: block.intent } : {}) });
      } else {
        return null;
      }
    }
    return { type, messageId, blocks, ...owner };
  }
  if (type === 'assistant_end' || type === 'assistant_cancel') {
    const messageId = bridgeString(event.messageId, 128);
    return messageId ? { type, messageId, ...(event.willContinue === true ? { willContinue: true } : {}), ...owner } : null;
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    if (!toolCallId || !toolName) return null;
    const hasArgs = type !== 'tool_execution_end' && event.args !== undefined;
    const hasPartialResult = type === 'tool_execution_update' && event.partialResult !== undefined;
    const hasResult = type === 'tool_execution_end' && event.result !== undefined;
    const args = hasArgs ? revalidateBridgeJson(event.args) : {};
    const partialResult = hasPartialResult ? revalidateBridgeJson(event.partialResult) : {};
    const result = hasResult ? revalidateBridgeJson(event.result) : {};
    if (args === null || partialResult === null || result === null) return null;
    return {
      type,
      toolCallId,
      toolName,
      ...(hasArgs ? { args: args.value } : {}),
      ...(bridgeString(event.intent, 300) !== undefined ? { intent: event.intent } : {}),
      ...(hasPartialResult ? { partialResult: partialResult.value } : {}),
      ...(hasResult ? { result: result.value } : {}),
      ...(type === 'tool_execution_end' && typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
      ...owner,
    };
  }
  if (type === 'agent_start') return { type };
  if (type === 'agent_end') return { type, ...(typeof event.willContinue === 'boolean' ? { willContinue: event.willContinue } : {}) };
  if (type === 'auto_retry_start') {
    if (!Number.isSafeInteger(event.attempt) || !Number.isSafeInteger(event.maxAttempts) || !Number.isSafeInteger(event.delayMs)) return null;
    return {
      type,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      ...(bridgeString(event.errorMessage, 500) !== undefined ? { errorMessage: event.errorMessage } : {}),
    };
  }
  if (type === 'auto_retry_end') {
    if (typeof event.success !== 'boolean' || !Number.isSafeInteger(event.attempt)) return null;
    return {
      type,
      success: event.success,
      attempt: event.attempt,
      ...(bridgeString(event.finalError, 500) !== undefined ? { finalError: event.finalError } : {}),
    };
  }
  if (type === 'auto_compaction_start') {
    const reason = bridgeString(event.reason, 32);
    const action = bridgeString(event.action, 32);
    return reason && action ? { type, reason, action } : null;
  }
  if (type === 'auto_compaction_end') {
    const action = bridgeString(event.action, 32);
    if (!action || typeof event.aborted !== 'boolean' || typeof event.willRetry !== 'boolean') return null;
    return {
      type,
      action,
      aborted: event.aborted,
      willRetry: event.willRetry,
      ...(typeof event.skipped === 'boolean' ? { skipped: event.skipped } : {}),
      ...(bridgeString(event.errorMessage, 500) !== undefined ? { errorMessage: event.errorMessage } : {}),
    };
  }
  if (type === 'credential_disabled') {
    const provider = bridgeString(event.provider, 80);
    return provider ? { type, provider } : null;
  }
  if (type === 'todo') return normalizeTodoEvent(event);
  if (type === 'tool_approval_requested') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    const approvalMode = bridgeString(event.approvalMode, 40);
    if (!toolCallId || !toolName || !approvalMode) return null;
    return { type, toolCallId, toolName, approvalMode, ...(bridgeString(event.reason, 500) !== undefined ? { reason: event.reason } : {}) };
  }
  if (type === 'tool_approval_resolved') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    if (!toolCallId || !toolName || typeof event.approved !== 'boolean') return null;
    return { type, toolCallId, toolName, approved: event.approved, ...(bridgeString(event.reason, 500) !== undefined ? { reason: event.reason } : {}) };
  }
  if (type === 'subagent_lifecycle' || type === 'subagent_progress') {
    const id = bridgeString(event.id, 128);
    const agent = bridgeString(event.agent, 80);
    const status = bridgeString(event.status, 20);
    const index = bridgeNumber(event.index, 0, 1000);
    if (!id || !agent || !status || index === undefined) return null;
    return {
      type,
      id,
      agent,
      status,
      index,
      detached: !!event.detached,
      ...(bridgeString(event.agentSource, 20) !== undefined ? { agentSource: event.agentSource } : {}),
      ...(bridgeString(event.task, 2_000) !== undefined ? { task: event.task } : {}),
      ...(bridgeString(event.assignment, 1_000) !== undefined ? { assignment: event.assignment } : {}),
      ...(bridgeString(event.sessionFile, 1_000) !== undefined ? { sessionFile: event.sessionFile } : {}),
      ...(bridgeString(event.parentToolCallId, 128) !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
      ...(bridgeString(event.description, 300) !== undefined ? { description: event.description } : {}),
      ...(bridgeString(event.intent, 300) !== undefined ? { intent: event.intent } : {}),
      ...(bridgeString(event.resolvedModel, 160) !== undefined ? { resolvedModel: event.resolvedModel } : {}),
      ...(bridgeNumber(event.toolCount) !== undefined ? { toolCount: event.toolCount } : {}),
      ...(bridgeNumber(event.requests) !== undefined ? { requests: event.requests } : {}),
      ...(bridgeNumber(event.tokens) !== undefined ? { tokens: event.tokens } : {}),
      ...(bridgeNumber(event.durationMs) !== undefined ? { durationMs: event.durationMs } : {}),
      ...(bridgeNumber(event.contextTokens) !== undefined ? { contextTokens: event.contextTokens } : {}),
      ...(bridgeNumber(event.contextWindow) !== undefined ? { contextWindow: event.contextWindow } : {}),
    };
  }
  if (type === 'async_jobs') {
    if (!Array.isArray(event.running) || !Array.isArray(event.recent) || event.running.length > 30 || event.recent.length > 20) return null;
    const running = event.running.map(normalizeAsyncJob);
    const recent = event.recent.map(normalizeAsyncJob);
    if (running.some(job => job === null) || recent.some(job => job === null)) return null;
    return {
      type,
      running,
      recent,
      delivery: {
        queued: bridgeNumber(event.delivery?.queued, 0, 1000) || 0,
        delivering: !!event.delivery?.delivering,
      },
    };
  }
  if (type === 'session_state') {
    const serviceTiers = {};
    if (event.serviceTiers && typeof event.serviceTiers === 'object' && !Array.isArray(event.serviceTiers)) {
      for (const [family, tier] of Object.entries(event.serviceTiers).slice(0, 20)) {
        if (bridgeString(family, 40) && (tier === null || bridgeString(tier, 40) !== undefined)) serviceTiers[family] = tier;
      }
    }
    return {
      type,
      ...(bridgeString(event.modelProvider, 80) !== undefined ? { modelProvider: event.modelProvider } : {}),
      ...(bridgeString(event.modelId, 160) !== undefined ? { modelId: event.modelId } : {}),
      ...(bridgeString(event.modelApi, 80) !== undefined ? { modelApi: event.modelApi } : {}),
      ...(bridgeString(event.thinkingLevel, 40) !== undefined ? { thinkingLevel: event.thinkingLevel } : {}),
      serviceTiers,
      ...(bridgeNumber(event.contextTokens) !== undefined ? { contextTokens: event.contextTokens } : {}),
      ...(bridgeNumber(event.contextWindow) !== undefined ? { contextWindow: event.contextWindow } : {}),
      ...(bridgeNumber(event.contextPercent, 0, 100) !== undefined ? { contextPercent: event.contextPercent } : {}),
    };
  }
  return null;
}

app.post('/api/internal/sessions/:id/events', async (req, res) => {
  const { id } = req.params;
  if (!bridgeTokenValid(id, req.get('X-Feather-Bridge-Token'))) return res.status(403).json({ error: 'invalid bridge token' });
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 50) return res.status(400).json({ error: 'events must be a non-empty array (max 50)' });
  const normalized = events.map(normalizeOmpBridgeEvent);
  if (normalized.some(event => event === null || Buffer.byteLength(JSON.stringify(event)) > OMP_BRIDGE_MAX_EVENT_BYTES)) {
    return res.status(400).json({ error: 'invalid bridge event' });
  }
  const terminalOwners = new Set();
  for (const event of events) {
    const isParentTerminal = !event?.subagentId && (
      ((event?.type === 'assistant_end' || event?.type === 'assistant_cancel') && !event.willContinue)
      || (event?.type === 'agent_end' && !event.willContinue)
    );
    if (isParentTerminal && typeof event.ownerExecutionId === 'string') terminalOwners.add(event.ownerExecutionId);
  }
  const bridgeVersion = Number.isSafeInteger(req.body?.version) ? req.body.version : 0;
  ompBridgeLastSeen.set(id, { seenAt: Date.now(), version: bridgeVersion });
  for (const event of normalized) {
    rememberOmpBridgeEvent(id, event);
    broadcastNamedEvent(id, 'omp_event', event);
  }
  try {
    for (const ownerExecutionId of terminalOwners) {
      await bindUnclaimedProtocolOwner(id, ownerExecutionId);
      await protocolRuns.ownerTerminated(id, ownerExecutionId);
    }
    res.status(204).end();
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

function protocolErrorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
}

function protocolBridgeRequestAllowed(req, allowedKeys) {
  if (!bridgeTokenValid(req.params.id, req.get('X-Feather-Bridge-Token'))) return { status: 403, error: 'invalid bridge token' };
  if (req.get('X-Feather-Subagent-ID') || req.body?.subagentId) return { status: 403, error: 'protocol tools are parent-only' };
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return { status: 400, error: 'request body must be an object' };
  if (Buffer.byteLength(JSON.stringify(req.body)) > 128_000) return { status: 413, error: 'protocol request body exceeds 128000 bytes' };
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(req.body).find(key => !allowed.has(key));
  if (unknown) return { status: 400, error: `request body contains unknown field ${unknown}` };
  return null;
}

app.post('/api/internal/sessions/:id/protocol-runs/claim', async (req, res) => {
  const denied = protocolBridgeRequestAllowed(req, ['ownerExecutionId', 'invocationMessageId', 'mode', 'input']);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  try {
    const envelope = await protocolRuns.claim(req.params.id, req.body);
    res.json({ envelope });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

app.post('/api/internal/sessions/:id/protocol-runs/:runId/events', async (req, res) => {
  const denied = protocolBridgeRequestAllowed(req, ['ownerExecutionId', 'event']);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  if (req.body?.event?.runId !== req.params.runId) return res.status(409).json({ error: 'event runId does not match route runId' });
  try {
    const result = await protocolRuns.appendEvent(req.params.id, req.body.ownerExecutionId, req.body.event);
    res.json({ ok: true, seq: result.seq, duplicate: result.duplicate });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

// Detect an optional agent's version via the interactive-rc shell so binaries
// under ~/.npm-global/bin (codex, omp) resolve the same way they do when spawned
// (the systemd PATH the server runs under doesn't include them). Returns the
// last non-empty output line, or null if the binary is absent.
const agentVersionCache = new Map();
function agentVersion(bin) {
  if (agentVersionCache.has(bin)) return agentVersionCache.get(bin);
  let version = null;
  try {
    if (READ_ONLY_MODE) {
      // A capability GET must not launch a harness: OMP 18 writes audit logs
      // even for --version. Probe a predictable PATH without sourcing rc files.
      const searchPath = [path.join(HOME, '.local/bin'), path.join(HOME, '.npm-global/bin'), process.env.PATH || ''].join(':');
      const found = searchPath.split(':').some(dir => {
        if (!dir) return false;
        try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; }
        catch { return false; }
      });
      if (!found) throw new Error(`${bin} not found`);
      version = 'installed';
    } else {
      const out = execFileSync('bash', ['--rcfile', path.join(HOME || '/home/user', '.bashrc'), '-ic', `${bin} --version`], { encoding: 'utf8', timeout: 5000 });
      version = out.split('\n').map(s => s.trim()).filter(Boolean).pop() || null;
    }
  } catch {}
  agentVersionCache.set(bin, version);
  return version;
}

app.get('/api/agents', (_req, res) => {
  const agents = [{ id: 'claude', label: 'Claude Code', available: true, default: DEFAULT_AGENT === 'claude' }];
  const codexVer = agentVersion('codex');
  agents.push(codexVer ? { id: 'codex', label: codexVer === 'installed' ? 'Codex' : `Codex ${codexVer}`, available: true, default: DEFAULT_AGENT === 'codex' } : { id: 'codex', label: 'Codex', available: false, default: DEFAULT_AGENT === 'codex' });
  const ompVer = agentVersion('omp');
  agents.push(ompVer ? { id: 'omp', label: ompVer === 'installed' ? 'oh-my-pi' : `oh-my-pi ${ompVer}`, available: true, default: DEFAULT_AGENT === 'omp' } : { id: 'omp', label: 'oh-my-pi', available: false, default: DEFAULT_AGENT === 'omp' });
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

// Human-facing room briefings are separate from terse agent working memory in
// notes.md. The JSONL feed is append-only so its count is a stable unread marker.
const ROOM_UPDATE_MAX_CHARS = 4000;
function roomUpdatesFile(name) { return path.join(ROOMS_HOME_DIR, name, 'updates.jsonl'); }

function readRoomUpdates(name) {
  let raw;
  try { raw = fs.readFileSync(roomUpdatesFile(name), 'utf8'); } catch { return []; }
  const updates = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.text === 'string') {
        updates.push({
          id: typeof entry.id === 'string' ? entry.id : null,
          ts: typeof entry.ts === 'string' ? entry.ts : null,
          text: entry.text,
        });
      }
    } catch {}
  }
  return updates;
}

function roomUpdatesSummary(name) {
  const updates = readRoomUpdates(name);
  const newest = updates[updates.length - 1] || null;
  return {
    count: updates.length,
    latestAt: newest?.ts || null,
    latest: newest ? newest.text.replace(/\s+/g, ' ').trim().slice(0, 180) : null,
  };
}

function appendRoomUpdate(name, text) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) throw httpError(400, 'update text is required');
  if (clean.length > ROOM_UPDATE_MAX_CHARS) throw httpError(413, `update exceeds ${ROOM_UPDATE_MAX_CHARS} characters`);
  const entry = { id: randomUUID(), ts: new Date().toISOString(), text: clean };
  fs.appendFileSync(roomUpdatesFile(name), JSON.stringify(entry) + '\n');
  return entry;
}

function readFrictionComplaints() {
  const notesPath = path.join(ROOMS_HOME_DIR, 'friction', 'notes.md');
  try {
    return parseFrictionNotes(fs.readFileSync(notesPath, 'utf8'));
  } catch {
    return [];
  }
}

function roomFrictionSummary(name, complaints) {
  const matching = complaints.filter(complaint => complaint.source === name);
  const newest = matching[matching.length - 1] || null;
  return {
    count: matching.length,
    latestAt: newest?.timestamp || null,
    latest: newest?.summary || null,
  };
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
  const frictionComplaints = readFrictionComplaints();

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
      updates: roomUpdatesSummary(name),
      friction: roomFrictionSummary(name, frictionComplaints),
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

app.get('/api/rooms/:name/friction', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const complaints = readFrictionComplaints()
      .filter(complaint => complaint.source === name)
      .reverse();
    res.json({ complaints, count: complaints.length });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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

app.post('/api/rooms/:name/rename', (req, res) => {
  try {
    const oldName = req.params.name;
    const newName = String(req.body?.name || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(newName)) {
      throw httpError(400, 'bad room name (lowercase, digits, dashes)');
    }
    if (!listRoomDirs().includes(oldName)) throw httpError(404, 'no such room');
    if (oldName === newName) return res.json({ ok: true, name: newName, cwd: path.join(ROOMS_HOME_DIR, newName) });
    if (fs.existsSync(path.join(ROOMS_HOME_DIR, newName))) throw httpError(409, 'room exists');

    const oldDir = path.join(ROOMS_HOME_DIR, oldName);
    const newDir = path.join(ROOMS_HOME_DIR, newName);
    if (!fs.lstatSync(oldDir).isDirectory()) throw httpError(409, 'symlinked rooms cannot be renamed in Feather');
    const room = buildRoomsSnapshot().find(candidate => candidate.name === oldName);
    fs.renameSync(oldDir, newDir);

    ROOM_ASSIGN_STATE.update(current => {
      const next = { ...current };
      for (const [sessionId, assignedRoom] of Object.entries(next)) {
        if (assignedRoom === oldName) next[sessionId] = newName;
      }
      for (const session of room?.sessions || []) next[session.id] = newName;
      return next;
    });
    ROOM_PULSES_STATE.update(current => {
      if (!(oldName in current)) return current;
      const next = { ...current, [newName]: current[oldName] };
      delete next[oldName];
      return next;
    });

    const meta = readMeta();
    let metaChanged = false;
    for (const session of room?.sessions || []) {
      if (session.cwd !== oldDir) continue;
      meta[session.id] = { ...(meta[session.id] || {}), cwd: newDir, cwdOverride: newDir };
      metaChanged = true;
    }
    if (metaChanged) writeMeta(meta);

    for (const [file, before, after] of [
      ['AGENTS.md', `# Room: #${oldName}`, `# Room: #${newName}`],
      ['notes.md', `# #${oldName} — notes`, `# #${newName} — notes`],
    ]) {
      const target = path.join(newDir, file);
      try {
        const contents = fs.readFileSync(target, 'utf8');
        if (contents.includes(before)) fs.writeFileSync(target, contents.replace(before, after));
      } catch {}
    }

    // A rename changes cwd metadata as well as room membership. Rebuild the
    // session index first so the room response returned after this mutation is
    // internally consistent instead of briefly serving the old cwd.
    sessionsSnapshotCache.refresh();
    roomSnapshotCache.refresh();
    res.json({ ok: true, name: newName, cwd: newDir });
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
    const previous = ROOM_PULSES_STATE.read()[name];
    ROOM_PULSES_STATE.update(current => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: req.body.enabled,
        status: req.body.enabled ? 'waiting' : 'paused',
        nextRunAtMs: req.body.enabled ? now + ROOM_PULSE_INTERVAL_MS : null,
        error: null,
      }),
    }));
    // Pausing means stop now, not merely "do not launch again". Persist the
    // disabled state first so the scheduler cannot race a replacement worker.
    if (!req.body.enabled && previous?.sessionId) {
      killTmuxSessions(previous.sessionId);
    }
    const pulse = roomPulse(name, now);
    roomSnapshotCache.update(rooms => rooms.map(room => room.name === name ? { ...room, pulse } : room));
    res.json({ ok: true, pulse });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.get('/api/rooms/:name/updates', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    res.json({ updates: readRoomUpdates(name) });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/rooms/:name/updates', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const entry = appendRoomUpdate(name, req.body?.text);
    roomSnapshotCache.update(rooms => rooms.map(room =>
      room.name === name ? { ...room, updates: roomUpdatesSummary(name) } : room));
    res.json({ ok: true, update: entry });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

const ROOM_PULSE_PROMPT = `Keep working on this room. Read AGENTS.md, notes.md, and the recent chats in this room. Then do the next useful thing fully autonomously. Do not ask the user to choose routine steps. Use tools and agents if useful. Append what you did and any open thread to notes.md. If you did something a person walking in cold would care about, also post a human-facing briefing: room update "<what happened and why it matters>". Write that update for a busy, sharp executive who has not seen this room in a day — plain language, lead with the outcome and why they should care, a few sentences over terseness; notes.md stays your terse working memory. If you hit a recurring annoyance, run: room complain "describe it plainly". If this room genuinely has no useful next action, run: room pause. Then stop.`;

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
    meta[id] = { ...(meta[id] || {}), agent: 'omp', cwd, title: `Keep working: #${name}`, background: 'room-pulse' };
    writeMeta(meta);
    ROOM_ASSIGN_STATE.update(current => ({ ...current, [id]: name }));
    watchOmpSessionDir(sessionDir, id);
    const hasTranscript = !!findOmpJsonlPath(id);
    const ompId = hasTranscript ? getOmpSessionId(id) : null;
    if (hasTranscript && !ompId) throw new Error(`Cannot resume OMP session ${id}: exact OMP session id not found`);
    const resumeArg = ompId ? `--resume ${ompId}` : '';
    spawnTmuxOmp(tmuxName(id), `${resumeArg} -p --auto-approve @${promptFile} --session-dir ${sessionDir}`.trim(), cwd, { interactive: false });
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
if (!READ_ONLY_MODE) await reconcileProtocolRunOwners();

// Verify that a static directory is a coherent build: index.html points to a
// JS bundle that actually exists in assets. Returns the matched JS filename.
function validateStaticBuild(directory) {
  const indexHtml = path.join(directory, 'index.html');
  if (!fs.existsSync(indexHtml)) return { ok: false, reason: 'no index.html' };
  const html = fs.readFileSync(indexHtml, 'utf8');
  const match = html.match(/assets\/(index-[^.]+\.js)/);
  if (!match) return { ok: false, reason: 'no JS bundle in index.html' };
  const jsPath = path.join(directory, 'assets', match[1]);
  if (!fs.existsSync(jsPath)) return { ok: false, reason: `missing asset ${match[1]}` };
  return { ok: true, js: match[1] };
}

function validateStaging() { return validateStaticBuild(STAGING_DIR); }

app.get('/api/version', (_req, res) => {
  try {
    const staged = validateStaging();
    const active = validateStaticBuild(STATIC_DIR);
    const changelog = path.join(import.meta.dirname, 'CHANGELOG.md');
    const changes = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '';
    // Immutable releases normally have no static-staging directory. Advertise
    // the active asset in that case so an older open tab can detect a newly
    // deployed release and offer a deliberate reload.
    res.json({
      stagingJs: staged.ok ? staged.js : (active.ok ? active.js : null),
      activeJs: active.ok ? active.js : null,
      changes: staged.ok ? changes : '',
    });
  } catch { res.json({ stagingJs: null, changes: '' }); }
});

app.post('/api/update', (_req, res) => {
  try {
    // Under an immutable release deployment, the update has already happened
    // server-side. The old client only needs permission to reload itself.
    if (!fs.existsSync(STAGING_DIR)) return res.json({ ok: true, reload: true });
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
          isActive: activeTmuxHas(active, sessionId),
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
    const query = String(req.query.q || '').trim();
    const queryLc = query.toLowerCase();
    let sessions;
    if (project) {
      sessions = discoverSessions(limit, project);
      if (queryLc) sessions = sessions.filter(session =>
        session.id.toLowerCase().includes(queryLc) || session.title.toLowerCase().includes(queryLc));
    } else if (queryLc) {
      const cachedMatches = [...sessionsSnapshotCache.get()].filter(session =>
        session.id.toLowerCase().includes(queryLc) || session.title.toLowerCase().includes(queryLc));
      // A deep-linked historical chat can fall outside the 300-item snapshot.
      // Resolve an exact id through the catalog's required-id path without
      // turning every activity refresh into an unbounded transcript parse.
      const exact = cachedMatches.some(session => session.id === query)
        ? []
        : discoverSessions(0, null, [query]);
      const byId = new Map([...exact, ...cachedMatches].map(session => [session.id, session]));
      sessions = [...byId.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit);
    } else {
      sessions = [...sessionsSnapshotCache.get()]
          .sort((a, b) => (b[SESSION_SOURCE_MTIME] || 0) - (a[SESSION_SOURCE_MTIME] || 0))
          .slice(0, limit)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
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
        const { lines } = capturePaneLines(existingTmuxName(session.id));
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
        const { lines } = capturePaneLines(existingTmuxName(session.id));
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

app.get('/api/sessions/:id/protocol-runs', (req, res) => {
  try {
    const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    res.json({ runs: protocolRuns.list(req.params.id, requestedLimit) });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
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
    closeSseClient(clients, oldest);
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  clients.add(res);
  writeSse(clients, res, 'event: connected\ndata: {}\n\n');

  // Send current activity immediately on connect
  const curActivity = lastActivity.get(sid) ?? extractActivity(existingTmuxName(sid));
  if (curActivity) {
    writeSse(clients, res, `event: activity\ndata: ${JSON.stringify({ activity: curActivity })}\n\n`);
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
            if (parsed) writeSse(clients, res, `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`);
          }
        }
      } catch {}
    }
  }

  replayOmpBridgeEvents(sid, clients, res);
  replayProtocolRuns(sid, clients, res);
  const hb = setInterval(() => {
    if (!writeSse(clients, res, 'event: heartbeat\ndata: {}\n\n')) clearInterval(hb);
  }, 15000);
  res.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
    ssePendingWrites.delete(res);
  });
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

const TERMINAL_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Space', 'Tab']);

function validatedTerminalKeys(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(key => TERMINAL_KEYS.has(key))
    ? value
    : null;
}

app.post('/api/sessions/:id/keys', (req, res) => {
  const keys = validatedTerminalKeys(req.body?.keys);
  if (!keys) return res.status(400).json({ error: 'invalid terminal keys' });
  try {
    execFileSync('tmux', ['send-keys', '-t', existingTmuxName(req.params.id), ...keys], { stdio: 'ignore' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:id/resume', async (req, res) => {
  try {
    if (!tmuxIsActive(req.params.id)) {
      const agent = getAgentForSession(req.params.id);
      spawnOrResume(req.params.id, req.body?.cwd, true, agent);
      try { await waitForAgentReady(tmuxName(req.params.id), agent); } catch {}
      sessionsSnapshotCache.invalidate();
      roomSnapshotCache.invalidate();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try {
    execFileSync('tmux', ['send-keys', '-t', existingTmuxName(req.params.id), 'C-c'], { stdio: 'ignore' });
    sessionsSnapshotCache.invalidate();
    roomSnapshotCache.invalidate();
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/answer', (req, res) => {
  try {
    const name = existingTmuxName(req.params.id);
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

app.post('/api/sessions/:id/delete', async (req, res) => {
  try {
    const id = req.params.id;
    await protocolRuns.deleteSession(id);
    killTmuxSessions(id);
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
    ompBridgeTokens.delete(id);
    try { fs.unlinkSync(ompBridgeTokenPath(id)); } catch {}
    resetOmpBridgeSessionState(id);
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
    if (getAgentForSession(id) === 'omp') {
      // OMP has no --fork-session; resume its conversation in a second tmux.
      // spawnTmuxOmp centrally applies the configured model/thinking defaults.
      const sessionDir = path.join(OMP_SESSIONS, id);
      const ompId = getOmpSessionId(id);
      if (!ompId) throw new Error(`Cannot fork OMP session ${id}: exact OMP session id not found`);
      spawnTmuxOmp(forkName, `--resume ${ompId} --session-dir ${sessionDir}`, cwd);
    } else {
      spawnTmuxClaude(forkName, `--resume ${id} --fork-session`, cwd);
    }
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
    killTmuxSessions(member.sessionId);
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
    agent = DEFAULT_AGENT,
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
    const { role = 'peer', agent = group.agent || DEFAULT_AGENT, task = '' } = req.body || {};
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
    killTmuxSessions(member.sessionId);
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
      killTmuxSessions(member.sessionId);
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
      if (!activeTmuxHas(active, id)) continue;
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'codex', mtime.getTime()),
        activeTmuxCreatedAt(active, id),
      );
      if (now - activity > IDLE_MS) {
        const name = existingTmuxName(id);
        killTmuxSessions(id);
        console.log(`[reaper] killed idle Codex session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
      }
    }
  } catch {}

  // Reap omp sessions.
  try {
    for (const id of fs.readdirSync(OMP_SESSIONS)) {
      if (!activeTmuxHas(active, id)) continue;
      const dirPath = path.join(OMP_SESSIONS, id);
      const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.jsonl')).sort().reverse();
      if (!files.length) continue;
      const fpath = path.join(dirPath, files[0]);
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'omp', fs.statSync(fpath).mtimeMs),
        activeTmuxCreatedAt(active, id),
      );
      if (now - activity > IDLE_MS) {
        const name = existingTmuxName(id);
        killTmuxSessions(id);
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
        if (!activeTmuxHas(active, id)) continue;
        const fpath = path.join(dirPath, file);
        const activity = latestSessionActivityMs(
          lastActivityMs(fpath, 'claude', fs.statSync(fpath).mtimeMs),
          activeTmuxCreatedAt(active, id),
        );
        if (now - activity > IDLE_MS) {
          const name = existingTmuxName(id);
          killTmuxSessions(id);
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
  // Use a root-relative send so checkouts under a hidden worktree directory
  // (for example .claude/worktrees) do not trip send's dotfile rejection.
  if (fs.existsSync(index)) res.sendFile('index.html', { root: STATIC_DIR });
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
  const terminalDimension = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const terminalCols = terminalDimension(url.searchParams.get('cols'), 120, 20, 500);
  const terminalRows = terminalDimension(url.searchParams.get('rows'), 30, 5, 200);

  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX; delete cleanEnv.TMUX_PANE;
  cleanEnv.TERM = 'xterm-256color';

  let term = null;
  let closed = false;
  const pendingMessages = [];
  let terminalSessionName = null;
  let hyperlinkProbe = '';
  let hyperlinkScanTimer = null;
  let lastHyperlinkPayload = '';
  const sendTerminalHyperlinks = () => {
    if (!terminalSessionName || ws.readyState !== WS.OPEN) return;
    const links = terminalHyperlinkTargets(terminalSessionName);
    const payload = JSON.stringify(links);
    if (!links.length || payload === lastHyperlinkPayload) return;
    lastHyperlinkPayload = payload;
    ws.send(JSON.stringify({ type: 'terminal-links', links }));
  };
  const handleTerminalMessage = (str) => {
    if (!term) {
      pendingMessages.push(str);
      if (pendingMessages.length > 100) pendingMessages.shift();
      return;
    }
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize') { term.resize(parsed.cols, parsed.rows); return; }
    } catch {}
    term.write(str);
  };

  ws.on('message', (msg) => handleTerminalMessage(msg.toString()));

  ws.on('close', () => {
    closed = true;
    if (hyperlinkScanTimer) clearTimeout(hyperlinkScanTimer);
    try { term?.kill(); } catch {}
  });

  const startTerminal = async () => {
    if (isShell) {
      term = pty.spawn('bash', ['-l'], {
        name: 'xterm-256color', cols: terminalCols, rows: terminalRows, env: cleanEnv, cwd: HOME,
      });
    } else {
      const sessionId = url.searchParams.get('session');
      if (!sessionId) { ws.close(1008, 'session required'); return; }
      if (!tmuxIsActive(sessionId)) { ws.close(1000, 'Session not active'); return; }
      terminalSessionName = existingTmuxName(sessionId);
      sendTerminalHyperlinks();
      // A new viewport makes OMP repaint its transcript on SIGWINCH. Let tmux
      // absorb that detached repaint, then attach only after it has settled so
      // the browser receives the current screen rather than the whole replay.
      try { await prepareTmuxTerminal(terminalSessionName, terminalCols, terminalRows); } catch {}
      if (closed || ws.readyState !== WS.OPEN) return;
      term = pty.spawn('tmux', ['attach', '-t', terminalSessionName], {
        name: 'xterm-256color', cols: terminalCols, rows: terminalRows, env: cleanEnv,
      });
    }

    term.onData(data => {
      try { ws.send(data); } catch {}
      if (!terminalSessionName) return;
      hyperlinkProbe = (hyperlinkProbe + data).slice(-2048);
      if (!/https?:\/\//i.test(hyperlinkProbe)) return;
      hyperlinkProbe = '';
      if (hyperlinkScanTimer) clearTimeout(hyperlinkScanTimer);
      // tmux redraws visible URL prefixes without forwarding their OSC 8 target.
      // By the time the redraw reaches us, capture-pane has retained that target.
      hyperlinkScanTimer = setTimeout(() => {
        hyperlinkScanTimer = null;
        sendTerminalHyperlinks();
      }, 100);
    });
    term.onExit(() => { try { ws.close(); } catch {} });
    for (const message of pendingMessages.splice(0)) handleTerminalMessage(message);
  };

  startTerminal().catch(() => {
    try { ws.close(1011, 'Terminal failed to start'); } catch {}
  });
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
