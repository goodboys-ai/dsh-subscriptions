// Keep `pnpm test` off the network. Loaded with `node --import` into every
// spec process that `node --test` starts.
//
// Every outbound TCP connection goes through net.Socket#connect: fetch
// (undici), net.connect, node:http, node:https, node:tls, and node:http2 all
// end there. A connection to anything other than loopback throws EHERMETIC
// before DNS or a SYN, so a test that forgets to mock a provider fails at
// once instead of calling the real service with whatever credentials the
// machine has.
// Loopback stays open because the OAuth callback servers and the fake
// provider servers under test listen on it. Unix sockets stay open too.
//
// Production code often catches fetch failures (a version lookup falls back,
// a usage poll keeps its last value), so the throw alone can be swallowed and
// the test still passes. Each refusal is therefore also recorded, and the
// spec process exits non-zero, which fails that spec file in the runner.
//
// test/hermetic.spec.ts proves the guard is loaded in every run.
import net from 'node:net'

const LOOPBACK =
  /^(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/

/** Refused destinations in this spec process, as `host:port`. */
const refused = []

/**
 * The connect options, however the caller passed them. net.connect() and
 * net.createConnection() hand the socket one array they already normalized,
 * which would read as an options object with no host.
 */
function connectOptions(args) {
  return Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0]
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function hermeticConnect(...args) {
  const options = connectOptions(args)
  if (options.path == null) {
    const host = options.host ?? 'localhost'
    if (!LOOPBACK.test(host)) {
      refused.push(`${host}:${options.port}`)
      throw Object.assign(
        new Error(
          `hermetic test run: blocked connection to ${host}:${options.port}; mock this request`,
        ),
        { code: 'EHERMETIC' },
      )
    }
  }
  return connect.apply(this, args)
}

process.on('exit', () => {
  if (
    refused.length === 0 ||
    globalThis.__dshHermeticExpectedRefusals === refused.length
  )
    return
  process.stderr.write(
    `hermetic test run: this spec tried to reach ${[...new Set(refused)].join(', ')}\n`,
  )
  process.exitCode = 1
})

globalThis.__dshHermeticTestRun = true
