"""labdata operational CLI for instrument PCs.

    python -m labdata flush    replay spooled registrations against the catalog
    python -m labdata status   count pending / dead-lettered spool entries

Both read the AUTOLAB_* environment (see labdata.config).
"""

from __future__ import annotations

import argparse
import sys

from labdata.config import client_from_env, spool_from_env


def _quarantined(spool) -> list:
    return sorted((spool.dir / "quarantine").glob("*"))


def _flush() -> int:
    spool = spool_from_env()
    # An entry that vanishes into dead/ or quarantine/ during THIS flush is
    # a failure the operator must see, not a cleared queue.
    dead_before = len(spool.dead())
    quarantined_before = len(_quarantined(spool))
    with client_from_env() as client:
        completed = spool.flush(client)
    remaining = len(spool.pending())
    new_dead = len(spool.dead()) - dead_before
    new_quarantined = len(_quarantined(spool)) - quarantined_before
    print(
        f"registered {completed}, still pending {remaining}, "
        f"dead-lettered {new_dead}, quarantined {new_quarantined}"
    )
    if new_dead or new_quarantined:
        print(
            f"FAILED entries preserved under {spool.dir}/dead and "
            f"{spool.dir}/quarantine — inspect and re-register manually"
        )
    return 1 if remaining or new_dead or new_quarantined else 0


def _status() -> int:
    spool = spool_from_env()
    pending = spool.pending()
    dead = spool.dead()
    quarantined = _quarantined(spool)
    print(f"spool: {spool.dir}")
    print(f"pending: {len(pending)}")
    for path in pending[:20]:
        print(f"  {path.name}")
    print(f"dead-lettered: {len(dead)}")
    for path in dead[:20]:
        print(f"  dead/{path.name}")
    print(f"quarantined (malformed journals): {len(quarantined)}")
    for path in quarantined[:20]:
        print(f"  quarantine/{path.name}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="labdata")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("flush", help="replay spooled registrations")
    sub.add_parser("status", help="show spool state")
    args = parser.parse_args(argv)
    if args.command == "flush":
        return _flush()
    return _status()


if __name__ == "__main__":
    sys.exit(main())
