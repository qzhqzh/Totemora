#!/usr/bin/env python3
"""Send multiline Markdown to Gitea through tea without shell escaping."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MAX_BODY_BYTES = 64 * 1024
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:sk|ghp|github_pat|glpat)-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s<]{8,}"),
)


def read_body(body_file: str | None = None) -> str:
    if body_file:
        allowed_root = Path(os.environ.get("TOTEMORA_GIT_FLOW_BODY_DIR", "/tmp/totemora-git-flow")).resolve()
        path = Path(body_file)
        if not hasattr(os, "O_NOFOLLOW"):
            raise SystemExit("This platform cannot safely open Markdown body files; use stdin")
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as error:
            raise SystemExit("Markdown body file must be a readable regular non-symlink file") from error
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode):
                raise SystemExit("Markdown body file must be a regular file")
            actual_path = Path(os.readlink(f"/proc/self/fd/{descriptor}")).resolve()
            try:
                actual_path.relative_to(allowed_root)
            except ValueError as error:
                raise SystemExit(f"Markdown body file must be inside {allowed_root}") from error
            if details.st_uid != os.getuid():
                raise SystemExit("Markdown body file must be owned by the current user")
            if details.st_size > MAX_BODY_BYTES:
                raise SystemExit("Markdown body exceeds 64 KiB")
            chunks: list[bytes] = []
            remaining = MAX_BODY_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(8192, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            body = b"".join(chunks).decode("utf-8")
        finally:
            os.close(descriptor)
    else:
        body = sys.stdin.read(MAX_BODY_BYTES + 1)
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise SystemExit("Markdown body exceeds 64 KiB")
    if not body.strip():
        raise SystemExit("Markdown body is empty")
    if "\\n" in body and body.count("\n") <= 1:
        raise SystemExit("Markdown contains literal \\n sequences; pass real multiline input")
    if any(pattern.search(body) for pattern in SECRET_PATTERNS):
        raise SystemExit("Markdown body looks like it contains a secret")
    return body.rstrip("\n")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    root.add_argument("--tea", default=os.environ.get("TEA_BIN", "tea"))
    root.add_argument("--dry-run", action="store_true")
    root.add_argument(
        "--body-file",
        help="Read Markdown from a UTF-8 file instead of stdin.",
    )
    sub = root.add_subparsers(dest="command", required=True)

    comment = sub.add_parser("comment")
    comment.add_argument("--repo", required=True)
    comment.add_argument("--login", default="origin")
    comment.add_argument("--pr", required=True)

    create = sub.add_parser("create-pr")
    create.add_argument("--repo", required=True)
    create.add_argument("--login", default="origin")
    create.add_argument("--head", required=True)
    create.add_argument("--base", required=True)
    create.add_argument("--title", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    body = read_body(args.body_file)
    if args.command == "comment":
        command = [
            args.tea,
            "comment",
            "-r",
            args.repo,
            "-l",
            args.login,
            args.pr,
            body,
        ]
    else:
        command = [
            args.tea,
            "pr",
            "create",
            "-r",
            args.repo,
            "-l",
            args.login,
            "--head",
            args.head,
            "--base",
            args.base,
            "--title",
            args.title,
            "--description",
            body,
        ]

    if args.dry_run:
        redacted = [*command[:-1], f"<markdown body redacted: {len(body.encode('utf-8'))} bytes>"]
        print(json.dumps(redacted, ensure_ascii=False))
        return
    subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
