#!/usr/bin/env node
// Host E2E driver: checks the plugin inside a running `dsh web` the way a
// user meets it. scripts/host-e2e.sh boots the host with the fake profile
// and the network preload, then runs this script.
//
//   node scripts/host-e2e.mjs <origin> <cookie-jar> <seen-log> <artifact-dir>
//
// Assertions are about the plugin-host contract:
//   1. The usage RPCs read the fixture profile and return each source's
//      canned percentage (`usage`, `cursorUsage`, `externalUsage`).
//   2. The host's model picker lists the plugin's Codex model.
//   3. A message to that model streams through the plugin's adapter, and
//      the canned reply renders in the transcript.
//   4. The usage pill renders inside the host's stats row
//      (`data-composer-stats`), and its dialog shows each source's name
//      with that source's own percentage and wears the host's menu
//      material (translucent fill plus backdrop blur) in both themes,
//      while the collapsed pill stays transparent.
//   5. The plugin's settings section renders inside the host's settings
//      panel: nav entry, intro copy, provider cards for the signed-in
//      fixture profile, the usage-display control, and the preference it
//      writes survives a reload.
//   6. No slot entry crashed, no host contract lookup missed, and the page
//      threw no uncaught exception.
//   7. Every provider request from the server was a planned fixture
//      (FIXTURE_REQUESTS, exact method and URL) carrying the fixture
//      credential, or a planned refusal (EXPECTED_REFUSALS).
//   8. The page itself requested nothing outside loopback. Chrome runs
//      without the Node preload, so the driver fences it instead: every
//      proxied request goes to a dead local port, every hostname other than
//      localhost fails to resolve, and background networking is off. The
//      driver lists each non-loopback request the page attempted, from the
//      CDP Network events, as a page error.
//
// Clicking through the host UI to reach those states (onboarding, workspace,
// model menu) is harness, not assertion. A harness step that fails is
// retried once in a fresh browser. A failed assertion, or any slot crash or
// page error seen during the attempt, is a product failure and never
// retried. Exit 1 is a product failure, exit 2 a harness failure.
//
// Evidence in <artifact-dir>: the last RPC answers (rpc/), and for each
// browser attempt its screenshot, DOM, console, and page requests
// (browser-attempt-N/). A passing browser attempt saves the same set, so a
// later seen-log or server-log failure still has the page state to read.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PAGE_ERRORS = 'the page reported errors'
/** One RPC round trip; the fixture answers from memory, so this only bounds a hung server. */
const RPC_TIMEOUT_MS = 15_000
/** One CDP command or awaited event; bounds a crashed or wedged Chrome. */
const CDP_TIMEOUT_MS = 30_000
/**
 * How long the usage dialog may take to show every fixture value after it
 * opens. The pill is already on screen by then, so the badge's first usage
 * poll has run; this only covers the rest of that poll landing.
 */
const DIALOG_SETTLE_MS = 10_000

/** The plugin's usage dialog, as opposed to the host's modal settings panel. */
const USAGE_DIALOG = 'div[role="dialog"]:not([aria-modal="true"])'

/**
 * Appearance-row cube labels per theme, in the driver's two locales. Declared
 * with the other top-level constants: the checks below run from the module's
 * top-level try, before any declaration placed after it is initialized.
 */
const THEME_LABELS = {
  light: ['Light', '浅色'],
  dark: ['Dark', '深色'],
  system: ['System', '跟随系统'],
}

/** A failed assertion about the plugin. Never retried. */
class ProductFailure extends Error {}
/** A host UI step the driver could not complete. Retried once. */
class HarnessFailure extends Error {}

// Exit 1 only for a ProductFailure. Anything else, including an exception
// that escapes the main try (a stray socket error, a rejected promise
// nobody awaited), means the run did not check the plugin, so it exits 2
// and the nightly job opens no issue for it.
function exitFor(error) {
  const kind = error instanceof ProductFailure ? 'PRODUCT' : 'HARNESS'
  console.error(`HOST E2E ${kind} FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  if (!(error instanceof ProductFailure) && !(error instanceof HarnessFailure) && error instanceof Error) {
    console.error(error.stack)
  }
  console.error(`evidence: ${artifactDir}`)
  process.exit(error instanceof ProductFailure ? 1 : 2)
}
const [origin, jarPath, seenPath, artifactDir] = process.argv.slice(2)
/** Where the directory-picker fallback creates its workspace; host-e2e.sh removes it. */
const workspaceRoot = process.env.HOST_E2E_WORKSPACES ?? join(tmpdir(), 'host-e2e-workspaces')
if (origin === undefined || jarPath === undefined || seenPath === undefined || artifactDir === undefined) {
  console.error('usage: host-e2e.mjs <origin> <cookie-jar> <seen-log> <artifact-dir>')
  process.exit(2)
}
process.on('uncaughtException', exitFor)
process.on('unhandledRejection', exitFor)

// Loaded here rather than imported statically, so a missing or unreadable
// module is a harness failure (exit 2) instead of Node's own exit 1.
let CODEX_MODEL, CODEX_PILL, CODEX_REPLY, EXPECTED_REFUSALS, FIXTURE_REQUESTS, USAGE_PERCENT, MINIMAX_WINDOWS
let HOST_CONTRACT, HOST_CONTRACT_MISS, SECTION_EN

try {
  ;({
    CODEX_MODEL, CODEX_PILL, CODEX_REPLY, EXPECTED_REFUSALS, FIXTURE_REQUESTS, USAGE_PERCENT, MINIMAX_WINDOWS,
  } = await import('./host-e2e-fixture.mjs'))
  // Node strips the types from these dependency-free modules; see their headers.
  ;({ HOST_CONTRACT, HOST_CONTRACT_MISS } = await import(join(root, 'src/client/host-contract.ts')))
  // Section copy is asserted in the host UI, so the driver reads the same
  // dictionary the component renders and the unit specs assert against.
  ;({ en: SECTION_EN } = await import(join(root, 'src/client/locales.ts')))
  mkdirSync(artifactDir, { recursive: true })
  const cookies = readCookies(readFileSync(jarPath, 'utf8'))
  if (cookies.length === 0) throw new HarnessFailure('the session cookie jar is empty')
  const roster = await waitForFixture(cookies)
  await checkUsageRpcs(cookies, roster)
  console.log('ok: usage, cursorUsage, and externalUsage return every fixture percentage')
  await checkBrowser(cookies)
  checkSeenLog()
  console.log('ok: every provider request hit a fixture with the fixture credential or a planned refusal')
  console.log('HOST E2E PASS')
} catch (error) {
  exitFor(error)
}

// ---------------------------------------------------------------------------
// RPC checks

function readCookies(text) {
  const cookies = []
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('# ')) continue
    const httpOnly = line.startsWith('#HttpOnly_')
    const fields = (httpOnly ? line.slice('#HttpOnly_'.length) : line).split('\t')
    if (fields.length < 7) continue
    cookies.push({
      domain: fields[0],
      path: fields[2],
      secure: fields[3] === 'TRUE',
      name: fields[5],
      value: fields[6],
      httpOnly,
    })
  }
  return cookies
}

/** One subscriptions-auth RPC in the browser's envelope; returns `result` (`{ ok, value | error }`). */
async function rpc(cookies, endpoint, payload) {
  const response = await fetch(`${origin}/api/subscriptions-auth.${endpoint}`, {
    method: 'POST',
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${endpoint}`, method: `subscriptions-auth.${endpoint}`, payload }),
  })
  const text = await response.text()
  saveRpc(endpoint, payload, response.status, text)
  if (!response.ok) throw new ProductFailure(`subscriptions-auth.${endpoint} answered HTTP ${response.status}`)
  const body = JSON.parse(text)
  if (/"accessToken"|"refreshToken"|Bearer /.test(JSON.stringify(body))) {
    throw new ProductFailure(`subscriptions-auth.${endpoint} response includes credential material`)
  }
  return body.result
}

