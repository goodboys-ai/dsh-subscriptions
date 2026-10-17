#!/usr/bin/env node
/**
 * check-pr-template.mjs — require a topic title and the pull request template.
 *
 * The title starts with a topic and a colon (`fix: ...` or `fix(scope): ...`).
 * The body uses the headings, verification labels, and AI disclosure fields
 * from .github/PULL_REQUEST_TEMPLATE.md, in that order. Each section has an
 * answer. Related issue is `None` or an issue link. A paragraph is one line,
 * because GitHub renders a newline in a pull request body as a hard break.
 * Lists, tables, and fenced code may span lines.
 *
 * Usage:
 *   node scripts/check-pr-template.mjs --event <github-event.json> [--template <path>]
 *   node scripts/check-pr-template.mjs --title <title> --body-file <path> [--template <path>]
 *
 * --event with no pull_request exits 0 after the template file parses, so a
 * push still fails when the template itself is unreadable. Exit 1 reports
 * findings. Exit 2 means the check did not run. The default template is this
 * repo's .github/PULL_REQUEST_TEMPLATE.md.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOPICS = ['feat', 'fix', 'docs', 'test', 'chore', 'refactor', 'ci', 'build', 'style']
const USAGE = 'usage: check-pr-template.mjs --event <github-event.json> | --title <title> --body-file <path> [--template <path>]'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag !== '--event' && flag !== '--title' && flag !== '--body-file' && flag !== '--template') {
      throw new Error(USAGE)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(USAGE)
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = value
  }
  if (args.event && (args.title || args.bodyFile)) throw new Error(USAGE)
  if (!args.event && (!args.title || !args.bodyFile)) throw new Error(USAGE)
  return args
}

function splitSections(text) {
  const preamble = []
  const sections = []
  let current = null
  for (const line of normalize(text).split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading) {
      current = { name: heading[1], lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  return { preamble, sections }
}

function parseTemplate(text) {
  const { sections } = splitSections(stripComments(normalize(text)))
  if (sections.length === 0) throw new Error('template has no ## sections')
  const names = sections.map(section => section.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new Error(`template repeats ## ${duplicate}`)
  const labels = (name, pattern) => {
    const section = sections.find(item => item.name === name)
    if (!section) return []
    return section.lines.flatMap(line => {
      const match = pattern.exec(line)
      return match ? [match[1]] : []
    })
  }
  return {
    names,
    verificationLabels: labels('Verification', /^\s*[-*+]\s+(.+?)\s*$/),
    aiLabels: labels('AI disclosure', /^\s*\*\*([^*]+)\*\*/),
  }
}

function checkTitle(title) {
  const oneLine = normalize(title).trim()
  if (oneLine.includes('\n')) return ['title: must be a single line']
  const topic = TOPICS.join('|')
  const pattern = new RegExp(`^(?:${topic})(?:\\([a-z0-9]+(?:[-,][a-z0-9]+)*\\))?: \\S.*$`)
  if (pattern.test(oneLine)) return []
  const shown = JSON.stringify(oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine)
  return [`title: must start with a topic and a colon (\`fix: ...\` or \`fix(scope): ...\`); topics: ${TOPICS.join(', ')} (received ${shown})`]
}

function wrapFindings(name, text) {
  const lines = text.split('\n')
  const findings = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index++
      continue
    }
    if (/^\s*```/.test(lines[index])) {
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index])) index++
      if (index < lines.length) index++
      continue
    }
    const start = index
    while (index < lines.length && lines[index].trim() !== '') index++
    const block = lines.slice(start, index)
    if (block.length === 1) continue
    const list = block.every(line => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line))
    const table = block.every(line => /^\s*\|/.test(line))
    if (list || table) continue
    const sample = block[0].trim().slice(0, 60)
    findings.push(`${name}: a paragraph wraps across ${block.length} lines ("${sample}"); write one line per paragraph`)
  }
  return findings
}

function labeledLine(lines, kind, label) {
  const escaped = escapeRegExp(label)
  const pattern = kind === 'list'
    ? new RegExp(`^\\s*[-*+]\\s+${escaped}(?:\\s+(\\S.*))?\\s*$`)
    : new RegExp(`^\\s*\\*\\*${escaped}\\*\\*(?:\\s+(\\S.*))?\\s*$`)
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index])
    if (match) return { index, answer: match[1] ?? '' }
  }
  return null
}

function labelFindings(section, lines, labels, kind) {
  const findings = []
  let last = -1
  for (const label of labels) {
    const found = labeledLine(lines, kind, label)
    if (!found) {
      findings.push(`${section}: missing \`${label}\``)
      continue
    }
    if (!found.answer.trim()) findings.push(`${section}: \`${label}\` needs an answer on the same line`)
    if (found.index < last) findings.push(`${section}: \`${label}\` is out of order`)
    else last = found.index
  }
  return findings
}

