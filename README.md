# AutoLab

AutoLab is the Mazin Lab's catalog, electronic lab notebook, and provenance
system. One PostgreSQL catalog records every wafer, device, fab step,
instrument, cooldown, measurement, analysis, and file, along with how they
derive from each other. People use a mobile-first web app (installable as a
PWA). LLM agents use the same catalog through an MCP server. Physical objects
carry QR labels that resolve to their catalog records.

Main pieces:

- **Catalog.** Every record gets an opaque UUIDv7 and a human accession code
  (`W-2026-0001`). Relationships are provenance edges (`derived_from`,
  `part_of`, `refers_to`, ...) stored as rows, never encoded in names.
- **Event feed.** Every create, update, and link writes an append-only event in
  the same transaction. The feed drives the activity views and Slack
  notifications.
- **Templates.** Capture forms for fab steps, measurements, experiments,
  analyses, and the rest come from `app/data/templates.json`.
- **Fab flow.** Wafers carry their process history as ordered fab steps that
  reference recipes and equipment.
- **Setup designer.** Experiment setups hold an RF and optical chain layout
  for a cryostat, with a gain and noise budget computed server side.
- **Result summaries.** A result summary collects analyses across projects into
  one table of their key results.
- **Labels.** Zebra label printing over raw TCP, with a separate label station
  page for ad hoc labels.
- **Instrument data.** The `labdata` client saves arrays and files on
  instrument PCs and registers them with a crash-safe spool.

## Layout

| Path | Contents |
| --- | --- |
| `labcore/` | SQLModel models, service layer, lineage, RF chain evaluator, label rendering. The single schema source. |
| `app/` | FastAPI app, REST routers, MCP server, identity middleware, watcher, notifier. |
| `alembic/` | Database migrations. Schema changes go only through Alembic. |
| `frontend/` | React PWA (Vite). `frontend/labels/` is the label station entry. |
| `labdata/` | Instrument-side client for saving and registering data. |
| `scripts/` | Backup, restore, and label badge generation. |
| `tests/` | pytest suite. Runs on SQLite locally and on Postgres 17 in CI. |

## Development

Python 3.13 and Node 22 or newer.

```sh
pip install -e ".[dev,labdata]"
pytest
python -m alembic upgrade head
uvicorn app.main:create_app --factory --reload
```

Development uses SQLite (`autolab.db`). Tests run on in-memory SQLite. Setting
`AUTOLAB_TEST_DB_URL` runs them against Postgres instead, which is what CI does.
Never point it at a database you care about: the suite creates and drops tables.

In a second terminal, run the frontend. Vite serves the app at
`http://127.0.0.1:5173` and proxies `/api` and `/mcp` to the API.

```sh
cd frontend
npm ci
npm run dev
npx vitest run
```

For a production-style local server, run `npm run build` in `frontend/` and
start uvicorn without `--reload`. FastAPI then serves `frontend/dist`,
including deep links, at `http://127.0.0.1:8000`. The interactive OpenAPI
reference is at `/docs`.

A Playwright smoke test runs against such a server. It is a local check, not a
CI job:

```sh
cd frontend
npx playwright install chromium
AUTOLAB_BASE_URL=http://127.0.0.1:8000 npx playwright test
```

## Deployment

Production runs with `docker-compose.yml`: Postgres 17, the app, the storage
watcher, and the Slack notifier. The app container runs `alembic upgrade head`
before it starts. A TLS reverse proxy on the host (Caddy in our deployment)
fronts it. The app publishes port 8000 on host loopback only. Never expose it
directly: the identity middleware trusts the reverse proxy's forwarded address.