/** Keep the last answer of each RPC call as evidence. */
function saveRpc(endpoint, payload, status, text) {
  const dir = join(artifactDir, 'rpc')
  mkdirSync(dir, { recursive: true })
  const name = [endpoint, ...Object.values(payload).filter(value => typeof value === 'string')].join('-').replace(/[^\w.-]/g, '_')
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ payload, status, body: text }, null, 2)}\n`)
}

/**
 * Wait until the server reports every fixture account signed in.
 * @returns the default account key of each OAuth provider.
 */
async function waitForFixture(cookies) {
  const oauth = ['codex', 'claude', 'grok', 'copilot', 'antigravity']
  let last = 'no answer yet'
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const status = await rpc(cookies, 'status', {})
      const external = await rpc(cookies, 'externalStatus', {})
      const cursor = await rpc(cookies, 'cursorStatus', {})
      const providers = status?.value?.providers ?? {}
      const accounts = Object.fromEntries(oauth.map(id => [id, providers[id]?.accounts?.find(a => a.isDefault)?.key]))
      const signedIn = oauth.every(id => accounts[id] !== undefined)
      const keys = ['opencode-go', 'kimi-code', 'minimax'].every(source => external?.value?.[source]?.configured === true)
        && external?.value?.['minimax-cn']?.configured === false
      const cursorIn = cursor?.value?.authenticated === true
      if (signedIn && keys && cursorIn) return accounts
      last = `oauth=${JSON.stringify(accounts)} keys=${keys} cursor=${cursorIn}`
    } catch (error) {
      if (error instanceof ProductFailure) throw error
      last = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new ProductFailure(`the plugin did not report the fixture profile as signed in (${last})`)
}

/**
 * Single-window sources return their own distinct fixture percentage. MiniMax
 * returns four exact scoped windows, including percentage-only quota and its
 * own millisecond bounds; merged rows or fabricated counts fail. Copilot has
 * no usage endpoint.
 */
async function checkUsageRpcs(cookies, accounts) {
  const calls = [
    ...['codex', 'claude', 'grok', 'antigravity'].map(provider => ({
      source: provider, endpoint: 'usage', payload: { provider, account: accounts[provider] },
    })),
    { source: 'cursor-subscription', endpoint: 'cursorUsage', payload: {} },
    { source: 'opencode-go', endpoint: 'externalUsage', payload: { source: 'opencode-go' } },
    { source: 'kimi-coding', endpoint: 'externalUsage', payload: { source: 'kimi-code' } },
  ]
  const wrong = []
  for (const { source, endpoint, payload } of calls) {
    const result = await rpc(cookies, endpoint, payload)
    const percents = (result?.value?.windows ?? []).map(window => window.usedPercent)
    // Equal up to float error only: Antigravity reports 1 - remainingFraction,
    // so its 44 arrives as 43.99999999999999. A rounded match would let a
    // wrong 11.4 through as 11.
    if (result?.ok !== true || result.value.supported !== true || percents.length !== 1
      || typeof percents[0] !== 'number' || Math.abs(percents[0] - USAGE_PERCENT[source].percent) > 1e-9) {
      wrong.push(`${endpoint}(${JSON.stringify(payload)}) → ${JSON.stringify(result)}`)
    }
  }
  const minimax = await rpc(cookies, 'externalUsage', { source: 'minimax' })
  if (minimax?.ok !== true || minimax.value.supported !== true || minimax.value.plan !== 'MiniMax'
    || !isDeepStrictEqual(minimax.value.windows, MINIMAX_WINDOWS)) {
    wrong.push(`externalUsage(minimax) should return exact scoped windows ${JSON.stringify(MINIMAX_WINDOWS)} → ${JSON.stringify(minimax)}`)
  }
  const now = Date.now()
  if (!MINIMAX_WINDOWS.every(window => window.startsAt <= now && now < window.resetsAt)) {
    throw new HarnessFailure('MiniMax fixture bounds are not current; omit HOST_E2E_FIXTURE_NOW or use a current epoch')
  }
  const copilot = await rpc(cookies, 'usage', { provider: 'copilot', account: accounts.copilot })
  if (copilot?.ok !== true || copilot.value.supported !== false) {
    wrong.push(`usage(copilot) should be { supported: false } → ${JSON.stringify(copilot)}`)
  }
  if (wrong.length > 0) throw new ProductFailure(`usage RPCs did not return the fixture values:\n  ${wrong.join('\n  ')}`)
}

// ---------------------------------------------------------------------------
// Browser checks

async function checkBrowser(cookies) {
  for (let attempt = 1; ; attempt++) {
    const evidence = join(artifactDir, `browser-attempt-${attempt}`)
    try {
      await withChrome(cookies, evidence, (cdp, page) => drive(cdp, page, evidence))
      return
    } catch (error) {
      if (!(error instanceof HarnessFailure) || attempt === 2) throw error
      console.log(`retry: harness step failed on attempt ${attempt} (${error.message}); evidence in ${evidence}`)
    }
  }
}

/**
 * Open the web UI in headless Chrome, run `body`, and save evidence either
 * way. Console output, page errors, and page requests are collected for the
 * whole visit.
 *
 * Chrome does not load the Node preload, so it gets its own network fence:
 * every non-loopback request goes to a proxy port nothing listens on, and
 * host names other than loopback do not resolve. Loopback bypasses the proxy
 * by Chrome's default rules. The page's attempts are still recorded, and
 * any attempt fails the run.
 */
async function withChrome(cookies, evidence, body) {
  const chrome = findChrome()
  const port = await freePort()
  const deadProxy = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'host-e2e-chrome-'))
  // Chrome leaves scratch dirs (com.google.Chrome.*) in its TMPDIR. Give it
  // one of its own so the cleanup below removes them. The path stays short
  // under /tmp: Chrome aborts when its singleton socket path there exceeds
  // the 108-byte Unix socket limit, which a deep workspace TMPDIR can do.
  const chromeTmp = mkdtempSync('/tmp/dsh-e2e-chrome-')
  const child = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${deadProxy}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--lang=en-US',
    '--window-size=1280,900',
    'about:blank',
  ], {
    stdio: 'ignore',
    env: { ...process.env, TMPDIR: chromeTmp },
    // Its own process group: google-chrome is a shell wrapper, and signalling
    // only the wrapper leaves Chrome writing into the profile being removed.
    detached: true,
  })
  const page = { console: [], exceptions: [], outside: [] }
  let cdp
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`)
    const list = await waitForJson(`http://127.0.0.1:${port}/json/list`)
    const target = list.find(entry => entry.type === 'page')
    if (target?.webSocketDebuggerUrl === undefined) throw new HarnessFailure('headless Chrome opened no page')
    cdp = await connect(target.webSocketDebuggerUrl)
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      page.console.push({ type, text: args.map(arg => arg.value ?? arg.description ?? '').join(' ') })
    })
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      page.exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
    })
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (leavesLoopback(request.url)) page.outside.push(`${request.method} ${request.url}`)
    })
    cdp.on('Network.webSocketCreated', ({ url }) => {
      if (leavesLoopback(url)) page.outside.push(`WebSocket ${url}`)
    })
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    for (const cookie of cookies) {
      await cdp.send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
      })
    }
    // Wait for both together, so a failed navigate cannot leave the load
    // waiter rejecting unobserved.
    await Promise.all([cdp.waitEvent('Page.loadEventFired'), cdp.send('Page.navigate', { url: origin })])
    await body(cdp, page)
    await saveEvidence(cdp, page, evidence)
    // Saving the evidence takes a moment, and the page keeps running. Check
    // again so a late exception or request fails the run instead of only
    // appearing in console.json.
    const late = await pageProblems(cdp, page)
    if (late.length > 0) throw new ProductFailure(`${PAGE_ERRORS}:\n  ${late.join('\n  ')}`)
  } catch (error) {
    await saveEvidence(cdp, page, evidence)
    // A crashed slot usually surfaces first as a missing element, which
    // reads as a harness step. The crash is the product failure, so it is
    // named and never retried: a crash that goes away in a second browser
    // is still a crash.
    const problems = await pageProblems(cdp, page)
    if (problems.length > 0 && error instanceof Error && !error.message.startsWith(PAGE_ERRORS)) {
      throw new ProductFailure(`${error.message}\n  ${PAGE_ERRORS}:\n  ${problems.join('\n  ')}`)
    }
    throw error
  } finally {
    cdp?.close()
    await stopChrome(child)
    // Chrome can still be releasing the profile directory for a moment.
    for (const dir of [profile, chromeTmp]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        console.error(`host E2E: could not remove Chrome's directory ${dir}`)
      }
    }
  }
}

