import { writeFileSync } from 'node:fs'

import type { ScrollBoxHandle } from '@hermes/ink'
import { evictInkCaches } from '@hermes/ink'
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'

import { buildSetupRequiredSections, SETUP_REQUIRED_TITLE } from '../content/setup.js'
import { introMsg, toTranscriptMessages } from '../domain/messages.js'
import { ZERO } from '../domain/usage.js'
import { type GatewayClient } from '../gatewayClient.js'
import type {
  SessionActivateResponse,
  SessionCloseResponse,
  SessionCreateResponse,
  SessionInflightTurn,
  SessionResumeResponse,
  SessionTitleResponse,
  SetupStatusResponse
} from '../gatewayTypes.js'
import { streamedInterimPrefixLength } from '../lib/interimBoundary.js'
import { asRpcResult } from '../lib/rpc.js'
import type { Msg, PanelSection, SessionInfo, Usage } from '../types.js'

import type { ComposerActions, GatewayRpc, StateSetter } from './interfaces.js'
import { patchOverlayState } from './overlayStore.js'
import { scheduleResumeScrollToBottom } from './sessionResumeView.js'
import { turnController } from './turnController.js'
import { patchTurnState } from './turnStore.js'
import { getUiState, patchUiState } from './uiStore.js'

export { refreshSessionView, scheduleResumeScrollToBottom } from './sessionResumeView.js'

const usageFrom = (info: null | SessionInfo): Usage => (info?.usage ? { ...ZERO, ...info.usage } : ZERO)

const statusFromLiveSession = (status?: string, running = false) => {
  if (status === 'waiting') {
    return 'waiting for input…'
  }

  if (status === 'starting') {
    return 'starting agent…'
  }

  return running || status === 'working' ? 'running…' : 'ready'
}

export const writeActiveSessionFile = (sessionId: null | string, file = process.env.HERMES_TUI_ACTIVE_SESSION_FILE) => {
  if (!file || !sessionId) {
    return
  }

  try {
    writeFileSync(file, JSON.stringify({ session_id: sessionId }), { mode: 0o600 })
  } catch {
    // Best-effort shell epilogue hint only; never break live session changes.
  }
}

export const liveSessionInflightMessages = (inflight?: null | SessionInflightTurn): Msg[] => {
  const user = String(inflight?.user ?? '').trim()
  const error = String(inflight?.error ?? '').trim()

  if (error) {
    return failedSessionInflightMessages(inflight ?? {}, user, error)
  }

  return user ? [{ role: 'user', text: user }] : []
}

interface LiveInterimBoundary {
  alreadyStreamed: boolean
  arrivalSequence: null | number
  assistantOffset: null | number
  segmentId: string
  text: string
}

export const liveSessionInterimBoundaries = (inflight?: null | SessionInflightTurn): LiveInterimBoundary[] => {
  const rawInterim: unknown = inflight?.interim

  return Array.isArray(rawInterim)
    ? rawInterim.flatMap(raw => {
        if (!raw || typeof raw !== 'object') {
          return []
        }

        const boundary = raw as Record<string, unknown>

        const assistantOffset =
          typeof boundary.assistant_offset === 'number' &&
          Number.isInteger(boundary.assistant_offset) &&
          boundary.assistant_offset >= 0
            ? boundary.assistant_offset
            : null

        const segmentId = typeof boundary.segment_id === 'string' ? boundary.segment_id.trim() : ''
        const text = typeof boundary.text === 'string' ? boundary.text : ''
        const arrivalSequence =
          typeof boundary.arrival_sequence === 'number' &&
          Number.isInteger(boundary.arrival_sequence) &&
          boundary.arrival_sequence > 0
            ? boundary.arrival_sequence
            : null

        return segmentId && text
          ? [{ alreadyStreamed: Boolean(boundary.already_streamed), arrivalSequence, assistantOffset, segmentId, text }]
          : []
      })
    : []
}

interface LiveCorrectionBoundary {
  assistantOffset: null | number
  index: number
  sequence: null | number
  text: string
}

const liveSessionCorrectionBoundaries = (inflight?: null | SessionInflightTurn): LiveCorrectionBoundary[] => {
  if (!Array.isArray(inflight?.corrections)) {
    return []
  }

  return inflight.corrections.flatMap((value, index) => {
    const text = String(value ?? '').trim()
    const rawOffset = inflight.correction_offsets?.[index]
    const rawSequence = inflight.correction_sequences?.[index]
    const assistantOffset =
      typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : null
    const sequence =
      typeof rawSequence === 'number' && Number.isInteger(rawSequence) && rawSequence > 0 ? rawSequence : null

    return text ? [{ assistantOffset, index, sequence, text }] : []
  })
}

