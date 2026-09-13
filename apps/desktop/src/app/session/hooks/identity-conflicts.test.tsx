import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import type { ChatMessage } from '@/lib/chat-messages'
import { chatMessageText } from '@/lib/chat-messages'

import { type MessageStreamHarness, renderMessageStream } from './use-message-stream/test-harness'
import {
  appendLiveSessionProjection,
  preserveLocalPendingTurnMessages,
  reconcileResumeMessages
} from './use-session-actions/utils'

const textMessage = (
  id: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage => ({ id, role, parts: [{ type: 'text', text }], ...extra })

describe('live turn identity conflicts', () => {
  afterEach(cleanup)

  it('lets conflicting liveTurnId override the same synthetic id for structural graft decisions', () => {
    const previous = [
      textMessage('assistant-stream-shared', 'assistant', 'same', {
        liveTurnId: 'turn-old',
        pending: true,
        parts: [
          { type: 'reasoning', text: 'old secret reasoning' },
          { type: 'text', text: 'same' }
        ]
      })
    ]
    const next = [
      textMessage('assistant-stream-shared', 'assistant', 'same', {
        liveTurnId: 'turn-new',
        pending: true
      })
    ]

    const [out] = reconcileResumeMessages(next, previous)

    expect(out.liveTurnId).toBe('turn-new')
    expect(out.parts).toEqual([{ type: 'text', text: 'same' }])
  })

  it('lets conflicting liveTurnId override timestamp equality for optimistic user cleanup', () => {
    const previous = [
      textMessage('user-local', 'user', 'repeat', {
        liveTurnId: 'turn-new',
        timestamp: 1
      })
    ]
    const next = [
      textMessage('stored-old', 'user', 'repeat', {
        liveTurnId: 'turn-old',
        timestamp: 1
      })
    ]

    const out = preserveLocalPendingTurnMessages(next, previous)

    expect(out.map(message => message.id)).toEqual(['stored-old', 'user-local'])
  })

  it('prevents a conflicting empty shell from adopting another turn content', () => {
    const previous = [
      textMessage('assistant-stream-session', 'assistant', 'old answer', {
        liveTurnId: 'turn-old',
        pending: true
      })
    ]
    const next = [
      textMessage('assistant-stream-session', 'assistant', '', {
        liveTurnId: 'turn-new',
        pending: true
      })
    ]

    const [out] = reconcileResumeMessages(next, previous)

    expect(out.liveTurnId).toBe('turn-new')
    expect(chatMessageText(out)).toBe('')
  })

  it('prevents settled assistant deletion despite equal text and timestamp across turns', () => {
    const previous = [
      textMessage('assistant-stream-local', 'assistant', 'repeat', {
        liveTurnId: 'turn-new',
        pending: false,
        timestamp: 2
      })
    ]
    const next = [
      textMessage('committed-old', 'assistant', 'repeat', {
        liveTurnId: 'turn-old',
        pending: false,
        timestamp: 2
      })
    ]

    const out = preserveLocalPendingTurnMessages(next, previous)

    expect(out.map(message => message.id)).toEqual(['committed-old', 'assistant-stream-local'])
  })

  it('preserves a newly accepted repeated prompt when a legacy snapshot omits turn_id', () => {
    const previous = [textMessage('stored-old', 'user', 'repeat prompt')]
    const out = appendLiveSessionProjection(previous, {
      session_id: 'session-1',
      inflight: { user: 'repeat prompt', assistant: '', streaming: true },
      queued: null
    })

    expect(out.filter(message => message.role === 'user').map(message => message.id)).toEqual([
      'stored-old',
      'user-inflight-session-1'
    ])
  })

  it('cannot overwrite an older conflicting turn merely because a steer row follows it', async () => {
    const sid = 'session-1'
    const stream: MessageStreamHarness = renderMessageStream(sid)
    const state = stream.state()
    const seeded: ClientSessionState = {
      ...state,
      liveTurnId: 'turn-new',
      streamId: null,
      messages: [
        textMessage('assistant-stream-old', 'assistant', 'same answer', {
          liveTurnId: 'turn-old',
          pending: false,
          interim: true
        }),
        textMessage('user-steer', 'user', 'redirect', {
          liveTurnId: 'turn-new',
          midTurnCorrection: true
        })
      ]
    }
    stream.states.set(sid, seeded)

    await act(() =>
      stream.handleEvent({
        session_id: sid,
        type: 'message.complete',
        payload: { text: 'same answer' }
      })
    )

    const assistants = stream.state().messages.filter(message => message.role === 'assistant')

    expect(assistants).toHaveLength(2)
    expect(assistants[0].liveTurnId).toBe('turn-old')
    expect(assistants[0].interim).toBe(true)
  })
})
