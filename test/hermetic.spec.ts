/**
 * The network guard in test/hermetic.mjs is loaded by the `test` script, not
 * by any spec. This file fails when a runner change drops the `--import`, so
 * the suite cannot quietly start reaching real provider hosts again.
 *
 * The guard fails any spec process that was refused a connection, even when
 * the error was caught. This spec is refused on purpose once per client
 * below and declares that count, so its own process still exits cleanly.
 *
 * The hosts are `.invalid` names, which never resolve, so a guard that stops
 * working fails here with a DNS error rather than reaching a real server.
 */
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { test } from 'node:test'

const guard = globalThis as {
  __dshHermeticTestRun?: boolean
  __dshHermeticExpectedRefusals?: number
}
const guarded = guard.__dshHermeticTestRun === true

test('the network guard is loaded', () => {
  assert.equal(
    guarded,
    true,
    'run specs through `pnpm test`, which loads test/hermetic.mjs',
  )
})

/** The clients refused below; the guard fails this file unless the count matches. */
const REFUSED_CLIENTS = 3

const hermetic = (error: unknown): boolean =>
  (error as { code?: string }).code === 'EHERMETIC'

test(
  'fetch to a non-loopback host is refused before DNS',
  { skip: !guarded },
  async () => {
    guard.__dshHermeticExpectedRefusals = REFUSED_CLIENTS
    await assert.rejects(
      fetch('https://provider.invalid/usage'),
      (error: unknown) => hermetic((error as { cause?: unknown }).cause),
    )
  },
)

// net.connect() and node:http pass the socket pre-normalized arguments; a
// guard that reads only the options form lets them through to DNS.
test(
  'net.connect to a non-loopback host is refused before DNS',
  { skip: !guarded },
  () => {
    guard.__dshHermeticExpectedRefusals = REFUSED_CLIENTS
    assert.throws(
      () => connect({ host: 'provider.invalid', port: 443 }),
      hermetic,
    )
  },
)

test(
  'node:http to a non-loopback host is refused before DNS',
  { skip: !guarded },
  () => {
    guard.__dshHermeticExpectedRefusals = REFUSED_CLIENTS
    assert.throws(() => get('http://provider.invalid/usage'), hermetic)
  },
)

test('loopback servers stay reachable', { skip: !guarded }, async (t) => {
  const server = createServer((_request, response) => {
    response.end('ok')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    server.close()
  })
  const { port } = server.address() as AddressInfo
  const response = await fetch(`http://localhost:${port}/`)
  assert.equal(await response.text(), 'ok')
})
