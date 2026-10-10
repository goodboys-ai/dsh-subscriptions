#!/usr/bin/env node
// Check one boot-smoke RPC body. The web profile posts the same
// client-request envelope the browser uses; this script checks the
// server-response for a logged-out install.
//
//   node scripts/assert-smoke-rpc.mjs <file> <endpoint> <expect>
//
// expect: status | external-status | cursor-status | external-usage
//
// Exit 1 when the body breaks the logged-out contract, and 2 when the check
// could not run (bad arguments, or the saved body could not be read).
import { readFileSync } from 'node:fs'

const [file, endpoint, expect] = process.argv.slice(2)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function setupFail(message) {
  console.error(`SMOKE SETUP FAILURE: ${message}`)
  process.exit(2)
}

const EXPECTATIONS = ['status', 'external-status', 'cursor-status', 'external-usage']
if (file === undefined || endpoint === undefined || !EXPECTATIONS.includes(expect)) {
  setupFail(`usage: assert-smoke-rpc.mjs <file> <endpoint> <${EXPECTATIONS.join(' | ')}>`)
}

let text
try {
  text = readFileSync(file, 'utf8')
} catch (error) {
  setupFail(`cannot read the saved subscriptions-auth.${endpoint} body: ${error.message}`)
}
let body
try {
  body = JSON.parse(text)
} catch {
  fail(`subscriptions-auth.${endpoint} body is not JSON`)
}

if (body?.type !== 'server-response' || body.rpcId !== `smoke-${endpoint}`) {
  fail(`subscriptions-auth.${endpoint} returned an unexpected envelope`)
}

const serialized = JSON.stringify(body)
if (/"accessToken"|"refreshToken"|Bearer /.test(serialized)) {
  fail(`subscriptions-auth.${endpoint} response includes credential material`)
}

const result = body.result
if (expect === 'external-usage') {
  const message = result?.error?.message ?? ''
  if (result?.ok !== false || result?.error?.code !== 'internal' || !message.includes('API key is not configured')) {
    fail(`subscriptions-auth.${endpoint} did not refuse an unconfigured key (${JSON.stringify(result?.error ?? result)})`)
  }
  process.exit(0)
}

if (result?.ok !== true) {
  fail(`subscriptions-auth.${endpoint} result was not ok (${JSON.stringify(result)})`)
}

const value = result.value
if (expect === 'status') {
  // Independent of PROVIDER_IDS in src/auth/store.ts. A new provider id
  // must be added here or the logged-out status check fails.
  const ids = ['codex', 'claude', 'grok', 'copilot', 'antigravity']
  const providers = value?.providers ?? {}
  const got = Object.keys(providers).sort().join(',')
  if (got !== [...ids].sort().join(',')) {
    fail(`status providers were ${got || '(none)'}`)
  }
  for (const id of ids) {
    const accounts = providers[id]?.accounts
    if (!Array.isArray(accounts) || accounts.length !== 0) {
      fail(`status.${id} was not an empty logged-out account list`)
    }
  }
} else if (expect === 'external-status') {
  if (value?.['opencode-go']?.configured !== false || value?.['kimi-code']?.configured !== false
    || value?.['ollama-cloud']?.configured !== false) {
    fail(`externalStatus was ${JSON.stringify(value)}`)
  }
} else if (expect === 'cursor-status') {
  if (value?.authenticated !== false) {
    fail(`cursorStatus was ${JSON.stringify(value)}`)
  }
}
