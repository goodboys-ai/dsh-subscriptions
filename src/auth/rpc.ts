/**
 * The `subscriptions-auth` host RPC endpoints the web Settings page drives.
 * They are mounted as exact POST Fetch routes on the shared `/api` channel
 * (`/api/subscriptions-auth.<endpoint>`) and registered only when a host
 * `connection` service exists (the web profile); headless compositions load
 * the plugin without it. All business outcomes are returned as RpcResult
 * values; handlers never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '../compat.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PROVIDER_IDS, type ProviderId } from './store.js'
import type { ProviderUsage } from '../providers/common.js'
import type { CliVersion } from '../providers/npm-cli-version.js'
import { EXTERNAL_USAGE_SOURCES } from '../providers/external-usage-controller.js'
import type { ExternalUsageSource, ExternalUsageStatus } from '../providers/external-usage-controller.js'
import type { CursorAuthStatus } from '../providers/cursor-auth.js'

/**
 * Endpoint-name prefix under the shared `/api` channel: endpoint `status`
 * is served at `/api/subscriptions-auth.status`. The browser half calls
 * `rpc.call('/api', 'subscriptions-auth.status', payload)`.
 */
export const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.'

/**
 * Every endpoint {@link dispatch} answers; each gets one exact Fetch route.
 * Kept in one place so the route table and the switch cannot drift apart.
 */
export const SUBSCRIPTIONS_AUTH_ENDPOINTS = [
  'providerSettings', 'setProviderSettings',
  'status', 'login', 'manual', 'cancel', 'logout', 'setDefault', 'usage',
  'externalStatus', 'externalUsage',
  'cursorStatus', 'cursorLogin', 'cursorCancel', 'cursorLogout', 'cursorUsage', 'cursorModels',
  'cursorSettings', 'cursorSetSettings',
  'image', 'video', 'prepareReset', 'consumeReset',
  'speed', 'setSpeed',
  'modelDefaults', 'setModelDefault',
] as const

/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
  mediaType: string
  dataBase64: string
}

/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
  mediaType: string
  dataBase64: string
}

/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value: the session's choice plus the visibility list. */
export interface SpeedState {
  /** The session's current speed tier (default `standard`). */
  tier: SpeedTier
  /** Codex model ids whose catalog advertises a fast tier. */
  fastModels: string[]
}

/** Speed state the RPC handler delegates to (in-memory, per session). */
export interface SpeedController {
  /** Current speed state: the session's tier and the fast-capable codex models. */
  speed(sessionId: string): Promise<SpeedState>
  /** Set one session's speed tier. */
  setSpeed(sessionId: string, tier: SpeedTier): Promise<void>
}

/** One logged-in account, as rendered by the Settings page. */
export interface AccountStatus {
  /** Stable account key (store identity). */
  key: string
  /** Display identity (email / login), when known. */
  account?: string
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Plan name the session carries (codex planType / claude subscriptionType), when known. */
  plan?: string
  /** Whether direct (non-pool) routes serve this account. */
  isDefault: boolean
}

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Logged-in accounts, default first. */
  accounts: AccountStatus[]
  /** The last login error, shown until the next success. */
  detail?: string
  /** The CLI version this route presents (Codex, Claude), and where it came from. */
  clientVersion?: CliVersion
}

/** How a Claude login should acquire credentials (other providers ignore it). */
export type LoginMethod = 'oauth' | 'keychain'

/** One model's default-effort picker state, as rendered by the Settings page. */
export interface ModelDefaultView {
  /** Wire model id. */
  id: string
  /** Human-readable display name. */
  name: string
  /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
  efforts: { id: string; name: string }[]
  /** The user-configured default effort, when set. */
  configured?: string
}

/** One provider's default-effort picker state. */
export interface ModelDefaultsCatalog {
  /** The subscription provider route. */
  provider: ProviderId
  /** Models the picker can configure, in catalog order. */
  models: ModelDefaultView[]
}

/** Per-account catalog returned by providerSettings, including providers without usage APIs. */
export interface ProviderAccountCatalog {
  key: string
  /** Original identity; the editable alias lives in settings.accounts[key].alias. */
  label: string
  models: { id: string; name: string }[]
  unavailable?: boolean
}

/** Provider and account preference operations behind providerSettings/setProviderSettings. */
export interface ProviderSettingsController {
  get(provider: ProviderId, force: boolean): Promise<unknown>
  set(provider: ProviderId, settings: unknown): Promise<void>
}

