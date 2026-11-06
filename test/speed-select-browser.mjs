// Optional offline UI check: PLAYWRIGHT_PATH=/path/to/playwright node test/speed-select-browser.mjs
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
  input: 'test/speed-select-browser.fixture.tsx',
  resolve: {
    alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` },
  },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [
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
    viewport: { width: 600, height: 420 },
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
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.goto('http://speed-select.test/')
  const standard = page.getByRole('button', {
    name: 'Speed · Standard',
    exact: true,
  })
  const fast = page.getByRole('button', { name: 'Speed · Fast', exact: true })
  await standard.waitFor()
  await standard.click()
  await page.getByRole('menu', { name: 'Speed', exact: true }).waitFor()
  const screenshot =
    process.env.SPEED_SCREENSHOT ?? '.cache/speed-model-memory.png'
  await mkdir(dirname(screenshot), { recursive: true })
  await page.screenshot({ path: screenshot, fullPage: true })
  await page.getByRole('menuitemradio').nth(1).click()
  await fast.waitFor()
  await page.waitForFunction(
    () => document.documentElement.dataset.setSpeedCalls === '1',
  )

  await page.getByRole('button', { name: 'Other model', exact: true }).click()
  await standard.waitFor()
  await standard.click()
  await page.getByRole('menuitemradio').nth(1).click()
  await fast.waitFor()
  await page.waitForFunction(
    () => document.documentElement.dataset.setSpeedCalls === '2',
  )
  await page.getByRole('button', { name: 'Fast model', exact: true }).click()
  await fast.waitFor()
  await page.getByRole('button', { name: 'Other model', exact: true }).click()
  await fast.waitFor()

  await page.getByRole('button', { name: 'Locale', exact: true }).click()
  const localized = page.getByRole('button', {
    name: '速度 · 快速',
    exact: true,
  })
  await localized.waitFor()
  await localized.click()
  await page.getByRole('menu', { name: '速度', exact: true }).waitFor()
  assert.equal(await page.getByRole('menuitemradio').count(), 2)
  assert.deepEqual(errors, [])
  console.log(
    `Speed browser PASS: model-bound persistence, RPC model identity, bilingual menu; screenshot ${screenshot}`,
  )
} finally {
  await browser.close()
}