async function captureNamedScreenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(artifactDir, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

async function saveEvidence(cdp, page, dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'console.json'), `${JSON.stringify(page, null, 2)}\n`)
  if (cdp === undefined) return
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(dir, 'screenshot.png'), Buffer.from(shot.data, 'base64'))
    writeFileSync(join(dir, 'dom.html'), await cdp.evaluate('document.documentElement.outerHTML'))
    writeFileSync(join(dir, 'summary.txt'), `${await snapshot(cdp)}\n`)
  } catch (error) {
    writeFileSync(join(dir, 'evidence-error.txt'), String(error))
  }
}

async function drive(cdp, page, evidence) {
  // Harness: reach an editable composer.
  if (!await waitFor(cdp, hasText('Send message'), 30_000)) throw new HarnessFailure('web UI did not show a composer')
  await dismissOnboarding(cdp)
  await ensureWorkspace(cdp)

  // Product: the host's model picker lists the plugin's Codex model.
  if (!await clickLabel(cdp, ['Select model', '选择模型'])) throw new HarnessFailure('model menu did not open')
  if (!await clickLabel(cdp, ['Model', '模型'])) throw new HarnessFailure('model list did not open')
  if (!await waitFor(cdp, hasText(CODEX_MODEL.name), 20_000)) {
    throw new ProductFailure(`the host model picker does not list ${CODEX_MODEL.name}`)
  }
  console.log(`ok: model picker lists ${CODEX_MODEL.name}`)
  if (!await clickLabel(cdp, [CODEX_MODEL.name])) throw new HarnessFailure(`${CODEX_MODEL.name} could not be selected`)
  await dismissOnboarding(cdp)
  await pressKey(cdp, 'Escape', 27)

  // Harness: send one message.
  if (!await typeDraft(cdp, 'host e2e check')) throw new HarnessFailure('composer did not accept the draft')
  if (!await clickEnabled(cdp, ['Send message', '发送消息'])) throw new HarnessFailure('composer send control was not available')
  if (!await waitFor(cdp, '(() => document.querySelector(\'[data-phase="active"]\') !== null)()', 15_000)) {
    throw new HarnessFailure('composer stayed on the hero layout after send')
  }

  // Product: the reply streamed through the plugin's Codex adapter.
  if (!await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(CODEX_REPLY)})`, 30_000)) {
    throw new ProductFailure(`the canned Codex reply "${CODEX_REPLY}" did not render in the transcript`)
  }
  console.log('ok: a Codex message streamed through the plugin and rendered')

  // Product: the pill sits in the host's stats row, not on its own line.
  const pillIn = (scope) => `(() => [...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})]
    .some(node => (node.getAttribute('aria-label') || '').includes(${JSON.stringify(CODEX_PILL)})))()`
  const statsRow = `[${HOST_CONTRACT.markers.composerStats.attribute}]`
  if (!await waitFor(cdp, pillIn(statsRow), 30_000)) {
    const elsewhere = await cdp.evaluate(pillIn(''))
    throw new ProductFailure(elsewhere
      ? `the usage pill ${CODEX_PILL} rendered outside ${statsRow}`
      : `the usage pill ${CODEX_PILL} did not render`)
  }
  console.log(`ok: usage pill ${CODEX_PILL} renders inside ${statsRow}`)

  // Product: the dialog lists every source with its own percentage.
  const colorPreset = await cdp.evaluate(`localStorage.getItem('dsh.subscriptions.usageColorPreset')`)
  if (colorPreset !== null && colorPreset !== 'standard') throw new HarnessFailure('MiniMax zero-used marker check requires Standard usage coloring')
  if (!await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('[data-composer-stats] button[aria-haspopup="dialog"]')].find(b => b.getAttribute('aria-label')?.includes('Codex ')); if (!button) return false; button.click(); return true })()`)) throw new HarnessFailure('the usage pill could not be clicked')
  if (!await waitFor(cdp, '(() => document.querySelector(\'[role="dialog"]\') !== null)()', 10_000)) {
    throw new ProductFailure('the usage dialog did not open')
  }
  // Antigravity quotas stay behind the preview disclosure unless the current
  // model is an Antigravity model. Open every disclosure before reading.
  await cdp.evaluate(`(() => {
    for (const summary of document.querySelectorAll('[role="dialog"] summary')) summary.click()
    return true
  })()`)
  // The badge fills the dialog from usage RPCs that settle at their own
  // pace, so poll until it shows the fixture, and judge the last snapshot
  // when the deadline passes. A wrong value only fails later; it cannot pass.
  let sections = []
  let wrong = []
  const deadline = Date.now() + DIALOG_SETTLE_MS
  for (;;) {
    sections = await dialogSections(cdp)
    wrong = dialogMismatches(sections)
    if (wrong.length === 0 || Date.now() >= deadline) break
    await delay(250)
  }
  if (wrong.length > 0) {
    throw new ProductFailure(`usage dialog does not match the fixture:\n  ${wrong.join('\n  ')}\n  sections: ${JSON.stringify(sections).slice(0, 2000)}`)
  }
  const paceMissing = await cdp.evaluate(`(() => {
    const sections = [...document.querySelectorAll('[role="dialog"] section')]
    return ['Codex', 'Claude', 'OpenCode Go'].filter(name => {
      const section = sections.find(s => s.textContent.includes(name))
      return !section?.querySelector('[data-usage-time-marker]')
    })
  })()`)
  if (paceMissing.length) throw new ProductFailure(`fixed-window time markers missing: ${paceMissing.join(', ')}`)
  console.log('ok: Codex and Claude fixed-window time markers render')
  console.log('ok: usage dialog lists every source with its fixture percentage')
  await checkMiniMaxRows(cdp)
  await captureNamedScreenshot(cdp, 'usage-dialog')
  const minimaxSection = await cdp.evaluate(`(() => {
    const section = [...document.querySelectorAll('${USAGE_DIALOG} section')].find(section => section.querySelector('span')?.textContent === 'MiniMax')
    if (!section) return false
    section.scrollIntoView({ block: 'center' })
    return true
  })()`)
  if (!minimaxSection) throw new ProductFailure('MiniMax badge section missing before screenshot')
  await captureNamedScreenshot(cdp, 'usage-dialog-minimax')

  // Product: the dialog wears the host's menu material in both themes, and
  // the collapsed pill is still transparent.
  await checkDialogSurface(cdp, evidence)

  // Product: the settings section renders inside the host's settings panel
  // and its display preference persists across a reload.
  await pressKey(cdp, 'Escape', 27)
  await delay(400)
  await checkSettingsSection(cdp)

  // Product: nothing crashed along the way.
  const problems = await pageProblems(cdp, page)
  if (problems.length > 0) throw new ProductFailure(`${PAGE_ERRORS}:\n  ${problems.join('\n  ')}`)
  console.log('ok: no slot crash, host contract miss, uncaught page error, or page request outside loopback')
}

