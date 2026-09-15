#!/usr/bin/env python3
"""Sinh `INFRA_MASTER_ENCRYPTION_KEY` **lần đầu** vào .env.local.

KHÔNG phải công cụ xoay khoá. Docstring cũ của file này hứa rằng "script từ chối chạy khi đã có
dòng mã hoá" — nhưng trong mã không hề có kiểm tra đó. Nó ghi đè khoá vô điều kiện. Chạy nó trên
một hệ thống đã có dữ liệu sẽ làm mất quyền giải mã **mọi** connection string, private key ký JWT,
secret webhook và seed TOTP đang lưu. Không có đường khôi phục (rủi ro R2).

Giờ nó chỉ làm đúng một việc an toàn: điền khoá vào chỗ còn trống.

  Đặt khoá lần đầu             →  script này
  Xoay khoá khi đã có dữ liệu  →  node scripts/rotate-master-key.mjs --to 2
"""
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env.local"
VAR = "INFRA_MASTER_ENCRYPTION_KEY"

if not ENV.exists():
    print("❌ không tìm thấy .env.local")
    sys.exit(1)

text = ENV.read_text()
existing = re.search(rf'^{VAR}=["\']?([^"\'\n]*)["\']?$', text, flags=re.M)
current = existing.group(1).strip() if existing else ""

# Khoá thật là 64 ký tự hex. Bất cứ thứ gì khác — rỗng, hoặc placeholder trong .env.example —
# là chỗ trống hợp lệ để điền.
if re.fullmatch(r"[0-9a-fA-F]{64}", current):
    print("")
    print("⛔ ĐÃ CÓ KHOÁ HỢP LỆ TRONG .env.local — script này sẽ không ghi đè.")
    print("")
    print("   Ghi đè một khoá đang dùng = mất mọi connection string, khoá ký JWT,")
    print("   secret webhook và seed TOTP đã mã hoá bằng nó. Không khôi phục được.")
    print("")
    print("   Muốn XOAY khoá thì dùng công cụ mã hoá lại dữ liệu, không phải công cụ này:")
    print("")
    print("     1. Đặt khoá mới vào INFRA_MASTER_ENCRYPTION_KEY_V2 (GIỮ NGUYÊN khoá cũ chỗ cũ)")
    print("     2. node scripts/rotate-master-key.mjs --to 2 --dry-run")
    print("     3. node scripts/rotate-master-key.mjs --to 2")
    print("     4. Đặt INFRA_MASTER_ENCRYPTION_KEY_VERSION=2, khởi động lại, health check")
    print("")
    print("   Quy trình đầy đủ: docs/runbooks.md §2")
    print("")
    sys.exit(1)

new_key = secrets.token_hex(32)

if existing:
    text = re.sub(rf"^{VAR}=.*$", f'{VAR}="{new_key}"', text, flags=re.M)
else:
    text = text.rstrip("\n") + f'\n{VAR}="{new_key}"\n'

ENV.write_text(text)

print("")
print("┌──────────────────────────────────────────────────────────────┐")
print("│  KHOÁ MỚI — LƯU VÀO PASSWORD MANAGER, ĐỪNG DÁN VÀO CHAT      │")
print("└──────────────────────────────────────────────────────────────┘")
print(f"{VAR}={new_key}")
print("")
print("Mất khoá này = mất mọi bí mật đã mã hoá. Sao lưu ngay, trước khi tạo app đầu tiên.")
