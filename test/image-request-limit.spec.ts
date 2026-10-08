import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { ToolCallId } from '../src/compat.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { hostSupportsImageOffload, imageRequestTarget, requiredImageOffloadCount, resolveImages } from '../src/translate/resolved.js'
import { CLAUDE_REQUEST_IMAGE_BUDGET, ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

const LIMIT = { maxEdge: 2000, maxBytes: 3_750_000 }
const WIDE: ImageAttachmentRef = { attachmentId: AttachmentId('wide'), mediaType: 'image/png', bytes: 9, width: 2560, height: 1215 }
const TALL: ImageAttachmentRef = { attachmentId: AttachmentId('tall'), mediaType: 'image/png', bytes: 9, width: 1800, height: 2329 }
const SMALL: ImageAttachmentRef = { attachmentId: AttachmentId('small'), mediaType: 'image/png', bytes: 9, width: 800, height: 600 }

function withImages(...refs: ImageAttachmentRef[]): Message[] {
  return [{
    id: MessageId('m'),
    role: 'user',
    source: { kind: 'user' },
    content: refs.map(attachment => ({ type: 'image', attachment }) satisfies ImageBlock),
  }]
}

/** An attachment store recording which read each image took. */
function store(options: { projection?: 'unsupported' } = {}) {
  const calls: string[] = []
  const targets: unknown[] = []
  const attachments = {
    readImage: async (ref: ImageAttachmentRef) => {
      calls.push(`stored:${ref.attachmentId}`)
      return { ref, data: new Uint8Array([111]) }
    },
    readImageRequest: async (ref: ImageAttachmentRef, target: unknown): Promise<RequestImageAttachment> => {
      if (options.projection === 'unsupported') throw new Error('The mounted attachment provider cannot derive model-request images.')
      calls.push(`request:${ref.attachmentId}`)
      targets.push(target)
      return {
        variantId: ImageVariantId('v'),
        attachment: ref,
        data: new Uint8Array([115]),
        mediaType: 'image/jpeg',
        bytes: 1,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
  return { attachments: attachments satisfies Pick<AttachmentStore, 'readImage' | 'readImageRequest'> as unknown as AttachmentStore, calls, targets }
}

test('image request targets fit the long edge and carry both host projection shapes', () => {
  // Pre-0.1.7 hosts read maxPixels, 0.1.7+ hosts read width/height.
  assert.deepEqual(imageRequestTarget(WIDE, LIMIT), { width: 2000, height: 949, maxPixels: 1_898_000, maxBytes: 3_750_000 })
  assert.deepEqual(imageRequestTarget(TALL, LIMIT), { width: 1545, height: 2000, maxPixels: 3_090_000, maxBytes: 3_750_000 })
  assert.equal(imageRequestTarget({ width: 2000, height: 2000 }, LIMIT), undefined)
  assert.equal(imageRequestTarget(SMALL, LIMIT), undefined)
})

test('a limited route sends oversized images downscaled and leaves the rest as stored', async () => {
  const { attachments, calls, targets } = store()
  const [message] = await resolveImages(withImages(WIDE, SMALL), attachments, undefined, LIMIT)
  assert.deepEqual(calls, ['request:wide', 'stored:small'])
  assert.deepEqual(targets, [imageRequestTarget(WIDE, LIMIT)])
  assert.deepEqual(message!.content[0], { type: 'image', mediaType: 'image/jpeg', dataBase64: 'cw==' })
  // The reference the model may reuse still names the stored attachment.
  assert.match((message!.content[1] as { text: string }).text, /"attachmentId":"wide","mediaType":"image\/png","bytes":9,"width":2560/)
  assert.deepEqual(message!.content[2], { type: 'image', mediaType: 'image/png', dataBase64: 'bw==' })
})

test('without a limit, or on a host that cannot project, images are sent as stored', async () => {
  const unlimited = store()
  await resolveImages(withImages(WIDE), unlimited.attachments)
  assert.deepEqual(unlimited.calls, ['stored:wide'])
  const unsupported = store({ projection: 'unsupported' })
  const [message] = await resolveImages(withImages(WIDE), unsupported.attachments, undefined, LIMIT)
  assert.deepEqual(unsupported.calls, ['stored:wide'])
  assert.deepEqual(message!.content[0], { type: 'image', mediaType: 'image/png', dataBase64: 'bw==' })
})

/** A Claude adapter on one logged-in account whose requests `fetch` answers. */
function claudeAdapter(attachments: unknown) {
  const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
    io: {
      list: () => Promise.resolve([{ key: 'acct', session }]),
      get: () => Promise.resolve(session),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  })
  return new ClaudeAdapter({
    models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
    streamIdleTimeoutMs: 1000,
    tokens,
    discovery: false,
    resolveAttachments: () => attachments as never,
    resolveCliVersion: async () => '2.1.999',
  })
}

/** Drain a stubbed Claude turn; return its error and request count. */
async function claudeTurn(messages: Message[], attachments: unknown): Promise<{ error: unknown; fetches: number }> {
  let fetches = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    fetches += 1
    return new Response('{}', { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const options: GenerateOptions = { provider: 'claude', model: 'claude-opus-5-5', messages, maxTokens: 1_000 }
    for await (const _chunk of claudeAdapter(attachments).stream(options)) { /* drain */ }
    return { error: undefined, fetches }
  } catch (error: unknown) {
    return { error, fetches }
  } finally {
    globalThis.fetch = original
  }
}

/** An attachment store whose every image reads back as `bytes` raw bytes. */
function sizedStore(bytes: number) {
  const data = new Uint8Array(bytes)
  return {
    readImage: async (ref: unknown) => ({ ref, data }),
    readImageRequest: async (ref: unknown) => ({ attachment: ref, data, mediaType: 'image/png' }),
  }
}

test('Claude turns send images within the 2000px many-image limit (#110)', async () => {
  const { attachments, calls } = store()
  const { error } = await claudeTurn(withImages(TALL), attachments)
  assert.ok(error instanceof Error)
  assert.deepEqual(calls, ['request:tall'])
})

/** Resolved user turn carrying one inline image per given base64 length. */
function resolvedImages(...lengths: number[]): TranslatableMessage[] {
  return [{ role: 'user', content: lengths.map(length => ({ type: 'image', mediaType: 'image/png', dataBase64: 'A'.repeat(length) })) }]
}

test('a request within the image budget needs no offload', () => {
  assert.equal(requiredImageOffloadCount(resolvedImages(40, 60), 100), 0)
})

test('the oldest images are offloaded until the rest fit the budget', () => {
  assert.equal(requiredImageOffloadCount(resolvedImages(50, 30, 40, 20), 100), 1)
  assert.equal(requiredImageOffloadCount(resolvedImages(10, 10, 90, 20), 100), 3)
})

test('tool-result images count toward the budget and assistant images do not', () => {
  const messages: TranslatableMessage[] = [
    { role: 'assistant', content: resolvedImages(500)[0]!.content },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('call'), content: resolvedImages(80)[0]!.content }] },
    ...resolvedImages(80),
  ]
  assert.equal(requiredImageOffloadCount(messages, 100), 1)
})

test('this host records image offloads', () => {
  assert.equal(hostSupportsImageOffload(), true)
})

test('Claude asks the host to offload the oldest images instead of sending an oversized request', async () => {
  // 7 images of 3.75MB raw (5MB base64) total 35MB, over the 20MiB budget;
  // offloading the oldest 3 leaves 4 (20MB), which fits.
  const raw = 3_750_000
  const refs = Array.from({ length: 7 }, (_, index) => ({ ...SMALL, attachmentId: AttachmentId(`shot${index}`), bytes: raw }))
  const { error, fetches } = await claudeTurn(withImages(...refs), sizedStore(raw))
  assert.equal(fetches, 0, 'nothing is sent before the host offloads')
  assert.ok(error instanceof Error)
  const failure = error as Error & { code?: string; failure?: { offloadImages?: number } }
  assert.equal(failure.code, 'IMAGE_OFFLOAD_REQUIRED')
  const base64 = Math.ceil(raw / 3) * 4
  assert.equal(failure.failure?.offloadImages, 7 - Math.floor(CLAUDE_REQUEST_IMAGE_BUDGET / base64))
})

test('Claude sends a request whose images fit the budget', async () => {
  const refs = Array.from({ length: 3 }, (_, index) => ({ ...SMALL, attachmentId: AttachmentId(`shot${index}`), bytes: 1_000_000 }))
  const { error, fetches } = await claudeTurn(withImages(...refs), sizedStore(1_000_000))
  assert.equal(fetches, 1)
  assert.notEqual((error as { code?: string }).code, 'IMAGE_OFFLOAD_REQUIRED')
})

// Isolate namespace exports in a child process: ESM bindings cannot be mocked
// in place. Fetch stays stubbed and the hermetic preloader forbids live I/O.
test('a host without the offload exports still receives images unchanged', () => {
  const adapterUrl = new URL('../src/providers/claude.js', import.meta.url).href
  const accountsUrl = new URL('../src/providers/accounts.js', import.meta.url).href
  const hermetic = new URL('../../test/hermetic.mjs', import.meta.url)
  for (const missing of ['IMAGE_OFFLOAD_REQUIRED_CODE', 'offloadedImageText']) {
    const script = `
      import { registerHooks } from 'node:module';
      const real = import.meta.resolve('@deepseek-ai/dsh-llm');
      const source = 'export * from ' + JSON.stringify(real)
        + '; export const ${missing} = undefined;';
      const replacement = 'data:text/javascript,' + encodeURIComponent(source);
      registerHooks({ resolve(specifier, context, next) {
        return specifier === '@deepseek-ai/dsh-llm'
          ? { url: replacement, shortCircuit: true }
          : next(specifier, context);
      }});
      const { ClaudeAdapter } = await import(${JSON.stringify(adapterUrl)});
      const { AccountTokenManager } = await import(${JSON.stringify(accountsUrl)});
      const session = { accessToken: 'at', refreshToken: 'rt',
        expiresAt: Date.now() + 3600000, scopes: 'scope' };
      const tokens = new AccountTokenManager({ provider: 'claude', displayName: 'Test',
        makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }),
        io: { list: async () => [{ key: 'acct', session }], get: async () => session,
          save: async () => {}, remove: async () => {} } });
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; return new Response('{}', { status: 400 }); };
      const data = new Uint8Array(3750000);
      const adapter = new ClaudeAdapter({ models: [{ id: 'claude-opus-5-5' }],
        streamIdleTimeoutMs: 1000, tokens, discovery: false,
        resolveCliVersion: async () => '2.1.999',
        resolveAttachments: () => ({ readImage: async ref => ({ ref, data }) }) });
      const messages = [{ id: 'm', role: 'user', source: { kind: 'user' },
        content: Array.from({ length: 7 }, (_, i) => ({ type: 'image', attachment: {
          attachmentId: 'shot' + i, mediaType: 'image/png', bytes: data.length,
          width: 800, height: 600 } })) }];
      let code;
      try { for await (const chunk of adapter.stream({ provider: 'claude',
        model: 'claude-opus-5-5', messages, maxTokens: 1000 })) {} }
      catch (error) { code = error.code; }
      console.log(JSON.stringify({ fetches, code }));
    `
    const child = spawnSync(process.execPath, [
      '--import', hermetic.href, '--input-type=module', '-e', script,
    ], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout) as {
      fetches: number; code?: string
    }
    assert.equal(result.fetches, 1, missing)
    assert.notEqual(result.code, 'IMAGE_OFFLOAD_REQUIRED', missing)
  }
})
