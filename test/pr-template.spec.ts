import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

// Compiled to lib-test/test/, so the repository root is two levels up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = join(root, 'scripts', 'check-pr-template.mjs')
const template = join(root, '.github', 'PULL_REQUEST_TEMPLATE.md')

const BODY = [
  '## What does this PR do?',
  '',
  'The badge and the host E2E described two different searches.',
  '',
  '## Thinking path',
  '',
  'The shared depth constant was not a shared search, so each side now names its own check.',
  '',
  '## Related issue',
  '',
  'None.',
  '',
  '## Changes made',
  '',
  '- Named row and dock fields replace the ordered attribute list.',
  '- The host E2E accepts a docked pill only inside the composer dock.',
  '',
  '## Verification',
  '',
  '- Commands run and results: pnpm test passed.',
  '- Test that fails without this change (for a bug fix), and how you saw it fail: Not a user-visible bug.',
  '- DSH versions checked: none.',
  '- Manual provider or UI checks, if relevant: none.',
  '- Remaining gaps or checks not run: host E2E is left to CI.',
  '',
  '## Compatibility and risks',
  '',
  'None.',
  '',
  '```sh',
  'echo kept',
  'echo in a fence',
  '```',
  '',
  '## AI disclosure',
  '',
  '**Tool(s) used:** N/A.',
  '',
  '**Prompt / approach:** N/A.',
  '',
  '## UI evidence, if applicable',
  '',
  'None.',
  '',
].join('\n')

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pr-template-'))
  const absolute = realpathSync(dir)
  t.after(() => {
    assert.equal(realpathSync(dir), absolute)
    assert.equal(dirname(absolute), realpathSync(tmpdir()))
    rmSync(absolute, { recursive: true, force: true })
  })
  return dir
}

function check(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  return result
}

function runBody(t: TestContext, title: string, body: string) {
  const dir = fixture(t)
  const bodyFile = join(dir, 'body.md')
  writeFileSync(bodyFile, body)
  return check([
    '--title',
    title,
    '--body-file',
    bodyFile,
    '--template',
    template,
  ])
}