/**
 * The plugin's settings section inside the host's settings panel. Opens the
 * panel through the host's settings trigger, navigates to the Subscriptions
 * section, and asserts the rendered copy and controls against the same
 * locale dictionary the component reads (SECTION_EN) and the unit specs
 * assert against. Then flips the usage-display preference to Hidden,
 * asserts the write landed in localStorage, reloads the page, and asserts
 * the control still reads Hidden — the persistence contract the
 * `usage-badge-preferences` unit spec proves at the helper layer.
 *
 * The settings panel is `div[role="dialog"][aria-modal="true"]` with a nav
 * rail; the section body renders inside `div[data-slot="settings.section"]`
 * (the slot outlet anchor). The usage dialog from the pill assertions is
 * also `role="dialog"` but never carries `aria-modal`, so the selector
 * scopes to the settings panel on both gated host versions.
 */
async function checkSettingsSection(cdp) {
  const t = SECTION_EN
  const panel = 'div[role="dialog"][aria-modal="true"]'
  const outlet = `${panel} [data-slot="settings.section"]`

  // Harness: open the settings panel through the host's trigger.
  if (!await clickLabel(cdp, ['Settings', '设置'])) throw new HarnessFailure('the settings trigger did not open the panel')
  if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(panel)}) !== null)()`, 10_000)) {
    throw new ProductFailure('the host settings panel did not open')
  }

  // Harness: navigate to the plugin's section. The nav lists every
  // registered section; the plugin's entry is labeled from its dictionary.
  if (!await clickLabel(cdp, [t.nav, '订阅'])) throw new HarnessFailure(`the settings nav has no ${t.nav} entry`)
  if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(outlet)}) !== null)()`, 10_000)) {
    throw new ProductFailure(`the ${t.nav} section did not render inside the settings panel`)
  }

  // Product: the section copy, provider cards, and display control render
  // with the dictionary's wording. The fixture profile signs every provider
  // in, so each card reports one connected account; that line arrives with
  // the section's status RPC, so poll until it lands and judge the last
  // snapshot when the deadline passes.
  const missingExpression = `(() => {
    const scope = document.querySelector(${JSON.stringify(outlet)})
    if (scope === null) return ['section outlet missing']
    const text = scope.textContent ?? ''
    const wanted = [
      ${JSON.stringify(t.intro)},
      ${JSON.stringify(t.usageBadgeDisplay)},
      ${JSON.stringify(t.usageBadgeDisplayRecent)},
      ${JSON.stringify(t.usageBadgeDisplayAlways)},
      ${JSON.stringify(t.usageBadgeDisplayHidden)},
      ${JSON.stringify(t.usageBadgeDisplayHint)},
      'Codex (ChatGPT)', 'Claude', 'Grok (X Premium)', 'GitHub Copilot', 'Google Antigravity',
      ${JSON.stringify(t.loggedInCount.replace('{count}', '1'))},
      ${JSON.stringify(t.cursorTitle)},
      'OpenCode Go', 'Kimi Code', 'MiniMax',
      ${JSON.stringify(t.externalUsageConnected)},
    ]
    return wanted.filter(line => !text.includes(line))
  })()`
  let missing = []
  const deadline = Date.now() + DIALOG_SETTLE_MS
  for (;;) {
    missing = await cdp.evaluate(missingExpression)
    if (missing.length === 0 || Date.now() >= deadline) break
    await delay(250)
  }
  if (missing.length > 0) {
    throw new ProductFailure(`the ${t.nav} section is missing rendered copy:\n  ${missing.join('\n  ')}`)
  }
  console.log(`ok: settings section ${t.nav} renders intro, provider cards, and the display control`)
  await captureNamedScreenshot(cdp, 'settings')
  await checkMiniMaxRows(cdp, outlet)
  const minimaxCard = await cdp.evaluate(`(() => {
    const name = [...document.querySelectorAll(${JSON.stringify(`${outlet} span`)})].find(span => span.textContent === 'MiniMax')
    if (!name) return false
    name.parentElement.parentElement.scrollIntoView({ block: 'center' })
    return true
  })()`)
  if (!minimaxCard) throw new ProductFailure('MiniMax settings card missing before screenshot')
  await captureNamedScreenshot(cdp, 'settings-minimax')
  if (process.env.HOST_E2E_COLOR_CHECK === '1') {
    const colorSelect = `document.querySelector(${JSON.stringify(`${outlet} select[aria-label="${t.usageColorLabel}"]`)})`
    if (!await waitFor(cdp, `(() => ${colorSelect} !== null)()`, 10_000)) throw new ProductFailure('usage coloring control missing')
    const values = await cdp.evaluate(`(() => [...${colorSelect}.options].map(o => o.value))()`)
    if (JSON.stringify(values) !== JSON.stringify(['standard', 'relaxed', 'remaining'])) throw new ProductFailure('usage coloring presets mismatch')
    await setSelectValue(cdp, colorSelect, 'remaining')
    if (await cdp.evaluate(`localStorage.getItem('dsh.subscriptions.usageColorPreset')`) !== 'remaining') throw new ProductFailure('usage coloring did not persist')
    console.log('ok: coloring exposes exactly three presets and persists Remaining quota only')
  }

  // Product: the display control is a select bound to the preference the
  // unit spec covers; flipping it persists to localStorage.
  const select = `document.querySelector(${JSON.stringify(`${outlet} select[aria-label="${t.usageBadgeDisplay}"]`)})`
  if (!await waitFor(cdp, `(() => ${select} !== null)()`, 10_000)) {
    throw new ProductFailure(`the ${t.usageBadgeDisplay} select did not render`)
  }
  const options = await cdp.evaluate(`(() => [...${select}.options].map(option => ({ value: option.value, text: option.textContent })))()`)
  const expectedOptions = [
    { value: 'recent', text: t.usageBadgeDisplayRecent },
    { value: 'always', text: t.usageBadgeDisplayAlways },
    { value: 'hidden', text: t.usageBadgeDisplayHidden },
  ]
  if (JSON.stringify(options) !== JSON.stringify(expectedOptions)) {
    throw new ProductFailure(`the ${t.usageBadgeDisplay} select options are ${JSON.stringify(options)}, expected ${JSON.stringify(expectedOptions)}`)
  }
  await setSelectValue(cdp, select, 'hidden')
  const stored = await cdp.evaluate(`window.localStorage.getItem('dsh.subscriptions.usageBadgeMode')`)
  if (stored !== 'hidden') {
    throw new ProductFailure(`flipping the display control stored ${JSON.stringify(stored)}, expected "hidden"`)
  }
  console.log('ok: the display control persists Hidden to localStorage')

  // Product: the preference survives a reload. The section mounts with the
  // stored value; no save action exists because the control autosaves.
  await Promise.all([cdp.waitEvent('Page.loadEventFired'), cdp.send('Page.navigate', { url: origin })])
  if (!await waitFor(cdp, hasText('Send message'), 30_000)) throw new HarnessFailure('web UI did not show a composer after reload')
  await dismissOnboarding(cdp)
  if (!await clickLabel(cdp, ['Settings', '设置'])) throw new HarnessFailure('the settings trigger did not reopen the panel after reload')
  if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(panel)}) !== null)()`, 10_000)) {
    throw new ProductFailure('the host settings panel did not reopen after reload')
  }
  if (!await clickLabel(cdp, [t.nav, '订阅'])) throw new HarnessFailure(`the settings nav lost its ${t.nav} entry after reload`)
  if (!await waitFor(cdp, `(() => ${select} !== null && ${select}.value === 'hidden')()`, 10_000)) {
    const value = await cdp.evaluate(`(() => ${select}?.value ?? null)()`)
    throw new ProductFailure(`after reload the display control reads ${JSON.stringify(value)}, expected "hidden"`)
  }
  console.log('ok: the display control still reads Hidden after a reload')
  if (process.env.HOST_E2E_COLOR_CHECK === '1') {
    const colorSelect = `document.querySelector(${JSON.stringify(`${outlet} select[aria-label="${t.usageColorLabel}"]`)})`
    if (!await waitFor(cdp, `(() => ${colorSelect}?.value === 'remaining')()`, 10_000)) throw new ProductFailure('usage coloring preference lost after reload')
    await setSelectValue(cdp, colorSelect, 'standard')
    console.log('ok: coloring survives reload and restores Standard')
  }

  // Leave the preference at its default so the rest of the run (and the
  // saved evidence) shows the shipped behavior.
  await setSelectValue(cdp, select, 'recent')
  await pressKey(cdp, 'Escape', 27)
  await delay(400)
}

/** Set a select's value through the native setter so React's onChange fires. */
async function setSelectValue(cdp, selectExpression, value) {
  const changed = await cdp.evaluate(`(() => {
    const select = ${selectExpression}
    if (select === null) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(select, ${JSON.stringify(value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value === ${JSON.stringify(value)}
  })()`)
  if (changed !== true) throw new HarnessFailure(`could not change the select to ${JSON.stringify(value)}`)
}

/**
 * Each provider section of the open usage dialog: its name, and the
 * percentage of every window row under it. textContent includes rows inside
 * a closed disclosure, so this does not depend on which ones are open.
 */
function dialogSections(cdp) {
  return cdp.evaluate(`[...document.querySelectorAll('[role="dialog"] section')].map(section => ({
    name: [...(section.querySelector('span')?.childNodes ?? [])]
      .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
    percents: [...section.querySelectorAll('dd')].map(dd => /^\\s*(\\d+)%/.exec(dd.textContent ?? '')?.[1] ?? dd.textContent),
  }))`)
}

/** MiniMax rows retain scope, percentage, and a visible time cursor, even at 0% used. */
async function checkMiniMaxRows(cdp, settingsOutlet) {
  const settings = settingsOutlet !== undefined
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(settingsOutlet ?? USAGE_DIALOG)})
    const matches = root === null ? [] : ${settings
      ? `[...root.querySelectorAll('span')].filter(span => span.textContent === 'MiniMax' && span.parentElement?.firstElementChild?.tagName === 'SPAN').map(span => span.parentElement.parentElement)`
      : `[...root.querySelectorAll('section')].filter(section => [...(section.querySelector('span')?.childNodes ?? [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === 'MiniMax')`}
    if (matches.length !== 1) return { cards: matches.length, rows: [] }
    const card = matches[0]
    for (const details of card.querySelectorAll('details')) if (!details.open) details.querySelector('summary')?.click()
    const rows = ${settings
      ? `[...card.querySelectorAll('[role="img"][data-usage-color]')].map(meter => ({ label: meter.previousElementSibling?.firstElementChild?.textContent, value: meter.previousElementSibling?.lastElementChild?.textContent, meter }))`
      : `[...card.querySelectorAll('dt')].map(dt => ({ label: dt.textContent, value: dt.nextElementSibling?.textContent, meter: dt.nextElementSibling?.nextElementSibling }))`}
    return { cards: matches.length, rows: rows.map(({ label, value, meter }) => {
      const marker = meter?.querySelector('[data-usage-time-marker]')
      const rect = marker?.getBoundingClientRect()
      return { label, percent: /^\\s*(\\d+)%/.exec(value ?? '')?.[1],
        fill: meter?.firstElementChild?.style.width,
        markers: meter?.querySelectorAll('[data-usage-time-marker]').length ?? 0,
        visible: !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(marker).visibility !== 'hidden' }
    }) }
  })()`
  let snapshot, wrong
  const deadline = Date.now() + DIALOG_SETTLE_MS
  for (;;) {
    snapshot = await cdp.evaluate(expression)
    wrong = []
    if (snapshot.cards !== 1) wrong.push(`${snapshot.cards} MiniMax cards`)
    if (snapshot.rows.length !== MINIMAX_WINDOWS.length) wrong.push(`${snapshot.rows.length} rows, expected ${MINIMAX_WINDOWS.length}`)
    for (const [index, window] of MINIMAX_WINDOWS.entries()) {
      const base = window.kind === 'session' ? SECTION_EN.usageSession : window.kind === 'weekly' ? SECTION_EN.usageWeekly : SECTION_EN.usageWindow
      const label = settings && window.kind === 'other' ? window.scope : `${base} · ${window.scope}`
      const row = snapshot.rows[index]
      if (row?.label !== label || row?.percent !== String(window.usedPercent)
        || Math.abs(Number.parseFloat(row?.fill) - window.usedPercent) > 1e-9 || !Number.isFinite(Number.parseFloat(row?.fill))
        || row?.markers !== 1 || row?.visible !== true) wrong.push(`${label}: expected ${window.usedPercent}% with its own visible time marker`)
    }
    if (wrong.length === 0 || Date.now() >= deadline) break
    await delay(250)
  }
  if (wrong.length) throw new ProductFailure(`MiniMax ${settings ? 'settings' : 'expanded badge'} rows mismatch: ${wrong.join('; ')} → ${JSON.stringify(snapshot)}`)
  console.log(`ok: MiniMax ${settings ? 'settings' : 'expanded badge'} keeps four scoped rows and time markers, including Standard 0% used`)
}

/** How the dialog's sections differ from the fixture; empty when they match. */
function dialogMismatches(sections) {
  const wrong = []
  for (const { name, percent } of Object.values(USAGE_PERCENT)) {
    const matches = sections.filter(section => section.name === name)
    if (matches.length !== 1) {
      wrong.push(`${name}: ${matches.length} sections`)
    } else if (JSON.stringify(matches[0].percents) !== JSON.stringify([String(percent)])) {
      wrong.push(`${name}: shows ${JSON.stringify(matches[0].percents)}, fixture serves ${percent}%`)
    }
  }
  // Copilot is signed in, but the plugin has no Copilot usage endpoint.
  const minimax = sections.filter(section => section.name === 'MiniMax')
  const minimaxPercents = MINIMAX_WINDOWS.map(window => String(window.usedPercent))
  if (minimax.length !== 1 || !isDeepStrictEqual(minimax[0]?.percents, minimaxPercents)) {
    wrong.push(`MiniMax: expected separate percentages ${JSON.stringify(minimaxPercents)}, shows ${JSON.stringify(minimax)}`)
  }
  const expectedNames = new Set([...Object.values(USAGE_PERCENT).map(({ name }) => name), 'MiniMax'])
  for (const { name } of sections) {
    if (!expectedNames.has(name)) wrong.push(`unexpected section ${JSON.stringify(name)}`)
  }
  return wrong
}

/**
 * The usage dialog must wear the host's menu material in both themes: the
 * translucent menu fill plus the host's backdrop blur. The fill alone keeps
 * the transcript behind the dialog sharp enough to read through it, which is
 * the defect this check catches.
 *
 * The panel's computed fill and blur are compared against probes resolving
 * the same theme tokens, so the check follows the host theme without
 * hard-coded colors or color-syntax parsing, and needs no screenshot
 * interpreter. The collapsed pill is judged in the same pass: the surface fix
 * must not paint the trigger. Each theme leaves a screenshot in the evidence
 * directory, and the problems from both themes are reported together so a
 * failing run still shows what the dark theme rendered.
 */
async function checkDialogSurface(cdp, evidence) {
  // The dialog is open from the percentage check above. Close it here rather
  // than leaning on the theme switch: clickLabel clicks with a synthetic
  // event that fires no pointerdown, so outside-pointer dismissal never sees
  // it, and the trigger's resting surface is measured with the dialog shut.
  await pressKey(cdp, 'Escape', 27)
  if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(USAGE_DIALOG)}) === null)()`, 5_000)) {
    throw new HarnessFailure('the usage dialog did not close before the surface check')
  }
  // The host records the active preference here, so the run restores what it
  // found instead of assuming the profile starts on `system`.
  const initial = await cdp.evaluate('document.documentElement.dataset.dsThemeSource')
  const surfaces = new Map()
  const problems = []
  try {
    for (const theme of ['light', 'dark']) {
      await applyTheme(cdp, theme)
      // The trigger is measured with the dialog closed: an open dialog
      // highlights the pill on purpose, so its resting surface is the contract.
      const pill = await pillSurface(cdp)
      if (pill.pillBackground === null) {
        throw new ProductFailure(`the usage pill is not in the stats row in the ${theme} theme`)
      }
      if (!await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('[data-composer-stats] button[aria-haspopup="dialog"]')].find(b => b.getAttribute('aria-label')?.includes('Codex ')); if (!button) return false; button.click(); return true })()`)) {
        throw new HarnessFailure(`the usage pill could not be clicked in the ${theme} theme`)
      }
      if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(USAGE_DIALOG)}) !== null)()`, 10_000)) {
        throw new ProductFailure(`the usage dialog did not open in the ${theme} theme`)
      }
      const surface = await dialogSurface(cdp)
      // The sample wait above is a bounded heuristic: the host can leave the
      // theme again while the dialog opens. This read happens in the same
      // synchronous evaluation as the computed styles, so a surface that does
      // not belong to the requested palette is caught here instead of being
      // reported as a finding about the theme it actually measured.
      if (surface.themeSource !== theme || surface.darkTheme !== (theme === 'dark')) {
        throw new HarnessFailure(`the ${theme} pass measured the ${surface.themeSource} theme`)
      }
      surfaces.set(theme, surface)
      await captureScreenshot(cdp, join(evidence, `dialog-surface-${theme}.png`))
      for (const wrong of surfaceMismatches(surface, pill)) problems.push(`${theme} theme: ${wrong}`)
      await pressKey(cdp, 'Escape', 27)
      if (!await waitFor(cdp, `(() => document.querySelector(${JSON.stringify(USAGE_DIALOG)}) === null)()`, 5_000)) {
        throw new HarnessFailure(`the usage dialog did not close after the ${theme} surface check`)
      }
    }
    const light = surfaces.get('light')
    const dark = surfaces.get('dark')
    // A fill that does not move with the theme means the probes read one theme
    // twice, so the dark pass would say nothing about the dark palette.
    if (light !== null && light !== undefined && dark !== null && dark !== undefined
      && light.menuFill === dark.menuFill) {
      problems.push('the menu fill did not change with the theme, so the dark pass proves nothing')
    }
  } catch (error) {
    throw surfaceStopFailure(problems, error)
  }
  // Report the surface findings before restoring the theme: a restore that
  // fails must not replace them, because a product failure is never retried
  // and a harness failure exits 2 without one.
  if (problems.length > 0) throw new ProductFailure(`the usage dialog surface is wrong:\n  ${problems.join('\n  ')}`)
  // Leave the host on the preference it started with.
  await applyTheme(cdp, THEME_LABELS[initial] === undefined ? 'system' : initial)
  console.log('ok: the usage dialog wears the host menu material in both themes, and the pill stays transparent')
}

/**
 * Switch the host's theme through the Appearance cubes in Settings → General
 * and assert the host applied it. The cubes are the host's own controls, so
 * this exercises the theme path a user takes rather than setting the body
 * attribute behind the host's back.
 */
async function applyTheme(cdp, theme) {
  const labels = THEME_LABELS[theme]
  if (!await clickLabel(cdp, ['Settings', '设置'])) {
    throw new HarnessFailure('the settings trigger did not open the panel for the theme switch')
  }
  // The Appearance row is a `settings.general.item`; the General section is
  // reachable from the nav rail whether or not the panel opened on it.
  await clickLabel(cdp, ['General', '通用设置'])
  const clicked = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(labels)}
    const cube = [...document.querySelectorAll('button[aria-pressed]')]
      .find(node => wanted.includes((node.innerText || '').trim()))
    if (cube === undefined) return false
    cube.click()
    return true
  })()`)
  if (clicked !== true) throw new HarnessFailure(`the Appearance row has no ${theme} cube`)
  // `system` follows the OS, so its dark attribute is whatever the media query
  // says; the other two are the preference itself. Both are read from the host
  // so a preference that silently failed to apply is caught here.
  const applied = theme === 'system'
    ? `document.documentElement.dataset.dsThemeSource === 'system' && document.body.hasAttribute('data-ds-dark-theme') === matchMedia('(prefers-color-scheme: dark)').matches`
    : `document.documentElement.dataset.dsThemeSource === ${JSON.stringify(theme)} && document.body.hasAttribute('data-ds-dark-theme') === ${theme === 'dark'}`
  if (!await waitFor(cdp, `(() => ${applied})()`, 10_000)) {
    throw new HarnessFailure(`the host did not apply the ${theme} theme`)
  }
  // The attributes flip before the theme settles. On DSH 0.1.7-rc.2 the
  // preference goes through the settings store and the theme is re-adopted
  // when the write arrives, so closing the panel can put the page back on the
  // previous theme for a moment; the first CI run of this check caught it and
  // it was reproduced locally. Wait for the theme to hold still, or a pass
  // measures one theme under the other theme's name.
  await pressKey(cdp, 'Escape', 27)
  if (!await waitForSettledTheme(cdp, theme)) {
    throw new HarnessFailure(`the ${theme} theme did not hold still after the settings panel closed`)
  }
}