const failedSessionInflightMessages = (inflight: SessionInflightTurn, user: string, error: string): Msg[] => {
  const assistant = String(inflight.assistant ?? '')
  const interim = liveSessionInterimBoundaries(inflight)
  const corrections = liveSessionCorrectionBoundaries(inflight)
  const correctionOffsetsUsable =
    corrections.length > 0 && corrections.every(boundary => boundary.assistantOffset !== null)
  const messages: Msg[] = user ? [{ role: 'user', text: user }] : []
  const seenInterimIds = new Set<string>()
  let assistantCursor = 0

  const pushAssistant = (text: string) => {
    if (text) {
      messages.push({ role: 'assistant', text })
    }
  }

  const timeline = [
    ...interim.flatMap((boundary, index) =>
      boundary.assistantOffset === null
        ? []
        : [{ boundary, index, kind: 'interim' as const, offset: boundary.assistantOffset }]
    ),
    ...(correctionOffsetsUsable
      ? corrections.map(boundary => ({
          boundary,
          index: boundary.index,
          kind: 'correction' as const,
          offset: boundary.assistantOffset!
        }))
      : [])
  ].sort((a, b) => {
    if (a.offset !== b.offset) {
      return a.offset - b.offset
    }

    const aSequence = a.kind === 'interim' ? a.boundary.arrivalSequence : a.boundary.sequence
    const bSequence = b.kind === 'interim' ? b.boundary.arrivalSequence : b.boundary.sequence

    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) {
      return aSequence - bSequence
    }

    return a.kind === b.kind ? a.index - b.index : a.kind === 'interim' ? -1 : 1
  })

  for (const item of timeline) {
    if (item.kind === 'correction') {
      const offset = Math.min(Math.max(item.offset, assistantCursor), assistant.length)

      pushAssistant(assistant.slice(assistantCursor, offset))
      assistantCursor = offset
      messages.push({ role: 'user', text: item.boundary.text })

      continue
    }

    const boundary = item.boundary

    if (seenInterimIds.has(boundary.segmentId) || item.offset < assistantCursor || item.offset > assistant.length) {
      continue
    }

    const streamedChunk = assistant.slice(assistantCursor, item.offset)
    const overlapLength = streamedInterimPrefixLength(streamedChunk, boundary.text)

    if (overlapLength > 0) {
      pushAssistant(streamedChunk.slice(0, streamedChunk.length - overlapLength))
    } else {
      if (boundary.alreadyStreamed) {
        continue
      }

      pushAssistant(streamedChunk)
    }

    assistantCursor = item.offset
    seenInterimIds.add(boundary.segmentId)
    messages.push({ role: 'assistant', text: boundary.text })
  }

  for (const boundary of interim) {
    if (boundary.assistantOffset !== null || seenInterimIds.has(boundary.segmentId)) {
      continue
    }

    if (boundary.alreadyStreamed) {
      if (!assistant.slice(assistantCursor).startsWith(boundary.text)) {
        continue
      }

      assistantCursor += boundary.text.length
    } else {
      pushAssistant(assistant.slice(assistantCursor))
      assistantCursor = assistant.length
    }

    seenInterimIds.add(boundary.segmentId)
    messages.push({ role: 'assistant', text: boundary.text })
  }

  pushAssistant(assistant.slice(assistantCursor))

  if (!correctionOffsetsUsable) {
    corrections.forEach(boundary => messages.push({ role: 'user', text: boundary.text }))
  }

  messages.push({ role: 'system', text: `error: ${error}` })

  return messages
}

