# Agent Note: Virtual-provider fakes

Status: implemented

## Problem

Provider login, refresh, usage, model discovery, and streaming logic need
repeatable regression tests. CI has no provider credentials and does not call
production provider servers; unit tests around adapter helpers alone do not
exercise the full plugin flow or its request shapes.

## Decision

Each of the six current provider routes has a fetch-level fake in `test/fakes/`
and an integration spec in `test/`. The spec drives the real plugin flow against
the fake: OAuth redirects, where applicable, reach a real local callback server;
token responses carry claims read by the real session parser; and usage,
catalog, and supported stream responses exercise the real adapters. The
[testing strategy](../../../../docs/testing.md) owns the layer's procedure and
coverage list.

Localhost requests pass through to the callback server. Unknown provider URLs
return 404 rather than reaching production. Specs assert observed wire details
such as grant types, encoding, authorization headers, and request bodies,
including refresh and rejected-state behavior. This pins the plugin's side of
the protocol while keeping CI offline.

## Verification boundaries

The fakes import some endpoint constants from production adapters. This keeps
renamed constants aligned, but it cannot verify their URL values: a wrong value
in the shared constant makes both sides agree and the test stays green.
Independent literal URL expectations are needed to cover that gap.

Cursor generation uses ConnectRPC over `node:http2`, outside the fetch router.
Its login polling, refresh, dashboard usage, and protobuf model discovery are
tested; its model stream is not. Grok OIDC discovery is cached per module load,
so the spec checks the first discovery request without an order-dependent
standalone test.

No fake proves that a provider still honors the recorded protocol. The manual
pre-release canary remains responsible for provider-side drift.

## Alternatives considered

- **Adapter-level dependency mocks.** They would bypass the HTTP request shapes
  and callback path that this layer must cover. The fetch-level boundary
  observes those behaviors.
- **Recorded production responses.** Offline replay would avoid CI calls to
  providers, but recordings can contain sensitive material and become stale
  without failing when a provider changes. Explicit synthetic cases also make
  refresh and rejection behavior easier to exercise.
- **Real-provider calls in CI.** They would detect provider drift, but need
  consumer OAuth credentials in automation and contact production servers. The
  project keeps those checks in the manual canary.

## Consequences

The suite catches regressions in the plugin's request construction, claim
parsing, refresh handling, catalog filtering, and supported stream translation
without provider credentials. Endpoint URL correctness, Cursor's HTTP/2 model
stream, and provider-side changes remain outside this layer.
