import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

const home = mkdtempSync(join(tmpdir(), 'cursor-registration-'))
// Suite-level hook: the mkdtemp is top-level, so there is no test context to hang t.after on.
after(() => {
  rmSync(home, { recursive: true, force: true })
})
process.env.DSH_HOME = home
const plugin = await import('../src/index.js')

test('a DSH credential service mounts the Cursor provider route', async () => {
  const routes: string[] = []
  const ctx = new Context()
  ctx.provide('llm', {
    registerAdapter: (names: string[]) => {
      routes.push(...names)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  ctx.provide('credentials', {
    resolve: async () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
  } satisfies Pick<
    CredentialProvider,
    'resolve' | 'set' | 'unset'
  > as unknown as CredentialProvider)
  ctx.plugin(plugin, { providers: [] })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(routes.includes('cursor-subscription'))
})
