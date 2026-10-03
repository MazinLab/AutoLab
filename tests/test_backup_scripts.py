import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = ROOT / "scripts" / "backup.sh"
RESTORE_SCRIPT = ROOT / "scripts" / "restore.sh"


def test_backup_and_restore_scripts_parse_and_are_executable() -> None:
    for script in (BACKUP_SCRIPT, RESTORE_SCRIPT):
        subprocess.run(["bash", "-n", script], check=True)
        assert os.access(script, os.X_OK)


def _install_fake_command(bin_dir: Path, name: str, script: str) -> Path:
    command = bin_dir / name
    command.write_text(script, encoding="utf-8")
    command.chmod(0o755)
    return command


def _command_env(bin_dir: Path, **values: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join(
        (str(bin_dir), environment.get("PATH", ""))
    )
    environment.update(values)
    return environment


def test_backup_executes_custom_format_dump_and_prunes_old_archives(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    target_dir = tmp_path / "backup dir"
    target_dir.mkdir()
    old_dump = target_dir / "autolab_20000101_000000.dump"
    kept_dump = target_dir / "autolab_20000102_000000.dump"
    old_dump.write_text("old", encoding="utf-8")
    kept_dump.write_text("kept", encoding="utf-8")
    unrelated = target_dir / "notes.txt"
    unrelated.write_text("keep", encoding="utf-8")
    dump_log = tmp_path / "pg_dump.args"
    _install_fake_command(
        bin_dir,
        "pg_dump",
        """#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$PG_DUMP_LOG"
for argument in "$@"; do
    if [[ "$argument" == --file=* ]]; then
        printf 'fake archive\\n' > "${argument#--file=}"
    fi
done
""",
    )

    result = subprocess.run(
        [
            str(BACKUP_SCRIPT),
            "postgresql+psycopg://user:p%40ss@db/autolab",
            str(target_dir),
            "2",
        ],
        env=_command_env(bin_dir, PG_DUMP_LOG=str(dump_log)),
        check=True,
        capture_output=True,
        text=True,
    )

    dump_file = Path(result.stdout.strip())
    assert dump_file.parent == target_dir.resolve()
    assert dump_file.is_file()
    assert not Path(f"{dump_file}.partial").exists()
    assert not old_dump.exists()
    assert kept_dump.exists()
    assert unrelated.exists()
    assert len(list(target_dir.glob("autolab_*.dump"))) == 2

    arguments = dump_log.read_text(encoding="utf-8").splitlines()
    assert arguments[0] == "-Fc"
    assert arguments[1].startswith("--file=")
    assert arguments[1].endswith(".partial")
    assert arguments[2] == "postgresql://user:p%40ss@db/autolab"


def test_backup_removes_partial_archive_when_dump_fails(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    target_dir = tmp_path / "backups"
    dump_log = tmp_path / "pg_dump.args"
    _install_fake_command(
        bin_dir,
        "pg_dump",
        """#!/usr/bin/env bash
set -eu
for argument in "$@"; do
    if [[ "$argument" == --file=* ]]; then
        printf 'incomplete archive\\n' > "${argument#--file=}"
    fi
done
exit 17
""",
    )

    result = subprocess.run(
        [str(BACKUP_SCRIPT), "postgresql://db", str(target_dir), "1"],
        env=_command_env(bin_dir, PG_DUMP_LOG=str(dump_log)),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 17
    assert list(target_dir.glob("*.partial")) == []
    assert list(target_dir.glob("*.dump")) == []


def test_restore_requires_confirmation_and_passes_safe_options(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    dump_file = tmp_path / "autolab.dump"
    dump_file.write_text("fake archive", encoding="utf-8")
    restore_log = tmp_path / "pg_restore.args"
    _install_fake_command(
        bin_dir,
        "pg_restore",
        """#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$PG_RESTORE_LOG"
""",
    )
    environment = _command_env(
        bin_dir,
        AUTOLAB_PG_URL="postgresql+psycopg://user:p%40ss@db/autolab",
        PG_RESTORE_LOG=str(restore_log),
    )

    cancelled = subprocess.run(
        [str(RESTORE_SCRIPT), str(dump_file)],
        env=environment,
        input="no\n",
        capture_output=True,
        text=True,
    )
    assert cancelled.returncode == 1
    assert not restore_log.exists()

    subprocess.run(
        [str(RESTORE_SCRIPT), str(dump_file), "--yes"],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    assert restore_log.read_text(encoding="utf-8").splitlines() == [
        "--clean",
        "--if-exists",
        "--single-transaction",
        "-d",
        "postgresql://user:p%40ss@db/autolab",
        "--exit-on-error",
        str(dump_file),
    ]
