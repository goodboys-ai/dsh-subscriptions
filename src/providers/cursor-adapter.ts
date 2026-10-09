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

export class CursorCompatAdapter extends CursorAdapter {
  private readonly visibleModels: (() => readonly string[] | undefined) | undefined

  constructor(options: ConstructorParameters<typeof CursorAdapter>[0] & {
    visibleModels?: () => readonly string[] | undefined
  }) {
    super(options)
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
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
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