Create a `.env` next to `docker-compose.yml`. Compose refuses to start without
the required values.

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTOLAB_PG_PASSWORD` | yes | Password for the `autolab` database role. |
| `POSTGRES_RO_PASSWORD` | yes | Password for the read-only `autolab_ro` role used by MCP `query_sql`. |
| `AUTOLAB_READONLY_DB_URL` | yes | `postgresql+psycopg://autolab_ro:<url-escaped-password>@postgres/autolab` |
| `AUTOLAB_STORAGE_HOST_DIR` | yes | Host directory for the artifact store, mounted at `/data/artifacts`. |
| `AUTOLAB_PUBLIC_BASE_URL` | no | Public URL, used in QR labels and notification links. No trailing `/`. |
| `AUTOLAB_IDENTITY_MODE` | no | `none`, `tailscale-serve`, `tailscale-whois`, or `tailscale-hybrid` (default). See below. |
| `AUTOLAB_REQUIRE_IDENTITY_FOR_WRITES` | no | Default `true`: requests without a resolved tailnet login are read only. |
| `AUTOLAB_PRINTERS` | no | JSON map of printer name to `host:port`. |
| `AUTOLAB_DEFAULT_PRINTER` | no | Printer used when a request names none. |
| `AUTOLAB_LABEL_TIMEZONE` | no | Time zone for dates printed on labels. Default `America/Los_Angeles`. |
| `AUTOLAB_SLACK_BOT_TOKEN` | no | Slack bot token for notification DMs. Without it the outbox fills but nothing is sent. |

A new `.env` setting only reaches the containers if `docker-compose.yml` maps
it in the service's `environment:` block.

Deploy an update with:

```sh
git pull --ff-only
docker compose up -d --build app watcher notifier
curl -s http://127.0.0.1:8000/api/health
```

The Postgres init script in `compose/initdb/` creates `autolab_ro` with
select-only grants. Init scripts run only when Postgres creates a new data
volume, so provision the role by hand on an existing cluster.

Set `AUTOLAB_LOG_JSON=true` to emit application logs as structured JSON.
Uvicorn's access log stays plain text.

### Access and identity

AutoLab has no passwords or user accounts of its own. A person's identity is
their tailnet login:

- **On the tailnet** a request is identified automatically and can write.
- **Off the tailnet** (for us, the campus network behind a shared reverse proxy
  password) the app is read only.

The app resolves a login in one of two ways, and both require that the
request's direct peer is in `AUTOLAB_IDENTITY_TRUSTED_PROXIES`:

- **whois.** The reverse proxy appends the client address to
  `X-Forwarded-For`. If the last hop is a tailnet address, the app asks the
  host's `tailscaled` (its socket is mounted into the container) who owns it.
  Only the last hop is consulted, because earlier entries come from the client.
- **Serve header.** A `tailscale serve` proxy injects `Tailscale-User-Login`.
  The reverse proxy must strip that header from everything else.

`tailscale-hybrid` accepts a verified Serve header and otherwise falls back to
whois. Our deployment uses both: whois for the lab's Headscale tailnet, and a
Serve container for a second, personal tailnet.

Because identity rides on the network rather than a cookie, the app rejects
any write whose `Origin` header names another site. Otherwise a page on
another site, opened by a tailnet member, could submit forms as them. Requests
without an `Origin` (scripts, instrument PCs, MCP clients) are unaffected.

A login maps to a person through the person record's Tailscale Login field.
One person can have several logins. The mapped person becomes the default
actor for that browser. Attribution is a notebook signature, not an access
control: anyone who can write may record work under another person's name,
and the event records who actually submitted it.

## Tailnet access with Headscale

