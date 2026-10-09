/**
 * The durable model-catalog store: per-provider round-trips over one file,
 * tolerance for missing/corrupt files, and strict snapshot validation (a
 * malformed persisted entry must read as absent, never flow into
 * resolveModel).
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { accountCatalogStore, catalogStore, sanitizeSnapshot } from '../src/providers/catalog-store.js'

async function tempStorePath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-models-'))
  // Registered before the caller's first assertion so a failure cannot strand the dir.
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'models.json')
}

test('catalog store round-trips per-provider snapshots in one file', async (t) => {
  const path = await tempStorePath(t)
  const grok = catalogStore('grok', path)
  const codex = catalogStore('codex', path)
  await grok.save({
    at: 123,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort', description: 'extensive' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  await codex.save({ at: 456, models: [{ id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', maxContextWindow: 872000 }] })

  const loaded = await grok.load()
  assert.equal(loaded?.at, 123)
  assert.equal(loaded?.models[0].reasoning?.defaultEffort, 'high')
  assert.equal(loaded?.models[0].reasoning?.efforts[0].description, 'extensive')
  assert.equal((await codex.load())?.models[0].name, 'GPT-5.2 Codex')
  assert.equal((await codex.load())?.models[0].maxContextWindow, 872000)

  // Clearing one provider keeps the other.
  await grok.clear()
  assert.equal(await grok.load(), undefined)
  assert.equal((await codex.load())?.at, 456)
  // The file itself stays valid JSON (parse throws otherwise).
  JSON.parse(await readFile(path, 'utf8'))
})

test('catalog store round-trips output token limits', async (t) => {
  const path = await tempStorePath(t)
  const snapshot = {
    at: 123,
    models: [
      { id: 'g', name: 'G', maxOutputTokens: 32_768 },
      { id: 'min', name: 'Minimum', maxOutputTokens: 1 },
      { id: 'max', name: 'Maximum', maxOutputTokens: Number.MAX_SAFE_INTEGER },
    ],
  }
  await catalogStore('grok', path).save(snapshot)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).grok, snapshot)
  assert.deepEqual(await catalogStore('grok', path).load(), snapshot)
})

test('catalog store accepts old caches without output token limits', async (t) => {
  const path = await tempStorePath(t)
  const snapshot = { at: 123, models: [{ id: 'g', name: 'G', contextWindow: 500_000 }] }
  await writeFile(path, JSON.stringify({ grok: snapshot }))
  const loaded = await catalogStore('grok', path).load()
  assert.deepEqual(loaded, snapshot)
  assert.equal(Object.hasOwn(loaded!.models[0], 'maxOutputTokens'), false)
})

test('sanitizeSnapshot rejects invalid output token limits', () => {
  for (const maxOutputTokens of [
    0, -1, 1.5, '32768', null, Number.MAX_SAFE_INTEGER + 1,
    NaN, Infinity, -Infinity, true, {}, [],
  ]) {
    assert.equal(sanitizeSnapshot({
      at: 123,
      models: [
        { id: 'valid', name: 'Valid' },
        { id: 'invalid', name: 'Invalid', maxOutputTokens },
      ],
    }), undefined, `Invalid maxOutputTokens: ${String(maxOutputTokens)}`)
  }
})

test('catalog store tolerates missing and corrupt files', async (t) => {
  const path = await tempStorePath(t)
  const store = catalogStore('grok', path)
  // Missing file reads as absent; clear on a missing file is a no-op.
  assert.equal(await store.load(), undefined)
  await store.clear()
  // Corrupt JSON reads as absent instead of throwing.
  await writeFile(path, 'not json')
  assert.equal(await store.load(), undefined)
  // A corrupt file is still writable: save rebuilds it from scratch.
  await store.save({ at: 2, models: [{ id: 'g', name: 'G' }] })
  assert.equal((await store.load())?.at, 2)
})

test('sanitizeSnapshot drops malformed snapshots wholesale', () => {
  const model = { id: 'g', name: 'G' }
  const efforts = [{ id: 'high', name: 'High' }]
  // A valid snapshot passes through.
  assert.notEqual(sanitizeSnapshot({ at: 1, models: [model] }), undefined)
  assert.notEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'high' } }] }),
    undefined,
  )
  // The codex fast-tier flag round-trips; a non-boolean one drops the snapshot.
  assert.equal(
    sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: true }] })?.models[0].fastTier,
    true,
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: 'yes' }] }), undefined)
  // Copilot per-model modalities round-trip; malformed ones drop the snapshot.
  assert.deepEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['text', 'image'] }] })?.models[0].inputModalities,
    ['text', 'image'],
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: [] }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['video'] }] }), undefined)
  // The Copilot wire choice and dual-protocol flag round-trip (a snapshot
  // losing them would route every restarted model to the chat wire); a
  // malformed value drops the snapshot.
  const copilot = sanitizeSnapshot({
    at: 1,
    models: [{ ...model, copilotWire: 'responses', copilotResponses: true }],
  })?.models[0]
  assert.equal(copilot?.copilotWire, 'responses')
  assert.equal(copilot?.copilotResponses, true)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotWire: 'grpc' }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotResponses: 'yes' }] }), undefined)
  for (const malformed of [
    undefined,
    null,
    'text',
    { at: 'soon', models: [model] },
    { at: 1, models: [] },
    { at: 1, models: [{ id: '', name: 'G' }] },
    { at: 1, models: [{ id: 'g', name: '' }] },
    { at: 1, models: [model, model] }, // duplicate ids
    { at: 1, models: [{ ...model, contextWindow: -5 }] },
    { at: 1, models: [{ ...model, description: 42 }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: 'high', name: '' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: '', name: 'High' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'unknown' } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [...efforts, ...efforts] } }] }, // duplicate efforts
  ]) {
    assert.equal(sanitizeSnapshot(malformed), undefined, JSON.stringify(malformed))
  }
})

test('account catalog store keeps per-account snapshots apart from the provider entry', async (t) => {
  const path = await tempStorePath(t)
  const provider = catalogStore('codex', path)
  const key = '["379d","user","user-m09"]'
  const account = accountCatalogStore('codex', key, path)
  const other = accountCatalogStore('codex', 'other', path)
  await provider.save({ at: 1, models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }] })
  await account.save({ at: 2, models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', priority: 1 }] })
  await other.save({ at: 3, models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] })

  assert.deepEqual((await provider.load())?.models.map(model => model.id), ['gpt-5.1'])
  assert.deepEqual((await account.load())?.models.map(model => model.id), ['gpt-6-astra'])
  assert.deepEqual((await other.load())?.models.map(model => model.id), ['gpt-5.5'])
  assert.equal(await accountCatalogStore('grok', key, path).load(), undefined)

  await account.clear()
  assert.equal(await account.load(), undefined)
  assert.deepEqual((await other.load())?.models.map(model => model.id), ['gpt-5.5'], 'clearing one account keeps its siblings')
  assert.deepEqual((await provider.load())?.models.map(model => model.id), ['gpt-5.1'])
  await provider.clear()
  assert.deepEqual((await other.load())?.models.map(model => model.id), ['gpt-5.5'], 'clearing the provider entry keeps account snapshots')
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function restoreFsMocks(t: TestContext): void {
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

const firstSnapshot = { at: 1, models: [{ id: 'first', name: 'First' }] }
const secondSnapshot = { at: 2, models: [{ id: 'second', name: 'Second' }] }

test('concurrent saves for different accounts both survive on disk', async (t) => {
  const path = await tempStorePath(t)
  const originalReadFile = fs.readFile
  const originalRename = fs.rename
  await writeFile(path, '{}')
  let diskText = await readFile(path, 'utf8')
  restoreFsMocks(t)
  // Immediate read results force overlapping unqueued writers to share a base;
  // successful renames refresh that base from the real file, without timing waits.
  t.mock.method(fs, 'readFile', (...[file, ...args]: Parameters<typeof fs.readFile>) => file === path
    ? Promise.resolve(diskText)
    : originalReadFile(file, ...args))
  t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
    await originalRename(source, destination)
    diskText = await originalReadFile(path, 'utf8')
  })
  syncBuiltinESMExports()

  await Promise.all([
    accountCatalogStore('codex', 'first', path).save(firstSnapshot),
    accountCatalogStore('codex', 'second', path).save(secondSnapshot),
  ])
  const file = JSON.parse(await originalReadFile(path, 'utf8'))
  assert.deepEqual(file.accounts.codex, { first: firstSnapshot, second: secondSnapshot },
    'both concurrently saved accounts must survive on disk')
})

test('a queued save reads the state committed by the preceding save', async (t) => {
  const path = await tempStorePath(t)
  const originalReadFile = fs.readFile
  const originalRename = fs.rename
  const atRename = deferred()
  const releaseRename = deferred()
  let reads = 0
  let renames = 0
  restoreFsMocks(t)
  t.mock.method(fs, 'readFile', (...[file, ...args]: Parameters<typeof fs.readFile>) => {
    if (file === path) reads++
    return originalReadFile(file, ...args)
  })
  t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
    if (++renames === 1) {
      atRename.resolve()
      await releaseRename.promise
    }
    await originalRename(source, destination)
  })
  syncBuiltinESMExports()

  const first = catalogStore('codex', path).save(firstSnapshot)
  await atRename.promise
  const second = accountCatalogStore('codex', 'second', path).save(secondSnapshot)
  try {
    assert.equal(reads, 1, 'a queued save must not read before the preceding rename completes')
  } finally {
    releaseRename.resolve()
    await Promise.allSettled([first, second])
  }
  await Promise.all([first, second])
  assert.deepEqual(JSON.parse(await originalReadFile(path, 'utf8')), {
    codex: firstSnapshot, accounts: { codex: { second: secondSnapshot } },
  })
})

test('provider and account clears preserve a preceding concurrent save', async (t) => {
  for (const target of ['provider', 'account'] as const) {
    await t.test(target, async (t) => {
      const path = await tempStorePath(t)
      const provider = catalogStore('codex', path)
      const account = accountCatalogStore('codex', 'second', path)
      const removing = target === 'provider' ? provider : account
      const keeping = target === 'provider' ? account : provider
      await removing.save(firstSnapshot)
      const originalReadFile = fs.readFile
      const originalRename = fs.rename
      const atRename = deferred()
      const releaseRename = deferred()
      let reads = 0
      let renames = 0
      restoreFsMocks(t)
      t.mock.method(fs, 'readFile', (...[file, ...args]: Parameters<typeof fs.readFile>) => {
        if (file === path) reads++
        return originalReadFile(file, ...args)
      })
      t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
        if (++renames === 1) {
          atRename.resolve()
          await releaseRename.promise
        }
        await originalRename(source, destination)
      })
      syncBuiltinESMExports()

      const saving = keeping.save(secondSnapshot)
      await atRename.promise
      const clearing = removing.clear()
      try {
        assert.equal(reads, 1, 'a queued clear must not read before the preceding rename completes')
      } finally {
        releaseRename.resolve()
        await Promise.allSettled([saving, clearing])
      }
      await Promise.all([saving, clearing])
      assert.equal(await removing.load(), undefined)
      assert.deepEqual(await keeping.load(), secondSnapshot)
    })
  }
})

test('a failed write preserves the previous file and does not block a queued save', async (t) => {
  for (const failure of ['writeFile', 'rename'] as const) {
    await t.test(failure, async (t) => {
      const path = await tempStorePath(t)
      const provider = catalogStore('codex', path)
      await provider.save(firstSnapshot)
      const previousText = await readFile(path, 'utf8')
      const originalWriteFile = fs.writeFile
      const originalRename = fs.rename
      const atFailure = deferred()
      const releaseFailure = deferred()
      const error = Object.assign(new Error(`injected ${failure} failure`), { code: 'EIO' })
      let attempts = 0
      restoreFsMocks(t)
      const fail = async (temp: string) => {
        assert.notEqual(temp, path, 'a failed write must only modify a temporary file')
        await originalWriteFile(temp, '{"partial":')
        atFailure.resolve()
        await releaseFailure.promise
        throw error
      }
      if (failure === 'writeFile') {
        t.mock.method(fs, 'writeFile', async (...[file, ...args]: Parameters<typeof fs.writeFile>) => {
          if (++attempts === 1) return fail(String(file))
          return originalWriteFile(file, ...args)
        })
      } else {
        t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
          if (++attempts === 1) return fail(String(source))
          return originalRename(source, destination)
        })
      }
      syncBuiltinESMExports()

      const failed = provider.save(secondSnapshot)
      const rejected = assert.rejects(failed, error)
      await atFailure.promise
      try {
        assert.equal(await readFile(path, 'utf8'), previousText)
        assert.deepEqual(await provider.load(), firstSnapshot)
      } finally {
        releaseFailure.resolve()
        await rejected
      }
      assert.equal(await readFile(path, 'utf8'), previousText)
      assert.deepEqual(await provider.load(), firstSnapshot)
      assert.deepEqual(await readdir(dirname(path)), ['models.json'], 'failed temporary files are removed')

      // Queue recovery is tested with another failure and an already waiting save.
      attempts = 0
      const nextFailure = provider.save(secondSnapshot)
      const nextRejected = assert.rejects(nextFailure, error)
      const queued = accountCatalogStore('codex', 'second', path).save(secondSnapshot)
      await Promise.all([nextRejected, queued])
      assert.deepEqual(await provider.load(), firstSnapshot)
      assert.deepEqual(await accountCatalogStore('codex', 'second', path).load(), secondSnapshot)
    })
  }
})

test('readers see the previous complete file until a complete temporary file is renamed', async (t) => {
  const path = await tempStorePath(t)
  const provider = catalogStore('codex', path)
  await provider.save(firstSnapshot)
  const previousText = await readFile(path, 'utf8')
  const originalWriteFile = fs.writeFile
  const originalRename = fs.rename
  const partialWritten = deferred()
  const finishWrite = deferred()
  const atRename = deferred()
  const releaseRename = deferred()
  restoreFsMocks(t)
  t.mock.method(fs, 'writeFile', async (...[file, data, ...args]: Parameters<typeof fs.writeFile>) => {
    assert.notEqual(file, path, 'catalog writes must target a temporary file')
    assert.equal(dirname(String(file)), dirname(path), 'rename source must be in the same directory')
    assert.ok(String(file).startsWith(`${path}.tmp-`))
    await originalWriteFile(file, '{"partial":')
    partialWritten.resolve()
    await finishWrite.promise
    await originalWriteFile(file, data, ...args)
  })
  t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
    assert.equal(destination, path)
    assert.notEqual(source, path)
    assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { codex: secondSnapshot },
      'only a complete catalog may be renamed into place')
    atRename.resolve()
    await releaseRename.promise
    await originalRename(source, destination)
  })
  syncBuiltinESMExports()

  const saving = provider.save(secondSnapshot)
  await partialWritten.promise
  try {
    assert.equal(await readFile(path, 'utf8'), previousText)
    assert.deepEqual(await provider.load(), firstSnapshot)
    finishWrite.resolve()
    await atRename.promise
    assert.equal(await readFile(path, 'utf8'), previousText)
    assert.deepEqual(await provider.load(), firstSnapshot)
  } finally {
    finishWrite.resolve()
    releaseRename.resolve()
    await saving
  }
  assert.deepEqual(await provider.load(), secondSnapshot)
  assert.deepEqual(await readdir(dirname(path)), ['models.json'])
})

test('account catalog store treats a malformed accounts section as absent', async (t) => {
  const path = await tempStorePath(t)
  await writeFile(path, JSON.stringify({ codex: { at: 1, models: [{ id: 'a', name: 'A' }] }, accounts: [] }))
  const account = accountCatalogStore('codex', 'x', path)
  assert.equal(await account.load(), undefined)
  await account.clear()
  await account.save({ at: 2, models: [{ id: 'b', name: 'B' }] })
  const file = JSON.parse(await readFile(path, 'utf8')) as { codex: unknown; accounts: { codex: Record<string, unknown> } }
  assert.deepEqual(Object.keys(file.accounts.codex), ['x'])
  assert.notEqual(file.codex, undefined, 'the provider entry survives the rewrite')
})