function topicsFromScript() {
  const source = readFileSync(script, 'utf8')
  const declared = source.match(/const TOPICS = \[([^\]]+)\]/)
  assert.ok(declared, 'TOPICS declaration')
  return [...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('the sample body uses the template headings in order', () => {
  const fromTemplate = [
    ...readFileSync(template, 'utf8').matchAll(/^## (.+)$/gm),
  ].map((match) => match[1])
  const fromBody = [...BODY.matchAll(/^## (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(fromBody, fromTemplate)
})

test('CONTRIBUTING and the template name every topic the script accepts', () => {
  const topics = topicsFromScript()
  assert.deepEqual(topics, [
    'feat',
    'fix',
    'docs',
    'test',
    'chore',
    'refactor',
    'ci',
    'build',
    'style',
  ])
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')
  for (const topic of topics)
    assert.ok(contributing.includes(`\`${topic}\``), topic)
  const phrase = `Topics are ${topics.slice(0, -1).join(', ')}, and ${topics.at(-1)}.`
  const flattened = readFileSync(template, 'utf8').replace(/\s+/g, ' ')
  assert.ok(flattened.includes(phrase), phrase)
})

test('a topic title and a filled template pass', (t) => {
  const result = runBody(t, 'fix: name the searches', BODY)
  assert.equal(result.status, 0, result.stderr)
})

test('scoped topic titles pass', (t) => {
  for (const title of [
    'fix(ollama): point the hint at the file',
    'fix(auth,tools): close the gap',
    'fix(host-e2e): boot the host',
    'chore(release): v0.1.5',
  ]) {
    const result = runBody(t, title, BODY)
    assert.equal(result.status, 0, `${title}\n${result.stderr}`)
  }
})

test('a title that does not start with a topic fails and names the topics', (t) => {
  for (const title of [
    'Name the change',
    'Feat: lower the case',
    'fix:',
    'debug: temp',
    'fix (scope): no',
    'fix(Auth): no',
  ]) {
    const result = runBody(t, title, BODY)
    assert.equal(result.status, 1, title)
    assert.match(result.stderr, /must start with a topic/)
    assert.match(
      result.stderr,
      /feat, fix, docs, test, chore, refactor, ci, build, style/,
    )
  }
})

test('a title with a newline fails', (t) => {
  const result = runBody(t, 'fix: one line\nfix: two lines', BODY)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /single line/)
})

test('the unchanged template fails', (t) => {
  const result = runBody(
    t,
    'docs: leave the template blank',
    readFileSync(template, 'utf8'),
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /What does this PR do\?: section is empty/)
  assert.match(result.stderr, /Commands run and results:.*needs an answer/)
  assert.match(result.stderr, /Tool\(s\) used:.*needs an answer/)
})

test('a missing section fails and names it', (t) => {
  const result = runBody(
    t,
    'fix: drop a section',
    BODY.replace(/## UI evidence, if applicable\n\nNone\.\n$/, ''),
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing section `## UI evidence, if applicable`/)
})

test('a section out of template order fails', (t) => {
  const swapped = BODY.replace(
    '## What does this PR do?\n\nThe badge and the host E2E described two different searches.\n\n## Thinking path\n\nThe shared depth constant was not a shared search, so each side now names its own check.\n\n',
    '## Thinking path\n\nThe shared depth constant was not a shared search, so each side now names its own check.\n\n## What does this PR do?\n\nThe badge and the host E2E described two different searches.\n\n',
  )
  const result = runBody(t, 'fix: reorder the sections', swapped)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /`## What does this PR do\?` is out of order/)
})

test('an extra section and a repeated section fail', (t) => {
  const extra = runBody(
    t,
    'fix: add a section',
    `${BODY}\n## Notes\n\nExtra.\n`,
  )
  assert.equal(extra.status, 1)
  assert.match(extra.stderr, /unexpected section `## Notes`/)
  const repeated = runBody(
    t,
    'fix: repeat a section',
    `${BODY}\n## What does this PR do?\n\nAgain.\n`,
  )
  assert.equal(repeated.status, 1)
  assert.match(repeated.stderr, /duplicate section `## What does this PR do\?`/)
})

test('a wrapped paragraph fails and a one-line list, table, and fence do not', (t) => {
  const wrapped = runBody(
    t,
    'fix: wrap a paragraph',
    BODY.replace(
      'The badge and the host E2E described two different searches.',
      'The badge and the host E2E\ndescribed two different searches.',
    ),
  )
  assert.equal(wrapped.status, 1)
  assert.match(
    wrapped.stderr,
    /What does this PR do\?: a paragraph wraps across 2 lines/,
  )
  const continued = runBody(
    t,
    'fix: wrap a list item',
    BODY.replace(
      '- Named row and dock fields replace the ordered attribute list.',
      '- Named row and dock fields replace\n  the ordered attribute list.',
    ),
  )
  assert.equal(continued.status, 1)
  assert.match(continued.stderr, /Changes made: a paragraph wraps across/)
  const table = BODY.replace(
    '- Named row and dock fields replace the ordered attribute list.\n- The host E2E accepts a docked pill only inside the composer dock.',
    '| File | Change |\n| --- | --- |\n| badge | names the markers |',
  )
  assert.equal(runBody(t, 'fix: show a table', table).status, 0)
})

test('related issue accepts None or an issue link', (t) => {
  assert.equal(
    runBody(t, 'fix: close an issue', BODY.replace('None.', 'Closes #12.'))
      .status,
    0,
  )
  assert.equal(
    runBody(
      t,
      'fix: link an issue',
      BODY.replace(
        'None.',
        'https://github.com/goodboys-ai/dsh-subscriptions/issues/46',
      ),
    ).status,
    0,
  )
  const prose = runBody(
    t,
    'fix: skip the link',
    BODY.replace('None.', 'Nonetheless there is no issue.'),
  )
  assert.equal(prose.status, 1)
  assert.match(prose.stderr, /Related issue: write `None` or link an issue/)
})

test('a verification label out of order or without an answer fails', (t) => {
  const blank = runBody(
    t,
    'fix: leave the command blank',
    BODY.replace(
      '- Commands run and results: pnpm test passed.',
      '- Commands run and results:',
    ),
  )
  assert.equal(blank.status, 1)
  assert.match(
    blank.stderr,
    /`Commands run and results:` needs an answer on the same line/,
  )
  const swapped = runBody(
    t,
    'fix: reorder verification',
    BODY.replace(
      '- Commands run and results: pnpm test passed.\n- Test that fails without this change (for a bug fix), and how you saw it fail: Not a user-visible bug.',
      '- Test that fails without this change (for a bug fix), and how you saw it fail: Not a user-visible bug.\n- Commands run and results: pnpm test passed.',
    ),
  )
  assert.equal(swapped.status, 1)
  assert.match(
    swapped.stderr,
    /Test that fails without this change \(for a bug fix\), and how you saw it fail:.*out of order/,
  )
})

test('an AI disclosure field with only the template comment fails', (t) => {
  const result = runBody(
    t,
    'fix: leave the tool blank',
    BODY.replace(
      '**Tool(s) used:** N/A.',
      '**Tool(s) used:** <!-- Name the tools, or write N/A. -->',
    ),
  )
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /`Tool\(s\) used:` needs an answer on the same line/,
  )
})

test('text before the first heading fails', (t) => {
  const result = runBody(t, 'fix: add a preamble', `Intro.\n\n${BODY}`)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /preamble/)
})

test('required headings come from the template file', (t) => {
  const dir = fixture(t)
  const custom = join(dir, 'template.md')
  const bodyFile = join(dir, 'body.md')
  writeFileSync(custom, '## Alpha\n\n## Beta\n')
  writeFileSync(bodyFile, '## Alpha\n\nFilled.\n\n## Beta\n\nFilled.\n')
  const pass = check([
    '--title',
    'docs: follow the file',
    '--body-file',
    bodyFile,
    '--template',
    custom,
  ])
  assert.equal(pass.status, 0, pass.stderr)
  writeFileSync(bodyFile, '## Alpha\n\nFilled.\n')
  const fail = check([
    '--title',
    'docs: follow the file',
    '--body-file',
    bodyFile,
    '--template',
    custom,
  ])
  assert.equal(fail.status, 1)
  assert.match(fail.stderr, /missing section `## Beta`/)
})

test('an event with no pull request skips, and a pull request event is checked', (t) => {
  const dir = fixture(t)
  const event = join(dir, 'event.json')
  writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' }))
  const skipped = check(['--event', event, '--template', template])
  assert.equal(skipped.status, 0)
  assert.match(skipped.stdout, /skipped — event has no pull request/)
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: { title: 'ci: check the template', body: BODY },
    }),
  )
  const passed = check(['--event', event, '--template', template])
  assert.equal(passed.status, 0, passed.stderr)
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: { title: 'ci: check the template', body: null },
    }),
  )
  assert.equal(check(['--event', event, '--template', template]).status, 1)
})

test('a broken template fails before a non-pull-request event can skip', (t) => {
  const dir = fixture(t)
  const custom = join(dir, 'template.md')
  const event = join(dir, 'event.json')
  writeFileSync(custom, 'no headings\n')
  writeFileSync(event, '{}\n')
  const result = check(['--event', event, '--template', custom])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /template has no ## sections/)
  assert.match(result.stderr, /the check did not run/)
})

test('a missing event file or a bad invocation exits 2', (t) => {
  const dir = fixture(t)
  const missing = check(['--event', join(dir, 'missing.json')])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /cannot read event/)
  assert.match(missing.stderr, /the check did not run/)
  const usage = check([])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /usage: check-pr-template\.mjs/)
})
