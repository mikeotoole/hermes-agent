import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScopedReplayGap } from '@/store/gateway'

let activeProfile = 'active'
let bootOptions: null | { handleReplayGap: (gap: ScopedReplayGap) => void } = null

vi.mock('@/app/gateway/hooks/use-gateway-boot', () => ({
  useGatewayBoot: vi.fn((options: typeof bootOptions) => {
    bootOptions = options
  })
}))

vi.mock('@/store/gateway', () => ({
  gatewayActivationEpoch: vi.fn(() => 17),
  replayGapMatchesActiveGateway: vi.fn((gap: ScopedReplayGap) => gap.profile === activeProfile),
  replayGapRecoveryStillCurrent: vi.fn(
    (gap: ScopedReplayGap, activationEpoch: number) => gap.profile === activeProfile && activationEpoch === 17
  )
}))

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

import { notifyError } from '@/store/notifications'

import { useContribGatewayBoot } from './use-contrib-gateway-boot'

const noop = () => undefined
const noopAsync = async () => undefined

afterEach(() => {
  cleanup()
  activeProfile = 'active'
  bootOptions = null
  vi.clearAllMocks()
})

describe('useContribGatewayBoot replay-gap recovery', () => {
  it('ignores an inactive source sharing the runtime ID and recovers the active source exactly once', () => {
    const resumeSession = vi.fn(
      async (
        _storedSessionId: string,
        _showAll?: boolean,
        _capturedOwner?: never,
        _isContinuationCurrent?: () => boolean
      ) => undefined
    )

    renderHook(() =>
      useContribGatewayBoot({
        beforeConnectionSwitch: noop,
        getActiveRuntimeId: () => 'runtime-shared',
        getSelectedStoredSessionId: () => 'stored-active',
        handleGatewayEvent: noop,
        onConnectionReady: noop,
        onGatewayReady: noop,
        refreshHermesConfig: noopAsync,
        refreshSessions: noopAsync,
        resumeSession
      })
    )

    const inactiveGap: ScopedReplayGap = {
      connectionId: 'connection-a',
      profile: 'inactive',
      reason: 'truncated',
      sessionIds: ['runtime-shared']
    }

    const activeGap: ScopedReplayGap = {
      ...inactiveGap,
      connectionId: 'connection-b',
      profile: 'active'
    }

    act(() => bootOptions?.handleReplayGap(inactiveGap))
    expect(resumeSession).not.toHaveBeenCalled()

    act(() => bootOptions?.handleReplayGap(activeGap))
    expect(resumeSession).toHaveBeenCalledTimes(1)
    expect(resumeSession).toHaveBeenCalledWith('stored-active', false, undefined, expect.any(Function))

    const continuationFence = resumeSession.mock.calls[0][3]
    expect(continuationFence?.()).toBe(true)

    activeProfile = 'inactive'
    expect(continuationFence?.()).toBe(false)
  })

  it('suppresses recovery errors after the accepted source loses ownership', async () => {
    let rejectRecovery: (error: Error) => void = () => undefined

    const resumeSession = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectRecovery = reject
        })
    )

    renderHook(() =>
      useContribGatewayBoot({
        beforeConnectionSwitch: noop,
        getActiveRuntimeId: () => 'runtime-active',
        getSelectedStoredSessionId: () => 'stored-active',
        handleGatewayEvent: noop,
        onConnectionReady: noop,
        onGatewayReady: noop,
        refreshHermesConfig: noopAsync,
        refreshSessions: noopAsync,
        resumeSession
      })
    )

    act(() =>
      bootOptions?.handleReplayGap({
        connectionId: 'connection-active',
        profile: 'active',
        reason: 'truncated',
        sessionIds: ['runtime-active']
      })
    )
    expect(resumeSession).toHaveBeenCalledTimes(1)

    activeProfile = 'inactive'
    await act(async () => {
      rejectRecovery(new Error('stale recovery failure'))
      await Promise.resolve()
    })

    expect(notifyError).not.toHaveBeenCalled()
  })
})
