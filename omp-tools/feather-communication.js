import path from 'node:path'
import { createHash } from 'node:crypto'

const collapseWhitespace = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()


const stableReportId = (toolCallId) =>
  createHash('sha256').update(String(toolCallId)).digest('hex').slice(0, 32)

function fallbackSource(cwd) {
  const label = path.basename(cwd || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)
  return label || 'unscoped'
}

/**
 * Literal OMP tools for intentional agent-to-human status and durable friction
 * reporting. The factory is discovered through OMP's custom-tool loader.
 */
export default function featherCommunicationTools(pi) {
  const tellUser = {
    name: 'tell_user',
    label: 'Tell User',
    description: 'Show one short human-facing progress update. Use sparingly at meaningful phase changes or before work likely to take over 30 seconds. Explain the outcome being pursued or what changed. Never narrate reasoning, tool names, commands, or generic activity. Do not use for final answers or questions.',
    loadMode: 'essential',
    parameters: pi.zod.object({
      message: pi.zod.string().min(1).max(280),
    }),

    async execute(toolCallId, params) {
      const message = String(params.message ?? '').trim()
      if (!message) throw new Error('tell_user message must not be empty')
      return {
        content: [{ type: 'text', text: 'Progress update shown to the user.' }],
        details: { kind: 'tell_user', statusId: toolCallId, message },
      }
    },
  }

  const reportFriction = {
    name: 'report_friction',
    label: 'Report Friction',
    description: 'Report a recurring tool, integration, workflow, or product friction that caused a workaround, wasted time, or blocked progress. State what went wrong and why it mattered. Ordinary code/test failures do not belong here. The #friction agent triages priority.',
    loadMode: 'essential',
    parameters: pi.zod.object({
      summary: pi.zod.string().min(1).max(500),
      evidence: pi.zod.string().max(2000).optional(),
    }),

    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      const summary = collapseWhitespace(params.summary)
      const evidence = collapseWhitespace(params.evidence)
      if (!summary) throw new Error('report_friction summary must not be empty')
      const reportId = stableReportId(toolCallId)
      const report = evidence ? `${summary} | Evidence: ${evidence}` : summary
      let result = await pi.exec('room', ['complain', '--id', reportId, '--', report], { cwd: pi.cwd, signal })
      if (result.killed) throw new Error('Friction report was cancelled')
      if (result.code !== 0 && /not inside a room/.test(result.stderr || result.stdout)) {
        result = await pi.exec(
          'room',
          ['complain', '--id', reportId, '--source', fallbackSource(pi.cwd), '--', report],
          { cwd: pi.cwd, signal },
        )
      }
      if (result.killed) throw new Error('Friction report was cancelled')
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Could not record friction report')
      const receipt = collapseWhitespace(result.stdout)
      const source = receipt.match(/from #([^ ]+)/)?.[1] || 'unknown'
      const wakeRequested = receipt.includes('wake requested')
      const duplicate = receipt.startsWith('already flagged')
      return {
        content: [{ type: 'text', text: receipt || `Recorded friction ${reportId} in #friction.` }],
        details: {
          kind: 'report_friction', reportId, sourceToolCallId: toolCallId,
          source, destination: 'friction', wakeRequested, duplicate, cwd: pi.cwd,
        },
      }
    },
  }

  return [tellUser, reportFriction]
}
