import { LlmError } from '@deepseek-ai/dsh-llm'

/** Constructor's code parameter, on both older hosts and hosts that narrow it. */
export type SubscriptionFailureCode = ConstructorParameters<typeof LlmError>[1]
type FailureOptions = ConstructorParameters<typeof LlmError>[2]

/**
 * Keep the plugin's stable custom failure codes across the host's type-only
 * BuiltinLlmFailureCode narrowing. Runtime LlmError construction is unchanged.
 */
export function subscriptionError(
  message: string,
  code: string,
  options?: FailureOptions,
): LlmError {
  return new LlmError(message, code as SubscriptionFailureCode, options)
}
