from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AUTOLAB_")

    db_url: str = "sqlite:///autolab.db"
    readonly_db_url: str = ""
    log_json: bool = False
    storage_root: Path = Path("artifact_store")
    # Upload ceiling: a mis-dragged file must not fill the disk. Raise per
    # deployment if the lab routinely uploads larger raw files.
    max_upload_bytes: int = 8 * 1024**3
    # Verify declared checksum/size against stored bytes when registering an
    # artifact by URI. Costs one read of the file per registration; disable
    # only if registration latency ever matters more than integrity.
    verify_artifact_bytes: bool = True
    frontend_dist: Path = Path("frontend/dist")
    printers: dict[str, str] = {}
    default_printer: str = ""
    # Label dates are printed in lab-local time: the server runs UTC, so
    # anything created after ~5pm Pacific would otherwise be stamped with
    # the following day.
    label_timezone: str = "America/Los_Angeles"
    public_base_url: str = "http://localhost:8000"
    # Slack bot token (xoxb-...) with chat:write + im:write; empty disables
    # DM delivery (matching still runs, the outbox simply accumulates).
    slack_bot_token: str = ""
    # "tailscale-serve" trusts Tailscale-User-Login headers on requests that
    # arrive from identity_trusted_proxies (the tailscale serve reverse proxy
    # on loopback); "tailscale-whois" instead resolves the proxy-appended
    # X-Forwarded-For client address through the local tailscaled whois API
    # (works behind any reverse proxy); "tailscale-hybrid" accepts a verified
    # Serve header and otherwise falls back to whois; "none" resolves no
    # network identity.
    identity_mode: str = "none"
    identity_trusted_proxies: tuple[str, ...] = ("127.0.0.1", "::1")
    identity_whois_socket: str = "/var/run/tailscale/tailscaled.sock"
    # When enabled, write methods (and the POST-based MCP endpoint) require
    # a resolved network identity; anonymous access — e.g. campus users
    # behind the shared reverse-proxy password — is read only.
    require_identity_for_writes: bool = False