export interface ModelDefaultsController {
  /** Per-provider picker state for the Settings page. */
  catalog(force?: boolean): Promise<ModelDefaultsCatalog[]>
  /** Set one model's configured default effort; undefined clears the override. */
  set(provider: ProviderId, model: string, effort: string | undefined): Promise<void>
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  prepareReset?(account: string, signal: AbortSignal): Promise<unknown>
  consumeReset?(account: string, ticket: string, signal: AbortSignal): Promise<void>
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @param provider - the provider route.
   * @param method - Claude only: force the OAuth browser flow or the Claude
   *   Code credential import; omitted keeps the auto behavior (import when
   *   available, else OAuth).
   * @returns the authorize URL for the user's browser; device-flow providers
   *   (copilot) also return the `userCode` the user types at that URL.
   * @throws when an attempt is already running for this provider.
   */
  login(provider: ProviderId, method?: LoginMethod): Promise<{ authorizeUrl: string; userCode?: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete one account's stored session. */
  logout(provider: ProviderId, account: string): Promise<void>
  /** Pin the account direct (non-pool) routes serve. */
  setDefault(provider: ProviderId, account: string): Promise<void>
  /**
   * Current subscription usage of one account.
   * @param signal - caller cancellation from the RPC transport.
   * @param force - bypass a fresh cached snapshot for an honest re-check
   *   (the manual Refresh button); a live failure cooldown still applies.
   * @returns `{ supported: false }` when the provider has no usage endpoint.
   * @throws when logged out or the usage lookup fails.
   */
  usage(provider: ProviderId, account: string, signal: AbortSignal, force?: boolean): Promise<ProviderUsage>
  /**
   * Read one image attachment's bytes for inline display.
   * @param ref - the full durable reference (`readImage` verifies against it).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when no attachment service is mounted or the read fails.
   */
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult>
  /**
   * Read one generated video's bytes for inline playback.
   * @param name - bare MP4 file name inside the plugin's videos directory
   *   (validated against {@link VIDEO_NAME_PATTERN}; never a path).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when the file does not exist or cannot be read.
   */
  readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>
}

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
export class BadRequest extends Error {}

/** Credential-backed quota readers for model providers already in DSH. */
export interface ExternalUsageRpcController {
  status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>>
  usage(source: ExternalUsageSource, signal: AbortSignal): Promise<ProviderUsage>
}

/** Cursor account actions; OAuth tokens remain in the host credential service. */
export interface CursorRpcController {
  status(): Promise<CursorAuthStatus>
  login(): Promise<{ authorizeUrl: string }>
  cancel(): Promise<void>
  logout(): Promise<void>
  usage(signal: AbortSignal): Promise<ProviderUsage>
  models(force: boolean, signal: AbortSignal): Promise<{ id: string; name: string }[]>
  settings(force: boolean, signal: AbortSignal): Promise<unknown>
  setSettings(input: unknown): Promise<void>
}

/**
 * Structural face of `connection.fetch.register` shared by both dsh lines.
 * The 0.1.2-alpha typings list only `GET`/`HEAD` methods and no
 * `requestBody`, while the 0.1.5 line adds `POST` plus the body mode; the
 * runtime on both lines dispatches any declared method to the exact route,
 * so the route is typed here rather than against either line's declaration.
 */
interface FetchRouteCompat {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** Buffered: the bridge aggregates the JSON body before `fetch` runs (0.1.5+; ignored earlier). */
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

type FetchRegisterCompat = (route: FetchRouteCompat) => () => Promise<void>

/** The private exact-route bridge uses only the endpoint, payload, and signal. */
type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>

/** Connection `client-request` envelope, as the browser rpc caller sends it. */
interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function readEnvelope(body: unknown): ClientRequestEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload }
}

