import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'
import { chatMessageText } from '@/lib/chat-messages'

import { renderMessageStream } from './use-message-stream/test-harness'
import {
  appendLiveSessionProjection,
  preserveLocalPendingTurnMessages,
  reconcileResumeMessages
} from './use-session-actions/utils'

const msg = (
  id: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage => ({ id, role, parts: [{ type: 'text', text }], ...extra })

const structured = (liveTurnId: string, text: string, pending = true): ChatMessage => ({
  id: 'assistant-stream-shared',
  role: 'assistant',
  liveTurnId,
  timestamp: 42,
  pending,
  parts: [
    { type: 'reasoning', text: `secret-${liveTurnId}` },
    { type: 'tool-call', toolCallId: 'shared-tool-id', toolName: 'terminal', result: `result-${liveTurnId}` },
    { type: 'text', text }
  ] as ChatMessagePart[]
})

describe('turn identity conflict composition', () => {
  afterEach(cleanup)

  it('conflicting live turn dominates equal id, timestamp, text, and toolCallId during structural graft', () => {
    const [out] = reconcileResumeMessages(
      [msg('assistant-stream-shared', 'assistant', 'repeat', { liveTurnId: 'turn-new', timestamp: 42, pending: true })],
      [structured('turn-old', 'repeat')]
    )
    expect(out.liveTurnId).toBe('turn-new')
    expect(out.parts).toEqual([{ type: 'text', text: 'repeat' }])
  })

  it('preserves conflicting pending shell and content rows instead of adopting across turns', () => {
    const authoritative = [
      msg('assistant-stream-shared', 'assistant', '', { liveTurnId: 'turn-new', timestamp: 42, pending: true })
    ]
    const out = preserveLocalPendingTurnMessages(authoritative, [structured('turn-old', 'old pending content')])
    expect(out.map(message => [message.liveTurnId, chatMessageText(message)])).toEqual([
      ['turn-new', ''],
      ['turn-old', 'old pending content']
    ])
  })

  it('preserves equal optimistic and settled rows across conflicting turns despite equal synthetic identity', () => {
    const optimistic = preserveLocalPendingTurnMessages(
      [msg('user-shared', 'user', 'repeat', { liveTurnId: 'turn-old', timestamp: 42 })],
      [msg('user-shared', 'user', 'repeat', { liveTurnId: 'turn-new', timestamp: 42 })]
    )
    const settled = preserveLocalPendingTurnMessages(
      [msg('assistant-stream-shared', 'assistant', 'repeat', { liveTurnId: 'turn-old', timestamp: 42, pending: false })],
      [structured('turn-new', 'repeat', false)]
    )
    expect(optimistic.map(message => message.liveTurnId)).toEqual(['turn-old', 'turn-new'])
    expect(settled.map(message => message.liveTurnId)).toEqual(['turn-old', 'turn-new'])
  })

  it('preserves a repeated prompt through the actual legacy synthetic-identity composition', () => {
    const syntheticTurnId = 'legacy:session-1'
    const authoritativeOldPrompt = [msg('stored-old', 'user', 'repeat prompt', { liveTurnId: syntheticTurnId })]
    const identityProjection = {
      session_id: 'session-1',
      inflight: { user: 'repeat prompt', assistant: '', streaming: true, turn_id: syntheticTurnId },
      queued: null
    }
    const out = appendLiveSessionProjection(authoritativeOldPrompt, identityProjection)
    expect(out.filter(message => message.role === 'user').map(message => message.id)).toEqual([
      'stored-old',
      'user-inflight-session-1'
    ])
  })

  it('does not delete a conflicting prior synthetic stream row during projection refresh', () => {
    const old = msg('assistant-stream-session-1', 'assistant', 'older answer', {
      liveTurnId: 'turn-old',
      pending: false
    })
    const out = appendLiveSessionProjection([old], {
      session_id: 'session-1',
      inflight: { user: 'new prompt', assistant: 'new answer', streaming: true, turn_id: 'turn-new' },
      queued: null
    })
    expect(
      out
        .filter(message => message.role === 'assistant')
        .map(message => [message.liveTurnId, chatMessageText(message)])
    ).toEqual([
      ['turn-old', 'older answer'],
      ['turn-new', 'new answer']
    ])
  })

  it('keeps same-turn projection hydration a fixed point', () => {
    const projection = {
      session_id: 'session-1',
      inflight: {
        user: 'prompt',
        assistant: 'beforeafter',
        streaming: true,
        turn_id: 'turn-fixed',
        corrections: ['redirect'],
        correction_offsets: [6]
      },
      queued: null
    }
    const once = appendLiveSessionProjection([], projection)
    expect(appendLiveSessionProjection(once, projection)).toEqual(once)
  })

  it('keeps repeated identical legacy prompt and correction ambiguous rather than consuming either', () => {
    const oldRows = [
      msg('user-inflight-session-1', 'user', 'repeat'),
      msg('user-inflight-correction-0-session-1', 'user', 'repeat', { midTurnCorrection: true })
    ]
    const out = appendLiveSessionProjection(oldRows, {
      session_id: 'session-1',
      inflight: { user: 'repeat', assistant: '', streaming: true, corrections: ['repeat'] },
      queued: null
    })
    expect(out.filter(message => message.role === 'user')).toHaveLength(4)
  })

  it('preserves equal interim segment ids across conflicting live turns', () => {
    const old = msg('assistant-interim-shared', 'assistant', 'older interim', {
      liveTurnId: 'turn-old',
      pending: false,
      interim: true
    })
    const out = appendLiveSessionProjection([old], {
      session_id: 'session-1',
      inflight: {
        user: 'new prompt',
        assistant: '',
        streaming: true,
        turn_id: 'turn-new',
        interim: [{ segment_id: 'shared', text: 'new interim', already_streamed: false }]
      },
      queued: null
    })

    expect(
      out
        .filter(message => message.id.startsWith('assistant-interim-shared'))
        .map(message => [message.liveTurnId, chatMessageText(message)])
    ).toEqual([
      ['turn-old', 'older interim'],
      ['turn-new', 'new interim']
    ])
  })

  it('does not bind an unbound legacy assistant to an older structured stream id', () => {
    const old = structured('', 'older structured answer', false)
    old.id = 'assistant-stream-session-1'
    delete old.liveTurnId

    const out = appendLiveSessionProjection([old], {
      session_id: 'session-1',
      inflight: { user: 'new prompt', assistant: 'new answer', streaming: true },
      queued: null
    })

    expect(out.filter(message => message.role === 'assistant').map(chatMessageText)).toEqual([
      'older structured answer',
      'new answer'
    ])
  })

  it('is fixed-point when conflicting turns occupy the base projection ids', () => {
    const occupied = [
      msg('user-inflight-session-1', 'user', 'older prompt', { liveTurnId: 'turn-old' }),
      msg('assistant-stream-session-1', 'assistant', 'older answer', { liveTurnId: 'turn-old' })
    ]
    const projection = {
      session_id: 'session-1',
      inflight: { user: 'new prompt', assistant: 'new answer', streaming: true, turn_id: 'turn-new' },
      queued: null
    }
    const once = appendLiveSessionProjection(occupied, projection)
    const twice = appendLiveSessionProjection(once, projection)

    expect(twice).toEqual(once)
    expect(new Set(twice.map(message => message.id)).size).toBe(twice.length)
    expect(twice.filter(message => message.liveTurnId === 'turn-new' && message.role === 'assistant')).toHaveLength(1)
  })

  it('keeps conflicting pending rows uniquely keyed when their deterministic suffix is occupied', () => {
    const previous = [
      msg('assistant-stream-session-1', 'assistant', 'older answer', {
        liveTurnId: 'turn-old',
        pending: true
      }),
      msg('assistant-stream-session-1-turn-old', 'assistant', 'older answer copy', {
        liveTurnId: 'turn-old',
        pending: true
      })
    ]
    const authoritative = [
      msg('assistant-stream-session-1', 'assistant', 'new answer', {
        liveTurnId: 'turn-new',
        pending: true
      })
    ]
    const out = preserveLocalPendingTurnMessages(authoritative, previous)

    expect(out.map(message => message.liveTurnId)).toEqual(['turn-new', 'turn-old', 'turn-old'])
    expect(new Set(out.map(message => message.id)).size).toBe(out.length)
  })

  it('does not settle an older conflicting pre-steer assistant', async () => {
    const sid = 'session-1'
    const stream = renderMessageStream(sid)
    const seeded: ClientSessionState = {
      ...stream.state(),
      liveTurnId: 'turn-new',
      streamId: null,
      messages: [
        msg('assistant-stream-old', 'assistant', 'old', { liveTurnId: 'turn-old', pending: false, interim: true }),
        msg('user-steer', 'user', 'redirect', { liveTurnId: 'turn-new', midTurnCorrection: true })
      ]
    }
    stream.states.set(sid, seeded)
    await act(() => stream.handleEvent({ session_id: sid, type: 'message.complete', payload: { text: 'new' } }))
    expect(
      stream
        .state()
        .messages.filter(message => message.role === 'assistant')
        .map(message => [message.liveTurnId, chatMessageText(message)])
    ).toEqual([
      ['turn-old', 'old'],
      [undefined, 'new']
    ])
  })
})
