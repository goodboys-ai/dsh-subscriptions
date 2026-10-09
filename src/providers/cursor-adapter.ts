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

/** Bound on remembered auth failure messages; they are short and few. */
const MAX_LOCAL_MESSAGES = 64

/**
 * Remembers the messages the auth service threw. The vendor stream turns an
 * auth failure into `finish/error` carrying exactly `error.message`, so a
 * failure whose message equals a remembered one originated locally and may keep
 * its text. The match is by exact text: a provider that echoed a remembered
 * message would only display a local literal, and an auth failure ends the
 * stream before any provider frame is read.
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
          this.remember(error instanceof Error ? error.message : String(error))
          throw error
        }
      },
    }
  }

  has(message: string): boolean {
    return this.messages.has(message)
  }

  private remember(message: string): void {
    this.messages.delete(message)
    this.messages.add(message)
    if (this.messages.size > MAX_LOCAL_MESSAGES) {
      const oldest = this.messages.values().next().value
      if (oldest !== undefined) this.messages.delete(oldest)
    }
  }
}

/**
 * Cursor adapter for the DSH host.
 *
 * Failure text contract: `finish/error` messages that originate from the
 * vendor stream (response status, content type, trailers, end-stream errors,
 * frame-reader and transport errors) are replaced by `<code> [provider
 * response text omitted]`, because they can quote provider-controlled text.
 * Failures that are wholly local keep their own message and code: anything the
 * auth service threw (not signed in, sign-in expired, token refresh status)
 * and the vendor's own request validation (`UNSUPPORTED_OPTION`,
 * `UNSUPPORTED_CONTENT`, `TOOL_LIMIT`). Local failures the vendor raises as
 * plain errors (idle or progress timeout, bridge closed, HTTP status text)
 * cannot be told apart from provider-derived ones at this boundary, so they are
 * still replaced; keeping them would need the vendor to tag them where it
 * throws.
 */
export class CursorCompatAdapter extends CursorAdapter {
  private readonly visibleModels: (() => readonly string[] | undefined) | undefined
  private readonly localFailures: LocalFailureMessages

  constructor(options: ConstructorParameters<typeof CursorAdapter>[0] & {
    visibleModels?: () => readonly string[] | undefined
  }) {
    const localFailures = new LocalFailureMessages()
    super({ ...options, auth: localFailures.wrap(options.auth) })
    this.localFailures = localFailures
    this.visibleModels = options.visibleModels
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
