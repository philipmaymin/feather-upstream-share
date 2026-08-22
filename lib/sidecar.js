// Sidecar: paired/grouped agent threads with a file-based chat channel.
// See docs/plans/2026-06-27-001 (v1) and -002 (multi-peer).
//
// State only — the group registry (sidecars.json) and per-group chat.jsonl.
// Spawning sessions, tmux injection, and SSE live in server-single.js. A "group" is a
// grouping + chat channel over ordinary Feather sessions; members are addressed
// by role NAME (so N peers is the same shape as one).
//
// Concurrency note: every registry mutation uses the synchronous JSON state
// updater, so handlers cannot interleave and reentrant writes fail explicitly.
// Deployment still permits only one Feather writer process for this state.

import fs from 'fs';
import path from 'path';
import { resolveStatePaths } from './state-paths.js';
import { createJsonState, isJsonRecord } from './json-state.js';

const HOME = process.env.HOME || '/home/user';
// Sidecar threads coordinate agent harnesses and intentionally remain scoped
// to the user's Feather home even when FEATHER_STATE_DIR moves instance state.
const SIDECAR_DIR = resolveStatePaths({ homeDir: HOME }).coordination.sidecarsDir;
const GROUPS_FILE = path.join(SIDECAR_DIR, 'groups.json');
const GROUPS_STATE = createJsonState({
  file: GROUPS_FILE,
  root: SIDECAR_DIR,
  document: 'Sidecar groups',
  defaultValue: {},
  validate: isJsonRecord,
});

// Existing malformed coordination state is a startup error, not an empty store.
GROUPS_STATE.read();

// Roles are addresses and CLI args — keep them unique and shell-safe.
const ROLE_RE = /^[A-Za-z0-9._-]+$/;
// Reserved address keyword for broadcast.
export const ALL = 'all';

function ensureDir() { try { fs.mkdirSync(SIDECAR_DIR, { recursive: true }); } catch {} }
function groupDir(id) { return path.join(SIDECAR_DIR, id); }
function chatPath(id) { return path.join(groupDir(id), 'chat.jsonl'); }

function assertRole(role, existingRoles) {
  if (!role || !ROLE_RE.test(role)) {
    throw new Error(`invalid role ${JSON.stringify(role)} — use letters, digits, dot, dash, underscore (no spaces)`);
  }
  if (role === ALL) throw new Error(`role "${ALL}" is reserved for broadcast`);
  if (existingRoles && existingRoles.includes(role)) throw new Error(`duplicate role: ${role}`);
}

export function readGroups() {
  return GROUPS_STATE.read();
}

