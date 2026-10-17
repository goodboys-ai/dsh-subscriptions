/**
 * Package identity consistency: the npm package name, the plugin's exported
 * name, the client bundle's module-loader id, and the cordis patch insert
 * name must all agree. A drift between any of these silently breaks install,
 * client-module registration, or the cordis bundle patch (see the banner-id
 * fix that restored the Settings page after the dsh-subscriptions rename).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

function matchFirst(pattern: RegExp, text: string, file: string): string {
  const m = pattern.exec(text)
  assert.ok(m, `${file} does not declare a package identity where expected`)
  return m[1]
}

test('npm name, plugin name, client bundle id, and cordis insert name agree', () => {
  const packageName: string = JSON.parse(read('package.json')).name
  assert.ok(packageName, 'package.json has no name')

  const pluginName = matchFirst(
    /^export const name = '([^']+)'/m,
    read('src/index.ts'),
    'src/index.ts',
  )
  const bannerId = matchFirst(
    /window\.__ModuleLoader__\.load\(\{ id: "([^"]+)",/,
    read('tsdown.config.ts'),
    'tsdown.config.ts',
  )
  const insertName = matchFirst(
    /^\s+name: '([^']+)'/m,
    read('cordis.patch.yml'),
    'cordis.patch.yml',
  )

  for (const [label, value] of [
    ['plugin export const name', pluginName],
    ['tsdown client banner id', bannerId],
    ['cordis.patch.yml insert name', insertName],
  ] as const) {
    assert.equal(
      value,
      packageName,
      `${label} (${value}) !== package.json name (${packageName})`,
    )
  }
})

/**
 * Plugin display metadata: DSH renders the Plugin Manager card and the
 * Settings inventory entry from locale `meta.title`/`meta.description`,
 * falling back to package.json name/description. Without the locale files
 * the card shows English for every UI language (the symptom that prompted
 * this test), and without the export/files coverage the host cannot read
 * the files from the packed tarball even when they exist in the repo.
 */

function nonEmptyString(value: unknown, file: string, field: string): string {
  assert.equal(typeof value, 'string', `${file} meta.${field} must be a string`)
  assert.ok(
    (value as string).trim().length > 0,
    `${file} meta.${field} must be non-empty`,
  )
  return value as string
}

// Source and manifest checks only; tarball contents and host rendering need
// separate pack and UI verification.
test('locale display metadata and package inclusion declarations are valid', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

  for (const locale of ['en', 'zh']) {
    const rel = `locale/${locale}.json`
    const meta = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')).meta
    assert.ok(
      meta && typeof meta === 'object',
      `${rel} must define a meta object`,
    )
    const title = nonEmptyString(meta.title, rel, 'title')
    const description = nonEmptyString(meta.description, rel, 'description')
    assert.equal(title, locale === 'en' ? 'DSH Subscriptions' : '订阅中心')
    // Guard against a copy-paste locale that ships one language twice.
    if (locale === 'zh') {
      const enMeta = JSON.parse(
        readFileSync(join(repoRoot, 'locale/en.json'), 'utf8'),
      ).meta
      assert.notEqual(
        title,
        enMeta.title,
        'locale/zh.json title must not duplicate en.json',
      )
      assert.notEqual(
        description,
        enMeta.description,
        'locale/zh.json description must not duplicate en.json',
      )
    }
  }

  assert.equal(
    pkg.exports?.['./locale/*.json'],
    './locale/*.json',
    'package.json exports must expose ./locale/*.json for host lookup',
  )
  for (const pattern of ['locale/*.json', 'icon.svg']) {
    assert.ok(
      (pkg.files ?? []).includes(pattern),
      `package.json files must include ${pattern} so pnpm pack ships it`,
    )
  }

  // Check the declared local icon's path, type, and size. These assertions
  // do not validate SVG contents or the host's rendered image.
  const icon = pkg.icon
  assert.equal(
    typeof icon,
    'string',
    'package.json must declare a top-level icon',
  )
  assert.ok(
    icon.startsWith('./'),
    `icon path must be relative to the package root (got ${icon})`,
  )
  assert.ok(
    !normalize(icon).startsWith('..'),
    `icon path must not escape the package directory`,
  )
  assert.match(
    icon,
    /\.(svg|png|jpe?g|webp)$/i,
    'icon must be a host-supported image type',
  )
  const iconAbs = join(repoRoot, icon)
  assert.ok(existsSync(iconAbs), `declared icon does not exist: ${icon}`)
  assert.ok(
    statSync(iconAbs).size <= 256 * 1024,
    `icon exceeds the 256 KiB host limit: ${statSync(iconAbs).size} bytes`,
  )
})