/**
 * What the host currently resolves its theme to: the two attributes it
 * publishes, the OS scheme it would follow, and the menu fill through a probe
 * element. The fill moves with the palette without this driver knowing any
 * color.
 */
function themeSample(cdp) {
  return cdp.evaluate(`(() => {
    const probe = document.createElement('div')
    probe.style.setProperty('background', 'var(--dsw-specific-menu)')
    document.body.appendChild(probe)
    const menuFill = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      source: document.documentElement.dataset.dsThemeSource,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      media: matchMedia('(prefers-color-scheme: dark)').matches,
      menuFill,
    }
  })()`)
}

/**
 * Wait until two samples in a row agree and the theme is the one asked for.
 * One attribute read is not enough: on the hosts `applyTheme` names the
 * preference lands asynchronously, so the page can leave the requested theme
 * again after it has already shown it. This is a bounded wait for the flip
 * that was observed, not a promise that the theme cannot move later, which is
 * why the surface read checks the palette again in its own evaluation.
 */
async function waitForSettledTheme(cdp, theme) {
  let previous = await themeSample(cdp)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250)
    const current = await themeSample(cdp)
    const still = current.source === previous.source && current.dark === previous.dark
      && current.menuFill === previous.menuFill
    const wanted = current.source === theme
      && current.dark === (theme === 'system' ? current.media : theme === 'dark')
    if (still && wanted) return true
    previous = current
  }
  return false
}

