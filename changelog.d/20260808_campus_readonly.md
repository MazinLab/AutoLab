## Campus access is password-gated and read only (2026-08-08)

New `AUTOLAB_REQUIRE_IDENTITY_FOR_WRITES` setting: when enabled, write
methods and the POST-based MCP endpoint return 403 unless the request
carries a network-resolved identity, so anonymous users can browse but
never alter records — X-Actor-Id cannot bypass it. Deployed with the
Caddy campus vhost requiring a shared lab password (basic auth) for
campus source addresses, while tailnet clients pass straight through
and identify via whois. Compose forwards the new setting from .env.
