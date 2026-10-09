/** Cursor OAuth session and browser-login lifecycle. Credentials stay in DSH. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseProviderJson } from './common.js'

export const CURSOR_CREDENTIAL_REF = credentialRef('CURSOR_SUBSCRIPTION_OAUTH')
const API_ORIGIN = 'https://api2.cursor.sh'
const REFRESH_AHEAD_MS = 5 * 60_000

export interface CursorCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

export interface CursorAuthStatus {
  authenticated: boolean
  busy: boolean
  expiresAt?: number
  error?: string
}

export interface CursorCredentialService {
  resolve(ref: typeof CURSOR_CREDENTIAL_REF): Promise<{ value: string } | undefined>
  set(ref: typeof CURSOR_CREDENTIAL_REF, value: string): Promise<void>
  unset(ref: typeof CURSOR_CREDENTIAL_REF): Promise<void>
}

async function parseCredential(value: string | undefined): Promise<CursorCredential | undefined> {
  if (value === undefined || value.length === 0) return undefined
  const parsed = await parseProviderJson(value, 'Cursor stored credential')
  if (parsed === null || typeof parsed !== 'object') throw new Error('Cursor credential is malformed')
  const item = parsed as Record<string, unknown>
  if (item.type !== 'oauth' || typeof item.access !== 'string' || item.access.length === 0
    || typeof item.refresh !== 'string' || typeof item.expires !== 'number' || !Number.isFinite(item.expires)) {
    throw new Error('Cursor credential is malformed')
  }
  return { type: 'oauth', access: item.access, refresh: item.refresh, expires: item.expires }
}

function tokenExpiry(token: string, now: number): number {
  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return now + 24 * 60 * 60_000
    const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const exp = (data as Record<string, unknown> | null)?.exp
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  } catch { /* JWTs without exp still receive a bounded lifetime. */ }
  return now + 24 * 60 * 60_000
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    function aborted() { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export class CursorAuth {
  private loginTask: { abort: AbortController; promise: Promise<void> } | undefined
  private error: string | undefined
  private refreshTask: Promise<CursorCredential> | undefined

  constructor(
    private readonly credentials: CursorCredentialService,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(): Promise<CursorCredential | undefined> {
    return parseCredential((await this.credentials.resolve(CURSOR_CREDENTIAL_REF))?.value)
  }

  async status(): Promise<CursorAuthStatus> {
    const current = await this.read()
    return {
      authenticated: current !== undefined,
      busy: this.loginTask !== undefined,
      ...(current === undefined ? {} : { expiresAt: current.expires }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  async accessToken({ signal }: { signal?: AbortSignal } = {}): Promise<string> {
    signal?.throwIfAborted()
    const current = await this.read()
    if (current === undefined) throw new Error('Cursor is not signed in')
    if (current.expires - this.now() > REFRESH_AHEAD_MS) return current.access
    if (current.refresh.length === 0) throw new Error('Cursor sign-in needs to be renewed')
    if (this.refreshTask === undefined) {
      const pending = this.refresh(current, signal)
      this.refreshTask = pending
      void pending.finally(() => { if (this.refreshTask === pending) this.refreshTask = undefined }).catch(() => undefined)
    }
    return (await this.refreshTask).access
  }

  private async refresh(current: CursorCredential, signal?: AbortSignal): Promise<CursorCredential> {
    const response = await this.http(`${API_ORIGIN}/auth/exchange_user_api_key`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${current.refresh}`, accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`Cursor token refresh failed (HTTP ${response.status})`)
    const body = await parseProviderJson(response, 'Cursor token refresh') as Record<string, unknown>
    if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
      throw new Error('Cursor token refresh returned no access token')
    }
    const next: CursorCredential = {
      type: 'oauth', access: body.accessToken,
      refresh: typeof body.refreshToken === 'string' && body.refreshToken.length > 0 ? body.refreshToken : current.refresh,
      expires: tokenExpiry(body.accessToken, this.now()),
    }
    const latest = await this.read()
    if (latest === undefined) throw new Error('Cursor signed out during token refresh')
    if (latest.refresh !== current.refresh) return latest
    await this.credentials.set(CURSOR_CREDENTIAL_REF, JSON.stringify(next))
    return next
  }

  /** Return a Cursor browser URL immediately; polling continues on the host. */
  async login(): Promise<{ authorizeUrl: string }> {
    await this.cancel()
    this.error = undefined
    const verifier = randomBytes(96).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const uuid = randomUUID()
    const url = new URL('https://cursor.com/loginDeepControl')
    url.search = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' }).toString()
    const abort = new AbortController()
    const promise = this.pollLogin(uuid, verifier, abort.signal)
      .catch(error => { if (!abort.signal.aborted) this.error = error instanceof Error ? error.message : String(error) })
      .finally(() => { if (this.loginTask?.abort === abort) this.loginTask = undefined })
    this.loginTask = { abort, promise }
    return { authorizeUrl: url.href }
  }

  private async pollLogin(uuid: string, verifier: string, signal: AbortSignal): Promise<void> {
    let delay = 1000
    for (let attempt = 0; attempt < 150; attempt++) {
      await abortableDelay(delay, signal)
      const url = `${API_ORIGIN}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
      const response = await this.http(url, { headers: { accept: 'application/json' }, redirect: 'error', signal })
      if (response.status === 404) { delay = Math.min(Math.ceil(delay * 1.2), 10_000); continue }
      if (!response.ok) throw new Error(`Cursor login failed (HTTP ${response.status})`)
      const body = await parseProviderJson(response, 'Cursor login poll') as Record<string, unknown>
      signal.throwIfAborted()
      if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
        throw new Error('Cursor login returned no access token')
      }
      if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
        throw new Error('Cursor login returned no refresh token')
      }
      const value: CursorCredential = {
        type: 'oauth', access: body.accessToken,
        refresh: body.refreshToken,
        expires: tokenExpiry(body.accessToken, this.now()),
      }
      await this.credentials.set(CURSOR_CREDENTIAL_REF, JSON.stringify(value))
      return
    }
    throw new Error('Cursor login timed out')
  }

  async cancel(): Promise<void> {
    const task = this.loginTask
    task?.abort.abort(new Error('Cursor login cancelled'))
    await task?.promise
    if (this.loginTask === task) this.loginTask = undefined
    this.error = undefined
  }

  async logout(): Promise<void> {
    await this.cancel()
    await this.credentials.unset(CURSOR_CREDENTIAL_REF)
  }
}
