# Cursor transport origin

`vendor/cursor/index.js` and `vendor/cursor/proto.js` were copied from
[orrinzeng/dsh-cursor-subscription](https://github.com/orrinzeng/dsh-cursor-subscription)
at commit `26f6cb1`. The original MIT license is retained at
`vendor/cursor/LICENSE`.

The host imports only `CursorAdapter`; the standalone plugin's own `apply`,
settings page, RPC, and credential controller are not mounted. This project uses
its own Cursor sign-in and usage UI and the DSH credential service.
`src/providers/cursor-adapter.ts` projects DSH `0.1.7-rc.2` first-class tool
messages into the transport's legacy tool-result blocks before streaming.

The transport uses Cursor's undocumented Agent protocol. Its protocol tests are
run offline against the copied files, but an authenticated Cursor model request
is still needed to confirm current server behavior.