function serverResponse(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Wrap one endpoint's RPC handler as an exact Fetch route: decode the
 * `client-request` envelope the browser rpc caller posts, run the handler,
 * and answer with the matching `server-response` envelope — the same wire
 * contract the dedicated-channel bridge used to apply, reproduced here so
 * `rpc.call('/api', 'subscriptions-auth.<endpoint>', payload)` keeps working
 * unchanged on the browser side.
 */
function fetchRouteFor(endpoint: string, handler: ConnectionRpcHandler): FetchRouteCompat {
  const method = `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        const rawId = (body as Record<string, unknown> | null)?.rpcId
        return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(envelope.rpcId, await handler(endpoint, envelope.payload, request.signal))
    },
  }
}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }
  return provider as ProviderId
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** Validate the `setModelDefault` endpoint's payload. */
function readModelDefaultInput(payload: unknown): { provider: ProviderId; model: string; effort?: string } {
  const provider = readProvider(payload)
  const model = readString(payload, 'model')
  const record = payload as Record<string, unknown>
  let effort: string | undefined
  if (record.effort !== undefined) {
    if (typeof record.effort !== 'string' || record.effort.length === 0) {
      throw new BadRequest('payload.effort must be a non-empty string when present')
    }
    effort = record.effort
  }
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
  }
}

/** Validate the optional Claude login method. */
function readLoginMethod(payload: unknown, provider: ProviderId): LoginMethod | undefined {
  const method = (payload as Record<string, unknown>).method
  if (method === undefined) return undefined
  if (provider !== 'claude') throw new BadRequest('payload.method is only valid for claude')
  if (method !== 'oauth' && method !== 'keychain') {
    throw new BadRequest('payload.method must be "oauth" or "keychain"')
  }
  return method
}

/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload: unknown): SpeedTier {
  const tier = (payload as Record<string, unknown>).tier
  if (tier !== 'standard' && tier !== 'fast') {
    throw new BadRequest('payload.tier must be "standard" or "fast"')
  }
  return tier
}

/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload: unknown): ImageAttachmentRef {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new BadRequest('payload.attachmentId must be a non-empty string')
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`)
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequest(`payload.${field} must be a positive integer`)
    }
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequest('payload.name must be a string when present')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...name === undefined ? {} : { name: name as string },
  }
}

/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
    throw new BadRequest('payload.name must be a bare .mp4 file name')
  }
  return name
}

/** Validate the usage/model catalog endpoints' optional force flag. */
function readForce(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const force = (payload as Record<string, unknown>).force
  if (force === undefined) return false
  if (typeof force !== 'boolean') throw new BadRequest('payload.force must be a boolean when present')
  return force
}

/** Validate the session id both speed endpoints carry. */
function readSessionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  return readString(payload, 'sessionId')
}