function relatedIssueOk(text) {
  const body = text.trim()
  if (/^None\b/.test(body)) return true
  if (/#\d+\b/.test(body)) return true
  return /github\.com\/\S+\/(?:issues|pull)\/\d+\b/.test(body)
}

function structureFindings(actual, expected) {
  const findings = []
  const allowed = new Set(expected)
  const seen = new Set()
  for (const name of actual) {
    if (!allowed.has(name)) findings.push(`unexpected section \`## ${name}\``)
    else if (seen.has(name)) findings.push(`duplicate section \`## ${name}\``)
    else seen.add(name)
  }
  let last = -1
  const ordered = new Set()
  for (const name of actual) {
    const index = expected.indexOf(name)
    if (index === -1 || ordered.has(name)) continue
    ordered.add(name)
    if (index < last) findings.push(`\`## ${name}\` is out of order`)
    else last = index
  }
  for (const name of expected) {
    if (!actual.includes(name)) findings.push(`missing section \`## ${name}\``)
  }
  return findings
}

function checkBody(body, template) {
  const findings = []
  const { preamble, sections } = splitSections(stripComments(normalize(body)))
  if (preamble.join('\n').trim()) findings.push('preamble: text before the first section; use the template headings')
  findings.push(...structureFindings(sections.map(section => section.name), template.names))
  const firstByName = new Map()
  for (const section of sections) {
    if (!firstByName.has(section.name)) firstByName.set(section.name, section)
  }
  for (const name of template.names) {
    const section = firstByName.get(name)
    if (!section) continue
    const text = section.lines.join('\n')
    if (text.trim() === '') {
      findings.push(`${name}: section is empty`)
      continue
    }
    if (name === 'Related issue' && !relatedIssueOk(text)) {
      findings.push('Related issue: write `None` or link an issue (`Closes #123`)')
    }
    findings.push(...wrapFindings(name, text))
    if (name === 'Verification') findings.push(...labelFindings(name, section.lines, template.verificationLabels, 'list'))
    if (name === 'AI disclosure') findings.push(...labelFindings(name, section.lines, template.aiLabels, 'field'))
  }
  return findings
}

function readEvent(path) {
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read event ${path}: ${detail}`)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`event ${path} is not a JSON object`)
  }
  return payload
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const templatePath = args.template ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'PULL_REQUEST_TEMPLATE.md')
  let templateText
  try {
    templateText = readFileSync(templatePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read template ${templatePath}: ${detail}`)
  }
  const template = parseTemplate(templateText)
  if (args.event) {
    const payload = readEvent(args.event)
    if (payload.pull_request == null) {
      console.log('check-pr-template: skipped — event has no pull request.')
      return 0
    }
    if (typeof payload.pull_request !== 'object') throw new Error('pull_request is not an object')
    const title = typeof payload.pull_request.title === 'string' ? payload.pull_request.title : ''
    const body = typeof payload.pull_request.body === 'string' ? payload.pull_request.body : ''
    return report(checkTitle(title), checkBody(body, template))
  }
  const body = readFileSync(args.bodyFile, 'utf8')
  return report(checkTitle(args.title), checkBody(body, template))
}

function report(titleFindings, bodyFindings) {
  const findings = [...titleFindings, ...bodyFindings]
  if (findings.length === 0) {
    console.log('check-pr-template: ok — title and template sections conform.')
    return 0
  }
  console.error('check-pr-template: violations found:')
  for (const finding of findings) console.error(`  ${finding}`)
  return 1
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`check-pr-template: ${error instanceof Error ? error.message : String(error)}; the check did not run`)
  process.exitCode = 2
}
