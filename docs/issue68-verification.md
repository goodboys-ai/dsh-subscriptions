# Issue #68: host-managed proxy

The original issue verified that DSH provides network proxy routing through its
global fetch dispatcher. This fork now uses that host routing for subscription
requests. The plugin-specific proxy card, RPC endpoints, config reader, and
`undici` dependency were removed.

An existing `~/.dsh/plugins/subscriptions/proxy.json` is ignored. It is left on
disk so the plugin does not alter an existing DSH profile during migration.
Configure network routing through DSH instead.

The earlier plugin-proxy verification and migration recommendation in this
document have been superseded by this change.
