#!/usr/bin/env python3
"""
load_git_gate.py — Git Gate enforcement loader (Docker entrypoint + local fallback)

Intercepts `git add` commands, checks each file against git-gate-config.json
via the compiled git_gate binary, then either blocks or forwards to real git.

Log entries are written as newline-delimited JSON to a path specified by the
GIT_GATE_LOG_FILE env var (set by the VS Code extension). This lets the
dashboard panel display live activity.

Log entry schema:
  { "ts": "HH:MM", "outcome": "blocked"|"safe"|"system", "files": "...", "rule": "..." }
"""

import os
import sys
import subprocess
import shutil
import json
import re
from pathlib import Path
from datetime import datetime

# ── paths ──────────────────────────────────────────────────────────────────
BINARY      = Path(__file__).parent / "git_gate"
CONFIG_NAME = "git-gate-config.json"
REAL_GIT    = shutil.which("git") or "/usr/bin/git"

# ── logging ────────────────────────────────────────────────────────────────

def now_hhmm() -> str:
    return datetime.now().strftime("%H:%M")


def write_log(outcome: str, files: str, rule: str | None = None):
    """Append a JSON log entry to the log file if configured."""
    log_path = os.environ.get("GIT_GATE_LOG_FILE")
    if not log_path:
        return
    entry: dict = {"ts": now_hhmm(), "outcome": outcome, "files": files}
    if rule:
        entry["rule"] = rule
    try:
        with open(log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


# ── config ─────────────────────────────────────────────────────────────────

def find_config() -> Path | None:
    """Walk up from cwd to find git-gate-config.json."""
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = parent / CONFIG_NAME
        if candidate.is_file():
            return candidate
        if (parent / ".git").exists() or parent == parent.parent:
            break
    return None


# ── path expansion ─────────────────────────────────────────────────────────

def expand_git_add_paths(args: list[str]) -> list[str]:
    """Extract concrete file paths from `git add` arguments."""
    paths = []
    skip_next = False
    for arg in args:
        if skip_next:
            skip_next = False
            continue
        if arg in ("--pathspec-from-file", "--chmod", "--pathspec-file-nul"):
            skip_next = True
            continue
        if arg.startswith("-"):
            continue
        paths.append(arg)

    if not paths:
        return []

    try:
        result = subprocess.run(
            [REAL_GIT, "ls-files", "--others", "--cached", "--modified",
             "--exclude-standard", "--", *paths],
            capture_output=True, text=True
        )
        listed = [l for l in result.stdout.splitlines() if l]
        return listed if listed else paths
    except Exception:
        return paths


# ── enforcement ────────────────────────────────────────────────────────────

def ensure_binary() -> bool:
    """Compile git_gate.c if the binary is missing. Returns True on success."""
    if BINARY.exists():
        return True
    src = BINARY.parent / "git_gate.c"
    print("git-gate: compiling enforcement binary…", file=sys.stderr)
    result = subprocess.run(
        ["gcc", "-O2", "-o", str(BINARY), str(src)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"git-gate: compile failed:\n{result.stderr}", file=sys.stderr)
        return False
    BINARY.chmod(0o755)
    return True


def run_enforcer(config: Path, files: list[str]) -> tuple[bool, str | None]:
    """
    Run the git_gate binary against the file list.
    Returns (safe: bool, blocked_rule: str | None).
    """
    if not ensure_binary():
        return True, None   # fail-open

    result = subprocess.run(
        [str(BINARY), str(config), *files],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return True, None

    # Extract which rule triggered the block from stderr
    rule_match = re.search(r"matches rule '([^']+)'", result.stderr)
    rule = rule_match.group(1) if rule_match else None
    sys.stderr.write(result.stderr)
    return False, rule


# ── main ───────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    subcommand_idx = next(
        (i for i, a in enumerate(args) if not a.startswith("-")), None
    )
    is_git_add = subcommand_idx is not None and args[subcommand_idx] == "add"

    if is_git_add:
        add_args = args[subcommand_idx + 1:]
        config   = find_config()

        if config is None:
            print(f"git-gate: no {CONFIG_NAME} found — running without enforcement.", file=sys.stderr)
        else:
            files = expand_git_add_paths(add_args)
            if files:
                files_str = " ".join(files)
                safe, rule = run_enforcer(config, files)
                if safe:
                    write_log("safe", files_str)
                else:
                    write_log("blocked", files_str, rule)
                    sys.exit(1)

    os.execv(REAL_GIT, [REAL_GIT, *args])


if __name__ == "__main__":
    main()
