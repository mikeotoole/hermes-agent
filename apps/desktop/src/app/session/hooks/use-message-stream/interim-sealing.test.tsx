import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { chatMessageText } from '@/lib/chat-messages'
import { clearSessionTodos } from '@/store/todos'
import type { RpcEvent } from '@/types/hermes'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const SID = 'session-1'

let stream: MessageStreamHarness
let mockCompleteSound: ReturnType<typeof vi.fn>
let mockHaptic: ReturnType<typeof vi.fn>

function mountStream(options: Parameters<typeof renderMessageStream>[1] = {}) {
  stream = renderMessageStream(SID, options)
}

const start = (turnId = 'turn-default') =>
  act(() => stream.handleEvent({ payload: { turn_id: turnId }, session_id: SID, type: 'message.start' }))

const delta = (text: string) =>
  act(() => stream.handleEvent({ payload: { text }, session_id: SID, type: 'message.delta' }))

const interim = (text: string) =>
  act(() => stream.handleEvent({ payload: { text, already_streamed: true }, session_id: SID, type: 'message.interim' }))

const complete = (text: string) =>
  act(() => stream.handleEvent({ payload: { text }, session_id: SID, type: 'message.complete' }))

const completePreviewed = (text: string) =>
  act(() =>
    stream.handleEvent({ payload: { text, response_previewed: true }, session_id: SID, type: 'message.complete' })
  )

function getState(): ClientSessionState {
  return stream.state()
}

function assistantText(): string {
  const state = getState()
  const last = [...state.messages].reverse().find(m => m.role === 'assistant' && !m.hidden)

  return last ? chatMessageText(last) : ''
}

function assistantMessages(): string[] {
  const state = getState()

  return state.messages
    .filter(m => m.role === 'assistant' && !m.hidden)
    .map(m => chatMessageText(m))
    .filter(Boolean)
}