/**
 * What to report when the surface check stops before both themes are done. A
 * finding already measured is not made uncertain by a driver step that fails
 * after it, and the browser retry would only repeat that step, so the finding
 * and the step that stopped the check are reported together as the product
 * failure. With nothing measured, or after an exception that says nothing
 * about the plugin, the driver keeps its own classification and its retry.
 */
function surfaceStopFailure(problems, error) {
  const classified = error instanceof HarnessFailure || error instanceof ProductFailure
  if (problems.length === 0 || !classified) return error
  return new ProductFailure(`the usage dialog surface is wrong:\n  ${problems.join('\n  ')}\n  and the check stopped there: ${error.message}`)
}

/**
 * The open dialog's surface, with the same theme tokens resolved through
 * probe elements. Computed values are compared, so no color syntax is parsed
 * and no palette is hard-coded here.
 */
function dialogSurface(cdp) {
  return cdp.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(USAGE_DIALOG)})
    if (panel === null) return null
    const probe = (value, property) => {
      const node = document.createElement('div')
      node.style.setProperty(property, value)
      document.body.appendChild(node)
      const computed = getComputedStyle(node)
      const resolved = property === 'background' ? computed.backgroundColor : computed.backdropFilter
      node.remove()
      return resolved
    }
    return {
      background: getComputedStyle(panel).backgroundColor,
      backdropFilter: getComputedStyle(panel).backdropFilter,
      menuFill: probe('var(--dsw-specific-menu)', 'background'),
      menuBlur: probe('var(--dsw-menu-backdrop-filter)', 'backdrop-filter'),
      // Read with the styles above, so the caller can tell which palette this
      // surface belongs to without a second, possibly later, evaluation.
      themeSource: document.documentElement.dataset.dsThemeSource,
      darkTheme: document.body.hasAttribute('data-ds-dark-theme'),
    }
  })()`)
}

/** The collapsed pill's resting surface, judged against a transparent probe. */
function pillSurface(cdp) {
  const statsRow = HOST_CONTRACT.markers.composerStats.attribute
  return cdp.evaluate(`(() => {
    const pill = [...document.querySelectorAll('[${statsRow}] button')]
      .find(node => (node.getAttribute('aria-label') || '').includes(${JSON.stringify(CODEX_PILL)}))
    const probe = document.createElement('div')
    probe.style.setProperty('background', 'transparent')
    document.body.appendChild(probe)
    const transparent = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { pillBackground: pill === undefined ? null : getComputedStyle(pill).backgroundColor, transparent }
  })()`)
}

/** How the dialog's surface diverges from the host menu material; empty when it matches. */
function surfaceMismatches(surface, pill) {
  const wrong = []
  if (surface === null || surface === undefined) {
    wrong.push('the usage dialog panel is not in the DOM')
  } else if (surface.menuBlur === 'none') {
    wrong.push('the host theme defines no menu backdrop filter, so this check cannot judge the surface')
  } else if (surface.backdropFilter !== surface.menuBlur) {
    wrong.push(`backdrop-filter is ${JSON.stringify(surface.backdropFilter)}, expected the host menu material ${JSON.stringify(surface.menuBlur)}`)
  }
  if (surface !== null && surface !== undefined && surface.background !== surface.menuFill) {
    wrong.push(`background is ${JSON.stringify(surface.background)}, expected the host menu fill ${JSON.stringify(surface.menuFill)}`)
  }
  if (pill.pillBackground !== pill.transparent) {
    wrong.push(`the collapsed pill painted its own background (${JSON.stringify(pill.pillBackground)}); it must stay transparent`)
  }
  return wrong
}

/** Write one screenshot into the run's evidence directory. */
async function captureScreenshot(cdp, path) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
}

/** Whether a page request would leave loopback; data:, blob:, and the like never do. */
function leavesLoopback(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false
  return !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(parsed.hostname)
}

/**
 * Slot crashes, host contract misses, uncaught exceptions, and page requests
 * outside loopback seen so far. The slot renderer catches an entry's crash,
 * so it never reaches the page's error handlers; its console line and crash
 * face are the only trace.
 */
async function pageProblems(cdp, page) {
  const { crashLog, errorAttribute } = HOST_CONTRACT.diagnostics
  // The recorded events stand even when the page can no longer be queried:
  // a dead CDP socket must not turn a seen crash into a retried harness step.
  // A failed DOM query is not itself a product problem: a harness failure
  // follows from the dead page anyway.
  let crashFaces = []
  if (cdp !== undefined) {
    try {
      const crashed = await cdp.evaluate(`[...document.querySelectorAll('[${errorAttribute}]')].map(node => node.getAttribute('${errorAttribute}'))`)
      crashFaces = crashed.map(slot => `slot ${slot} rendered its crash face`)
    } catch {
      // Keep the recorded events below.
    }
  }
  return [
    ...crashFaces,
    ...page.console.filter(entry => entry.text.includes(crashLog)).map(entry => `console: ${entry.text.slice(0, 400)}`),
    ...page.console.filter(entry => entry.text.includes(HOST_CONTRACT_MISS)).map(entry => `console: ${entry.text.slice(0, 400)}`),
    ...page.exceptions.map(text => `uncaught: ${text.slice(0, 400)}`),
    ...page.outside.map(request => `page request outside loopback (blocked): ${request}`),
  ]
}

/**
 * Make the composer editable. host-e2e.sh points the host's default
 * workspace at a temp directory, so a fresh profile normally opens one by
 * itself. When it does not, open a temp directory through the host's
 * directory picker.
 */
async function ensureWorkspace(cdp) {
  if (await editorReady(cdp, 15_000)) {
    console.log('harness: the host opened its default workspace')
    return
  }
  console.log('harness: no default workspace; opening one through the directory picker')
  mkdirSync(workspaceRoot, { recursive: true })
  const workspace = mkdtempSync(join(workspaceRoot, 'workspace-'))
  if (!await clickLabel(cdp, ['Choose workspace'])) throw new HarnessFailure('no default workspace, and the workspace picker did not open')
  // The picker lists the home directory first. While that listing loads,
  // its controls are disabled, and when it lands it closes the path editor.
  // Clicking Edit path before then loses the typed path, so wait until the
  // control has stayed enabled across two polls.
  const editPath = '(() => { const node = document.querySelector(\'button[aria-label="Edit path"]\'); return node !== null && !node.disabled })()'
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!await waitStable(cdp, editPath, 15_000)) throw new HarnessFailure('the workspace picker never settled')
    await clickLabel(cdp, ['Edit path'])
    if (!await waitFor(cdp, '(() => document.querySelector(\'input[aria-label="Edit path"]\') !== null)()', 5_000)) continue
    const typed = await cdp.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Edit path"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (input === null || setter === undefined) return false
      setter.call(input, ${JSON.stringify(workspace)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return input.value
    })()`)
    if (typed !== workspace) continue
    await pressKey(cdp, 'Enter', 13)
    if (await waitFor(cdp, hasText(workspace.split('/').at(-1)), 15_000)) {
      if (!await clickExact(cdp, 'Open')) throw new HarnessFailure(`workspace Open was not available for ${workspace}`)
      if (!await editorReady(cdp)) throw new HarnessFailure('composer did not become editable after opening the workspace')
      return
    }
  }
  throw new HarnessFailure('the workspace path could not be entered')
}

