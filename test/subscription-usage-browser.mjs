// Optional offline UI check: PLAYWRIGHT_PATH=/path/to/playwright node test/subscription-usage-browser.mjs
// No running DSH server, real accounts, credentials, screenshots or model writes.
import assert from 'node:assert/strict'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = (name) =>
  resolve(
    'node_modules/.pnpm',
    dependencies.find((entry) => entry.startsWith(`${name}@`)),
    'node_modules',
    name,
  )
const { build } = await import(
  pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`)
)
const { chromium } = await import(
  pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`)
)
const result = await build({
  input: 'test/subscription-usage-browser.fixture.tsx',
  resolve: {
    alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` },
  },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [
    {
      name: 'test-host-primitives',
      resolveId(id) {
        return id === '@deepseek-ai/dsh-client-ui-primitives'
          ? '\0subscription-test-host-primitives'
          : null
      },
      load(id) {
        return id === '\0subscription-test-host-primitives'
          ? `export const IconDataOutlineRegular = () => null
             export const useAnchoredPosition = () => ({ left: 16, top: 100 })
             export const useDismissOnOutsidePointer = () => {}`
          : null
      },
    },
    {
      name: 'test-css',
      load(id) {
        return id.endsWith('.css') ? 'export default {}' : null
      },
    },
  ],
  output: { format: 'iife' },
  write: false,
})
const code = result.output.find((file) => file.type === 'chunk').code
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
})
try {
  const context = await browser.newContext({
    viewport: { width: 900, height: 900 },
  })
  await context.route('**/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: route.request().url().endsWith('/app.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
      body: route.request().url().endsWith('/app.js')
        ? code
        : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>',
    }),
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto('http://subscription-usage.test/')
  const control = page.getByRole('combobox', {
    name: 'Status-bar quota display',
    exact: true,
  })
  const badge = page.locator('[data-composer-stats] button')
  const title = 'Provider usage'
  const panel = page.getByRole('dialog', { name: title, exact: true })
  await control.waitFor()
  await page.waitForFunction(
    () => Number(document.documentElement.dataset.modelReads) >= 2,
  )
  assert.equal(
    await badge.count(),
    0,
    'no unrelated provider without view history',
  )
  const choose = async (name, provider) => {
    const reads = await page.evaluate(() =>
      Number(document.documentElement.dataset.modelReads),
    )
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(
      ({ reads, provider }) =>
        Number(document.documentElement.dataset.modelReads) > reads &&
        document.documentElement.dataset.lastRead === provider,
      { reads, provider },
    )
  }
  for (const [name, provider, expected] of [
    ['codex', 'codex', 'Codex'],
    ['api', 'deepseek', 'Codex'],
    ['grok', 'grok', 'Grok'],
    ['api', 'deepseek', 'Grok'],
    ['antigravity', 'antigravity', 'Antigravity'],
    ['api', 'deepseek', 'Antigravity'],
  ]) {
    await choose(name, provider)
    await badge.waitFor()
    assert.equal(await badge.count(), 1)
    assert.match(await badge.innerText(), new RegExp(`^${expected} .*%`))
    assert.equal((await badge.innerText()).includes('|'), false)
  }
  console.log('40%: current/recent single-provider selection verified')
  await badge.click()
  await panel.waitFor()
  const anti = panel.locator('section').filter({ hasText: 'Antigravity' })
  // The dialog follows the retained subscription the badge shows: first, with
  // its model previewed, but not tagged current while an API model is selected.
  assert.match(
    await panel.locator('section').first().innerText(),
    /^Antigravity/,
  )
  assert.equal(await anti.getByText('current', { exact: true }).count(), 0)
  assert.equal(await anti.locator('dt:visible').count(), 2)
  assert.match(
    await anti.locator('dt:visible').first().innerText(),
    /gemini-model-59/,
  )
  await anti.locator('summary').first().click()
  assert.equal(await anti.locator('dt:visible').count(), 61)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await choose('antigravity', 'antigravity')
  await badge.click()
  await panel.waitFor()
  assert.equal(await anti.locator('dt:visible').count(), 2)
  assert.match(
    await anti.locator('dt:visible').first().innerText(),
    /gemini-model-59/,
  )
  const waitGoogleRows = async (expected) => {
    await page.waitForFunction((count) => {
      const sections = [
        ...(document.querySelectorAll('[role="dialog"] section') ?? []),
      ]
      const google = sections.find((section) =>
        section.textContent?.includes('Antigravity'),
      )
      return (google?.querySelectorAll('dt').length ?? 0) === count
    }, expected)
  }
  const refreshGoogle = async (name) => {
    const before = await page.evaluate(() => ({
      status: Number(document.documentElement.dataset.statusCalls ?? 0),
      usage: Number(document.documentElement.dataset.usageCalls ?? 0),
    }))
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(
      ({ status, usage }) =>
        Number(document.documentElement.dataset.statusCalls) > status &&
        Number(document.documentElement.dataset.usageCalls) >= usage + 2,
      before,
    )
  }
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await refreshGoogle('Filter Google models')
  await badge.click()
  await panel.waitFor()
  await waitGoogleRows(4)
  assert.equal(await anti.locator('dt:visible').count(), 2)
  assert.match(
    await anti.locator('dt:visible').first().innerText(),
    /gemini-model-59/,
  )
  assert.equal(
    await anti.getByText('More quota windows (1)', { exact: true }).count(),
    2,
  )
  await anti.locator('summary').nth(0).click()
  await anti.locator('summary').nth(1).click()
  assert.equal(await anti.locator('dt:visible').count(), 4)
  if (process.env.SUBSCRIPTION_USAGE_SCREENSHOT) {
    const path = process.env.SUBSCRIPTION_USAGE_SCREENSHOT
    await mkdir(dirname(path), { recursive: true })
    await page.screenshot({ path, fullPage: true })
  }
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await refreshGoogle('Clear Google models')
  await badge.click()
  await panel.waitFor()
  await waitGoogleRows(0)
  assert.equal(
    await anti
      .getByText('No usage windows for the models visible in the picker.', {
        exact: true,
      })
      .count(),
    2,
  )
  assert.equal(await anti.locator('summary').count(), 0)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await refreshGoogle('Fail Google usage')
  await refreshGoogle('Show all Google models')
  await badge.click()
  await panel.waitFor()
  await waitGoogleRows(120)
  assert.match(
    await badge.innerText(),
    /59%/,
    'raw cached quotas survive hiding and restore after failed fetches',
  )
  console.log(
    'Google visibility: previews, expanded counts, two accounts, empty selection and raw-cache recovery verified',
  )
  // Change the preference from a second tab while the quota dialog is open.
  const other = await context.newPage()
  await other.goto('http://subscription-usage.test/')
  const otherControl = other.getByRole('combobox', {
    name: 'Status-bar quota display',
    exact: true,
  })
  await otherControl.selectOption('hidden')
  await badge.waitFor({ state: 'detached' })
  await panel.waitFor({ state: 'detached' })
  assert.equal(await control.inputValue(), 'hidden')
  await page.reload()
  await control.waitFor()
  assert.equal(await control.inputValue(), 'hidden')
  await choose('codex', 'codex')
  assert.equal(await badge.count(), 0)
  // A page that loads hidden never asks for usage; showing it refreshes at once.
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.statusCalls),
    undefined,
  )
  await control.selectOption('recent')
  await badge.waitFor()
  assert.equal(
    await page.getByRole('dialog').count(),
    0,
    'unhiding does not reopen the previous dialog',
  )
  await page.waitForFunction(
    () => localStorage.getItem('dsh.subscriptions.usageBadgeMode') === 'recent',
  )
  await badge.click()
  await panel.waitFor()
  assert.equal(await panel.locator('section').count(), 3)
  const sectionText = await panel.locator('section').allInnerTexts()
  const providerOrder = sectionText.map((text) =>
    ['Codex', 'Grok', 'Antigravity'].find((name) => text.startsWith(name)),
  )
  assert.deepEqual([...providerOrder].sort(), ['Antigravity', 'Codex', 'Grok'])
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  console.log(
    '70%: compact Antigravity, cross-tab hiding and persisted preference verified',
  )
  // Always mode: the current provider pins the pill; without one the badge
  // rotates through the providers that report usage, in display order.
  // Unlike recent, a retained subscription must not pin: after switching to
  // the API model the pill has to start moving.
  await page.getByRole('button', { name: 'Fast rotation', exact: true }).click()
  await control.selectOption('always')
  await choose('codex', 'codex')
  await badge.waitFor()
  assert.match(await badge.innerText(), /^Codex /)
  await choose('api', 'deepseek')
  const sequence = []
  for (let i = 0; i < 4; i++) {
    await page.waitForFunction(
      ({ seen }) => {
        const text =
          document.querySelector('[data-composer-stats] button')?.innerText ??
          ''
        return seen.length === 0 || !text.startsWith(seen[seen.length - 1])
      },
      { seen: sequence },
    )
    sequence.push((await badge.innerText()).split(' ')[0])
  }
  const start = providerOrder.indexOf(sequence[0])
  assert.notEqual(start, -1)
  assert.deepEqual(
    sequence,
    sequence.map((_, index) => providerOrder[(start + index) % 3]),
    `rotation follows dialog order: ${providerOrder.join(' → ')}`,
  )
  // A pinned current model keeps its model scope in always mode: the
  // Antigravity pill reads the exact model, not the catalog count.
  await choose('antigravity', 'antigravity')
  await page.waitForFunction(() =>
    /^Antigravity Window 59%/.test(
      document.querySelector('[data-composer-stats] button')?.innerText ?? '',
    ),
  )
  // The dialog opened from a rotated pill leads with the provider shown,
  // not the roster's first row.
  await choose('api', 'deepseek')
  await page.waitForFunction(() =>
    /^Grok /.test(
      document.querySelector('[data-composer-stats] button')?.innerText ?? '',
    ),
  )
  await badge.click({ force: true })
  await panel.waitFor()
  assert.match(await panel.locator('section').first().innerText(), /^Grok/)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  // Switching back to recent restores the pinned selection.
  await control.selectOption('recent')
  await choose('codex', 'codex')
  await badge.waitFor()
  assert.match(await badge.innerText(), /^Codex /)
  console.log('85%: always-mode rotation verified')
  await page.evaluate(() => {
    window.savedSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dsh.subscriptions.usageBadgeMode')
        throw new DOMException('full', 'QuotaExceededError')
      return window.savedSetItem.call(this, key, value)
    }
  })
  await control.selectOption('hidden')
  await page.getByRole('alert').waitFor()
  assert.equal(await control.inputValue(), 'recent')
  assert.equal(await badge.count(), 1)
  await page.evaluate(() => {
    Storage.prototype.setItem = window.savedSetItem
  })
  await control.selectOption('hidden')
  await page.getByRole('alert').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Locale', exact: true }).click()
  await page
    .getByRole('combobox', { name: '状态栏额度显示', exact: true })
    .waitFor()
  await page.setViewportSize({ width: 360, height: 720 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  const quotaMode = page.getByRole('combobox', {
    name: '额度百分比',
    exact: true,
  })
  await quotaMode.waitFor()
  await page
    .getByRole('combobox', { name: '状态栏额度显示', exact: true })
    .selectOption('recent')
  await badge.waitFor()
  await quotaMode.selectOption('remaining')
  await page.waitForFunction(() =>
    document
      .querySelector('[data-composer-stats] button')
      ?.innerText.includes('87%'),
  )
  await badge.click()
  const remainingPanel = page.getByRole('dialog', {
    name: '服务商用量',
    exact: true,
  })
  await remainingPanel.waitFor()
  const currentSection = remainingPanel.locator('section').first()
  await currentSection.getByText('剩余 87%', { exact: true }).waitFor()
  const quotaScreenshot =
    process.env.QUOTA_SCREENSHOT ?? '.cache/quota-remaining-zh.png'
  await page.screenshot({ path: quotaScreenshot, fullPage: true })
  await quotaMode.selectOption('used')
  await page.waitForFunction(() =>
    document
      .querySelector('[data-composer-stats] button')
      ?.innerText.includes('13%'),
  )
  await currentSection.getByText('已用 13%', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log(
    '100%: offline badge browser checks passed, including storage errors and bilingual setting',
  )
} finally {
  await browser.close()
}
