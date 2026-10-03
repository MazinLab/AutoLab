## Whois identity mode and portable Docker build (2026-08-08)

New `AUTOLAB_IDENTITY_MODE=tailscale-whois`: instead of trusting tailscale
serve's injected header, the app resolves the reverse proxy's appended
X-Forwarded-For client address through the local tailscaled whois API.
Auto-identity now works behind any reverse proxy (Caddy on the shared
campus/tailnet hostname included); campus clients simply resolve to no
default actor. Only the proxy-appended forwarded hop is consulted, so
clients cannot forge a tailnet identity. Compose mounts the tailscaled
socket for this. Also: the Docker frontend build stage now carries
app/data/templates.json for the template-validation test.