// ---------------------------------------------------------------------------
// Seen-log check

/**
 * Every line the preload logged is an exact FIXTURE_REQUESTS hit with the
 * fixture credential, or a refusal listed in EXPECTED_REFUSALS. Every
 * required fixture was hit at least once.
 */
function checkSeenLog() {
  let lines
  try {
    lines = readFileSync(seenPath, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
  } catch (error) {
    // The usage RPCs already returned fixture values, so the preload served
    // and logged them; a log that cannot be read is the harness's problem.
    throw new HarnessFailure(`cannot read the network preload's request log: ${error.message}`)
  }
  const problems = []
  const hits = new Set()
  for (const entry of lines) {
    if (entry.refused === true) {
      const target = entry.url ?? entry.host
      // A planned URL may carry a query string (catalog clients add their
      // version or beta flag); anything else, a longer path included, is new.
      if (!EXPECTED_REFUSALS.some(planned => target === planned || (entry.url !== undefined && target.startsWith(`${planned}?`)))) {
        problems.push(`unplanned request refused: ${entry.method ?? 'TCP'} ${target}`)
      }
      continue
    }
    const key = `${entry.method} ${entry.url}`
    const fixture = FIXTURE_REQUESTS[key]
    if (fixture === undefined) {
      problems.push(`logged request matches no fixture: ${key}`)
      continue
    }
    hits.add(key)
    if (entry.fixtureAuth !== true) problems.push(`${key} did not carry the fixture credential`)
    if (fixture.stream && entry.model !== CODEX_MODEL.id) {
      problems.push(`the Codex request asked for model ${entry.model}, not ${CODEX_MODEL.id}`)
    }
  }
  for (const [key, fixture] of Object.entries(FIXTURE_REQUESTS)) {
    if (fixture.required && !hits.has(key)) problems.push(`no request reached ${key}`)
  }
  if (problems.length > 0) throw new ProductFailure(`provider traffic was not as planned:\n  ${[...new Set(problems)].join('\n  ')}`)
}

// ---------------------------------------------------------------------------
// Host UI helpers

async function dismissOnboarding(cdp) {
  // Exact labels, and the confirmation actions before Skip. Skip is also the
  // footer control that opens the confirmation, so matching it first would
  // click the footer again and never confirm.
  const labels = ['Continue', 'Configure later', 'Open app', 'Got it', 'Skip', 'Get started', 'Next']
  for (let step = 0; step < 8; step++) {
    let clicked = false
    for (const label of labels) {
      if (await clickExact(cdp, label, 1)) {
        clicked = true
        break
      }
    }
    if (!clicked) return
    await delay(400)
  }
}

async function pressKey(cdp, key, windowsVirtualKeyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode })
}

