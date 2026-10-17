#!/usr/bin/env node
/**
 * check-markdown-tables.mjs — cap a Markdown table row at 120 characters.
 *
 * Prose wraps at 80. A table row cannot wrap, and Prettier pads every cell
 * out to the widest cell in its column, so the 80-column check skips tables.
 * 120 is wide enough for a command table and still one screen line. The
 * upstream README snapshots are imported sources and are not checked.
 *
 * A row is counted only inside a GitHub-flavored pipe table: a header row,
 * a delimiter row, and the body rows that follow. Fenced code is not a table.
 * The count is the source line length, including the indent Prettier leaves.
 *
 * Usage: node scripts/check-markdown-tables.mjs [--dir <repository-root>]
 * Defaults to the repository containing this script, regardless of cwd.
 * Exit 0 when clean, 1 with one finding per offending row, and 2 when the
 * root is missing, is not a directory, or the scan otherwise could not run.
 * No dependencies: Node built-ins only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 120
const SKIP_DIRS = new Set([
  'node_modules',
  'lib',
  'lib-test',
  'vendor',
  '.git',
  'coverage',
  'reports',
  '.stryker-tmp',
])
/** Imported upstream sources. Prettier ignores these too. */
const SKIP_FILES = new Set([
  'docs/upstream-README.md',
  'docs/upstream-README.zh.md',
])

/** Cells of a pipe row, with the outer pipes removed. */
function cells(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|')
}

/** A delimiter row is only dashes and optional alignment colons. */
function isDelimiter(line) {
  if (!line.includes('|')) return false
  const parts = cells(line)
  return (
    parts.length > 0 && parts.every((part) => /^\s*:?-{3,}:?\s*$/.test(part))
  )
}

/** A body or header row. Prettier always emits the outer pipes. */
function isRow(line) {
  return !isDelimiter(line) && /^\s*\|.*\|\s*$/.test(line)
}

/**
 * Table source lines, with 1-based line numbers. Fenced code is skipped,
 * including a fence that itself contains pipe rows.
 * @returns {{ line: number, text: string }[]}
 */
function tableLines(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  /** @type {{ char: string, len: number } | null} */
  let fence = null
  /** @type {{ line: number, text: string }[]} */
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mark = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        mark &&
        mark[2][0] === fence.char &&
        mark[2].length >= fence.len &&
        mark[3].trim() === ''
      )
        fence = null
      continue
    }
    if (mark) {
      fence = { char: mark[2][0], len: mark[2].length }
      continue
    }
    if (!(isDelimiter(line) && i > 0 && isRow(lines[i - 1]))) continue
    found.push({ line: i, text: lines[i - 1] })
    found.push({ line: i + 1, text: line })
    let j = i + 1
    while (j < lines.length && isRow(lines[j])) {
      found.push({ line: j + 1, text: lines[j] })
      j++
    }
    i = j - 1
  }
  return found
}

/** Relative path with forward slashes, the form findings and skips use. */
function relPath(root, file) {
  return relative(root, file).split(sep).join('/')
}

function main() {
  const args = process.argv.slice(2)
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== '--dir' || !args[1])
  ) {
    throw new Error(
      'usage: check-markdown-tables.mjs [--dir <repository-root>]',
    )
  }
  const root = args.length
    ? resolve(args[1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (!statSync(root).isDirectory())
    throw new Error(`${root}: scan root is not a directory`)
  /** @type {string[]} */
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const path = relPath(root, join(dir, entry.name))
      if (!SKIP_FILES.has(path)) files.push(path)
    }
  }
  walk(root)
  const findings = []
  for (const path of files) {
    const text = readFileSync(join(root, path), 'utf8')
    for (const row of tableLines(text)) {
      if (row.text.length > LIMIT) {
        findings.push(
          `${path}:${row.line}: ${row.text.length} characters — table row exceeds ${LIMIT}`,
        )
      }
    }
  }
  if (findings.length) {
    console.error('check-markdown-tables: violations found:')
    for (const finding of findings) console.error(`  ${finding}`)
    return 1
  }
  console.log(
    'check-markdown-tables: ok — markdown table rows are at most 120 characters.',
  )
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(
    `check-markdown-tables: ${error instanceof Error ? error.message : String(error)}; the check did not run`,
  )
  process.exitCode = 2
}
