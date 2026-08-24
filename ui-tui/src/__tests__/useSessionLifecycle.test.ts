import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { turnController } from '../app/turnController.js'
import { getTurnState, resetTurnState } from '../app/turnStore.js'
import { getUiState, patchUiState, resetUiState } from '../app/uiStore.js'
import {
  hydrateLiveSessionInflight,
  liveSessionInflightMessages,
  scheduleResumeScrollToBottom,
  signalFreshSessionBoundary,
  useSessionLifecycle,
  writeActiveSessionFile
} from '../app/useSessionLifecycle.js'

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

const renderSessionLifecycle = (responses: Record<string, unknown>) => {
  let actions: null | ReturnType<typeof useSessionLifecycle> = null
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()

  Object.assign(stdout, { columns: 80, isTTY: false, rows: 20 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', () => {})

  function Harness() {
    actions = useSessionLifecycle({
      colsRef: { current: 80 },
      composerActions: { setComposerTokens: vi.fn() } as never,
      gw: {
        request: vi.fn(async (method: string) => responses[method]),
        send: vi.fn()
      } as never,
      panel: vi.fn(),
      rpc: vi.fn(async (method: string) =>
        method === 'setup.status' ? { provider_configured: true } : responses[method]
      ) as never,
      scrollRef: { current: null },
      setHistoryItems: vi.fn(),
      setLastUserMsg: vi.fn(),
      setSessionStartedAt: vi.fn(),
      setStickyPrompt: vi.fn(),
      setVoiceProcessing: vi.fn(),
      setVoiceRecording: vi.fn(),
      sys: vi.fn()
    })

    return null
  }

  const instance = renderSync(React.createElement(Harness), {
    patchConsole: false,
    stderr: stderr as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream
  })

  return {
    actions: () => actions!,
    cleanup: () => {
      instance.unmount()
      instance.cleanup()
    }
  }
}

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

  it('hydrates the activation response through the public activate action', async () => {
    const harness = renderSessionLifecycle({
      'session.activate': {
        inflight: { assistant: 'activated partial', streaming: true },
        messages: [],
        running: true,
        session_id: 'activated-session'
      }
    })

    try {
      harness.actions().activateLiveSession('activated-session')
      await flushPromises()

      expect(getTurnState().streaming).toBe('activated partial')
    } finally {
      harness.cleanup()
    }
  })

  it('hydrates the resume response through the public resume action', async () => {
    const harness = renderSessionLifecycle({
      'session.resume': {
        inflight: { assistant: 'resumed partial', streaming: true },
        messages: [],
        resumed: 'resumed-session',
        running: true,
        session_id: 'resumed-session'
      }
    })

    try {
      harness.actions().resumeById('resumed-session')
      await flushPromises()
      await flushPromises()

      expect(getTurnState().streaming).toBe('resumed partial')
    } finally {
      harness.cleanup()
    }
  })

  it('hydrates stable interim boundaries and leaves only the unsealed assistant tail streaming', () => {
    const inflight = {
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
    }

    hydrateLiveSessionInflight(inflight)
    turnController.recordInterimMessage('streamed checkpoint', 'stable-1', true)

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual([
      'streamed checkpoint',
      'tool-call commentary'
    ])
    expect(turnController.bufRef).toBe('remaining answer')
    expect(getTurnState().streaming).toBe('remaining answer')
  })

  it('hydrates streamed text around commentary and ignores mismatched streamed boundaries', () => {
    hydrateLiveSessionInflight({
      assistant: '😀streamed prefixtail',
      streaming: true,
      interim: [
        {
          already_streamed: false,
          assistant_offset: '😀streamed prefix'.length,
          segment_id: 'stable-commentary',
          text: 'tool-call commentary'
        },
        {
          already_streamed: true,
          assistant_offset: '😀streamed prefixtail'.length,
          segment_id: 'bad',
          text: 'wrong'
        },
        {
          already_streamed: true,
          assistant_offset: '😀streamed prefixtail'.length,
          segment_id: 'bad',
          text: 'tail'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual([
      '😀streamed prefix',
      'tool-call commentary',
      'tail'
    ])
    expect(getTurnState().streaming).toBe('')
  })

  it('rejects a repeated stable id before it consumes later assistant text', () => {
    hydrateLiveSessionInflight({
      assistant: 'abcXYZ',
      streaming: true,
      interim: [
        {
          already_streamed: true,
          assistant_offset: 3,
          segment_id: 'stable-repeat',
          text: 'abc'
        },
        {
          already_streamed: true,
          assistant_offset: 6,
          segment_id: 'stable-repeat',
          text: 'XYZ'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual(['abc'])
    expect(getTurnState().streaming).toBe('XYZ')
  })

  it('hydrates the authoritative interim when only its prefix reached the stream snapshot', () => {
    hydrateLiveSessionInflight({
      assistant: 'hello',
      streaming: true,
      interim: [
        {
          already_streamed: true,
          assistant_offset: 'hello'.length,
          segment_id: 'stable-partial',
          text: 'hello world'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual(['hello world'])
    expect(turnController.bufRef).toBe('')
    expect(getTurnState().streaming).toBe('')
  })

  it('replaces a truncated snapshot prefix when the producer marks the full interim non-streamed', () => {
    hydrateLiveSessionInflight({
      assistant: 'hello',
      streaming: true,
      interim: [
        {
          already_streamed: false,
          assistant_offset: 'hello'.length,
          segment_id: 'stable-partial-false',
          text: 'hello world'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual(['hello world'])
    expect(turnController.bufRef).toBe('')
    expect(getTurnState().streaming).toBe('')
  })

  it('hydrates a whitespace-normalized interim after preserving ordinary streamed text', () => {
    const assistant = 'ordinary prefix hello   there'
    hydrateLiveSessionInflight({
      assistant,
      streaming: true,
      interim: [
        {
          already_streamed: true,
          assistant_offset: assistant.length,
          segment_id: 'stable-normalized-partial',
          text: 'hello there world'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text.trim())).toEqual([
      'ordinary prefix',
      'hello there world'
    ])
    expect(turnController.bufRef).toBe('')
    expect(getTurnState().streaming).toBe('')
  })

  it('preserves streamed-before-commentary ordering for old snapshots without prefixes', () => {
    hydrateLiveSessionInflight({
      assistant: 'streamed prefix',
      streaming: true,
      interim: [
        {
          already_streamed: false,
          segment_id: 'legacy-commentary',
          text: 'tool-call commentary'
        }
      ]
    })

    expect(getTurnState().streamSegments.map(message => message.text)).toEqual([
      'streamed prefix',
      'tool-call commentary'
    ])
    expect(getTurnState().streaming).toBe('')
  })

  it.each([
    {
      correctionSequence: 1,
      expected: [
        ['assistant', 'before'],
        ['user', 'redirect this'],
        ['assistant', 'checkpoint'],
        ['assistant', 'after']
      ],
      interimSequence: 2
    },
    {
      correctionSequence: 2,
      expected: [
        ['assistant', 'before'],
        ['assistant', 'checkpoint'],
        ['user', 'redirect this'],
        ['assistant', 'after']
      ],
      interimSequence: 1
    }
  ])(
    'orders a correction and interim sharing an offset by arrival sequence ($correctionSequence/$interimSequence)',
    ({ correctionSequence, expected, interimSequence }) => {
      hydrateLiveSessionInflight({
        assistant: 'beforeafter',
        correction_offsets: ['before'.length],
        correction_sequences: [correctionSequence],
        corrections: ['redirect this'],
        streaming: true,
        interim: [
          {
            already_streamed: false,
            arrival_sequence: interimSequence,
            assistant_offset: 'before'.length,
            segment_id: `stable-${interimSequence}`,
            text: 'checkpoint'
          }
        ]
      })

      expect(getTurnState().streamSegments.map(message => [message.role, message.text])).toEqual(expected.slice(0, -1))
      expect(['assistant', getTurnState().streaming]).toEqual(expected.at(-1))
    }
  )

  it('settles a retained failed turn as partial output plus an error instead of a live stream', () => {
    patchUiState({ busy: true })
    const inflight = {
      assistant: 'partial answer',
      error: 'provider disconnected',
      recoverable: true,
      status: 'error',
      streaming: false,
      user: 'current prompt'
    }

    expect(liveSessionInflightMessages(inflight)).toEqual([
      { role: 'user', text: 'current prompt' },
      { role: 'assistant', text: 'partial answer' },
      { role: 'system', text: 'error: provider disconnected' }
    ])

    hydrateLiveSessionInflight(inflight)

    expect(getTurnState().streamSegments).toEqual([])
    expect(getTurnState().streaming).toBe('')
    expect(getUiState().busy).toBe(false)
  })

  it('preserves commentary inside a retained failed turn before settling its error', () => {
    const inflight = {
      assistant: 'beforeafter',
      error: 'provider disconnected',
      recoverable: true,
      status: 'error',
      streaming: false,
      user: 'current prompt',
      interim: [
        {
          already_streamed: false,
          assistant_offset: 'before'.length,
          segment_id: 'failed-commentary',
          text: 'checkpoint'
        }
      ]
    }

    expect(liveSessionInflightMessages(inflight)).toEqual([
      { role: 'user', text: 'current prompt' },
      { role: 'assistant', text: 'before' },
      { role: 'assistant', text: 'checkpoint' },
      { role: 'assistant', text: 'after' },
      { role: 'system', text: 'error: provider disconnected' }
    ])
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
