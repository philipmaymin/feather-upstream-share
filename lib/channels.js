import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { DatabaseSync } from 'node:sqlite'

const CHANNEL_SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/
const USERNAME_RE = /^[a-z][a-z0-9_-]{0,47}$/
const THREAD_STATES = new Set(['open', 'working', 'needs_you', 'resolved'])
const MESSAGE_TYPES = new Set(['human', 'agent', 'system', 'progress'])
const MAX_MESSAGE_BYTES = 48 * 1024
const MAX_AGENT_DEPTH = 4
const MAX_AGENT_FANOUT = 3
const MAX_AGENT_MESSAGES_PER_THREAD = 12

function nowIso() {
  return new Date().toISOString()
}

function normalizedUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!USERNAME_RE.test(username)) throw new Error('invalid principal username')
  return username
}

function boundedText(value, label, maxBytes = MAX_MESSAGE_BYTES) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${label} is required`)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} is too large`)
  return text
}

function threadTitle(text) {
  const first = text.replace(/\s+/g, ' ').trim()
  return first.length <= 72 ? first : `${first.slice(0, 69).trimEnd()}…`
}

function mentionedUsernames(text) {
  const names = new Set()
  for (const match of String(text || '').matchAll(/(?:^|\s)@([a-z][a-z0-9_-]{0,47})\b/gi)) {
    names.add(match[1].toLowerCase())
  }
  return [...names]
}

function agentNeedsHuman(text) {
  return /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?NEEDS YOU(?:\*\*|__)?\s*:/i.test(String(text || ''))
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: Number(row.seq),
    threadRootId: row.thread_root_id,
    replyToId: row.reply_to_id,
    messageType: row.message_type,
    content: row.content || '',
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    author: {
      id: row.author_id,
      kind: row.author_kind,
      username: row.author_username,
      displayName: row.author_display_name,
      avatarSeed: row.author_avatar_seed,
    },
    metadata: parseJson(row.metadata_json, {}),
  }
}

function mapPrincipal(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    displayName: row.display_name,
    avatarSeed: row.avatar_seed,
    agentBackend: row.agent_backend || null,
    sessionId: row.session_id || null,
    createdAt: row.created_at,
  }
}

function publicPrincipal(row) {
  const principal = mapPrincipal(row)
  if (!principal) return null
  const { sessionId: _sessionId, ...visible } = principal
  return visible
}

