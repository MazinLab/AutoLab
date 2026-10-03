import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = ROOT / "scripts" / "backup.sh"


def test_backup_restricts_directory_and_dump_permissions(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_pg_dump = bin_dir / "pg_dump"
    fake_pg_dump.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
    if [[ "$argument" == --file=* ]]; then
        printf 'fake archive\\n' > "${argument#--file=}"
    fi
done
""",
        encoding="utf-8",
    )
    fake_pg_dump.chmod(0o755)

    target_dir = tmp_path / "backups"
    target_dir.mkdir(mode=0o755)
    target_dir.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join(
        (str(bin_dir), environment.get("PATH", ""))
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            'umask 0022; exec "$@"',
            "bash",
            str(BACKUP_SCRIPT),
            "postgresql://db/autolab",
            str(target_dir),
            "1",
        ],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    dump_file = Path(result.stdout.strip())
    assert stat.S_IMODE(target_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(dump_file.stat().st_mode) == 0o600
