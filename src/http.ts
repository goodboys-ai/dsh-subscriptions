/** Host-managed network routing for subscription requests. */
import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net'

/** Keep a sufficient per-address connection budget on high-latency networks. */
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 1500

export function ensureConnectAttemptTimeout(
  minMs = MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
): number {
  const previous = getDefaultAutoSelectFamilyAttemptTimeout()
  if (previous < minMs) setDefaultAutoSelectFamilyAttemptTimeout(minMs)
  return previous
}

export function restoreConnectAttemptTimeout(previous: number): void {
  setDefaultAutoSelectFamilyAttemptTimeout(previous)
}

/** Use DSH's global fetch routing, including its configured network proxy. */
export const hostFetch: typeof fetch = (input, init) => fetch(input, init)
