import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ChannelStore, mentionedUsernames, threadTitle } from '../../lib/channels.js'

const roots = []
const stores = []
afterEach(() => {
  while (stores.length) stores.pop().close()
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-channels-'))
  roots.push(root)
  const store = new ChannelStore({ file: path.join(root, 'channels.sqlite3') })
  stores.push(store)
  const philip = store.ensureHuman({ username: 'philip', displayName: 'Philip' })
  const channel = store.createChannel({
    slug: 'films7',
    title: 'Films 7',
    description: 'A shared film studio.',
    creatorId: philip.id,
    idempotencyKey: 'pilot:films7',
  })
  const coordinator = store.addAgent({
    channelId: channel.id,
    actorId: philip.id,
    username: 'coordinator',
    displayName: 'Coordinator',
    sessionId: 'channel-films7-coordinator',
    makeDefault: true,
  }).principal
  const caretaker = store.addAgent({
    channelId: channel.id,
    actorId: philip.id,
    username: 'caretaker',
    displayName: 'Caretaker',
    sessionId: 'channel-films7-caretaker',
  }).principal
  const btw = store.addAgent({
    channelId: channel.id,
    actorId: philip.id,
    username: 'btw',
    displayName: 'Btw',
    sessionId: 'channel-films7-btw',
  }).principal
  return { root, store, philip, channel, coordinator, caretaker, btw }
}

describe('channel event store', () => {
  it('keeps canonical sequence order and makes idempotent posts durable', () => {
    const { root, store, philip, channel } = setup()
    const first = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Start with the emotional turn, not the shot list.',
      messageType: 'human',
      idempotencyKey: 'client:first',
    })
    const replay = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'A retry must not create another message.',
      messageType: 'human',
      idempotencyKey: 'client:first',
    })

    assert.equal(replay.id, first.id)
    assert.equal(replay.content, first.content)
    assert.deepEqual(store.listChannelRoots(channel.id, philip.id).map(message => message.id), [first.id])
    const mode = fs.statSync(path.join(root, 'channels.sqlite3')).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it('keeps adaptive presentation feedback durable and idempotent', () => {
    const { store, philip, channel } = setup()
    const first = store.recordPresentationFeedback({
      channelId: channel.id,
      principalId: philip.id,
      planId: 'fable-plan-1',
      focus: 'direction',
      action: 'helpful',
      idempotencyKey: 'presentation-feedback:1',
    })
    const replay = store.recordPresentationFeedback({
      channelId: channel.id,
      principalId: philip.id,
      planId: 'fable-plan-1',
      focus: 'direction',
      action: 'helpful',
      idempotencyKey: 'presentation-feedback:1',
    })
    store.recordPresentationFeedback({
      channelId: channel.id,
      principalId: philip.id,
      planId: 'fable-plan-1',
      focus: 'direction',
      action: 'prompt_prepared',
      idempotencyKey: 'presentation-feedback:2',
    })

    assert.equal(replay.eventId, first.eventId)
    assert.equal(replay.existing, true)
    const summary = store.presentationFeedbackSummary(channel.id, philip.id)
    assert.equal(summary.sampleSize, 2)
    assert.deepEqual(summary.actions, { prompt_prepared: 1, helpful: 1 })
    assert.deepEqual(summary.focuses, { direction: 2 })
    assert.ok(summary.latestAt)
    assert.throws(() => store.recordPresentationFeedback({
      channelId: channel.id,
      principalId: philip.id,
      planId: 'fable-plan-2',
      focus: 'invented',
      action: 'helpful',
    }), /invalid presentation focus/)
  })

  it('keeps agent sessions stable and dispatches only the latest unanswered thread after staffing', () => {
    const { store, philip, channel, coordinator, caretaker, btw } = setup()
    const replay = store.addAgent({
      channelId: channel.id,
      actorId: philip.id,
      username: coordinator.username,
      displayName: 'Coordinator',
      sessionId: 'must-not-replace-the-original-session',
    }).principal
    assert.equal(replay.id, coordinator.id)
    assert.equal(replay.sessionId, coordinator.sessionId)
    assert.deepEqual([...store.agentSessionIds()].sort(), [btw.sessionId, caretaker.sessionId, coordinator.sessionId].sort())

    const fresh = store.createChannel({
      slug: 'fairfield',
      title: 'Fairfield',
      creatorId: philip.id,
      idempotencyKey: 'pilot:fairfield',
    })
    const freshCoordinator = store.addAgent({
      channelId: fresh.id,
      actorId: philip.id,
      username: 'fairfield-coordinator',
      displayName: 'Coordinator',
      sessionId: 'channel-fairfield-coordinator',
    }).principal
    const first = store.postMessage({
      channelId: fresh.id,
      authorId: philip.id,
      content: 'First unanswered request.',
      messageType: 'human',
      idempotencyKey: 'client:fairfield:first',
    })
    const latest = store.postMessage({
      channelId: fresh.id,
      authorId: philip.id,
      content: 'Are any agents here?',
      messageType: 'human',
      idempotencyKey: 'client:fairfield:latest',
    })

    store.setDefaultAgent({ channelId: fresh.id, actorId: philip.id, agentId: freshCoordinator.id })
    assert.equal(store.enqueueLatestUnansweredThread({ channelId: fresh.id, actorId: philip.id }), true)
    const dispatch = store.claimDispatch()
    assert.equal(dispatch.agent.id, freshCoordinator.id)
    assert.equal(dispatch.threadRootId, latest.id)
    assert.notEqual(dispatch.threadRootId, first.id)
    assert.equal(store.enqueueLatestUnansweredThread({ channelId: fresh.id, actorId: philip.id }), false)
    assert.equal(store.executionForMember({ executionId: dispatch.executionId, principalId: philip.id }).sessionId, freshCoordinator.sessionId)
    const outsider = store.ensureHuman({ username: 'outsider', displayName: 'Outsider' })
    assert.throws(() => store.executionForMember({ executionId: dispatch.executionId, principalId: outsider.id }), /not an active channel member/)
    assert.equal(store.activeExecutionSessionIds().has(freshCoordinator.sessionId), true)
    assert.throws(() => store.restartExecution({ executionId: dispatch.executionId, principalId: outsider.id }), /not an active channel member/)
    assert.equal(store.restartExecution({ executionId: dispatch.executionId, principalId: philip.id }).state, 'queued')
    const restartedDispatch = store.claimDispatch()
    assert.notEqual(restartedDispatch.executionId, dispatch.executionId)
    assert.equal(restartedDispatch.triggerMessageId, latest.id)
    assert.equal(store.getThread(latest.id, philip.id).executions.find(execution => execution.id === dispatch.executionId).error, 'Restarted by a channel member')
    store.completeExecution({ executionId: restartedDispatch.executionId, content: 'Coordinator is here.' })
    const followUp = store.postMessage({
      channelId: fresh.id,
      authorId: philip.id,
      content: 'Where are we now?',
      threadRootId: latest.id,
      replyToId: latest.id,
      messageType: 'human',
      idempotencyKey: 'client:fairfield:follow-up',
    })
    const followUpDispatch = store.claimDispatch()
    assert.equal(followUpDispatch.agent.id, freshCoordinator.id)
    assert.equal(followUpDispatch.triggerMessageId, followUp.id)
  })

  it('queues later human replies until the same agent finishes its active turn', () => {
    const { store, philip, channel, coordinator } = setup()
    const root = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Start the first task.',
      messageType: 'human',
      idempotencyKey: 'client:serial:first',
    })
    const first = store.claimDispatch()
    assert.equal(first.agent.id, coordinator.id)

    const followUp = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Add this while you are still working.',
      threadRootId: root.id,
      replyToId: root.id,
      messageType: 'human',
      idempotencyKey: 'client:serial:follow-up',
    })
    assert.equal(store.claimDispatch(), null, 'the same persistent agent must have only one active turn')
    const waiting = store.getThread(root.id, philip.id).delivery
    assert.equal(waiting.activeCount, 1)
    assert.equal(waiting.queuedCount, 1)
    assert.deepEqual(waiting.activeAgents.map(agent => agent.id), [coordinator.id])
    assert.deepEqual(waiting.queuedAgents.map(agent => agent.id), [coordinator.id])
    store.completeExecution({ executionId: first.executionId, content: 'First task complete.' })

    const second = store.claimDispatch()
    assert.equal(second.agent.id, coordinator.id)
    assert.equal(second.triggerMessageId, followUp.id)
    assert.notEqual(second.executionId, first.executionId)
  })

  it('uses Btw only while Coordinator is busy and queues substantial handoffs', () => {
    const { store, philip, channel, coordinator, btw } = setup()
    store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Begin the substantial work.',
      messageType: 'human',
      idempotencyKey: 'client:btw:main',
    })
    const main = store.claimDispatch()
    assert.equal(main.agent.id, coordinator.id)

    store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'What does BTW stand for?',
      messageType: 'human',
      idempotencyKey: 'client:btw:quick',
    })
    const quick = store.claimDispatch()
    assert.equal(quick.agent.id, btw.id)
    store.completeExecution({ executionId: quick.executionId, content: 'By the way.' })

    store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Also audit all of the gradebooks.',
      messageType: 'human',
      idempotencyKey: 'client:btw:handoff',
    })
    const triage = store.claimDispatch()
    assert.equal(triage.agent.id, btw.id)
    const acknowledgement = store.completeExecution({
      executionId: triage.executionId,
      content: '👀 Read. @coordinator is taking this.',
    })
    assert.equal(store.claimDispatch(), null, 'Coordinator handoff waits behind Coordinator’s active turn')

    store.completeExecution({ executionId: main.executionId, content: 'Initial work complete.' })
    const handoff = store.claimDispatch()
    assert.equal(handoff.agent.id, coordinator.id)
    assert.equal(handoff.triggerMessageId, acknowledgement.id)
  })

  it('continues answering human follow-ups beyond the agent handoff loop cap', () => {
    const { store, philip, channel, coordinator } = setup()
    const root = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Begin a long-lived human conversation.',
      messageType: 'human',
      idempotencyKey: 'client:long-human:root',
    })
    let dispatch = store.claimDispatch()
    for (let round = 0; round < 13; round++) {
      store.completeExecution({ executionId: dispatch.executionId, content: `Agent answer ${round + 1}.` })
      const followUp = store.postMessage({
        channelId: channel.id,
        authorId: philip.id,
        content: `Human follow-up ${round + 1}.`,
        threadRootId: root.id,
        replyToId: root.id,
        messageType: 'human',
        idempotencyKey: `client:long-human:${round + 1}`,
      })
      dispatch = store.claimDispatch()
      assert.ok(dispatch, `human follow-up ${round + 1} must dispatch`)
      assert.equal(dispatch.agent.id, coordinator.id)
      assert.equal(dispatch.triggerMessageId, followUp.id)
    }
  })

  it('models flat threads, explicit agent mentions, and bounded agent dispatch', () => {
    const { store, philip, channel, coordinator, caretaker } = setup()
    const root = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Find the dramatic question for the opening.',
      messageType: 'human',
      idempotencyKey: 'client:root',
    })
    const firstDispatch = store.claimDispatch()
    assert.equal(firstDispatch.agent.id, coordinator.id)
    assert.equal(firstDispatch.threadRootId, root.id)
    assert.equal(firstDispatch.thread.messages.length, 1)

    const agentReply = store.completeExecution({
      executionId: firstDispatch.executionId,
      content: 'The question is whether she will tell the truth. @caretaker check the continuity risk.',
    })
    assert.equal(agentReply.threadRootId, root.id)
    assert.equal(store.messageHasAgentHandoff(agentReply.id), true)
    const secondDispatch = store.claimDispatch()
    assert.equal(secondDispatch.agent.id, caretaker.id)
    assert.equal(secondDispatch.depth, 1)
    store.completeExecution({ executionId: secondDispatch.executionId, content: 'Continuity holds if the unopened letter is visible in both shots. @coordinator close the loop.' })

    const thread = store.getThread(root.id, philip.id)
    assert.equal(thread.messages.length, 3)
    assert.ok(thread.messages.every(message => message.threadRootId === root.id))
    assert.equal(thread.executions.length, 2)
    assert.equal(thread.executions[0].state, 'done')
    assert.equal(thread.state, 'resolved')
    assert.equal(store.claimDispatch(), null)
    assert.equal(thread.executions.filter(execution => execution.agent.id === coordinator.id).length, 1, 'an agent runs at most once per human turn')
    const activity = store.listActivity(philip.id)
    assert.equal(activity.length, 1, 'Activity groups agent updates by thread')
    assert.equal(activity[0].updates, 2)
  })

  it('recognizes Markdown-styled agent requests as Needs you', () => {
    const { store, philip, channel } = setup()
    const maya = store.addHumanMember({
      channelId: channel.id,
      actorId: philip.id,
      username: 'maya',
      displayName: 'Maya',
    }).principal
    const root = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Tell me which ending needs a decision.',
      messageType: 'human',
      idempotencyKey: 'client:needs-you',
    })
    const dispatch = store.claimDispatch()
    store.completeExecution({
      executionId: dispatch.executionId,
      content: '**NEEDS YOU:** Choose whether the final look lands before or after the cut.',
    })

    assert.equal(store.getThread(root.id, philip.id).state, 'needs_you')
    assert.equal(store.listActivity(philip.id)[0].kind, 'needs_you')
    assert.equal(store.listActivity(maya.id).length, 0, 'Needs you targets thread participants, not every channel member')
    store.updateThread({ rootId: root.id, actorId: philip.id, state: 'resolved' })
    assert.equal(store.reconcileAgentAttentionSignals(), 1)
    assert.equal(store.getThread(root.id, philip.id).state, 'needs_you')
    assert.equal(store.reconcileAgentAttentionSignals(), 0)
  })

  it('separates unread, follow, done, snooze, and notification reason', () => {
    const { store, philip, channel } = setup()
    const root = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Please make the ending earn its silence.',
      messageType: 'human',
      idempotencyKey: 'client:attention',
    })
    const dispatch = store.claimDispatch()
    store.completeExecution({ executionId: dispatch.executionId, content: 'I cut the explanatory line; the held look now carries the decision.' })

    let activity = store.listActivity(philip.id)
    assert.equal(activity.length, 1)
    assert.equal(activity[0].kind, 'agent_reply')
    assert.match(activity[0].reason, /as an agent/)
    assert.equal(activity[0].actor.kind, 'agent')
    assert.equal(store.unreadActivityCount(philip.id), 1)

    let thread = store.getThread(root.id, philip.id)
    assert.equal(thread.lastReadSeq, root.seq, 'the API exposes where this member last stopped reading')
    assert.equal(store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'read' }).changed, true)
    assert.equal(store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'read' }).changed, false, 're-reading an unchanged thread is a no-op')
    thread = store.getThread(root.id, philip.id)
    assert.equal(thread.lastReadSeq, thread.messages.at(-1).seq)
    assert.equal(store.unreadActivityCount(philip.id), 0)
    assert.equal(thread.following, true)

    store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'done' })
    assert.equal(store.listActivity(philip.id).length, 0)
    assert.equal(store.listActivity(philip.id, { includeDone: true }).length, 1)

    store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'done', value: false })
    store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'snooze', until: '2999-01-01T00:00:00.000Z' })
    assert.equal(store.listActivity(philip.id).length, 0)

    thread = store.getThread(root.id, philip.id)
    assert.equal(thread.snoozedUntil, '2999-01-01T00:00:00.000Z')
  })
  it('projects unread mentions into thread triage', () => {
    const { store, philip, channel } = setup()
    const maya = store.addHumanMember({
      channelId: channel.id,
      actorId: philip.id,
      username: 'maya',
      displayName: 'Maya',
    }).principal
    const root = store.postMessage({
      channelId: channel.id,
      authorId: maya.id,
      content: '@philip Please decide which version ships.',
      messageType: 'human',
      idempotencyKey: 'client:mention-filter',
    })

    assert.equal(store.listChannelRoots(channel.id, philip.id)[0].thread.mentioned, true)
    store.updateThreadAttention({ rootId: root.id, principalId: philip.id, action: 'read' })
    assert.equal(store.listChannelRoots(channel.id, philip.id)[0].thread.mentioned, false)
  })

  it('enforces membership, supports human invitations, and creates one DM per pair', () => {
    const { store, philip, channel } = setup()
    const maya = store.ensureHuman({ username: 'maya', displayName: 'Maya' })
    assert.throws(() => store.getChannel(channel.id, maya.id), /not an active channel member/)
    store.addHumanMember({ channelId: channel.id, actorId: philip.id, username: 'maya', displayName: 'Maya' })
    assert.equal(store.getChannel(channel.id, maya.id).members.some(member => member.id === maya.id), true)

    const dm = store.createDm({ creatorId: philip.id, otherPrincipalId: maya.id })
    const replay = store.createDm({ creatorId: maya.id, otherPrincipalId: philip.id })
    assert.equal(replay.id, dm.id)
    const message = store.postMessage({
      channelId: dm.id,
      authorId: philip.id,
      content: 'The cut is ready for your eyes.',
      messageType: 'human',
      idempotencyKey: 'client:dm',
    })
    assert.equal(store.listActivity(maya.id)[0].messageId, message.id)
  })

  it('redacts payload content without deleting its immutable event', () => {
    const { store, philip, channel } = setup()
    const message = store.postMessage({
      channelId: channel.id,
      authorId: philip.id,
      content: 'Temporary sensitive context.',
      messageType: 'human',
      idempotencyKey: 'client:redact',
    })
    store.redactPayload({ messageId: message.id, actorId: philip.id })
    assert.equal(store.getMessage(message.id, philip.id).content, '')
    assert.equal(store.listChannelRoots(channel.id, philip.id).length, 1)
  })
})

describe('channel text rules', () => {
  it('extracts explicit mentions and generates compact thread titles', () => {
    assert.deepEqual(mentionedUsernames('Ask @Coordinator and @caretaker, not email@host.test.'), ['coordinator', 'caretaker'])
    assert.equal(threadTitle('  One   clear\nquestion  '), 'One clear question')
    assert.match(threadTitle('x'.repeat(100)), /…$/)
  })
})
