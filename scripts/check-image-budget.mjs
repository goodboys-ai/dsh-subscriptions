#!/usr/bin/env node
/**
 * check-image-budget.mjs — keep PR-only evidence out of every clone's budget.
 * Every clone and CI fetch pays for committed bitmaps. Stills under
 * docs/assets/pr-<number>/ must be at most 300 KiB; recordings belong elsewhere.
 *
 * This rule is absolute and scoped to docs/assets/pr-* directories, not base-relative
 * over the whole repository. This public repository is small; the ten
 * upstream README screenshots in docs/images/ are not policed. An absolute
 * cap needs no base ref or fetch-depth and behaves the same locally, in CI,
 * and after a merge. The escape hatch for a recording or oversized still is
 * the assets branch, not a line in the PR description.
 *
 * Usage: node scripts/check-image-budget.mjs [--dir <repository-root>]
 * Defaults to the repository containing this script, regardless of cwd.
 * Exit 0 when clean, 1 with one finding per offending file, and 2 when the
 * root is missing, is not a directory, or the scan otherwise could not run.
 * No dependencies, network, or git base ref: Node built-ins only.
 */
import { readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUDGET = 300 * 1024
const BITMAPS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.bmp',
  '.tif',
  '.tiff',
  '.ico',
  '.heic',
  '.heif',
  '.apng',
])
const RECORDINGS = new Set(['.gif', '.mp4', '.webm', '.mov'])

function main() {
  const args = process.argv.slice(2)
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== '--dir' || !args[1])
  ) {
    throw new Error('usage: check-image-budget.mjs [--dir <repository-root>]')
  }
  const root = args.length
    ? resolve(args[1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (!statSync(root).isDirectory())
    throw new Error(`${root}: scan root is not a directory`)
  const findings = []
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(path)
      } else {
        const extension = extname(entry.name).toLowerCase()
        if (!BITMAPS.has(extension) && !RECORDINGS.has(extension)) continue
        const size = statSync(join(root, path)).size
        if (RECORDINGS.has(extension)) {
          findings.push(
            `${path}: ${size} bytes — recordings are forbidden in docs/assets/pr-*/; use an assets branch`,
          )
        } else if (size > BUDGET) {
          findings.push(
            `${path}: ${size} bytes — exceeds ${BUDGET} bytes (300 KiB); use an assets branch`,
          )
        }
      }
    }
  }
  let entries
  try {
    entries = readdirSync(join(root, 'docs/assets'), { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    entries = []
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && /^pr-.+/.test(entry.name))
      walk(`docs/assets/${entry.name}`)
  }
  if (findings.length) {
    console.error('check-image-budget: violations found:')
    for (const finding of findings) console.error(`  ${finding}`)
    return 1
  }
  console.log(
    'check-image-budget: ok — PR stills are at most 300 KiB, with no recordings.',
  )
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(
    `check-image-budget: ${error instanceof Error ? error.message : String(error)}; the check did not run`,
  )
  process.exitCode = 2
}