describe('useMessageStream interim text sealing', () => {
  beforeEach(() => {
    clearSessionTodos(SID)
  })

  afterEach(() => {
    cleanup()
    clearSessionTodos(SID)
    vi.restoreAllMocks()
  })

  it('preserves interim text that the final response does not include', async () => {
    mountStream()
    await start()

    await delta('awaaaaa clean!! tsc zero errors')
    await interim('awaaaaa clean!! tsc zero errors')

    await complete('All checks passed.')

    const texts = assistantMessages()
    expect(texts).toContain('awaaaaa clean!! tsc zero errors')
    expect(texts).toContain('All checks passed.')
  })

  it('marks sealed interim bubbles interim and leaves the final reply unmarked', async () => {
    mountStream()
    await start()

    await delta('Let me check the files.')
    await interim('Let me check the files.')
    await delta('Now the second pass.')
    await interim('Now the second pass.')
    await complete('All done.')

    const assistants = getState().messages.filter(m => m.role === 'assistant' && !m.hidden)
    const byText = (text: string) => assistants.find(m => chatMessageText(m) === text)

    expect(byText('Let me check the files.')?.interim).toBe(true)
    expect(byText('Now the second pass.')?.interim).toBe(true)
    expect(byText('All done.')?.interim).toBeFalsy()
  })

  it('does not duplicate a stable interim frame delivered twice by replay', async () => {
    mountStream()
    await start()
    await delta('Let me inspect it.')

    const frame = {
      payload: { text: 'Let me inspect it.', already_streamed: true, segment_id: 'stable-1' },
      session_id: SID,
      type: 'message.interim'
    } as RpcEvent

    await act(() => stream.handleEvent(frame))
    await act(() => stream.handleEvent(frame))

    expect(assistantMessages().filter(text => text === 'Let me inspect it.')).toHaveLength(1)
  })

  it('treats a legacy interim without already_streamed as already streamed', async () => {
    mountStream()
    await start()
    await delta('legacy commentary')
    await act(() =>
      stream.handleEvent({
        payload: { text: 'legacy commentary' },
        session_id: SID,
        type: 'message.interim'
      } as RpcEvent)
    )

    expect(assistantMessages()).toEqual(['legacy commentary'])
    expect(getState().messages.find(message => chatMessageText(message) === 'legacy commentary')?.interim).toBe(true)
  })


  it('clears the interim mark when a previewed final settles onto the interim bubble', async () => {
    mountStream()
    await start()

    await interim('same reply')
    await completePreviewed('same reply')

    const assistants = getState().messages.filter(m => m.role === 'assistant' && !m.hidden)
    expect(assistants).toHaveLength(1)
    expect(assistants[0].interim).toBeFalsy()
  })

  it('dedupes interim text when the final response includes it', async () => {
    mountStream()
    await start()

    await delta('Let me check the files.')
    await interim('Let me check the files.')

    await complete('Let me check the files. Everything looks good.')

    const texts = assistantMessages()
    expect(texts).not.toContain('Let me check the files.Let me check the files.')
    expect(texts.some(t => t.includes('Let me check the files. Everything looks good.'))).toBe(true)
  })

  it('clears interimBoundaryPending at turn end so the next turn starts clean', async () => {
    mountStream()
    await start()

    await delta('interim text')
    await interim('interim text')
    await complete('final text')

    expect(getState().interimBoundaryPending).toBe(false)

    await start()
    expect(getState().interimBoundaryPending).toBe(false)

    await complete('new turn final')

    const texts = assistantMessages()
    expect(texts[texts.length - 1]).toBe('new turn final')
  })

  it('finalizes an interim segment without settling the turn', async () => {
    mountStream()
    await start()

    await delta('streaming text')
    await interim('streaming text')

    // Turn is still active — busy stays true
    expect(getState().busy).toBe(true)
    expect(getState().interimBoundaryPending).toBe(true)
  })

  it('hydrates an ambiguous identical non-previewed completion instead of inferring segment identity (#63679)', async () => {
    const hydrateFromStoredSession = vi.fn(async () => undefined)
    mountStream({ hydrateFromStoredSession })
    await start()

    // A plain tool-call turn: the streamed text is sealed as an interim at the
    // tool boundary (no response_previewed — that flag is only for verify-on-
    // stop). Exact text cannot prove segment identity, so keep both local rows
    // until canonical stored history resolves whether the DB has one or two.
    await interim('same reply')
    await complete('same reply')

    expect(assistantMessages().filter(t => t === 'same reply')).toHaveLength(2)
    expect(hydrateFromStoredSession).toHaveBeenCalledOnce()
  })

  it('hydrates an ambiguous prefix-related non-previewed completion', async () => {
    const hydrateFromStoredSession = vi.fn(async () => undefined)
    mountStream({ hydrateFromStoredSession })
    await start()

    // The stream dropped/settled early at the tool boundary; the final adds a
    // trailing delta. Prefix continuity is presentation, not segment identity.
    await delta('partial')
    await interim('partial')
    await complete('partial answer continued')

    expect(assistantMessages()).toEqual(['partial', 'partial answer continued'])
    expect(hydrateFromStoredSession).toHaveBeenCalledOnce()
  })

  it('settles final onto interim even after message.start reset the boundary flag (#74560)', async () => {
    mountStream()
    await start()
    await delta('partial')
    await interim('partial')
    // A chained turn / follow-up re-emits message.start, which resets
    // interimBoundaryPending to false BEFORE the same turn's message.complete.
    // The continuation must still settle onto the interim — not append a
    // duplicate bubble. Regression for #74560.
    await start()
    await completePreviewed('partial answer continued')

    const texts = assistantMessages()
    expect(texts.filter(t => t.includes('partial'))).toHaveLength(1)
    expect(texts[0]).toBe('partial answer continued')
  })

  it('does not settle prefix-related completion onto an interim from a different live turn', async () => {
    mountStream()
    await start('turn-a')
    await delta('partial')
    await interim('partial')

    await start('turn-b')
    await complete('partial answer from a new turn')

    expect(assistantMessages()).toEqual(['partial', 'partial answer from a new turn'])
  })

  it('appends a distinct previewed final after a message.start reset instead of overwriting the interim', async () => {
    mountStream()
    await start()
    await interim('old interim text')
    // A genuinely new turn begins — message.start resets interimBoundaryPending.
    // Production ordering: mid-turn compaction-resume events do NOT include
    // message.start (COMPACTION_RESUME_EVENT_TYPES in gateway-event/index.ts), and
    // the TUI gateway emits message.complete BEFORE goal-followup starts
    // (tui_gateway/server.py), so a previewed final arriving after the reset
    // is a DISTINCT reply, not a rewrite of the interim. It must append its
    // own bubble — never overwrite the old one (sweeper review on #76583).
    await start()
    await completePreviewed('totally new answer')

    const texts = assistantMessages()
    expect(texts).toContain('old interim text')
    expect(texts).toContain('totally new answer')
    expect(texts).toHaveLength(2)
  })

  it('appends a genuinely different final as its own bubble (two real assistant segments)', async () => {
    mountStream()
    await start()

    // The interim is one segment (pre-tool commentary); the final is different
    // content, not a continuation of it. These are two real messages and must
    // both render — the fix must not over-collapse distinct replies.
    await interim('let me check the files')
    await complete('the answer is 42')

    const texts = assistantMessages()
    expect(texts).toContain('let me check the files')
    expect(texts).toContain('the answer is 42')
    expect(texts).toHaveLength(2)
  })

  it('settles an identical final completion onto the interim when response_previewed', async () => {
    mountStream()
    await start()

    await interim('same reply')
    await completePreviewed('same reply')

    // With response_previewed, the final text is the same model response
    // that was published provisionally as an interim — settle onto the
    // existing interim instead of creating a duplicate. (#65919 review)
    const texts = assistantMessages()
    expect(texts.filter(t => t === 'same reply')).toHaveLength(1)
  })

  it('settles a prefix-matched final onto the interim when response_previewed', async () => {
    mountStream()
    await start()

    // Interim text is a PREFIX of the final — the model streamed part of
    // its answer before the verify nudge fired, then the final includes
    // the same text plus a trailing delta.
    await interim('partial answer')
    await completePreviewed('partial answer with more detail')

    // Prefix match: the final starts with the interim text, so settle
    // onto the interim instead of creating a duplicate bubble.
    const texts = assistantMessages()
    expect(texts.filter(t => t.includes('partial answer'))).toHaveLength(1)
    expect(texts[0]).toBe('partial answer with more detail')
  })

  it('dedupes partial-stream-then-nudge: streamed prefix + interim + previewed final settles to one bubble', async () => {
    mountStream()
    await start()

    // The model streamed part of its answer via message.delta, then the
    // verify nudge fired. The interim seals the streamed text, then the
    // final response is the same text plus a trailing delta.
    await delta('partial streamed')
    await interim('partial streamed')
    await completePreviewed('partial streamed answer continued')

    // One bubble, containing the full final text — not two.
    const texts = assistantMessages()
    expect(texts.filter(t => t.includes('partial streamed'))).toHaveLength(1)
    expect(texts[0]).toBe('partial streamed answer continued')
  })

  it('ignores malformed message.interim payload', async () => {
    mountStream()
    await start()

    // No payload at all
    await act(() => stream.handleEvent({ type: 'message.interim' } as RpcEvent))
    // Empty text
    await act(() => stream.handleEvent({ payload: { text: '' }, session_id: SID, type: 'message.interim' } as RpcEvent))
    // Undefined text
    await act(() =>
      stream.handleEvent({ payload: { text: undefined }, session_id: SID, type: 'message.interim' } as RpcEvent)
    )

    // Turn continues without finalizing or throwing
    expect(getState().busy).toBe(true)
    expect(getState().interimBoundaryPending).toBe(false)
  })

  it('clears interimBoundaryPending on message.start', async () => {
    mountStream()
    await start()

    await delta('interim text')
    await interim('interim text')
    expect(getState().interimBoundaryPending).toBe(true)

    // New turn starts
    await start()
    expect(getState().interimBoundaryPending).toBe(false)
  })

  it('binds the trailing optimistic user row to the accepted live turn', async () => {
    mountStream()
    stream.states.set(SID, {
      ...getState(),
      messages: [
        {
          id: 'user-optimistic',
          role: 'user',
          parts: [{ type: 'text', text: 'accepted prompt' }]
        }
      ]
    })

    await start('turn-accepted')

    expect(getState().messages[0].liveTurnId).toBe('turn-accepted')
  })
})