export const hydrateLiveSessionInflight = (inflight?: null | SessionInflightTurn) => {
  const assistant = String(inflight?.assistant ?? '')
  const interim = liveSessionInterimBoundaries(inflight)
  const corrections = liveSessionCorrectionBoundaries(inflight)
  let assistantCursor = 0

  if (String(inflight?.error ?? '').trim()) {
    turnController.recordError()

    return
  }

  if (!assistant && !inflight?.streaming && !interim.length && !corrections.length) {
    return
  }

  const correctionOffsetsUsable =
    corrections.length > 0 && corrections.every(boundary => boundary.assistantOffset !== null)
  const timeline = [
    ...interim.flatMap((boundary, index) =>
      boundary.assistantOffset === null
        ? []
        : [{ boundary, index, kind: 'interim' as const, offset: boundary.assistantOffset }]
    ),
    ...(correctionOffsetsUsable
      ? corrections.map(boundary => ({
          boundary,
          index: boundary.index,
          kind: 'correction' as const,
          offset: boundary.assistantOffset!
        }))
      : [])
  ].sort((a, b) => {
    if (a.offset !== b.offset) {
      return a.offset - b.offset
    }

    const aSequence = a.kind === 'interim' ? a.boundary.arrivalSequence : a.boundary.sequence
    const bSequence = b.kind === 'interim' ? b.boundary.arrivalSequence : b.boundary.sequence

    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) {
      return aSequence - bSequence
    }

    return a.kind === b.kind ? a.index - b.index : a.kind === 'interim' ? -1 : 1
  })

  for (const item of timeline) {
    if (item.kind === 'correction') {
      const offset = Math.min(Math.max(item.offset, assistantCursor), assistant.length)

      turnController.hydrateStreamingText(assistant.slice(assistantCursor, offset))
      turnController.flushStreamingSegment()
      assistantCursor = offset
      turnController.recordCorrectionMessage(item.boundary.text)

      continue
    }

    const boundary = item.boundary

    if (turnController.hasInterimSegment(boundary.segmentId)) {
      continue
    }

    const assistantOffset = boundary.assistantOffset
    let effectiveAlreadyStreamed = boundary.alreadyStreamed

    if (assistantOffset! < assistantCursor || assistantOffset! > assistant.length) {
      continue
    }

    const streamedChunk = assistant.slice(assistantCursor, assistantOffset!)
    const overlapLength = streamedInterimPrefixLength(streamedChunk, boundary.text)

    if (overlapLength > 0) {
      effectiveAlreadyStreamed = true
      turnController.hydrateStreamingText(streamedChunk.slice(0, streamedChunk.length - overlapLength))
      turnController.flushStreamingSegment()
    } else {
      if (boundary.alreadyStreamed) {
        continue
      }

      turnController.hydrateStreamingText(streamedChunk)
      turnController.flushStreamingSegment()
    }

    assistantCursor = assistantOffset!
    turnController.recordInterimMessage(boundary.text, boundary.segmentId, effectiveAlreadyStreamed)
  }

  for (const boundary of interim) {
    if (boundary.assistantOffset !== null || turnController.hasInterimSegment(boundary.segmentId)) {
      continue
    }

    if (boundary.alreadyStreamed) {
      if (!assistant.slice(assistantCursor).startsWith(boundary.text)) {
        continue
      }

      assistantCursor += boundary.text.length
    } else {
      turnController.hydrateStreamingText(assistant.slice(assistantCursor))
      turnController.flushStreamingSegment()
      assistantCursor = assistant.length
    }

    turnController.recordInterimMessage(boundary.text, boundary.segmentId, boundary.alreadyStreamed)
  }

  turnController.hydrateStreamingText(assistant.slice(assistantCursor))

  if (!correctionOffsetsUsable) {
    for (const boundary of corrections) {
      turnController.recordCorrectionMessage(boundary.text)
    }
  }
}

export const signalFreshSessionBoundary = (
  previousSid: null | string,
  nextSid: null | string,
  onFreshSessionStarted?: (sessionId: string) => void
) => {
  if (!previousSid || !nextSid || previousSid === nextSid || !onFreshSessionStarted) {
    return false
  }

  onFreshSessionStarted(nextSid)

  return true
}

const trimTail = (items: Msg[]) => {
  const q = [...items]

  while (q.at(-1)?.role === 'assistant' || q.at(-1)?.role === 'tool') {
    q.pop()
  }

  if (q.at(-1)?.role === 'user') {
    q.pop()
  }

  return q
}

export interface UseSessionLifecycleOptions {
  colsRef: { current: number }
  composerActions: ComposerActions
  gw: GatewayClient
  onFreshSessionStarted?: (sessionId: string) => void
  panel: (title: string, sections: PanelSection[]) => void
  rpc: GatewayRpc
  scrollRef: RefObject<null | ScrollBoxHandle>
  setHistoryItems: StateSetter<Msg[]>
  setLastUserMsg: StateSetter<string>
  setSessionStartedAt: StateSetter<number>
  setStickyPrompt: StateSetter<string>
  setVoiceProcessing: StateSetter<boolean>
  setVoiceRecording: StateSetter<boolean>
  sys: (text: string) => void
}

