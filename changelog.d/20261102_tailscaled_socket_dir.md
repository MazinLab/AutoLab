## Whois identity survives tailscaled restarts (2026-11-02)

Compose now mounts the host's tailscaled socket directory instead of the
socket file. tailscaled recreates its socket on every restart, and the file
mount kept pointing at the deleted one, so after an unattended tailscale
upgrade every headscale user silently fell back to read only until the app
container was restarted. The host unit also needs
`RuntimeDirectoryPreserve=yes` (README, deployment step 4) so systemd keeps
the directory itself. `AUTOLAB_TAILSCALED_SOCKET` is replaced by
`AUTOLAB_TAILSCALED_SOCKET_DIR`.