async function typeDraft(cdp, text) {
  const box = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x + Math.min(24, rect.width / 2), y: rect.y + Math.min(16, rect.height / 2) }
  })()`)
  if (box === null || box === undefined) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.insertText', { text })
  if (await draftHas(cdp, text)) return true
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    el?.focus()
    document.execCommand('insertText', false, ${JSON.stringify(text)})
    return true
  })()`)
  return draftHas(cdp, text)
}

function draftHas(cdp, text) {
  return cdp.evaluate(`(() => (document.querySelector('[data-composer-input]')?.innerText || '').includes(${JSON.stringify(text)}))()`)
    .then(value => value === true)
}

function editorReady(cdp, timeoutMs = 15_000) {
  return waitFor(cdp, '(() => document.querySelector(\'[data-composer-input][contenteditable="true"]\') !== null)()', timeoutMs)
}

function hasText(text) {
  return `(() => [...document.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"]')].some(node => ((node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')).includes(${JSON.stringify(text)})))()`
}

async function clickExact(cdp, label, attempts = 10) {
  const expression = `(() => {
    const node = [...document.querySelectorAll('button')].find(item => (item.innerText || '').trim() === ${JSON.stringify(label)} && !item.disabled)
    if (node === undefined) return false
    node.click()
    return true
  })()`
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await cdp.evaluate(expression) === true) return true
    await delay(300)
  }
  return false
}

async function clickLabel(cdp, labels, attempts = 10) {
  const expression = `(() => {
    const labels = ${JSON.stringify(labels)}
    const nodes = [...document.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"]')]
    const node = nodes.find(item => {
      const text = (item.getAttribute('aria-label') || '') + ' ' + (item.innerText || '')
      return labels.some(label => text.includes(label))
    })
    if (node === undefined) return false
    node.click()
    return true
  })()`
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await cdp.evaluate(expression) === true) return true
    await delay(300)
  }
  return false
}

async function clickEnabled(cdp, labels, attempts = 10) {
  const expression = `(() => {
    const labels = ${JSON.stringify(labels)}
    const node = [...document.querySelectorAll('button')].find(item => {
      if (item.disabled) return false
      const text = (item.getAttribute('aria-label') || '') + ' ' + (item.innerText || '')
      return labels.some(label => text.includes(label))
    })
    if (node === undefined) return false
    node.click()
    return true
  })()`
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await cdp.evaluate(expression) === true) return true
    await delay(300)
  }
  return false
}

async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression) === true) return true
    await delay(300)
  }
  return false
}

/** Like waitFor, but the expression must hold on two polls in a row. */
async function waitStable(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let held = 0
  while (Date.now() < deadline) {
    held = await cdp.evaluate(expression) === true ? held + 1 : 0
    if (held >= 2) return true
    await delay(300)
  }
  return false
}

function snapshot(cdp) {
  return cdp.evaluate(`(() => {
    const phase = document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? ''
    const draft = (document.querySelector('[data-composer-input]')?.innerText || '').slice(0, 80)
    const send = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || '').includes('Send message'))
    const buttons = [...document.querySelectorAll('button')].map(node => (node.getAttribute('aria-label') || node.innerText || '').trim().slice(0, 160)).filter(Boolean).slice(0, 60)
    return ['phase: ' + phase, 'draft: ' + JSON.stringify(draft), 'sendDisabled: ' + (send === undefined ? 'missing' : String(send.disabled)), 'buttons:', ...buttons].join('\\n')
  })()`)
}

// ---------------------------------------------------------------------------
// Chrome and CDP plumbing

function findChrome() {
  const names = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .filter(name => name !== undefined && name.length > 0)
  for (const name of names) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' })
      return name
    } catch { /* try the next name */ }
  }
  throw new HarnessFailure('Chrome is not installed; set CHROME_BIN to a Chromium binary')
}

/** Stop Chrome's whole process group, and wait until it is gone. */
async function stopChrome(child) {
  const signalGroup = signal => {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      return false // the group has already exited
    }
  }
  if (!signalGroup('SIGTERM')) return
  for (let waited = 0; waited < 3_000; waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!signalGroup(0)) return
  }
  signalGroup('SIGKILL')
  for (let waited = 0; waited < 2_000 && signalGroup(0); waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForJson(url) {
  const deadline = Date.now() + 15_000
  let last
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return await response.json()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error
    }
    await delay(200)
  }
  throw new HarnessFailure(`Chrome DevTools did not answer: ${last}`)
}

/**
 * A CDP session over one page socket. Every command and awaited event fails
 * with a HarnessFailure after CDP_TIMEOUT_MS or when the socket closes, so a
 * crashed Chrome ends the attempt instead of hanging until the CI timeout.
 */
function connect(url) {
  const ws = new WebSocket(url)
  let next = 0
  let closed
  const pending = new Map()
  const waiters = new Map()
  const listeners = new Map()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HarnessFailure('Chrome DevTools socket did not open')), CDP_TIMEOUT_MS)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new HarnessFailure('Chrome DevTools socket failed')) })
  })
  ws.addEventListener('close', () => {
    closed = new HarnessFailure('Chrome DevTools socket closed (did Chrome crash?)')
    for (const waiter of pending.values()) waiter.reject(closed)
    pending.clear()
    for (const queue of waiters.values()) for (const waiter of queue) waiter.reject(closed)
    waiters.clear()
  })
  /**
   * Hand `register` a waiter, and reject after CDP_TIMEOUT_MS naming `what`.
   * `register` returns how to drop the waiter again, so a timed-out waiter
   * does not stay registered.
   */
  const bounded = (what, register) => new Promise((resolve, reject) => {
    if (closed !== undefined) {
      reject(closed)
      return
    }
    let unregister = () => {}
    const timer = setTimeout(() => {
      unregister()
      reject(new HarnessFailure(`Chrome DevTools: ${what} timed out`))
    }, CDP_TIMEOUT_MS)
    unregister = register({
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
  })
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params)
    const queue = waiters.get(message.method)
    if (queue === undefined) return
    waiters.delete(message.method)
    for (const waiter of queue) waiter.resolve(message.params)
  })
  return ready.then(() => ({
    send(method, params) {
      const id = ++next
      return bounded(method, waiter => {
        pending.set(id, waiter)
        ws.send(JSON.stringify({ id, method, params }))
        return () => pending.delete(id)
      })
    },
    on(method, listener) {
      listeners.set(method, [...listeners.get(method) ?? [], listener])
    },
    waitEvent(method) {
      return bounded(`waiting for ${method}`, waiter => {
        waiters.set(method, [...waiters.get(method) ?? [], waiter])
        return () => {
          const rest = (waiters.get(method) ?? []).filter(other => other !== waiter)
          if (rest.length > 0) waiters.set(method, rest)
          else waiters.delete(method)
        }
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true })
      if (result.exceptionDetails !== undefined) {
        throw new HarnessFailure(`page expression failed: ${result.exceptionDetails.text ?? expression.slice(0, 80)}`)
      }
      return result.result?.value
    },
    close() {
      ws.close()
    },
  }))
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
