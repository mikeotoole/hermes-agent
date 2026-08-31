import { useGatewayBoot } from '@/app/gateway/hooks/use-gateway-boot'
import {
  gatewayActivationEpoch,
  replayGapMatchesActiveGateway,
  replayGapRecoveryStillCurrent,
  type ScopedReplayGap
} from '@/store/gateway'
import { notifyError } from '@/store/notifications'

type GatewayBootOptions = Parameters<typeof useGatewayBoot>[0]
type ResumeSession = (
  storedSessionId: string,
  showAll?: boolean,
  capturedOwner?: never,
  isContinuationCurrent?: () => boolean
) => Promise<unknown>

interface ContribGatewayBootOptions extends Omit<GatewayBootOptions, 'handleReplayGap'> {
  getActiveRuntimeId: () => null | string
  getSelectedStoredSessionId: () => null | string
  resumeSession: ResumeSession
}

/**
 * Register Contrib's gateway boot lifecycle and fail-closed replay-gap recovery.
 * The source scope, runtime membership, recovery call, and continuation fence
 * intentionally live together so the public callback can be tested as one path.
 */
export function useContribGatewayBoot({
  getActiveRuntimeId,
  getSelectedStoredSessionId,
  resumeSession,
  ...bootOptions
}: ContribGatewayBootOptions): void {
  useGatewayBoot({
    ...bootOptions,
    handleReplayGap: (gap: ScopedReplayGap) => {
      const activeRuntimeId = getActiveRuntimeId()
      const storedSessionId = getSelectedStoredSessionId()

      if (
        !activeRuntimeId ||
        !storedSessionId ||
        !gap.sessionIds.includes(activeRuntimeId) ||
        !replayGapMatchesActiveGateway(gap)
      ) {
        return
      }

      const acceptedActivationEpoch = gatewayActivationEpoch()
      const isGapSourceCurrent = () => replayGapRecoveryStillCurrent(gap, acceptedActivationEpoch)

      void resumeSession(storedSessionId, false, undefined, isGapSourceCurrent).catch(error => {
        if (!isGapSourceCurrent()) {
          return
        }

        notifyError(error, 'Failed to recover the active session after a reconnect gap')
      })
    }
  })
}
