import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { turnController } from '../app/turnController.js'
import { getTurnState, resetTurnState } from '../app/turnStore.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import {
  hydrateLiveSessionInflight,
  liveSessionInflightMessages,
  scheduleResumeScrollToBottom,
  signalFreshSessionBoundary,
  writeActiveSessionFile
} from '../app/useSessionLifecycle.js'

describe('fresh session boundary', () => {
  it('signals only when a live session is replaced by a different session', () => {
    const onFreshSessionStarted = vi.fn()

    expect(signalFreshSessionBoundary('old-session', 'new-session', onFreshSessionStarted)).toBe(true)
    expect(signalFreshSessionBoundary(null, 'first-session', onFreshSessionStarted)).toBe(false)
    expect(signalFreshSessionBoundary('same-session', 'same-session', onFreshSessionStarted)).toBe(false)
    expect(signalFreshSessionBoundary('old-session', null, onFreshSessionStarted)).toBe(false)
    expect(signalFreshSessionBoundary('old-session', 'new-session')).toBe(false)
    expect(onFreshSessionStarted).toHaveBeenCalledOnce()
    expect(onFreshSessionStarted).toHaveBeenCalledWith('new-session')
  })
})

describe('writeActiveSessionFile', () => {
  let dir = ''

  afterEach(() => {
    if (dir) {
      rmSync(dir, { force: true, recursive: true })
      dir = ''
    }
  })

  it('writes the actual resumed session id for the shell exit summary', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-tui-active-'))
    const path = join(dir, 'active.json')

    writeActiveSessionFile('actual_session', path)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ session_id: 'actual_session' })
  })
})

