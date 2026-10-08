import { randomUUID } from 'node:crypto'
import type { ProviderUsage } from './common.js'

export interface ResetConfirmation {
  ticket: string
  expiresAt: number
  creditExpiresAt?: number
  weeklyUsedPercent: number
}

/**
 * Manual-only redemption with single-use tickets. An ambiguous submission parks
 * the account to prevent an immediate blind retry. This block is process-local,
 * not a durable rate limit: restarting the host clears it. Re-check credits and
 * limits in Codex before retrying; a lost success response may have spent a
 * credit already, and another submission can spend another credit.
 * Rationale: [manual reset note](../../.agents/notes/implemented/provider/2026-10-04-codex-manual-reset.md).
 */
export class ResetRedemption {
  private tickets = new Map<string, { account: string; creditId: string; expiresAt: number }>()
  private busy = new Set<string>()
  private uncertain = new Set<string>()
  constructor(
    private readonly read: (account: string, signal: AbortSignal) => Promise<ProviderUsage>,
    private readonly consume: (account: string, creditId: string, requestId: string, signal: AbortSignal) => Promise<void>,
    private readonly invalidate: (account: string) => void,
    /**
     * Stable identity for one real account. The RPC carries whatever reference
     * the browser holds — a canonical id, a legacy key, an email, a workspace
     * id — and the session layer resolves all of them to one Codex account.
     * Keying the guards on the raw reference would let an alias slip past the
     * busy and uncertain checks and spend a second credit, so state is keyed
     * on this instead. Falls back to the raw reference when it cannot resolve.
     */
    private readonly canonical: (account: string, signal: AbortSignal) => Promise<string> = async account => account,
  ) {}

  /**
   * The identity the guards key on. Aliases of one account resolve together, so
   * a pending or uncertain operation blocks every reference to that account.
   */
  private async identity(account: string, signal: AbortSignal): Promise<string> {
    try {
      const resolved = await this.canonical(account, signal)
      return typeof resolved === 'string' && resolved.length > 0 ? resolved : account
    } catch {
      return account
    }
  }

  private eligible(usage: ProviderUsage): number {
    const weekly = usage.windows?.find(w => w.kind === 'weekly' && w.scope === undefined)
    if (!weekly || !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 80
      || weekly.resetsAt === undefined || weekly.resetsAt <= Date.now()) {
      throw new Error('Reset blocked: fresh weekly usage must be at least 80%.')
    }
    if (usage.resetCreditsError) throw new Error('Reset credits could not be verified.')
    return weekly.usedPercent
  }

  async prepare(account: string, signal: AbortSignal): Promise<ResetConfirmation> {
    const who = await this.identity(account, signal)
    if (this.busy.has(who) || this.uncertain.has(who)) throw new Error('Reset blocked: an operation is pending or its outcome is uncertain. Check Codex before retrying.')
    const usage = await this.read(account, signal)
    const weeklyUsedPercent = this.eligible(usage)
    const credit = usage.resetCredits?.filter(c => c.id && (c.expiresAt === undefined || c.expiresAt > Date.now()))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0]
    if (!credit?.id) throw new Error('No available reset credit.')
    for (const [key, value] of this.tickets) if (value.account === who || value.expiresAt <= Date.now()) this.tickets.delete(key)
    const ticket = randomUUID()
    const expiresAt = Date.now() + 60_000
    this.tickets.set(ticket, { account: who, creditId: credit.id, expiresAt })
    return { ticket, expiresAt, weeklyUsedPercent, ...(credit.expiresAt === undefined ? {} : { creditExpiresAt: credit.expiresAt }) }
  }

  async redeem(account: string, ticket: string, signal: AbortSignal): Promise<void> {
    const who = await this.identity(account, signal)
    const pending = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!pending || pending.account !== who || pending.expiresAt <= Date.now()) throw new Error('Confirmation expired. Start again.')
    if (this.busy.has(who) || this.uncertain.has(who)) throw new Error('Reset blocked: operation pending or uncertain.')
    this.busy.add(who)
    try {
      const usage = await this.read(account, signal)
      // The ticket bounds how long the confirmation counts. A read that
      // outlives it must not go on to submit, so this comes first.
      if (pending.expiresAt <= Date.now()) throw new Error('Confirmation expired. Start again.')
      this.eligible(usage)
      if (!usage.resetCredits?.some(c => c.id === pending.creditId && (c.expiresAt === undefined || c.expiresAt > Date.now()))) throw new Error('The selected reset is no longer available.')
      // Mark before submission: no blind retry after transport or response ambiguity.
      this.uncertain.add(who)
      try {
        await this.consume(account, pending.creditId, randomUUID(), signal)
      } catch {
        throw new Error('Reset outcome could not be confirmed. Do not retry or restart to bypass this block; verify credits and limits in Codex first.')
      }
      this.uncertain.delete(who)
    } finally {
      this.invalidate(who)
      this.busy.delete(who)
    }
  }
}