[Headscale](https://headscale.net) is a self-hosted Tailscale control server.
With it, the lab owns the tailnet, and joining a device is how a person gets
write access to AutoLab. This section describes the setup we run: one host with
Headscale, Caddy, `tailscaled`, and AutoLab. The hostnames below are
placeholders.

| Name | Role |
| --- | --- |
| `headscale.example.edu` | Headscale's public URL. Tailscale clients talk to it. |
| `autolab.example.edu` | AutoLab's URL. Campus DNS points it at the host's public IP. |
| `100.64.0.1` | The host's tailnet address. |

The request path is:

1. A tailnet client resolves `autolab.example.edu` through Tailscale's DNS. A
   Headscale DNS record returns the host's tailnet address, so the request
   travels over WireGuard.
2. Caddy sees a source address in `100.64.0.0/10` and proxies to the app
   without a password. Caddy appends that address to `X-Forwarded-For`.
3. The app asks the host's `tailscaled` who owns the address. Headscale has
   told it, because the host is a node on the same tailnet.

A browser that is not on the tailnet resolves the public IP instead. It lands
in the password branch and is read only.

### 1. Run Headscale

We run the `headscale/headscale` image (0.29) in Docker, with ports 8080 and
9090 published on host loopback only. The settings that matter for AutoLab,
from `config.yaml`:

```yaml
server_url: https://headscale.example.edu
listen_addr: 0.0.0.0:8080        # container port; published on 127.0.0.1 only
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
node:
  expiry: 0                      # lab devices do not need to re-authenticate
policy:
  mode: file
  path: /etc/headscale/policy.hujson
dns:
  magic_dns: true
  base_domain: tail.headscale.example.edu
  override_local_dns: false      # keep each device's own resolvers
  nameservers:
    global: []
    split: {}
  extra_records:
    # Split horizon: tailnet clients reach AutoLab over WireGuard.
    - name: autolab.example.edu
      type: A
      value: 100.64.0.1          # the AutoLab host's tailnet address (step 3)
```

The policy lets every member reach only the web ports on the AutoLab host:

```hujson
{
  "tagOwners": { "tag:app-host": ["admin@"] },
  "grants": [
    { "src": ["admin@"], "dst": ["tag:app-host"], "ip": ["*"] },
    { "src": ["autogroup:member"], "dst": ["tag:app-host"], "ip": ["tcp:80", "tcp:443"] }
  ]
}
```

[Headplane](https://github.com/tale/headplane) is an optional web admin UI. We
serve it to the tailnet only.

### 2. Put Caddy in front of both

Caddy terminates TLS for both names. The AutoLab site routes by source
address:

```caddyfile
headscale.example.edu {
	reverse_proxy 127.0.0.1:8080
}

autolab.example.edu {
	# Tailnet clients: identified by whois in the app, no password.
	@tailnet remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
	handle @tailnet {
		reverse_proxy 127.0.0.1:8000 {
			header_up -Tailscale-User-Login
		}
	}

	# Campus clients: shared password, read only in the app.
	@campus remote_ip 192.0.2.0/24
	handle @campus {
		basic_auth {
			lab <bcrypt hash from `caddy hash-password`>
		}
		reverse_proxy 127.0.0.1:8000 {
			header_up -Tailscale-User-Login
		}
	}

	respond 403
}
```

Leave out the campus branch for tailnet-only access.

### 3. Join the AutoLab host to the tailnet

Install Tailscale on the host and log in to Headscale as a tagged node. The
host does not need tailnet DNS or routes:

```sh
sudo tailscale up --login-server https://headscale.example.edu \
  --advertise-tags=tag:app-host --accept-dns=false --accept-routes=false
```

The command prints a registration URL that contains an auth ID. Approve it on
the Headscale side, then put the host's address (`tailscale ip -4`) into the
`extra_records` entry from step 1:

```sh
docker exec headscale headscale users create admin --email admin@example.edu
docker exec headscale headscale auth register --auth-id <AUTH_ID> --user admin
```

### 4. Configure AutoLab

The compose defaults already match this setup. Check these points:

- `AUTOLAB_IDENTITY_MODE` is `tailscale-whois` or `tailscale-hybrid`.
- `AUTOLAB_IDENTITY_TRUSTED_PROXIES` contains the Docker gateway (`172.28.0.1`
  on the pinned compose network). Caddy reaches the published port through it.
- The host's `tailscaled.sock` is mounted into the app container. Set
  `AUTOLAB_TAILSCALED_SOCKET` if it is not at `/var/run/tailscale/`.
- `AUTOLAB_REQUIRE_IDENTITY_FOR_WRITES=true`.

### 5. Enroll a person

1. Create their Headscale user:

   ```sh
   docker exec headscale headscale users create jdoe --email jdoe@example.edu
   ```

2. On their device, install Tailscale and log in with a custom server:
   - **iOS:** account icon, "Log in…", options menu, "Use custom coordination
     server".
   - **macOS:** Option-click the menu bar icon, Debug, Custom Login Server, Add
     Account. Or run `tailscale login --login-server <URL>`.
   - **Android:** Settings, Accounts, then "Use an alternate server" in the
     menu.
   - **Linux and Windows:** `tailscale up --login-server <URL>`.

   Headscale's [client docs](https://headscale.net/stable/usage/connect/apple/)
   cover the details.

3. The device shows a registration page with an auth ID. Approve it:

   ```sh
   docker exec headscale headscale auth register --auth-id <AUTH_ID> --user jdoe
   ```

   For unattended machines such as instrument PCs, create a key instead with
   `headscale preauthkeys create --user <numeric user ID>`. Then run
   `tailscale up --login-server <URL> --authkey <key>` on the machine.

4. Leave "Use Tailscale DNS" on. Without it the device resolves the public
   address and gets the read-only site.

5. On that device, open `https://autolab.example.edu/api/whoami`. Copy the
   `login` value into the Tailscale Login field of the person's record in
   AutoLab.

### Troubleshooting

If a tailnet device sees AutoLab as read only:

- `/api/whoami` shows `"login": null`. Check that the name resolves to the
  `100.x` address on that device (`nslookup autolab.example.edu`). Common
  causes are Tailscale DNS turned off, another VPN taking over DNS, or a cached
  public answer.
- `login` is set but `mapped` is false. The login is not on any person's
  record yet (step 5.5).
- Check that the policy grants `tcp:443` to the host's tag.

## Labels and QR codes

AutoLab renders ZPL and sends it straight to a Zebra-compatible printer over
TCP, conventionally port 9100. No driver or print queue is involved.

```sh
AUTOLAB_PRINTERS='{"zebra":"192.0.2.10:9100"}'
AUTOLAB_DEFAULT_PRINTER=zebra
AUTOLAB_PUBLIC_BASE_URL=https://autolab.example.edu
```

QR labels encode `<public_base_url>/e/<accession>`. Creating a wafer, substrate
batch, or instrument from the web app prints its label automatically, and the
success card says where it went. Every record page can reprint a QR or
text-only label. A print failure never undoes the record.

Printing comes first and the `label_printed` event second. A database failure
after a successful send can therefore leave a physical label without a
matching event.

The label station at `/labels` prints ad hoc labels such as computer labels
(hostname, MAC, IP) and general labels with an optional QR code. It has no link
from the main app and returns 404 unless the request resolves to a tailnet
login (or identity is not required, as in development). The layout engine in
`labcore/labeldesign.py` produces both the ZPL and the SVG preview from one
element list. `scripts/make_label_mark.py` regenerates the lab badge bitmaps.

## Backups

`scripts/backup.sh` writes a timestamped custom-format archive
(`autolab_YYYYMMDD_HHMMSS.dump`) and keeps the newest
`AUTOLAB_BACKUP_RETENTION` archives (default 14). It reads the database URL
from `AUTOLAB_PG_URL` or `AUTOLAB_DB_URL`, and the output directory from
`AUTOLAB_BACKUP_DIR`. Postgres publishes 5432 on host loopback for this. Run it
nightly from cron with the variables in a root-owned file:

```sh
17 2 * * * . /etc/autolab/backup.env && /path/to/autolab/scripts/backup.sh >> /var/log/autolab-backup.log 2>&1
```

Restore an archive into an existing database from the repository root:

```sh
AUTOLAB_PG_URL=postgresql://autolab:<password>@localhost/autolab ./scripts/restore.sh <dumpfile>
```

The restore runs `pg_restore --clean --if-exists --single-transaction`, so it
replaces database objects. It asks you to type `RESTORE`. `--yes` exists for
automation such as CI, which runs a backup and restore round trip on every
push.

Artifacts live in `AUTOLAB_STORAGE_HOST_DIR` and need their own backup.

## Agents (MCP)

Agents connect to `https://<host>/mcp` over streamable HTTP. The MCP server
runs in the same process as the REST API. With identity required, `POST /mcp`
needs a tailnet login like any other write.

| Tool | What it does |
| --- | --- |
| `describe_schema` | Tables, columns, foreign keys, and the provenance relation vocabulary. |
| `query_sql` | One read-only SQL query with a bounded result, run as `autolab_ro` on Postgres. |
| `get_events` | The event feed after an optional cursor. |
| `read_document` | A cataloged text artifact. Rejects binary or oversized files. |
| `summarize_array` | Statistics for an HDF5 dataset or Parquet structure, without returning the data. |
| `propose_annotation` | Records proposed text as a `review_task` for a human to accept. |
| `create_record`, `update_record`, `link_records` | Agent-attributed catalog writes. There is no delete. |
| `get_project_report`, `create_project_item`, `update_project_item` | Project dashboards and to-do items. |
| `get_rf_parts`, `evaluate_setup` | The RF parts library and a setup's gain and noise budget. |

Every MCP write names an agent entity, and its events carry that agent's
attribution.

## Instrument data

Install the `labdata` extra (the Docker image includes it). `save()` writes a
file to the shared store and registers it in one call. The write-ahead spool
journals each registration before contacting the catalog, so an outage loses
nothing. Network errors, 5xx, and 429 stay pending for `flush()`. Other HTTP
errors move the entry to `dead/` and come back in `result["error"]`.

```python
from pathlib import Path

import numpy as np

from labdata import LabData, Spool, save

spool = Spool(Path("labdata-spool"))
with LabData.for_url("http://localhost:8000") as client:
    result = save(
        np.arange(16),
        kind="array",
        name="VNA sweep",
        storage_dir=Path("artifact_store"),
        client=client,
        spool=spool,
    )
    spool.flush(client)
```

On instrument PCs, `labdata.config.session_from_env()` builds a session from
`AUTOLAB_URL`, `AUTOLAB_ACTOR_ID`, `AUTOLAB_STORAGE_DIR`, and
`AUTOLAB_SPOOL_DIR`. `python -m labdata flush` and `python -m labdata status`
manage the spool.

Artifacts resolve beneath `AUTOLAB_STORAGE_ROOT`. Writers and the app must see
the same directory. Once an artifact has a checksum, its URI, checksum, size,
media type, format, role, and schema version are immutable. Corrections go
through `POST /api/artifacts/{id}/supersede`, which adds a new artifact and a
`supersedes` edge. The watcher service files a `review_task` for any file in
the store that nobody registered.

## Legacy elog import

`app.importers.elog` imports a JSONL export of one elog logbook. Message IDs
are unique only within a logbook, so export and import each logbook
separately. Each JSONL line carries the elog and message IDs, logbook, source
URL, timezone-aware timestamp, author, subject, entry type, body, attributes,
attachment URLs, reply and thread IDs, and a content hash.

```sh
AUTOLAB_DB_URL=postgresql+psycopg://autolab:<password>@localhost/autolab \
  python -m app.importers.elog /path/to/logbook.jsonl
```

The import is idempotent on each entry's content hash. Entries become notes,
authors become people, logbooks become instruments, and replies refer to their
parents. Legacy IDs, attributes, and attachment URLs are kept in `extra`. The
importer does not yet ingest attachment files, so keep them with the export.

## API conventions

- `POST /api/{entity_type}` creates a record. Unknown fields go into `extra`
  instead of being rejected. An optional `source_key` makes creation
  idempotent.
- Single-record reads return an `ETag`. `PATCH` honors `If-Match` and rejects
  stale updates with 412.
- `GET /api/e/{accession}` resolves an accession code.
- `GET /api/events?after=<cursor>` pages the feed by a strict `(at, id)` cursor.
- The `X-Actor-Id` header (a person or agent UUID) sets who a write is
  recorded as.

The full reference is the OpenAPI page at `/docs`.

## License

BSD 3-Clause. See `LICENSE`.

AutoLab is provided as is, with no warranty of any kind. Use it at your own
risk. The authors and the University of California are not liable for any
damage or data loss that results from using it.