export class ChannelStore {
  constructor({ file, readOnly = false } = {}) {
    if (!file || !path.isAbsolute(file)) throw new Error('channel database path must be absolute')
    this.file = file
    this.readOnly = readOnly
    this.db = null
    if (readOnly && !fs.existsSync(file)) return
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file, { readOnly })
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.#migrate()
      fs.chmodSync(file, 0o600)
    }
  }

  close() {
    this.db?.close()
    this.db = null
  }

  #requireDb() {
    if (!this.db) throw new Error('channel store is unavailable')
    return this.db
  }

  #requireWritable() {
    if (this.readOnly) throw new Error('channel store is read-only')
    return this.#requireDb()
  }

  #migrate() {
    const db = this.#requireWritable()
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_schema (
        version INTEGER NOT NULL
      );
      INSERT INTO channel_schema(version)
        SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM channel_schema);

      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('human','agent','service')),
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_seed TEXT NOT NULL,
        agent_backend TEXT,
        session_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        channel_type TEXT NOT NULL CHECK(channel_type IN ('channel','dm')),
        created_by TEXT NOT NULL REFERENCES principals(id),
        default_agent_id TEXT REFERENCES principals(id),
        dm_key TEXT UNIQUE,
        next_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memberships (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        principal_id TEXT NOT NULL REFERENCES principals(id),
        role TEXT NOT NULL CHECK(role IN ('owner','member','agent')),
        notification_level TEXT NOT NULL DEFAULT 'mentions' CHECK(notification_level IN ('all','mentions','mute')),
        joined_seq INTEGER NOT NULL,
        left_seq INTEGER,
        PRIMARY KEY(channel_id, principal_id)
      );

      CREATE TABLE IF NOT EXISTS payloads (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        redacted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_attachments (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        uploader_id TEXT NOT NULL REFERENCES principals(id),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, storage_name)
      );

      CREATE TABLE IF NOT EXISTS events (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        actor_principal_id TEXT REFERENCES principals(id),
        correlation_id TEXT,
        causation_id TEXT,
        idempotency_key TEXT,
        payload_id TEXT REFERENCES payloads(id),
        public_json TEXT NOT NULL DEFAULT '{}',
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, seq),
        UNIQUE(channel_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        thread_root_id TEXT NOT NULL,
        reply_to_id TEXT,
        author_id TEXT NOT NULL REFERENCES principals(id),
        message_type TEXT NOT NULL CHECK(message_type IN ('human','agent','system','progress')),
        payload_id TEXT NOT NULL REFERENCES payloads(id),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        edited_at TEXT,
        UNIQUE(channel_id, seq)
      );

      CREATE TABLE IF NOT EXISTS threads (
        root_message_id TEXT PRIMARY KEY REFERENCES messages(id),
        channel_id TEXT NOT NULL REFERENCES channels(id),
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','working','needs_you','resolved')),
        auto_agent_id TEXT REFERENCES principals(id),
        reply_count INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_reads (
        principal_id TEXT NOT NULL REFERENCES principals(id),
        root_message_id TEXT NOT NULL REFERENCES threads(root_message_id),
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        following INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        snoozed_until TEXT,
        PRIMARY KEY(principal_id, root_message_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL REFERENCES principals(id),
        channel_id TEXT NOT NULL REFERENCES channels(id),
        thread_root_id TEXT REFERENCES threads(root_message_id),
        message_id TEXT REFERENCES messages(id),
        actor_id TEXT REFERENCES principals(id),
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        done_at TEXT,
        UNIQUE(recipient_id, message_id, kind)
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        thread_root_id TEXT NOT NULL REFERENCES threads(root_message_id),
        trigger_message_id TEXT NOT NULL REFERENCES messages(id),
        agent_principal_id TEXT NOT NULL REFERENCES principals(id),
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','done','error','killed')),
        depth INTEGER NOT NULL DEFAULT 0,
        final_message_id TEXT REFERENCES messages(id),
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        thread_root_id TEXT NOT NULL REFERENCES threads(root_message_id),
        trigger_message_id TEXT NOT NULL REFERENCES messages(id),
        recipient_principal_id TEXT NOT NULL REFERENCES principals(id),
        depth INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending','processing','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        execution_id TEXT REFERENCES executions(id),
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS messages_channel_root ON messages(channel_id, thread_root_id, seq);
      CREATE INDEX IF NOT EXISTS threads_channel_updated ON threads(channel_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS notifications_recipient_open ON notifications(recipient_id, done_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS outbox_pending ON channel_outbox(state, available_at, created_at);
      CREATE INDEX IF NOT EXISTS executions_session_state ON executions(session_id, state);
    `)
    const version = db.prepare('SELECT version FROM channel_schema LIMIT 1').get()?.version
    if (version !== 1) throw new Error(`unsupported channel schema version ${version}`)
  }

  #transaction(work) {
    const db = this.#requireWritable()
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = work(db)
      db.exec('COMMIT')
      return value
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  #principal(id) {
    return mapPrincipal(this.#requireDb().prepare('SELECT * FROM principals WHERE id = ?').get(id))
  }

  #membership(channelId, principalId) {
    return this.#requireDb().prepare(`
      SELECT * FROM memberships
      WHERE channel_id = ? AND principal_id = ? AND left_seq IS NULL
    `).get(channelId, principalId) || null
  }

  #requireMembership(channelId, principalId) {
    const membership = this.#membership(channelId, principalId)
    if (!membership) throw new Error('principal is not an active channel member')
    return membership
  }

  #nextSeq(db, channelId) {
    const row = db.prepare('UPDATE channels SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq').get(channelId)
    if (!row) throw new Error('no such channel')
    return Number(row.next_seq)
  }

  #payload(db, content) {
    const id = randomUUID()
    const hash = createHash('sha256').update(content).digest('hex')
    db.prepare('INSERT INTO payloads(id, content_hash, content, created_at) VALUES (?, ?, ?, ?)')
      .run(id, hash, content, nowIso())
    return { id, hash }
  }

  #appendEvent(db, { channelId, type, actorId = null, idempotencyKey = null, payloadId = null, publicData = {}, correlationId = null, causationId = null }) {
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM events WHERE channel_id = ? AND idempotency_key = ?').get(channelId, idempotencyKey)
      if (existing) return { existing: true, event: existing }
    }
    const seq = this.#nextSeq(db, channelId)
    const event = {
      channel_id: channelId,
      seq,
      event_id: randomUUID(),
      type,
      actor_principal_id: actorId,
      correlation_id: correlationId,
      causation_id: causationId,
      idempotency_key: idempotencyKey,
      payload_id: payloadId,
      public_json: JSON.stringify(publicData),
      accepted_at: nowIso(),
    }
    db.prepare(`
      INSERT INTO events(channel_id, seq, event_id, type, actor_principal_id, correlation_id, causation_id,
        idempotency_key, payload_id, public_json, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.channel_id, event.seq, event.event_id, event.type, event.actor_principal_id,
      event.correlation_id, event.causation_id, event.idempotency_key, event.payload_id,
      event.public_json, event.accepted_at)
    return { existing: false, event }
  }

  ensureHuman({ username, displayName }) {
    const clean = normalizedUsername(username)
    const name = boundedText(displayName || clean, 'display name', 512)
    const id = `human:${clean}`
    if (this.readOnly) return this.#principal(id)
    this.#requireWritable().prepare(`
      INSERT INTO principals(id, kind, username, display_name, avatar_seed, created_at)
      VALUES (?, 'human', ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name
    `).run(id, clean, name, clean, nowIso())
    return this.#principal(id)
  }

  createChannel({ slug, title, description = '', creatorId, idempotencyKey }) {
    const cleanSlug = normalizedUsername(slug)
    if (!CHANNEL_SLUG_RE.test(cleanSlug)) throw new Error('invalid channel slug')
    const cleanTitle = boundedText(title || cleanSlug, 'channel title', 512)
    const cleanDescription = String(description || '').trim().slice(0, 1000)
    return this.#transaction(db => {
      const existing = db.prepare('SELECT * FROM channels WHERE slug = ?').get(cleanSlug)
      if (existing) return this.getChannel(existing.id, creatorId)
      if (!this.#principal(creatorId)) throw new Error('creator principal does not exist')
      const id = randomUUID()
      db.prepare(`
        INSERT INTO channels(id, slug, title, description, channel_type, created_by, created_at)
        VALUES (?, ?, ?, ?, 'channel', ?, ?)
      `).run(id, cleanSlug, cleanTitle, cleanDescription, creatorId, nowIso())
      const appended = this.#appendEvent(db, {
        channelId: id,
        type: 'channel.created',
        actorId: creatorId,
        idempotencyKey,
        publicData: { slug: cleanSlug, title: cleanTitle },
      })
      db.prepare(`
        INSERT INTO memberships(channel_id, principal_id, role, notification_level, joined_seq)
        VALUES (?, ?, 'owner', 'all', ?)
      `).run(id, creatorId, appended.event.seq)
      return this.getChannel(id, creatorId)
    })
  }

  createDm({ creatorId, otherPrincipalId }) {
    if (creatorId === otherPrincipalId) throw new Error('cannot create a DM with yourself')
    const other = this.#principal(otherPrincipalId)
    if (!this.#principal(creatorId) || !other) throw new Error('DM principal does not exist')
    const dmKey = [creatorId, otherPrincipalId].sort().join('|')
    return this.#transaction(db => {
      const existing = db.prepare('SELECT id FROM channels WHERE dm_key = ?').get(dmKey)
      if (existing) return this.getChannel(existing.id, creatorId)
      const id = randomUUID()
      db.prepare(`
        INSERT INTO channels(id, slug, title, description, channel_type, created_by, dm_key, created_at)
        VALUES (?, NULL, 'Direct message', '', 'dm', ?, ?, ?)
      `).run(id, creatorId, dmKey, nowIso())
      const appended = this.#appendEvent(db, {
        channelId: id,
        type: 'dm.created',
        actorId: creatorId,
        idempotencyKey: `dm:${dmKey}`,
        publicData: {},
      })
      for (const principalId of [creatorId, otherPrincipalId]) {
        db.prepare(`
          INSERT INTO memberships(channel_id, principal_id, role, notification_level, joined_seq)
          VALUES (?, ?, 'member', 'all', ?)
        `).run(id, principalId, appended.event.seq)
      }
      if (other.kind === 'agent') db.prepare('UPDATE channels SET default_agent_id = ? WHERE id = ?').run(other.id, id)
      return this.getChannel(id, creatorId)
    })
  }

  addHumanMember({ channelId, actorId, username, displayName }) {
    const actor = this.#requireMembership(channelId, actorId)
    if (actor.role !== 'owner') throw new Error('only a channel owner can add members')
    const principal = this.ensureHuman({ username, displayName })
    return this.#addMembership({ channelId, actorId, principal, role: 'member', notificationLevel: 'mentions' })
  }

  addAgent({ channelId, actorId, username, displayName, sessionId, agentBackend = 'omp', makeDefault = false }) {
    const actor = this.#requireMembership(channelId, actorId)
    if (actor.role !== 'owner') throw new Error('only a channel owner can add agents')
    const clean = normalizedUsername(username)
    const name = boundedText(displayName || clean, 'display name', 512)
    const session = boundedText(sessionId, 'agent session id', 256)
    const principalId = `agent:${channelId}:${clean}`
    const db = this.#requireWritable()
    db.prepare(`
      INSERT OR IGNORE INTO principals(id, kind, username, display_name, avatar_seed, agent_backend, session_id, created_at)
      VALUES (?, 'agent', ?, ?, ?, ?, ?, ?)
    `).run(principalId, clean, name, clean, agentBackend, session, nowIso())
    const principal = this.#principal(principalId)
    if (!principal) throw new Error('agent username or session id is already assigned')
    const member = this.#addMembership({ channelId, actorId, principal, role: 'agent', notificationLevel: 'mentions' })
    if (makeDefault) this.setDefaultAgent({ channelId, actorId, agentId: principal.id })
    return { ...member, default: makeDefault }
  }

  setDefaultAgent({ channelId, actorId, agentId }) {
    const actor = this.#requireMembership(channelId, actorId)
    if (actor.role !== 'owner') throw new Error('only a channel owner can set the default agent')
    const agent = this.#requireMembership(channelId, agentId)
    if (agent.role !== 'agent') throw new Error('default channel agent must be an agent member')
    this.#transaction(db => {
      db.prepare('UPDATE channels SET default_agent_id = ? WHERE id = ?').run(agentId, channelId)
      db.prepare('UPDATE threads SET auto_agent_id = ? WHERE channel_id = ? AND auto_agent_id IS NULL').run(agentId, channelId)
    })
    return this.getChannel(channelId, actorId)
  }

  enqueueLatestUnansweredThread({ channelId, actorId }) {
    const actor = this.#requireMembership(channelId, actorId)
    if (actor.role !== 'owner') throw new Error('only a channel owner can start default agent work')
    return this.#transaction(db => {
      const channel = db.prepare('SELECT default_agent_id FROM channels WHERE id = ?').get(channelId)
      if (!channel?.default_agent_id) return false
      const latest = db.prepare(`
        SELECT message.id, message.thread_root_id
        FROM threads thread
        JOIN messages message ON message.id = (
          SELECT candidate.id FROM messages candidate
          WHERE candidate.thread_root_id = thread.root_message_id
          ORDER BY candidate.seq DESC LIMIT 1
        )
        JOIN principals author ON author.id = message.author_id
        WHERE thread.channel_id = ? AND author.kind = 'human'
        ORDER BY thread.updated_at DESC LIMIT 1
      `).get(channelId)
      if (!latest) return false
      return this.#enqueueDispatchDb(db, {
        channelId,
        rootId: latest.thread_root_id,
        messageId: latest.id,
        agentId: channel.default_agent_id,
        depth: 0,
      })
    })
  }

  #addMembership({ channelId, actorId, principal, role, notificationLevel }) {
    return this.#transaction(db => {
      const existing = db.prepare('SELECT * FROM memberships WHERE channel_id = ? AND principal_id = ?').get(channelId, principal.id)
      if (existing?.left_seq === null) return { principal, role: existing.role }
      const appended = this.#appendEvent(db, {
        channelId,
        type: 'membership.joined',
        actorId,
        idempotencyKey: `membership:${principal.id}:joined`,
        publicData: { principalId: principal.id, role },
      })
      db.prepare(`
        INSERT INTO memberships(channel_id, principal_id, role, notification_level, joined_seq, left_seq)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(channel_id, principal_id) DO UPDATE SET role = excluded.role,
          notification_level = excluded.notification_level, joined_seq = excluded.joined_seq, left_seq = NULL
      `).run(channelId, principal.id, role, notificationLevel, appended.event.seq)
      return { principal, role }
    })
  }

  getChannel(channelId, principalId) {
    const db = this.#requireDb()
    this.#requireMembership(channelId, principalId)
    const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId)
    if (!row) throw new Error('no such channel')
    const members = this.listMembers(channelId, principalId)
    const unread = db.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE recipient_id = ? AND channel_id = ? AND read_at IS NULL AND done_at IS NULL
    `).get(principalId, channelId)?.count || 0
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      type: row.channel_type,
      defaultAgentId: row.default_agent_id || null,
      createdAt: row.created_at,
      archivedAt: row.archived_at || null,
      unread: Number(unread),
      members,
    }
  }

  listChannels(principalId) {
    if (!this.db) return []
    const rows = this.db.prepare(`
      SELECT c.id FROM channels c
      JOIN memberships m ON m.channel_id = c.id
      WHERE m.principal_id = ? AND m.left_seq IS NULL AND c.archived_at IS NULL
      ORDER BY c.channel_type, c.title COLLATE NOCASE
    `).all(principalId)
    return rows.map(row => this.getChannel(row.id, principalId))
  }
  dataVersion() {
    if (!this.db) return 0
    return Number(this.db.prepare('PRAGMA data_version').get()?.data_version) || 0
  }

  listMembers(channelId, principalId) {
    this.#requireMembership(channelId, principalId)
    return this.#requireDb().prepare(`
      SELECT p.*, m.role, m.notification_level
      FROM memberships m JOIN principals p ON p.id = m.principal_id
      WHERE m.channel_id = ? AND m.left_seq IS NULL
      ORDER BY CASE p.kind WHEN 'human' THEN 0 ELSE 1 END, p.display_name COLLATE NOCASE
    `).all(channelId).map(row => ({ ...publicPrincipal(row), role: row.role, notificationLevel: row.notification_level }))
  }

  listPrincipals(requesterId) {
    const channelIds = this.listChannels(requesterId).map(channel => channel.id)
    if (!channelIds.length) return [publicPrincipal(this.#requireDb().prepare('SELECT * FROM principals WHERE id = ?').get(requesterId))].filter(Boolean)
    const placeholders = channelIds.map(() => '?').join(',')
    return this.#requireDb().prepare(`
      SELECT DISTINCT p.* FROM principals p
      JOIN memberships m ON m.principal_id = p.id
      WHERE m.left_seq IS NULL AND m.channel_id IN (${placeholders})
      ORDER BY CASE p.kind WHEN 'human' THEN 0 ELSE 1 END, p.display_name COLLATE NOCASE
    `).all(...channelIds).map(publicPrincipal)
  }

  registerAttachment({ id, channelId, uploaderId, filename, contentType, byteSize, contentHash, storageName }) {
    this.#requireMembership(channelId, uploaderId)
    const cleanFilename = boundedText(filename, 'attachment filename', 512)
    const cleanContentType = boundedText(contentType, 'attachment content type', 128)
    const cleanStorageName = boundedText(storageName, 'attachment storage name', 256)
    const size = Number(byteSize)
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('invalid attachment size')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      throw new Error('invalid attachment id')
    }
    if (!/^[0-9a-f]{64}$/.test(String(contentHash))) throw new Error('invalid attachment content hash')
    if (path.basename(cleanStorageName) !== cleanStorageName || !cleanStorageName.startsWith(`${id}.`)) {
      throw new Error('invalid attachment storage name')
    }
    return this.#transaction(db => {
      const existing = db.prepare('SELECT * FROM channel_attachments WHERE id = ?').get(id)
      if (existing) {
        if (existing.channel_id !== channelId || existing.uploader_id !== uploaderId
          || existing.content_hash !== contentHash || Number(existing.byte_size) !== size) {
          throw new Error('attachment id already exists with different content')
        }
        return this.getAttachment({ id, channelId, principalId: uploaderId })
      }
      const appended = this.#appendEvent(db, {
        channelId,
        type: 'attachment.created',
        actorId: uploaderId,
        idempotencyKey: `attachment:${id}`,
        publicData: { attachmentId: id, filename: cleanFilename, contentType: cleanContentType, byteSize: size, contentHash },
      })
      db.prepare(`
        INSERT INTO channel_attachments(id, channel_id, uploader_id, filename, content_type,
          byte_size, content_hash, storage_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, channelId, uploaderId, cleanFilename, cleanContentType, size, contentHash,
        cleanStorageName, appended.event.accepted_at)
      return this.getAttachment({ id, channelId, principalId: uploaderId })
    })
  }

  getAttachment({ id, channelId, principalId }) {
    this.#requireMembership(channelId, principalId)
    const row = this.#requireDb().prepare(`
      SELECT * FROM channel_attachments WHERE id = ? AND channel_id = ?
    `).get(id, channelId)
    if (!row) throw new Error('no such attachment')
    return {
      id: row.id,
      channelId: row.channel_id,
      uploaderId: row.uploader_id,
      filename: row.filename,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      contentHash: row.content_hash,
      storageName: row.storage_name,
      createdAt: row.created_at,
    }
  }

  attachmentUsage({ channelId, principalId }) {
    this.#requireMembership(channelId, principalId)
    return Number(this.#requireDb().prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM channel_attachments WHERE channel_id = ?
    `).get(channelId)?.bytes || 0)
  }

  postMessage({ channelId, authorId, content, threadRootId = null, replyToId = null,
    messageType, idempotencyKey, metadata = {}, depth = 0 }) {
    const cleanContent = boundedText(content, 'message')
    if (!MESSAGE_TYPES.has(messageType)) throw new Error('invalid message type')
    this.#requireMembership(channelId, authorId)
    return this.#transaction(db => {
      if (idempotencyKey) {
        const prior = db.prepare(`
          SELECT m.* FROM messages m JOIN events e ON e.event_id = m.event_id
          WHERE e.channel_id = ? AND e.idempotency_key = ?
        `).get(channelId, idempotencyKey)
        if (prior) return this.getMessage(prior.id, authorId)
      }
      const author = this.#principal(authorId)
      if (!author) throw new Error('message author does not exist')
      let rootId = threadRootId
      if (rootId) {
        const root = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND id = thread_root_id').get(rootId, channelId)
        if (!root) throw new Error('thread root does not exist')
      }
      if (replyToId) {
        const replied = db.prepare('SELECT thread_root_id FROM messages WHERE id = ? AND channel_id = ?').get(replyToId, channelId)
        if (!replied || (rootId && replied.thread_root_id !== rootId)) throw new Error('reply target is outside the thread')
        rootId ||= replied.thread_root_id
      }
      const messageId = randomUUID()
      rootId ||= messageId
      const payload = this.#payload(db, cleanContent)
      const appended = this.#appendEvent(db, {
        channelId,
        type: 'message.created',
        actorId: authorId,
        idempotencyKey,
        payloadId: payload.id,
        publicData: { messageId, threadRootId: rootId, messageType, contentHash: payload.hash },
        correlationId: rootId,
        causationId: replyToId,
      })
      db.prepare(`
        INSERT INTO messages(id, channel_id, seq, event_id, thread_root_id, reply_to_id, author_id,
          message_type, payload_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, channelId, appended.event.seq, appended.event.event_id, rootId, replyToId,
        authorId, messageType, payload.id, JSON.stringify({ ...metadata, depth }), appended.event.accepted_at)
      if (rootId === messageId) {
        const channel = db.prepare('SELECT default_agent_id FROM channels WHERE id = ?').get(channelId)
        db.prepare(`
          INSERT INTO threads(root_message_id, channel_id, title, state, auto_agent_id, last_seq, updated_at)
          VALUES (?, ?, ?, 'open', ?, ?, ?)
        `).run(rootId, channelId, threadTitle(cleanContent), channel?.default_agent_id || null,
          appended.event.seq, appended.event.accepted_at)
      } else {
        db.prepare(`
          UPDATE threads SET reply_count = reply_count + 1, last_seq = ?, updated_at = ?
          WHERE root_message_id = ?
        `).run(appended.event.seq, appended.event.accepted_at, rootId)
      }
      db.prepare(`
        INSERT INTO thread_reads(principal_id, root_message_id, last_read_seq, following)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(principal_id, root_message_id) DO UPDATE SET last_read_seq = excluded.last_read_seq,
          following = 1, done_at = NULL
      `).run(authorId, rootId, appended.event.seq)
      this.#createNotifications(db, {
        channelId,
        rootId,
        messageId,
        author,
        content: cleanContent,
        messageType,
        seq: appended.event.seq,
      })
      return this.getMessage(messageId, authorId)
    })
  }

  #createNotifications(db, { channelId, rootId, messageId, author, content, messageType, seq }) {
    if (messageType === 'progress') return
    const mentions = new Set(mentionedUsernames(content))
    const members = db.prepare(`
      SELECT p.*, m.notification_level FROM memberships m
      JOIN principals p ON p.id = m.principal_id
      WHERE m.channel_id = ? AND m.left_seq IS NULL AND p.id != ?
    `).all(channelId, author.id)
    const humanParticipants = new Set(db.prepare(`
      SELECT DISTINCT m.author_id FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.thread_root_id = ? AND p.kind = 'human'
    `).all(rootId).map(row => row.author_id))
    for (const member of members) {
      if (member.kind !== 'human' || member.notification_level === 'mute') continue
      const followed = db.prepare(`
        SELECT following, done_at, snoozed_until FROM thread_reads
        WHERE principal_id = ? AND root_message_id = ?
      `).get(member.id, rootId)
      const mentioned = mentions.has(member.username)
      const shouldNotify = mentioned
        || member.notification_level === 'all'
        || (messageType === 'agent' && (humanParticipants.has(member.id) || followed?.following))
      if (!shouldNotify) continue
      const kind = mentioned ? 'mention' : messageType === 'agent' ? 'agent_reply' : 'reply'
      const reason = mentioned ? `${author.displayName} mentioned you`
        : messageType === 'agent' ? `${author.displayName} replied as an agent`
          : `${author.displayName} replied in a followed thread`
      db.prepare(`
        INSERT OR IGNORE INTO notifications(id, recipient_id, channel_id, thread_root_id,
          message_id, actor_id, kind, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), member.id, channelId, rootId, messageId, author.id, kind, reason, nowIso())
    }
    let dispatchedAgents = 0
    for (const member of members) {
      if ((messageType === 'human' || messageType === 'agent')
        && member.kind === 'agent' && mentions.has(member.username) && dispatchedAgents < MAX_AGENT_FANOUT) {
        if (this.#enqueueDispatchDb(db, {
          channelId,
          rootId,
          messageId,
          agentId: member.id,
          depth: this.#messageDepth(db, messageId) + 1,
        })) dispatchedAgents += 1
      }
    }
    if (author.kind === 'human' && messageType === 'human') {
      const explicitAgents = members.filter(member => member.kind === 'agent' && mentions.has(member.username))
      if (!explicitAgents.length) {
        const thread = db.prepare('SELECT auto_agent_id FROM threads WHERE root_message_id = ?').get(rootId)
        if (thread?.auto_agent_id) this.#enqueueDispatchDb(db, { channelId, rootId, messageId, agentId: thread.auto_agent_id, depth: 0 })
      }
    }
    db.prepare(`
      UPDATE thread_reads SET done_at = NULL
      WHERE root_message_id = ? AND principal_id != ? AND last_read_seq < ?
    `).run(rootId, author.id, seq)
  }

  #messageDepth(db, messageId) {
    const row = db.prepare('SELECT metadata_json FROM messages WHERE id = ?').get(messageId)
    return Number(parseJson(row?.metadata_json, {}).depth || 0)
  }

  #enqueueDispatchDb(db, { channelId, rootId, messageId, agentId, depth }) {
    if (depth > MAX_AGENT_DEPTH) return false
    const trigger = db.prepare(`
      SELECT p.kind AS author_kind FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.id = ?
    `).get(messageId)
    if (trigger?.author_kind === 'agent') {
      const latestHumanSeq = Number(db.prepare(`
        SELECT COALESCE(MAX(m.seq), 0) AS seq FROM messages m JOIN principals p ON p.id = m.author_id
        WHERE m.thread_root_id = ? AND p.kind = 'human'
      `).get(rootId)?.seq || 0)
      const alreadyInvoked = db.prepare(`
        SELECT 1 FROM channel_outbox o JOIN messages trigger_message ON trigger_message.id = o.trigger_message_id
        WHERE o.thread_root_id = ? AND o.recipient_principal_id = ? AND trigger_message.seq >= ?
        LIMIT 1
      `).get(rootId, agentId, latestHumanSeq)
      if (alreadyInvoked) return false
    }
    const agentMessages = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM messages m JOIN principals p ON p.id = m.author_id
      WHERE m.thread_root_id = ? AND p.kind = 'agent' AND m.message_type = 'agent'
    `).get(rootId)?.count || 0)
    if (agentMessages >= MAX_AGENT_MESSAGES_PER_THREAD) return false
    const agent = mapPrincipal(db.prepare('SELECT * FROM principals WHERE id = ? AND kind = ?').get(agentId, 'agent'))
    if (!agent?.sessionId) return false
    const id = randomUUID()
    const result = db.prepare(`
      INSERT OR IGNORE INTO channel_outbox(id, dedupe_key, kind, channel_id, thread_root_id,
        trigger_message_id, recipient_principal_id, depth, state, available_at, created_at)
      VALUES (?, ?, 'dispatch_agent', ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, `dispatch:${messageId}:${agentId}`, channelId, rootId, messageId, agentId,
      depth, nowIso(), nowIso())
    return Number(result.changes) > 0
  }

  getMessage(messageId, principalId) {
    const db = this.#requireDb()
    const channel = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId)
    if (!channel) return null
    this.#requireMembership(channel.channel_id, principalId)
    return mapMessage(db.prepare(`
      SELECT m.*, p.kind AS author_kind, p.username AS author_username,
        p.display_name AS author_display_name, p.avatar_seed AS author_avatar_seed,
        y.content
      FROM messages m JOIN principals p ON p.id = m.author_id
      JOIN payloads y ON y.id = m.payload_id
      WHERE m.id = ?
    `).get(messageId))
  }

  listChannelRoots(channelId, principalId, limit = 100) {
    this.#requireMembership(channelId, principalId)
    const rows = this.#requireDb().prepare(`
      SELECT m.*, p.kind AS author_kind, p.username AS author_username,
        p.display_name AS author_display_name, p.avatar_seed AS author_avatar_seed,
        y.content, t.title AS thread_title, t.state AS thread_state, t.reply_count,
        t.updated_at AS thread_updated_at, t.last_seq AS thread_last_seq,
        COALESCE(r.last_read_seq, 0) AS last_read_seq,
        COALESCE(r.following, 0) AS following,
        r.done_at, r.snoozed_until
      FROM messages m JOIN principals p ON p.id = m.author_id
      JOIN payloads y ON y.id = m.payload_id
      JOIN threads t ON t.root_message_id = m.id
      LEFT JOIN thread_reads r ON r.root_message_id = t.root_message_id AND r.principal_id = ?
      WHERE m.channel_id = ? AND m.id = m.thread_root_id
      ORDER BY m.seq DESC LIMIT ?
    `).all(principalId, channelId, Math.max(1, Math.min(200, Number(limit) || 100)))
    return rows.reverse().map(row => ({
      ...mapMessage(row),
      thread: {
        title: row.thread_title,
        state: row.thread_state,
        replyCount: Number(row.reply_count),
        updatedAt: row.thread_updated_at,
        unread: Number(row.last_read_seq) < Number(row.thread_last_seq),
        following: !!row.following,
        doneAt: row.done_at || null,
        snoozedUntil: row.snoozed_until || null,
      },
      replies: this.#replyPreview(row.id, principalId),
    }))
  }

  #replyPreview(rootId, principalId) {
    const rows = this.#requireDb().prepare(`
      SELECT m.*, p.kind AS author_kind, p.username AS author_username,
        p.display_name AS author_display_name, p.avatar_seed AS author_avatar_seed, y.content
      FROM messages m JOIN principals p ON p.id = m.author_id
      JOIN payloads y ON y.id = m.payload_id
      WHERE m.thread_root_id = ? AND m.id != m.thread_root_id
      ORDER BY m.seq DESC LIMIT 3
    `).all(rootId)
    if (rows.length) this.#requireMembership(rows[0].channel_id, principalId)
    return rows.reverse().map(mapMessage)
  }

  getThread(rootId, principalId) {
    const db = this.#requireDb()
    const thread = db.prepare('SELECT * FROM threads WHERE root_message_id = ?').get(rootId)
    if (!thread) throw new Error('no such thread')
    this.#requireMembership(thread.channel_id, principalId)
    const messages = db.prepare(`
      SELECT m.*, p.kind AS author_kind, p.username AS author_username,
        p.display_name AS author_display_name, p.avatar_seed AS author_avatar_seed, y.content
      FROM messages m JOIN principals p ON p.id = m.author_id
      JOIN payloads y ON y.id = m.payload_id
      WHERE m.thread_root_id = ? ORDER BY m.seq
    `).all(rootId).map(mapMessage)
    const read = db.prepare('SELECT * FROM thread_reads WHERE principal_id = ? AND root_message_id = ?').get(principalId, rootId)
    const executions = db.prepare(`
      SELECT e.*, p.username AS agent_username, p.display_name AS agent_display_name
      FROM executions e JOIN principals p ON p.id = e.agent_principal_id
      WHERE e.thread_root_id = ? ORDER BY e.started_at
    `).all(rootId).map(row => ({
      id: row.id,
      state: row.state,
      agent: { id: row.agent_principal_id, username: row.agent_username, displayName: row.agent_display_name },
      triggerMessageId: row.trigger_message_id,
      finalMessageId: row.final_message_id || null,
      depth: Number(row.depth),
      startedAt: row.started_at,
      completedAt: row.completed_at || null,
      error: row.error || null,
    }))
    return {
      id: rootId,
      channelId: thread.channel_id,
      title: thread.title,
      state: thread.state,
      following: !!read?.following,
      doneAt: read?.done_at || null,
      snoozedUntil: read?.snoozed_until || null,
      messages,
      executions,
    }
  }

  updateThread({ rootId, actorId, title, state }) {
    const current = this.getThread(rootId, actorId)
    const cleanTitle = title === undefined ? current.title : boundedText(title, 'thread title', 512)
    const cleanState = state === undefined ? current.state : String(state)
    if (!THREAD_STATES.has(cleanState)) throw new Error('invalid thread state')
    return this.#transaction(db => {
      const payload = this.#payload(db, JSON.stringify({ title: cleanTitle, state: cleanState }))
      this.#appendEvent(db, {
        channelId: current.channelId,
        type: 'thread.updated',
        actorId,
        idempotencyKey: `thread:${rootId}:${cleanTitle}:${cleanState}`,
        payloadId: payload.id,
        publicData: { rootId, title: cleanTitle, state: cleanState },
        correlationId: rootId,
      })
      db.prepare('UPDATE threads SET title = ?, state = ?, updated_at = ? WHERE root_message_id = ?')
        .run(cleanTitle, cleanState, nowIso(), rootId)
      if (cleanState === 'needs_you') this.#notifyThreadHumans(db, rootId, actorId, 'needs_you', 'This thread needs your input')
      return this.getThread(rootId, actorId)
    })
  }

  #notifyThreadHumans(db, rootId, actorId, kind, reason, messageId = null) {
    const thread = db.prepare('SELECT channel_id FROM threads WHERE root_message_id = ?').get(rootId)
    const humans = db.prepare(`
      SELECT p.id FROM memberships m JOIN principals p ON p.id = m.principal_id
      WHERE m.channel_id = ? AND m.left_seq IS NULL AND m.notification_level != 'mute'
        AND p.kind = 'human' AND p.id != ?
        AND (
          EXISTS (SELECT 1 FROM messages message WHERE message.thread_root_id = ? AND message.author_id = p.id)
          OR EXISTS (SELECT 1 FROM thread_reads attention WHERE attention.root_message_id = ?
            AND attention.principal_id = p.id AND attention.following = 1)
        )
    `).all(thread.channel_id, actorId, rootId, rootId)
    for (const human of humans) {
      db.prepare(`
        INSERT OR IGNORE INTO notifications(id, recipient_id, channel_id, thread_root_id,
          message_id, actor_id, kind, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), human.id, thread.channel_id, rootId, messageId, actorId, kind, reason, nowIso())
    }
  }

  updateThreadAttention({ rootId, principalId, action, value = true, until = null }) {
    this.getThread(rootId, principalId)
    const db = this.#requireWritable()
    const previous = db.prepare(`
      SELECT * FROM thread_reads WHERE principal_id = ? AND root_message_id = ?
    `).get(principalId, rootId)
    db.prepare(`
      INSERT OR IGNORE INTO thread_reads(principal_id, root_message_id, last_read_seq, following)
      VALUES (?, ?, 0, 0)
    `).run(principalId, rootId)
    let changed = false
    if (action === 'read') {
      const lastSeq = db.prepare('SELECT last_seq FROM threads WHERE root_message_id = ?').get(rootId)?.last_seq || 0
      const unread = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM notifications
        WHERE recipient_id = ? AND thread_root_id = ? AND read_at IS NULL
      `).get(principalId, rootId)?.count || 0)
      changed = Number(previous?.last_read_seq || 0) !== Number(lastSeq) || unread > 0
      if (changed) {
        db.prepare('UPDATE thread_reads SET last_read_seq = ? WHERE principal_id = ? AND root_message_id = ?')
          .run(lastSeq, principalId, rootId)
        db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE recipient_id = ? AND thread_root_id = ?')
          .run(nowIso(), principalId, rootId)
      }
    } else if (action === 'follow') {
      changed = !!previous?.following !== !!value
      if (changed) db.prepare('UPDATE thread_reads SET following = ? WHERE principal_id = ? AND root_message_id = ?')
        .run(value ? 1 : 0, principalId, rootId)
    } else if (action === 'done') {
      changed = !!previous?.done_at !== !!value
      if (changed) {
        const doneAt = value ? nowIso() : null
        db.prepare('UPDATE thread_reads SET done_at = ? WHERE principal_id = ? AND root_message_id = ?')
          .run(doneAt, principalId, rootId)
        db.prepare('UPDATE notifications SET done_at = ? WHERE recipient_id = ? AND thread_root_id = ?')
          .run(doneAt, principalId, rootId)
      }
    } else if (action === 'snooze') {
      changed = (previous?.snoozed_until || null) !== until
      if (changed) db.prepare('UPDATE thread_reads SET snoozed_until = ? WHERE principal_id = ? AND root_message_id = ?')
        .run(until, principalId, rootId)
    } else {
      throw new Error('invalid thread attention action')
    }
    return { thread: this.getThread(rootId, principalId), changed }
  }

  listActivity(principalId, { includeDone = false, limit = 100 } = {}) {
    if (!this.db) return []
    const items = this.db.prepare(`
      SELECT n.*, c.slug AS channel_slug, c.title AS channel_title,
        t.title AS thread_title, t.state AS thread_state,
        p.kind AS actor_kind, p.username AS actor_username, p.display_name AS actor_display_name,
        y.content
      FROM notifications n JOIN channels c ON c.id = n.channel_id
      LEFT JOIN threads t ON t.root_message_id = n.thread_root_id
      LEFT JOIN principals p ON p.id = n.actor_id
      LEFT JOIN messages m ON m.id = n.message_id
      LEFT JOIN payloads y ON y.id = m.payload_id
      WHERE n.recipient_id = ? AND (? = 1 OR n.done_at IS NULL)
        AND (n.thread_root_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM thread_reads r WHERE r.principal_id = n.recipient_id
            AND r.root_message_id = n.thread_root_id
            AND r.snoozed_until IS NOT NULL AND r.snoozed_until > ?
        ))
      ORDER BY n.created_at DESC LIMIT ?
    `).all(principalId, includeDone ? 1 : 0, nowIso(), Math.max(1, Math.min(200, Number(limit) || 100)))
      .map(row => ({
        id: row.id,
        kind: row.kind,
        reason: row.reason,
        createdAt: row.created_at,
        readAt: row.read_at || null,
        doneAt: row.done_at || null,
        channel: { id: row.channel_id, slug: row.channel_slug, title: row.channel_title },
        thread: row.thread_root_id ? { id: row.thread_root_id, title: row.thread_title, state: row.thread_state } : null,
        messageId: row.message_id || null,
        preview: row.content || '',
        actor: row.actor_id ? { id: row.actor_id, kind: row.actor_kind, username: row.actor_username, displayName: row.actor_display_name } : null,
      }))
    const priority = { failure: 5, needs_you: 4, mention: 3, agent_reply: 2, reply: 1 }
    const grouped = new Map()
    const counts = new Map()
    for (const item of items) {
      const key = item.thread?.id || item.id
      counts.set(key, (counts.get(key) || 0) + 1)
      const current = grouped.get(key)
      if (!current || (priority[item.kind] || 0) > (priority[current.kind] || 0)) grouped.set(key, item)
    }
    return [...grouped.entries()].map(([key, item]) => ({ ...item, updates: counts.get(key) }))
  }

  notificationRecipientsForMessage(messageId) {
    if (!this.db) return []
    return this.db.prepare(`
      SELECT n.id, n.kind, n.reason, p.username, p.display_name,
        c.channel_type, c.slug, c.title AS channel_title, t.title AS thread_title
      FROM notifications n JOIN principals p ON p.id = n.recipient_id
      JOIN channels c ON c.id = n.channel_id
      LEFT JOIN threads t ON t.root_message_id = n.thread_root_id
      WHERE n.message_id = ?
    `).all(messageId).map(row => ({
      notificationId: row.id,
      kind: row.kind,
      reason: row.reason,
      username: row.username,
      displayName: row.display_name,
      channelType: row.channel_type,
      channelSlug: row.slug,
      channelTitle: row.channel_title,
      threadTitle: row.thread_title,
    }))
  }

  messageHasAgentHandoff(messageId) {
    if (!this.db) return false
    return !!this.db.prepare(`
      SELECT 1 FROM channel_outbox
      WHERE trigger_message_id = ? AND kind = 'dispatch_agent'
      LIMIT 1
    `).get(messageId)
  }

  notificationRecipientsForThread(rootId, kind) {
    if (!this.db) return []
    return this.db.prepare(`
      SELECT DISTINCT n.id, n.kind, n.reason, p.username, c.slug, c.title AS channel_title,
        t.title AS thread_title, n.channel_id
      FROM notifications n JOIN principals p ON p.id = n.recipient_id
      JOIN channels c ON c.id = n.channel_id
      JOIN threads t ON t.root_message_id = n.thread_root_id
      WHERE n.thread_root_id = ? AND n.kind = ?
      ORDER BY n.created_at DESC
    `).all(rootId, kind).map(row => ({
      notificationId: row.id,
      kind: row.kind,
      reason: row.reason,
      username: row.username,
      channelId: row.channel_id,
      channelSlug: row.slug,
      channelTitle: row.channel_title,
      threadTitle: row.thread_title,
    }))
  }

  claimDispatch() {
    if (!this.db || this.readOnly) return null
    return this.#transaction(db => {
      const item = db.prepare(`
        SELECT o.*, p.session_id, p.username AS agent_username, p.display_name AS agent_display_name
        FROM channel_outbox o JOIN principals p ON p.id = o.recipient_principal_id
        WHERE o.state = 'pending' AND o.available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM executions e
            WHERE e.agent_principal_id = o.recipient_principal_id AND e.state IN ('queued','running')
          )
        ORDER BY o.created_at LIMIT 1
      `).get(nowIso())
      if (!item) return null
      const executionId = randomUUID()
      db.prepare(`
        INSERT INTO executions(id, channel_id, thread_root_id, trigger_message_id,
          agent_principal_id, session_id, state, depth, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(executionId, item.channel_id, item.thread_root_id, item.trigger_message_id,
        item.recipient_principal_id, item.session_id, item.depth, nowIso())
      db.prepare(`
        UPDATE channel_outbox SET state = 'processing', attempts = attempts + 1, execution_id = ?
        WHERE id = ?
      `).run(executionId, item.id)
      db.prepare(`UPDATE threads SET state = 'working', updated_at = ? WHERE root_message_id = ?`)
        .run(nowIso(), item.thread_root_id)
      return {
        id: item.id,
        executionId,
        channelId: item.channel_id,
        threadRootId: item.thread_root_id,
        triggerMessageId: item.trigger_message_id,
        agent: {
          id: item.recipient_principal_id,
          username: item.agent_username,
          displayName: item.agent_display_name,
          sessionId: item.session_id,
        },
        depth: Number(item.depth),
        channel: this.getChannel(item.channel_id, item.recipient_principal_id),
        thread: this.getThread(item.thread_root_id, item.recipient_principal_id),
        members: this.listMembers(item.channel_id, item.recipient_principal_id),
      }
    })
  }

  activeExecutionForSession(sessionId) {
    if (!this.db) return null
    return this.db.prepare(`
      SELECT e.*, p.username AS agent_username, p.display_name AS agent_display_name
      FROM executions e JOIN principals p ON p.id = e.agent_principal_id
      WHERE e.session_id = ? AND e.state = 'running'
      ORDER BY e.started_at DESC LIMIT 1
    `).get(sessionId) || null
  }

  completeExecution({ executionId, content, timestamp }) {
    const execution = this.#requireDb().prepare('SELECT * FROM executions WHERE id = ? AND state = ?').get(executionId, 'running')
    if (!execution) return null
    const message = this.postMessage({
      channelId: execution.channel_id,
      authorId: execution.agent_principal_id,
      content,
      threadRootId: execution.thread_root_id,
      replyToId: execution.trigger_message_id,
      messageType: 'agent',
      idempotencyKey: `execution:${executionId}:final`,
      metadata: { executionId, sourceTimestamp: timestamp || null },
      depth: Number(execution.depth),
    })
    const needsYou = agentNeedsHuman(content)
    this.#transaction(db => {
      db.prepare(`
        UPDATE executions SET state = 'done', final_message_id = ?, completed_at = ? WHERE id = ?
      `).run(message.id, nowIso(), executionId)
      db.prepare(`
        UPDATE channel_outbox SET state = 'done', completed_at = ? WHERE execution_id = ?
      `).run(nowIso(), executionId)
      db.prepare(`
        UPDATE threads SET state = ?, updated_at = ? WHERE root_message_id = ?
      `).run(needsYou ? 'needs_you' : 'resolved', nowIso(), execution.thread_root_id)
      if (needsYou) {
        this.#notifyThreadHumans(db, execution.thread_root_id, execution.agent_principal_id,
          'needs_you', 'An agent needs your decision', message.id)
      }
    })
    return message
  }

  failExecution(executionId, error) {
    if (!this.db || this.readOnly) return
    const message = String(error || 'Agent execution failed').slice(0, 2000)
    this.#transaction(db => {
      const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
      if (!execution || execution.state !== 'running') return
      db.prepare(`UPDATE executions SET state = 'error', error = ?, completed_at = ? WHERE id = ?`)
        .run(message, nowIso(), executionId)
      db.prepare(`UPDATE channel_outbox SET state = 'failed', last_error = ?, completed_at = ? WHERE execution_id = ?`)
        .run(message, nowIso(), executionId)
      db.prepare(`UPDATE threads SET state = 'needs_you', updated_at = ? WHERE root_message_id = ?`)
        .run(nowIso(), execution.thread_root_id)
      this.#notifyThreadHumans(db, execution.thread_root_id, execution.agent_principal_id, 'failure', 'An agent failed in this thread')
    })
  }

  executionForMember({ executionId, principalId }) {
    if (!this.db) return null
    const execution = this.db.prepare(`
      SELECT e.*, p.username AS agent_username, p.display_name AS agent_display_name
      FROM executions e JOIN principals p ON p.id = e.agent_principal_id
      WHERE e.id = ?
    `).get(executionId)
    if (!execution) return null
    this.#requireMembership(execution.channel_id, principalId)
    return {
      id: execution.id,
      channelId: execution.channel_id,
      threadRootId: execution.thread_root_id,
      sessionId: execution.session_id,
      state: execution.state,
      agent: {
        id: execution.agent_principal_id,
        username: execution.agent_username,
        displayName: execution.agent_display_name,
      },
      startedAt: execution.started_at,
      completedAt: execution.completed_at || null,
    }
  }
  cancelExecution({ executionId, principalId }) {
    if (!this.db || this.readOnly) return null
    return this.#transaction(db => {
      const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
      if (!execution) throw new Error('no such execution')
      this.#requireMembership(execution.channel_id, principalId)
      if (!['queued', 'running'].includes(execution.state)) return { sessionId: execution.session_id, state: execution.state }
      db.prepare(`UPDATE executions SET state = 'killed', error = 'Stopped by a channel member', completed_at = ? WHERE id = ?`)
        .run(nowIso(), executionId)
      db.prepare(`UPDATE channel_outbox SET state = 'failed', last_error = 'Stopped by a channel member', completed_at = ? WHERE execution_id = ?`)
        .run(nowIso(), executionId)
      db.prepare(`UPDATE threads SET state = 'needs_you', updated_at = ? WHERE root_message_id = ?`)
        .run(nowIso(), execution.thread_root_id)
      return { sessionId: execution.session_id, state: 'killed' }
    })
  }

  reconcileAgentAttentionSignals() {
    if (!this.db || this.readOnly) return 0
    const rows = this.db.prepare(`
      SELECT t.root_message_id, m.id AS message_id, m.author_id, y.content
      FROM threads t
      JOIN messages m ON m.id = (
        SELECT latest.id FROM messages latest
        WHERE latest.thread_root_id = t.root_message_id
        ORDER BY latest.seq DESC LIMIT 1
      )
      JOIN principals p ON p.id = m.author_id
      JOIN payloads y ON y.id = m.payload_id
      WHERE t.state = 'resolved' AND p.kind = 'agent'
    `).all().filter(row => agentNeedsHuman(row.content))
    if (!rows.length) return 0
    return this.#transaction(db => {
      for (const row of rows) {
        db.prepare(`UPDATE threads SET state = 'needs_you', updated_at = ? WHERE root_message_id = ?`)
          .run(nowIso(), row.root_message_id)
        this.#notifyThreadHumans(db, row.root_message_id, row.author_id,
          'needs_you', 'An agent needs your decision', row.message_id)
      }
      return rows.length
    })
  }

  retryAbandonedExecutions() {
    if (!this.db || this.readOnly) return 0
    return this.#transaction(db => {
      const rows = db.prepare(`SELECT id FROM executions WHERE state = 'running'`).all()
      for (const row of rows) {
        db.prepare(`UPDATE executions SET state = 'error', error = 'Server restarted during execution', completed_at = ? WHERE id = ?`)
          .run(nowIso(), row.id)
        db.prepare(`UPDATE channel_outbox SET state = 'pending', execution_id = NULL, available_at = ?, last_error = 'Retry after server restart' WHERE execution_id = ?`)
          .run(nowIso(), row.id)
      }
      return rows.length
    })
  }

  redactPayload({ messageId, actorId }) {
    const message = this.getMessage(messageId, actorId)
    const membership = this.#requireMembership(message.channelId, actorId)
    if (membership.role !== 'owner' && message.author.id !== actorId) throw new Error('not allowed to redact this message')
    return this.#transaction(db => {
      const row = db.prepare('SELECT payload_id FROM messages WHERE id = ?').get(messageId)
      const appended = this.#appendEvent(db, {
        channelId: message.channelId,
        type: 'message.redacted',
        actorId,
        idempotencyKey: `redact:${messageId}`,
        publicData: { messageId },
        correlationId: message.threadRootId,
        causationId: messageId,
      })
      db.prepare('UPDATE payloads SET content = NULL, redacted_at = ? WHERE id = ?').run(appended.event.accepted_at, row.payload_id)
      return { ok: true, messageId, redactedAt: appended.event.accepted_at }
    })
  }
}

export const channelLimits = Object.freeze({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxAgentDepth: MAX_AGENT_DEPTH,
  maxAgentMessagesPerThread: MAX_AGENT_MESSAGES_PER_THREAD,
  maxAgentFanout: MAX_AGENT_FANOUT,
})

export { agentNeedsHuman, mentionedUsernames, threadTitle }
