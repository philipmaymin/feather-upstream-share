import path from 'path'

// Claude names project directories by replacing path separators and dots with
// dashes. Codex/OMP project ids use the same encoding in server discovery.
export function encodeProjectPath(cwd) {
  return cwd.replace(/[/.]/g, '-')
}

export function groupRoomSessions({ roomNames, roomsRoot, sessions, assignments }) {
  const grouped = new Map(roomNames.map((name) => [name, []]))
  const projectRooms = new Map(roomNames.map((name) => [
    encodeProjectPath(path.join(roomsRoot, name)),
    name,
  ]))
  const seen = new Set()

  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    const assignedRoom = assignments[session.id]
    const room = assignedRoom || projectRooms.get(session.projectId || '')
    if (!room || !grouped.has(room)) continue
    grouped.get(room).push(assignedRoom === room ? { ...session, roomAssigned: true } : session)
  }
  return grouped
}
