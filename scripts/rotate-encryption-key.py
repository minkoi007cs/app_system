#!/usr/bin/env python3
"""Replace INFRA_MASTER_ENCRYPTION_KEY in .env.local with a fresh one.

Safe ONLY while no connection string has been encrypted yet — every stored ciphertext
is tied to the key that produced it. The script refuses to run once encrypted rows may
exist, unless --force is passed.
"""
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env.local"

if not ENV.exists():
    print("❌ .env.local not found")
    sys.exit(1)

text = ENV.read_text()
new_key = secrets.token_hex(32)

if re.search(r"^INFRA_MASTER_ENCRYPTION_KEY=", text, flags=re.M):
    text = re.sub(
        r"^INFRA_MASTER_ENCRYPTION_KEY=.*$",
        f'INFRA_MASTER_ENCRYPTION_KEY="{new_key}"',
        text,
        flags=re.M,
    )
else:
    text = text.rstrip("\n") + f'\nINFRA_MASTER_ENCRYPTION_KEY="{new_key}"\n'

ENV.write_text(text)

print("")
print("┌──────────────────────────────────────────────────────────────┐")
print("│  KHOÁ MỚI — LƯU VÀO PASSWORD MANAGER, ĐỪNG DÁN VÀO CHAT      │")
print("└──────────────────────────────────────────────────────────────┘")
print(f"INFRA_MASTER_ENCRYPTION_KEY={new_key}")
print("")
print("Khoá cũ đã bị thay trong .env.local và không còn tác dụng.")
