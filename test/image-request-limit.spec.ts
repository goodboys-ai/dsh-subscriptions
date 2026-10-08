import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { imageRequestTarget, resolveImages } from '../src/translate/resolved.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
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

test('Claude turns send images within the 2000px many-image limit (#110)', async () => {
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
  const { attachments, calls } = store()
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 400 })) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens,
      discovery: false,
      resolveAttachments: () => attachments,
      resolveCliVersion: async () => '2.1.999',
    })
    const options: GenerateOptions = { provider: 'claude', model: 'claude-opus-5-5', messages: withImages(TALL), maxTokens: 1_000 }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    assert.deepEqual(calls, ['request:tall'])
  } finally {
    globalThis.fetch = original
  }
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

// Blocked on the host, not ported: our floor ships IMAGE_OFFLOAD_REQUIRED_CODE
// and offloadedImageText but nothing consumes the error, so upstream's guard
// would fail a multi-image turn before sending. This pins the state that makes
// the port unsafe, so it stops looking like missing coverage.
test('the floor host exports the offload contract but has no consumer for it', async () => {
  const llm = await import('@deepseek-ai/dsh-llm') as Record<string, unknown>
  assert.equal(llm['IMAGE_OFFLOAD_REQUIRED_CODE'], 'IMAGE_OFFLOAD_REQUIRED')
  assert.equal(typeof llm['offloadedImageText'], 'function')
  // Resolve through the real package specifier; the compiled spec lives under lib-test.
  const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-llm')), 'utf8')
  const consumers = source.match(/catch[^]{0,200}IMAGE_OFFLOAD_REQUIRED|IMAGE_OFFLOAD_REQUIRED[^]{0,80}requiredImageOffload\(/g)
  assert.equal(consumers, null, 'a consumer appeared: upstream eb42966 can be ported after review')
})