async function dispatch(
  controller: AuthController,
  speed: SpeedController,
  modelDefaults: ModelDefaultsController | undefined,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  providerSettings?: ProviderSettingsController,
  externalUsage?: ExternalUsageRpcController,
  cursor?: CursorRpcController,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'providerSettings':
      if (!providerSettings) throw new BadRequest('provider settings are unavailable')
      return ok(await providerSettings.get(readProvider(payload), readForce(payload)))
    case 'setProviderSettings': {
      if (!providerSettings) throw new BadRequest('provider settings are unavailable')
      const provider = readProvider(payload)
      await providerSettings.set(provider, (payload as Record<string, unknown>).settings)
      return ok({ ok: true })
    }
    case 'status': {
      // One provider's failure (a corrupt store entry, a broken flow) must not
      // blind the whole page: it degrades to an error detail on that provider
      // while the others still report their real status.
      const entries = await Promise.all(PROVIDER_IDS.map(
        async provider => [provider, await controller.status(provider).catch((error: unknown) => ({
          busy: false,
          accounts: [],
          detail: error instanceof Error ? error.message : String(error),
        }) satisfies ProviderStatus)] as const,
      ))
      return ok({ providers: Object.fromEntries(entries) })
    }
    case 'login': {
      const provider = readProvider(payload)
      return ok(await controller.login(provider, readLoginMethod(payload, provider)))
    }
    case 'manual': {
      const provider = readProvider(payload)
      await controller.manual(provider, readString(payload, 'input'))
      return ok({ ok: true })
    }
    case 'cancel':
      await controller.cancel(readProvider(payload))
      return ok({ ok: true })
    case 'logout': {
      const provider = readProvider(payload)
      await controller.logout(provider, readString(payload, 'account'))
      return ok({ ok: true })
    }
    case 'setDefault': {
      const provider = readProvider(payload)
      await controller.setDefault(provider, readString(payload, 'account'))
      return ok({ ok: true })
    }
    case 'usage': {
      const provider = readProvider(payload)
      return ok(await controller.usage(provider, readString(payload, 'account'), signal, readForce(payload)))
    }
    case 'externalStatus':
      if (!externalUsage) throw new BadRequest('external usage is unavailable')
      return ok(await externalUsage.status())
    case 'externalUsage': {
      if (!externalUsage) throw new BadRequest('external usage is unavailable')
      const source = readString(payload, 'source')
      if (!(EXTERNAL_USAGE_SOURCES as readonly string[]).includes(source)) {
        throw new BadRequest(`payload.source must be one of ${EXTERNAL_USAGE_SOURCES.join(', ')}`)
      }
      return ok(await externalUsage.usage(source as ExternalUsageSource, signal))
    }
    case 'cursorStatus':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      return ok(await cursor.status())
    case 'cursorLogin':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      return ok(await cursor.login())
    case 'cursorCancel':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      await cursor.cancel()
      return ok({ ok: true })
    case 'cursorLogout':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      await cursor.logout()
      return ok({ ok: true })
    case 'cursorUsage':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      return ok(await cursor.usage(signal))
    case 'cursorModels':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      return ok(await cursor.models(readForce(payload), signal))
    case 'cursorSettings':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      return ok(await cursor.settings(readForce(payload), signal))
    case 'cursorSetSettings':
      if (!cursor) throw new BadRequest('Cursor account is unavailable')
      if (payload === null || typeof payload !== 'object') throw new BadRequest('payload must be an object')
      await cursor.setSettings((payload as Record<string, unknown>).settings)
      return ok({ ok: true })
    case 'prepareReset':
      if (!controller.prepareReset) throw new BadRequest('Reset redemption unavailable')
      return ok(await controller.prepareReset(readString(payload, 'account'), signal))
    case 'consumeReset':
      if (!controller.consumeReset) throw new BadRequest('Reset redemption unavailable')
      await controller.consumeReset(readString(payload, 'account'), readString(payload, 'ticket'), signal)
      return ok({ ok: true })
    case 'image':
      return ok(await controller.readImage(readImageRef(payload), signal))
    case 'video':
      return ok(await controller.readVideo(readVideoName(payload), signal))
    case 'speed':
      return ok(await speed.speed(readSessionId(payload)))
    case 'setSpeed':
      await speed.setSpeed(readSessionId(payload), readSpeedTier(payload))
      return ok({ ok: true })
    case 'modelDefaults': {
      if (modelDefaults === undefined) throw new BadRequest('model defaults are unavailable')
      return ok(await modelDefaults.catalog(readForce(payload)))
    }
    case 'setModelDefault':
      if (modelDefaults === undefined) throw new BadRequest('model defaults are unavailable')
      {
        const input = readModelDefaultInput(payload)
        await modelDefaults.set(input.provider, input.model, input.effort)
      }
      return ok({ ok: true })
    default:
      throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  }
}

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 * @param modelDefaults - optional per-model default-effort state backing `modelDefaults`/`setModelDefault`.
 */
export function registerAuthRpc(
  ctx: Context,
  controller: AuthController,
  speed: SpeedController,
  modelDefaults: ModelDefaultsController | undefined = undefined,
  providerSettings: ProviderSettingsController | undefined = undefined,
  externalUsage: ExternalUsageRpcController | undefined = undefined,
  cursor: CursorRpcController | undefined = undefined,
): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  //
  // Exact Fetch routes under `/api` rather than a dedicated `rpc.handle`
  // channel: since dsh 0.1.5 the connection plugin no longer injects
  // `webServer` itself, and `rpc.handle` resolves `webServer` through the
  // connection plugin's own fiber, so every dedicated channel registration
  // throws `cannot get property "webServer" without inject`. The `/api`
  // route is mounted by the connection plugin (with its own webServer scope)
  // and applies the same trust fence and browser authentication, so exact
  // routes below it work on both dsh lines.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
      try {
        return await dispatch(controller, speed, modelDefaults, endpoint, payload, signal, providerSettings, externalUsage, cursor)
      } catch (error) {
        return failure(error)
      }
    }
    const register = connection.fetch.register as unknown as FetchRegisterCompat
    for (const endpoint of SUBSCRIPTIONS_AUTH_ENDPOINTS) {
      ctx.effect(
        () => register(fetchRouteFor(endpoint, handler)),
        `dsh-subscriptions: /api/${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint} route`,
      )
    }
  })
}