describe('live session activation in-flight state', () => {
  beforeEach(() => {
    resetUiState()
    resetTurnState()
    turnController.fullReset()
    patchUiState({ streaming: true })
  })

  it('keeps the in-flight user prompt in history and hydrates partial assistant text', () => {
    const inflight = { assistant: 'partial answer', streaming: true, user: 'write a long answer' }

    expect(liveSessionInflightMessages(inflight)).toEqual([{ role: 'user', text: 'write a long answer' }])

    hydrateLiveSessionInflight(inflight)

    expect(turnController.bufRef).toBe('partial answer')
    expect(getTurnState().streaming).toBe('partial answer')
  })

  it('hydrates stable interim boundaries and leaves only the unsealed tail streaming', () => {
    hydrateLiveSessionInflight({
      assistant: 'streamed checkpointremaining answer',
      streaming: true,
      user: 'current prompt',
      interim: [
        {
          already_streamed: true,
          assistant_offset: 'streamed checkpoint'.length,
          segment_id: 'stable-1',
          text: 'streamed checkpoint'
        },
        {
          already_streamed: false,
          assistant_offset: 'streamed checkpoint'.length,
          segment_id: 'stable-2',
          text: 'tool-call commentary'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual([
      'streamed checkpoint',
      'tool-call commentary'
    ])
    expect(turnController.bufRef).toBe('remaining answer')
    expect(getTurnState().streaming).toBe('remaining answer')
  })

  it('hydrates an exact commentary boundary without losing ordinary streamed text', () => {
    const prefix = 'ordinary answerhello   there'

    hydrateLiveSessionInflight({
      assistant: `${prefix}remaining answer`,
      streaming: true,
      interim: [
        {
          already_streamed: true,
          assistant_offset: prefix.length,
          segment_id: 'stable-normalized',
          text: 'hello   there'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual([
      'ordinary answer',
      'hello   there'
    ])
    expect(getTurnState().streaming).toBe('remaining answer')
  })

  it('does not duplicate a hydrated interim when replay delivers the same stable id', () => {
    hydrateLiveSessionInflight({
      assistant: 'streamed checkpointremaining answer',
      streaming: true,
      interim: [
        {
          already_streamed: true,
          assistant_offset: 'streamed checkpoint'.length,
          segment_id: 'stable-1',
          text: 'streamed checkpoint'
        }
      ]
    })

    turnController.recordInterimMessage('streamed checkpoint', 'stable-1', true)

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual(['streamed checkpoint'])
    expect(turnController.bufRef).toBe('remaining answer')
    expect(getTurnState().streaming).toBe('remaining answer')
  })

  it('restores same-offset interims and corrections in gateway arrival order', () => {
    const inflight = {
      assistant: 'draft',
      streaming: true,
      interim: [
        {
          already_streamed: false,
          arrival_sequence: 0,
          assistant_offset: 5,
          segment_id: 'stable-1',
          text: 'first commentary'
        },
        {
          already_streamed: false,
          arrival_sequence: 2,
          assistant_offset: 5,
          segment_id: 'stable-2',
          text: 'second commentary'
        }
      ],
      correction_entries: [{ arrival_sequence: 1, assistant_offset: 5, text: 'redirect' }]
    } as any

    hydrateLiveSessionInflight(inflight)

    expect(getTurnState().streamSegments.map(message => [message.role, message.text])).toEqual([
      ['assistant', 'draft'],
      ['assistant', 'first commentary'],
      ['user', 'redirect'],
      ['assistant', 'second commentary']
    ])
    expect(getTurnState().streaming).toBe('')

    hydrateLiveSessionInflight(inflight)

    expect(getTurnState().streamSegments.map(message => [message.role, message.text])).toEqual([
      ['assistant', 'draft'],
      ['assistant', 'first commentary'],
      ['user', 'redirect'],
      ['assistant', 'second commentary']
    ])
    expect(getTurnState().streaming).toBe('')
  })
  it('rejects offsets that split a UTF-16 surrogate pair', () => {
    hydrateLiveSessionInflight({
      assistant: 'A😀B',
      streaming: true,
      interim: [
        {
          already_streamed: false,
          assistant_offset: 2,
          segment_id: 'invalid-surrogate',
          text: 'must not render'
        }
      ],
      correction_entries: [{ assistant_offset: 2, text: 'must not redirect' }]
    })

    expect(getTurnState().streamSegments).toEqual([])
    expect(getTurnState().streaming).toBe('A😀B')
  })

  it('ignores empty in-flight payloads', () => {
    expect(liveSessionInflightMessages({ assistant: '', streaming: false, user: '   ' })).toEqual([])

    hydrateLiveSessionInflight({ assistant: '', streaming: false, user: '' })

    expect(turnController.bufRef).toBe('')
    expect(getTurnState().streaming).toBe('')
  })
})

describe('resume scroll settle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-snaps while sticky and stops when the user scrolls away', () => {
    vi.useFakeTimers()
    let sticky = true
    let lastManualScrollAt = 0
    const scrollToBottom = vi.fn()

    const cancel = scheduleResumeScrollToBottom(
      {
        current: {
          getLastManualScrollAt: () => lastManualScrollAt,
          isSticky: () => sticky,
          scrollToBottom
        }
      } as any,
      [0, 80, 240]
    )

    vi.advanceTimersByTime(0)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(80)
    expect(scrollToBottom).toHaveBeenCalledTimes(2)

    sticky = false
    lastManualScrollAt = Date.now() + 1
    vi.advanceTimersByTime(160)
    expect(scrollToBottom).toHaveBeenCalledTimes(2)

    cancel()
  })

  it('cancels pending resume snaps', () => {
    vi.useFakeTimers()
    const scrollToBottom = vi.fn()

    const cancel = scheduleResumeScrollToBottom(
      {
        current: {
          getLastManualScrollAt: () => 0,
          isSticky: () => true,
          scrollToBottom
        }
      } as any,
      [20]
    )

    cancel()
    vi.advanceTimersByTime(20)

    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('keeps the immediate resume snap even before sticky state settles', () => {
    vi.useFakeTimers()
    let sticky = false
    const scrollToBottom = vi.fn()

    const cancel = scheduleResumeScrollToBottom(
      {
        current: {
          getLastManualScrollAt: () => 0,
          isSticky: () => sticky,
          scrollToBottom
        }
      } as any,
      [0, 80]
    )

    vi.advanceTimersByTime(0)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(80)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)

    sticky = true
    cancel()
  })
})
