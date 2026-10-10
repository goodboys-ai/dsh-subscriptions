import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from 'dsh-subscriptions/cursor-transport'

/**
 * The imported Cursor transport still reads tool results as user-role content
 * blocks. DSH 0.1.7 carries them as first-class role=tool messages instead.
 */
export function projectCursorMessages(messages: GenerateOptions['messages']): unknown[] {
  return messages.map(message => message.role === 'tool'
    ? {
      ...message,
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: message.toolCallId,
        isError: message.isError,
        content: message.content,
      }],
    }
    : message)
}

type CursorAuthPort = ConstructorParameters<typeof CursorAdapter>[0]['auth']

/**
 * Vendor `LlmError` codes whose whole message is a local literal (no response
 * header, trailer, body or end-stream text). Provider-derived failures can only
 * carry a `classifyCursorError` code or `CURSOR_PROTOCOL`, never these, so the
 * code is a sound discriminator for them.
 */
const LOCAL_VENDOR_CODES: ReadonlySet<string> = new Set(['UNSUPPORTED_OPTION', 'UNSUPPORTED_CONTENT', 'TOOL_LIMIT'])

/**
 * Plain-error messages the vendor throws as fixed literals (`vendor/cursor/
 * index.js`: `waitForResponse`, the request write, the tool-continuation write,
 * the stream `close` handler, the frame reader, the stall watchdog and the
 * settings validation). None
 * interpolates response text, so they are matched by exact message, the same way
 * the auth messages are. A provider that echoed one of these sentences would
 * only make the user read a local literal.
 */
const LOCAL_VENDOR_MESSAGES: ReadonlySet<string> = new Set([
  'Cursor HTTP response timeout',
  'Cursor HTTP stream closed before response',
  'Cursor agent bridge closed before accepting the request',
  'Cursor tool continuation bridge closed before accepting the result',
  'Cursor sent an unreadable compressed frame',
  'Cursor stream idle timeout',
  // `resolveCursorSettings`, run at the top of every stream.
  'cursor-subscription: maxToolRounds must be an integer between 1 and 1000',
  'cursor-subscription: retryCount must be an integer between 0 and 10',
  'cursor-subscription: retryIntervalMs must be an integer between 0 and 300000',
  'cursor-subscription: retryHttpStatusCodes must contain only HTTP status integers from 400 to 599',
  'cursor-subscription: retryHttpStatusCodes must not contain duplicates',
  'cursor-subscription: replayHistoryEachStep must be a boolean',
])

/**
 * The same, for the two literals that embed a number the vendor computes: the
 * response status (`Number(headers[':status'])`, so digits or `NaN`) and the
 * configured progress timeout.
 */
const LOCAL_VENDOR_PATTERNS: readonly RegExp[] = [
  /^Cursor agent returned HTTP \d{3}$/,
  /^Cursor stream progress timeout: no content for \d+ms$/,
]

/**
 * Operating-system network error codes. An `Error` carrying one of these on
 * itself, or on its `cause` (Node wraps a refused connection in
 * `ERR_HTTP2_STREAM_CANCEL`), was produced by the local socket layer, so its
 * message is local: `connect ECONNREFUSED 127.0.0.1:443`, `getaddrinfo ENOTFOUND
 * host`. This is a property of the thrown object, which a provider cannot
 * forge. It is deliberately not a test on the vendor's `TRANSPORT` code: the
 * vendor derives that code from message text, so a provider's end-stream
 * message or `grpc-message` containing "connection" or "socket" gets it too.
 * Transport failures with no such code (TLS and certificate errors, HTTP/2
 * protocol errors) are not recognised and stay replaced.
 */
const LOCAL_SYSTEM_ERRNO: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE',
])

function errorCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined
}

function isLocalSystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const own = errorCode(error)
  const cause = errorCode(error.cause)
  return (typeof own === 'string' && LOCAL_SYSTEM_ERRNO.has(own))
    || (typeof cause === 'string' && LOCAL_SYSTEM_ERRNO.has(cause))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound on remembered local failure messages; they are short and few. */
const MAX_LOCAL_MESSAGES = 64

/**
 * Remembers the messages of failures raised by this machine rather than read
 * from the provider: whatever the auth service threw, whatever the host
 * attachment store threw while reading an image, and a socket-layer network
 * error seen on the run. The vendor stream turns each of these into
 * `finish/error` carrying exactly `error.message`, so a failure whose message
 * equals a remembered one originated locally and may keep its text. The match
 * is by exact text: a provider that echoed a remembered message would only
 * display a local literal.
 */
class LocalFailureMessages {
  private readonly messages = new Set<string>()

  /** Wrap `auth` so its failures are remembered and rethrown unchanged. */
  wrap(auth: CursorAuthPort): CursorAuthPort {
    return {
      accessToken: async (options) => {
        try {
          return await auth.accessToken(options)
        } catch (error) {
          this.remember(messageOf(error))
          throw error
        }
      },
    }
  }

  /**
   * Wrap the host attachment store the vendor reads images through, so a read
   * failure keeps its own message. The store is a local service; its errors
   * carry no provider text. Anything that is not a store passes through.
   */
  wrapAttachments(resolve: () => unknown): () => unknown {
    return () => {
      const store = resolve()
      const readImage = (store as { readImage?: unknown } | undefined)?.readImage
      if (typeof readImage !== 'function') return store
      return Object.create(store as object, {
        readImage: {
          value: async (...args: unknown[]) => {
            try {
              return await readImage.apply(store, args)
            } catch (error) {
              this.remember(messageOf(error))
              throw error
            }
          },
        },
      })
    }
  }

