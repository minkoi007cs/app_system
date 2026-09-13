#!/usr/bin/env python3
"""Merge the project's variables into .env.local without touching what `neon link` wrote.

Existing non-empty values are never overwritten. Generated secrets are printed to the
terminal only (/dev/tty), so they never reach a log file.
"""
import os
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env.local"


def parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def tty(message: str) -> None:
    try:
        with open("/dev/tty", "w") as handle:
            handle.write(message + "\n")
    except OSError:
        pass


text = ENV.read_text() if ENV.exists() else ""
current = parse(text)

master = (
    current.get("INFRA_MASTER_DATABASE_URL")
    or current.get("DATABASE_URL_UNPOOLED")
    or current.get("DATABASE_URL")
    or ""
)
if not master:
    print("❌ no database url found in .env.local — run `neon link` first")
    sys.exit(1)

wanted: dict[str, str] = {
    "INFRA_MASTER_DATABASE_URL": master,
    "INFRA_MASTER_ENCRYPTION_KEY": secrets.token_hex(32),
    "BETTER_AUTH_SECRET": secrets.token_urlsafe(32),
    "BETTER_AUTH_URL": "http://localhost:3000",
    "INFRA_PUBLIC_URL": "http://localhost:3000",
    "NODE_ENV": "development",
    "INFRA_LOG_LEVEL": "info",
}

added: list[str] = []
lines = text.splitlines()
for key, value in wanted.items():
    if current.get(key):
        continue
    if re.search(rf"^{key}=", text, flags=re.M):
        lines = [re.sub(rf"^{key}=.*$", f'{key}="{value}"', ln) for ln in lines]
    else:
        lines.append(f'{key}="{value}"')
    added.append(key)

if added:
    header = "" if text.strip() == "" else "\n# ── Unified-App-Infra ──"
    ENV.write_text("\n".join(lines + ([header] if False else [])) + "\n")
    print("filled in: " + ", ".join(added))
else:
    print("nothing to fill in — .env.local already complete")

if "INFRA_MASTER_ENCRYPTION_KEY" in added:
    tty("")
    tty("┌──────────────────────────────────────────────────────────────┐")
    tty("│  SAO LƯU KHOÁ NÀY VÀO PASSWORD MANAGER — CHỈ HIỆN MỘT LẦN    │")
    tty("│  Mất khoá = mọi connection string đã mã hoá thành rác        │")
    tty("└──────────────────────────────────────────────────────────────┘")
    tty("INFRA_MASTER_ENCRYPTION_KEY=" + wanted["INFRA_MASTER_ENCRYPTION_KEY"])
    tty("")
    print("(khoá mã hoá đã in ra màn hình — lưu lại ngay)")