export function useSessionLifecycle(opts: UseSessionLifecycleOptions) {
  const {
    colsRef,
    composerActions,
    gw,
    onFreshSessionStarted,
    panel,
    rpc,
    scrollRef,
    setHistoryItems,
    setLastUserMsg,
    setSessionStartedAt,
    setStickyPrompt,
    setVoiceProcessing,
    setVoiceRecording,
    sys
  } = opts

  const closeSession = useCallback(
    (targetSid?: null | string) =>
      targetSid ? rpc<SessionCloseResponse>('session.close', { session_id: targetSid }) : Promise.resolve(null),
    [rpc]
  )

  const cancelResumeScrollRef = useRef<null | (() => void)>(null)

  const resetSession = useCallback(() => {
    cancelResumeScrollRef.current?.()
    cancelResumeScrollRef.current = null
    turnController.fullReset()
    setVoiceRecording(false)
    setVoiceProcessing(false)
    patchUiState({ bgTasks: new Set(), info: null, sid: null, usage: ZERO })
    setHistoryItems([])
    setLastUserMsg('')
    setStickyPrompt('')
    composerActions.setComposerTokens([])
    // Half-prune: new session has new keys, but keep a warm pool in case
    // the user resumes back to the prior session.
    evictInkCaches('half')
  }, [composerActions, setHistoryItems, setLastUserMsg, setStickyPrompt, setVoiceProcessing, setVoiceRecording])

  useEffect(
    () => () => {
      cancelResumeScrollRef.current?.()
      cancelResumeScrollRef.current = null
    },
    []
  )

  const resetVisibleHistory = useCallback(
    (info: null | SessionInfo = null) => {
      turnController.idle()
      turnController.clearReasoning()
      turnController.turnTools = []
      turnController.persistedToolLabels.clear()

      setHistoryItems(info ? [introMsg(info)] : [])
      setStickyPrompt('')
      setLastUserMsg('')
      composerActions.setComposerTokens([])
      patchTurnState({ activity: [] })
      patchUiState({ info, usage: usageFrom(info) })
    },
    [composerActions, setHistoryItems, setLastUserMsg, setStickyPrompt]
  )

  const startNewSession = useCallback(
    async (msg?: string, title?: string, keepCurrent = false) => {
      const setup = await rpc<SetupStatusResponse>('setup.status', {})

      if (setup?.provider_configured === false) {
        panel(SETUP_REQUIRED_TITLE, buildSetupRequiredSections())
        patchUiState({ status: 'setup required' })

        return null
      }

      const previousSid = getUiState().sid

      if (!keepCurrent) {
        await closeSession(previousSid)
      }

      const r = await rpc<SessionCreateResponse>('session.create', { cols: colsRef.current })

      if (!r) {
        patchUiState({ status: 'ready' })

        return null
      }

      const info = r.info ?? null
      const requestedTitle = title?.trim() ?? ''

      resetSession()
      setSessionStartedAt(Date.now())

      writeActiveSessionFile(r.session_id)
      patchUiState({
        info,
        sid: r.session_id,
        status: info?.version ? 'ready' : 'starting agent…',
        usage: usageFrom(info)
      })

      if (info) {
        setHistoryItems([introMsg(info)])
      }

      if (info?.credential_warning) {
        sys(`warning: ${info.credential_warning}`)
      }

      if (info?.config_warning) {
        sys(`warning: ${info.config_warning}`)
      }

      if (msg) {
        sys(msg)
      }

      if (requestedTitle) {
        rpc<SessionTitleResponse>('session.title', {
          session_id: r.session_id,
          title: requestedTitle
        })
          .then(result => {
            if (!result || getUiState().sid !== r.session_id) {
              return
            }

            const nextTitle = (result.title ?? requestedTitle).trim()
            const suffix = result.pending ? ' (queued while session initializes)' : ''
            patchUiState({ sessionTitle: nextTitle })
            sys(`session title set: ${nextTitle}${suffix}`)
          })
          .catch((err: unknown) => {
            if (getUiState().sid !== r.session_id) {
              return
            }

            const message = err instanceof Error ? err.message : String(err)
            sys(`warning: failed to set session title: ${message}`)
          })
      }

      signalFreshSessionBoundary(previousSid, r.session_id, onFreshSessionStarted)

      return r.session_id
    },
    [closeSession, colsRef, onFreshSessionStarted, panel, resetSession, rpc, setHistoryItems, setSessionStartedAt, sys]
  )

  const newSession = useCallback(
    (msg?: string, title?: string) => startNewSession(msg, title, false),
    [startNewSession]
  )

  const newLiveSession = useCallback(
    (msg = 'new live session started', title?: string) => {
      patchOverlayState({ sessions: false })

      return startNewSession(msg, title, true)
    },
    [startNewSession]
  )

  const activateLiveSession = useCallback(
    (id: string) => {
      patchOverlayState({ sessions: false })
      patchUiState({ status: 'switching session…' })

      gw.request<SessionActivateResponse>('session.activate', { session_id: id })
        .then(raw => {
          const r = asRpcResult<SessionActivateResponse>(raw)

          if (!r) {
            sys('error: invalid response: session.activate')

            return patchUiState({ status: 'ready' })
          }

          const info = r.info ?? null
          const running = Boolean(r.running || r.status === 'working' || r.status === 'waiting')

          resetSession()
          setSessionStartedAt(r.started_at ? r.started_at * 1000 : Date.now())
          const transcript = [...toTranscriptMessages(r.messages), ...liveSessionInflightMessages(r.inflight)]
          setHistoryItems(info ? [introMsg(info), ...transcript] : transcript)
          writeActiveSessionFile(r.session_key ?? r.session_id)
          patchUiState({
            busy: running,
            info,
            sid: r.session_id,
            status: statusFromLiveSession(r.status, running),
            usage: usageFrom(info)
          })
          hydrateLiveSessionInflight(r.inflight)
          cancelResumeScrollRef.current?.()
          cancelResumeScrollRef.current = scheduleResumeScrollToBottom(scrollRef)
        })
        .catch((e: Error) => {
          sys(`error: ${e.message}`)
          patchUiState({ status: 'ready' })
        })
    },
    [gw, resetSession, scrollRef, setHistoryItems, setSessionStartedAt, sys]
  )

  const resumeById = useCallback(
    (id: string) => {
      patchOverlayState({ sessions: false })
      patchUiState({ status: 'resuming…' })

      rpc<SetupStatusResponse>('setup.status', {}).then(setup => {
        if (setup?.provider_configured === false) {
          panel(SETUP_REQUIRED_TITLE, buildSetupRequiredSections())
          patchUiState({ status: 'setup required' })

          return
        }

        const previousSid = getUiState().sid

        gw.request<SessionResumeResponse>('session.resume', { cols: colsRef.current, session_id: id })
          .then(raw => {
            const r = asRpcResult<SessionResumeResponse>(raw)

            if (!r) {
              sys('error: invalid response: session.resume')

              return patchUiState({ status: 'ready' })
            }

            const info = r.info ?? null
            const running = Boolean(r.running || r.status === 'working' || r.status === 'waiting')

            resetSession()
            setSessionStartedAt(r.started_at ? r.started_at * 1000 : Date.now())

            const resumed = [...toTranscriptMessages(r.messages), ...liveSessionInflightMessages(r.inflight)]

            setHistoryItems(info ? [introMsg(info), ...resumed] : resumed)
            writeActiveSessionFile(r.resumed ?? r.session_id)
            patchUiState({
              busy: running,
              info,
              sid: r.session_id,
              status: statusFromLiveSession(r.status, running),
              usage: usageFrom(info)
            })
            hydrateLiveSessionInflight(r.inflight)
            cancelResumeScrollRef.current?.()
            cancelResumeScrollRef.current = scheduleResumeScrollToBottom(scrollRef)

            if (previousSid && previousSid !== r.session_id) {
              void closeSession(previousSid)
            }
          })
          .catch((e: Error) => {
            sys(`error: ${e.message}`)
            patchUiState({ status: 'ready' })
          })
      })
    },
    [closeSession, colsRef, gw, panel, resetSession, rpc, scrollRef, setHistoryItems, setSessionStartedAt, sys]
  )

  const guardBusySessionSwitch = useCallback(
    (what = 'switch sessions') => {
      if (!getUiState().busy) {
        return false
      }

      sys(`interrupt the current turn before trying to ${what}`)

      return true
    },
    [sys]
  )

  return useMemo(
    () => ({
      activateLiveSession,
      closeSession,
      guardBusySessionSwitch,
      newLiveSession,
      newSession,
      resetSession,
      resetVisibleHistory,
      resumeById,
      trimLastExchange: trimTail
    }),
    [
      activateLiveSession,
      closeSession,
      guardBusySessionSwitch,
      newLiveSession,
      newSession,
      resetSession,
      resetVisibleHistory,
      resumeById,
      trimTail
    ]
  )
}