  /**
   * Observe a vendor run's two failure channels, the response promise and the
   * frame reader, and remember the message of an error the socket layer raised.
   * The run's behavior is unchanged: the same error is rethrown.
   */
  observeRun<T>(run: T): T {
    if (typeof run !== 'object' || run === null) return run
    const target = run as {
      waitForResponse?: (...args: unknown[]) => unknown
      frames?: { next?: (...args: unknown[]) => unknown }
    }
    const observe = (error: unknown): never => {
      if (isLocalSystemError(error)) this.remember(messageOf(error))
      throw error
    }
    const wait = target.waitForResponse
    if (typeof wait === 'function') {
      target.waitForResponse = (...args) => Promise.resolve(wait.apply(target, args)).catch(observe)
    }
    const frames = target.frames
    const next = frames?.next
    if (frames !== undefined && typeof next === 'function') {
      frames.next = (...args) => Promise.resolve(next.apply(frames, args)).catch(observe)
    }
    return run
  }

  has(message: string): boolean {
    return this.messages.has(message)
  }

  private remember(message: string): void {
    // An empty message displays nothing; remembering it would exempt every
    // empty failure from the boundary for no benefit.
    if (message === '') return
    this.messages.delete(message)
    this.messages.add(message)
    if (this.messages.size > MAX_LOCAL_MESSAGES) {
      const oldest = this.messages.values().next().value
      if (oldest !== undefined) this.messages.delete(oldest)
    }
  }
}

function isVendorLocalMessage(message: string): boolean {
  return LOCAL_VENDOR_MESSAGES.has(message) || LOCAL_VENDOR_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * Cursor adapter for the DSH host.
 *
 * Failure text contract: `finish/error` messages that originate from the
 * vendor stream and can quote provider-controlled text (the response content
 * type, trailers, end-stream errors, a frame-reader or other error whose message
 * is not one of the literals below, and a transport-coded failure that is not a
 * socket-layer error) are replaced by `<code> [provider response text omitted]`. Failures that are
 * wholly local keep their own message and code:
 *
 * - anything the auth service threw (not signed in, sign-in expired, token
 *   refresh status), and a host attachment read failure;
 * - the vendor's own request validation, by code (`UNSUPPORTED_OPTION`,
 *   `UNSUPPORTED_CONTENT`, `TOOL_LIMIT`);
 * - the vendor's fixed-literal plain errors, by exact message: the HTTP status
 *   (`Cursor agent returned HTTP 429`), the response, idle and progress
 *   timeouts, a closed bridge or stream, an unreadable compressed frame, and
 *   an invalid Cursor setting;
 * - a network error raised by the operating system (`ECONNREFUSED`,
 *   `ENOTFOUND`, ...), recognised from the thrown error's own code, not from
 *   the vendor's classification.
 *
 * Not a provider-origin class: a network error such as `ECONNREFUSED` is a
 * local failure (no network, daemon down, DNS), and is kept. What is still
 * replaced although it is probably local is a transport failure with no
 * socket-layer errno: a TLS or certificate failure and an HTTP/2 protocol
 * error. The vendor's `TRANSPORT` code cannot decide those, because
 * `classifyCursorError` derives it from message text (`network`, `connection`,
 * `socket`, `fetch`, `ECONN`, `http2`) and a provider's end-stream message or
 * `grpc-message` can contain any of them; so the code is never trusted alone.
 * Telling these apart would need a check on the thrown error object, as the
 * errno check above does, extended to the TLS and HTTP/2 error codes. That is
 * not done here and is not verified.
 */
export class CursorCompatAdapter extends CursorAdapter {
  private readonly visibleModels: (() => readonly string[] | undefined) | undefined
  private readonly localFailures: LocalFailureMessages

  constructor(options: ConstructorParameters<typeof CursorAdapter>[0] & {
    visibleModels?: () => readonly string[] | undefined
  }) {
    const localFailures = new LocalFailureMessages()
    super({
      ...options,
      auth: localFailures.wrap(options.auth),
      ...(options.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: localFailures.wrapAttachments(options.resolveAttachments) }),
    })
    this.localFailures = localFailures
    this.visibleModels = options.visibleModels
    // The vendor assigns `createAgentRun` (the injected one, or its own
    // `AgentRun` factory) in its constructor but does not type it as a member.
    const vendor = this as unknown as { createAgentRun: (access: string) => unknown }
    const createRun = vendor.createAgentRun
    vendor.createAgentRun = access => localFailures.observeRun(createRun(access))
  }

  override async listModels(provider: string) {
    const models = await super.listModels(provider)
    const visible = this.visibleModels?.()
    return visible === undefined ? models : models.filter(model => visible.includes(model.id))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for await (const chunk of super.stream({
      ...options,
      // Existing DSH sessions may still hold this retired selection.
      model: options.model === 'composer-2' ? 'composer-2.5' : options.model,
      messages: projectCursorMessages(options.messages) as GenerateOptions['messages'],
    })) {
      if (chunk.type === 'finish' && chunk.reason.kind === 'error'
        && !LOCAL_VENDOR_CODES.has(chunk.reason.failure.code)
        && !isVendorLocalMessage(chunk.reason.failure.message)
        && !this.localFailures.has(chunk.reason.failure.message)) {
        // The vendor uses raw headers, trailers and end-stream errors for protocol
        // checks and classification before this boundary. Keep its code and retry
        // decisions; do not reclassify the replacement text. "Safe" here means no
        // provider-controlled free text is displayed in failures, not that no
        // secret can exist anywhere internally.
        yield {
          ...chunk,
          reason: {
            ...chunk.reason,
            failure: {
              ...chunk.reason.failure,
              message: `${chunk.reason.failure.code} [provider response text omitted]`,
            },
          },
        }
      } else {
        yield chunk
      }
    }
  }
}