export function listGroups() {
  return Object.values(readGroups()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getGroup(id) {
  return readGroups()[id] || null;
}

// members: [{ sessionId, role, spawned }]
export function createGroup({ id, members, agent, task }) {
  const roles = [];
  for (const m of members) { assertRole(m.role, roles); roles.push(m.role); }
  ensureDir();
  fs.mkdirSync(groupDir(id), { recursive: true });
  const group = {
    id, members,
    agent: agent || 'claude',
    task: task || '',
    status: 'active',
    seq: 0,
    createdAt: Date.now(),
  };
  GROUPS_STATE.update((groups) => ({ ...groups, [id]: group }));
  try { fs.closeSync(fs.openSync(chatPath(id), 'a')); } catch {}
  return group;
}

export function addMember(id, member) {
  let result;
  GROUPS_STATE.update((groups) => {
    const g = groups[id];
    if (!g) throw new Error('no such group');
    assertRole(member.role, g.members.map(m => m.role));
    result = { ...g, members: [...g.members, member] };
    return { ...groups, [id]: result };
  });
  return result;
}

export function removeMember(id, role) {
  let removed = null;
  GROUPS_STATE.update((groups) => {
    const g = groups[id];
    if (!g) return groups;
    removed = g.members.find(m => m.role === role) || null;
    const next = { ...g, members: g.members.filter(m => m.role !== role) };
    return { ...groups, [id]: next };
  });
  return removed;
}

export function teardownGroup(id) {
  GROUPS_STATE.update((groups) => groups[id]
    ? { ...groups, [id]: { ...groups[id], status: 'done' } }
    : groups);
}

// ── Addressing ───────────────────────────────────────────────────────────────

// Resolve a `to` (a single role, a comma-list, or ALL) to recipient members,
// excluding the sender for ALL. Returns { targets, missing } so callers can
// 400 on an unknown role rather than silently dropping it.
export function resolveRecipients(group, to, senderRole) {
  if (to === ALL) {
    return { targets: group.members.filter(m => m.role !== senderRole), missing: [] };
  }
  const roles = String(to).split(',').map(s => s.trim()).filter(Boolean);
  const targets = [];
  const missing = [];
  for (const r of roles) {
    if (r === senderRole) continue; // never self-inject (livelock guard, mirrors `all`)
    const m = group.members.find(x => x.role === r);
    if (m) targets.push(m); else missing.push(r);
  }
  return { targets, missing };
}

// Back-compat single-role resolution.
export function resolveRecipient(group, role) {
  const m = group.members.find(m => m.role === role);
  return m ? m.sessionId : null;
}

// Most-recent active group containing the sender (v1 behavior; ambiguous when
// the sender is in several groups).
export function groupForSessionPrefix(prefix) {
  return listGroups().find(g =>
    g.status === 'active' && g.members.some(m => m.sessionId.slice(0, 8) === prefix)) || null;
}

// Smarter resolution (v2): among active groups containing the sender, if a
// single target role is given, prefer the group that also contains that role.
// Returns null when still ambiguous (caller should require an explicit group).
export function groupForSenderAndRole(prefix, to) {
  const candidates = listGroups().filter(g =>
    g.status === 'active' && g.members.some(m => m.sessionId.slice(0, 8) === prefix));
  if (candidates.length <= 1) return candidates[0] || null;
  if (to && to !== ALL) {
    const firstRole = String(to).split(',')[0].trim();
    const withRole = candidates.filter(g => g.members.some(m => m.role === firstRole));
    if (withRole.length === 1) return withRole[0];
  }
  return null; // ambiguous
}

export function roleForPrefix(group, prefix) {
  const m = group.members.find(m => m.sessionId.slice(0, 8) === prefix);
  return m ? m.role : null;
}

// ── Chat thread ─────────────────────────────────────────────────────────────

// Append a message with a monotonic per-group seq (ms-tie-proof ordering for
// fan-in). seq is drawn synchronously under the same read-modify-write as the
// registry, so concurrent appends can't collide on a value.
export function appendMessage(id, msg) {
  ensureDir();
  fs.mkdirSync(groupDir(id), { recursive: true });
  let seq;
  GROUPS_STATE.update((groups) => {
    const group = groups[id];
    if (!group) return groups;
    seq = (group.seq || 0) + 1;
    return { ...groups, [id]: { ...group, seq } };
  });
  if (seq === undefined) {
    // Group gone (torn down/unknown): keep seq monotonic by deriving it from the
    // existing thread instead of resetting to 1.
    seq = readThread(id).reduce((mx, m) => Math.max(mx, m.seq || 0), 0) + 1;
  }
  const record = { ts: Date.now(), seq, ...msg };
  fs.appendFileSync(chatPath(id), JSON.stringify(record) + '\n');
  return record;
}

export function readThread(id) {
  try {
    return fs.readFileSync(chatPath(id), 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Message templates ───────────────────────────────────────────────────────

// Roster-aware priming: tell a member who else is in the group and how to
// address one peer, or everyone (when there are 2+ others).
export function priming({ selfRole, roster, task }) {
  const others = (roster || []).filter(r => r !== selfRole);
  return [
    `You are a Feather **sidecar** agent. Your role: "${selfRole}". Other members: ${others.length ? others.join(', ') : '(none yet)'}.`,
    `Message one peer:   sidecar post --to <role> "..."`,
    others.length > 1 ? `Message everyone:   sidecar post --to all "..."   (goes to all members except you)` : null,
    `Read the thread:    sidecar read`,
    task ? `\nYour task:\n${task}` : `\nWait for a message, then collaborate.`,
  ].filter(Boolean).join('\n');
}

export function formatInbound(fromRole, text) {
  return `[sidecar message from ${fromRole}]\n${text}`;
}
