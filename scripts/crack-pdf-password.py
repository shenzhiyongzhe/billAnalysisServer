#!/usr/bin/env python3
"""
Fast PDF user-password checker for Standard security handler R=2/3/4.
Verifies candidates against /U using Algorithm 3.2 + 3.4/3.5 (no full decrypt).
Supports hex </O> and literal (/O (...)) encodings; prefers top-level /Length 40|128|256.

Usage:
  python scripts/crack-pdf-password.py path/to/file.pdf
  python scripts/crack-pdf-password.py path/to/file.pdf --digits 6
  python scripts/crack-pdf-password.py path/to/file.pdf --wordlist passwords.txt
"""

from __future__ import annotations

import argparse
import hashlib
import multiprocessing as mp
import re
import struct
import sys
import time
from pathlib import Path

# Set by pool initializer for worker processes.
_WORKER_KW: dict | None = None

PADDING = bytes(
    [
        0x28,
        0xBF,
        0x4E,
        0x5E,
        0x4E,
        0x75,
        0x8A,
        0x41,
        0x64,
        0x00,
        0x4E,
        0x56,
        0xFF,
        0xFA,
        0x01,
        0x08,
        0x2E,
        0x2E,
        0x00,
        0xB6,
        0xD0,
        0x68,
        0x3E,
        0x80,
        0x2F,
        0x0C,
        0xA9,
        0xFE,
        0x64,
        0x53,
        0x69,
        0x7A,
    ]
)


def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 0xFF
        s[i], s[j] = s[j], s[i]
    i = j = 0
    out = bytearray(len(data))
    for n, b in enumerate(data):
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out[n] = b ^ s[(s[i] + s[j]) & 0xFF]
    return bytes(out)


def pad_password(password: str | bytes) -> bytes:
    raw = password.encode("latin-1", errors="ignore") if isinstance(password, str) else password
    if len(raw) >= 32:
        return raw[:32]
    return raw + PADDING[: 32 - len(raw)]


def compute_key(
    password: str | bytes,
    o_entry: bytes,
    p_entry: int,
    file_id: bytes,
    revision: int,
    key_bits: int,
) -> bytes:
    buf = bytearray()
    buf.extend(pad_password(password))
    buf.extend(o_entry)
    # PDF treats P as unsigned 32-bit, low-order byte first (even if written as negative).
    buf.extend(struct.pack("<I", p_entry & 0xFFFFFFFF))
    buf.extend(file_id)
    digest = hashlib.md5(buf).digest()
    key_len = key_bits // 8
    if revision >= 3:
        # Spec: each round feeds only the first n/8 bytes back into MD5.
        # (For Length=128 this equals the full digest; for Length=40 it is 5 bytes.)
        for _ in range(50):
            digest = hashlib.md5(digest[:key_len]).digest()
    return digest[:key_len]


def compute_u(
    key: bytes,
    file_id: bytes,
    revision: int,
) -> bytes:
    if revision == 2:
        return rc4(key, PADDING) + b"\x00" * 16
    # Revision >= 3
    md = hashlib.md5(PADDING + file_id).digest()
    enc = rc4(key, md)
    for i in range(1, 20):
        xkey = bytes(b ^ i for b in key)
        enc = rc4(xkey, enc)
    return enc + b"\x00" * 16


def password_matches(
    password: str | bytes,
    *,
    o_entry: bytes,
    u_entry: bytes,
    p_entry: int,
    file_id: bytes,
    revision: int,
    key_bits: int,
) -> bool:
    key = compute_key(password, o_entry, p_entry, file_id, revision, key_bits)
    u = compute_u(key, file_id, revision)
    if revision >= 3:
        return u[:16] == u_entry[:16]
    return u[:32] == u_entry[:32]


def parse_hex_bytes(s: str) -> bytes:
    return bytes.fromhex(re.sub(r"\s+", "", s))


def parse_pdf_literal_string(data: bytes, start: int) -> tuple[bytes, int]:
    """Parse a PDF literal string starting at data[start] == ord('('). Returns (value, end_index)."""
    if start >= len(data) or data[start] != ord("("):
        raise ValueError("literal string must start with '('")
    i = start + 1
    out = bytearray()
    depth = 1
    while i < len(data):
        b = data[i]
        if b == ord("\\"):
            i += 1
            if i >= len(data):
                break
            esc = data[i]
            if esc in (ord("n"),):
                out.append(0x0A)
            elif esc in (ord("r"),):
                out.append(0x0D)
            elif esc in (ord("t"),):
                out.append(0x09)
            elif esc in (ord("b"),):
                out.append(0x08)
            elif esc in (ord("f"),):
                out.append(0x0C)
            elif esc in (ord("("), ord(")"), ord("\\")):
                out.append(esc)
            elif ord("0") <= esc <= ord("7"):
                octal = [esc]
                j = i + 1
                while j < len(data) and len(octal) < 3 and ord("0") <= data[j] <= ord("7"):
                    octal.append(data[j])
                    j += 1
                out.append(int(bytes(octal), 8) & 0xFF)
                i = j - 1
            else:
                # Unknown escape: take the char as-is (PDF ignores the backslash)
                out.append(esc)
            i += 1
            continue
        if b == ord("("):
            depth += 1
            out.append(b)
            i += 1
            continue
        if b == ord(")"):
            depth -= 1
            if depth == 0:
                return bytes(out), i + 1
            out.append(b)
            i += 1
            continue
        out.append(b)
        i += 1
    raise ValueError("unterminated PDF literal string")


def extract_encrypt_info(pdf: bytes) -> dict:
    # Only scan the file tail — full-file regex on multi-MB PDFs is painfully slow.
    tail = pdf[-min(len(pdf), 256 * 1024) :]

    trailer_m = re.search(rb"trailer\s*<<(.*?)>>\s*startxref", tail, re.S | re.I)
    if not trailer_m:
        raise ValueError("未找到 trailer")
    trailer = trailer_m.group(1)

    enc_ref = re.search(rb"/Encrypt\s+(\d+)\s+0\s+R", trailer)
    if not enc_ref:
        raise ValueError("PDF 未加密（无 /Encrypt）")
    obj_num = int(enc_ref.group(1))

    id_m = re.search(rb"/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", trailer)
    if not id_m:
        raise ValueError("未找到 /ID")
    file_id = parse_hex_bytes(id_m.group(1).decode())

    # Encrypt dict sits just before xref in this file; search tail first.
    obj_pat = re.compile(
        rf"{obj_num}\s+0\s+obj\s*<<(.*?)>>\s*endobj".encode(),
        re.S,
    )
    obj_m = obj_pat.search(tail) or obj_pat.search(pdf)
    if not obj_m:
        raise ValueError(f"未找到加密对象 {obj_num} 0 obj")
    body = obj_m.group(1)

    def req_int(name: str) -> int:
        m = re.search(rf"/{name}\s+(-?\d+)".encode(), body)
        if not m:
            raise ValueError(f"加密字典缺少 /{name}")
        return int(m.group(1))

    def req_bytes(name: str) -> bytes:
        # Hex string form: /O <DEADBEEF...>
        m = re.search(rf"/{name}\s*<([0-9A-Fa-f]+)>".encode(), body)
        if m:
            return parse_hex_bytes(m.group(1).decode())
        # Literal string form: /O (...)
        m = re.search(rf"/{name}\s*\(".encode(), body)
        if not m:
            raise ValueError(f"加密字典缺少 /{name}")
        value, _ = parse_pdf_literal_string(body, m.end() - 1)
        return value

    revision = req_int("R")
    version = req_int("V")
    # Prefer top-level key length (40/128/256). Nested /CF StdCF also has /Length 16 (bytes).
    length_matches = [int(x) for x in re.findall(rb"/Length\s+(\d+)", body)]
    length = next(
        (n for n in reversed(length_matches) if n in (40, 128, 256)),
        (40 if revision == 2 else 128),
    )
    p_entry = req_int("P")
    o_entry = req_bytes("O")
    u_entry = req_bytes("U")

    return {
        "obj": obj_num,
        "V": version,
        "R": revision,
        "Length": length,
        "P": p_entry,
        "O": o_entry,
        "U": u_entry,
        "ID0": file_id,
    }


def iter_digit_passwords(digits: int, start: int = 0, stop: int | None = None):
    width = digits
    total = 10**digits
    end = total if stop is None else min(stop, total)
    for i in range(start, end):
        yield f"{i:0{width}d}"


def iter_wordlist(path: Path):
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            pw = line.strip("\r\n")
            if pw:
                yield pw


def _pool_init(kwargs: dict) -> None:
    global _WORKER_KW
    _WORKER_KW = kwargs


def _pool_scan_range(task: tuple[int, int, int]) -> str | None:
    """Scan numeric passwords [start, stop) with zero-padded width."""
    start, stop, width = task
    assert _WORKER_KW is not None
    for i in range(start, stop):
        pw = f"{i:0{width}d}"
        if password_matches(pw, **_WORKER_KW):
            return pw
    return None


def brute_digits_mp(
    kwargs: dict,
    digits: int,
    workers: int,
    start: int = 0,
    stop: int | None = None,
) -> str | None:
    total = 10**digits
    end = total if stop is None else min(stop, total)
    if start >= end:
        return None

    workers = max(1, workers)
    span = end - start
    # Chunk so we get frequent progress callbacks.
    chunk = max(5000, span // (workers * 20))
    tasks = []
    cur = start
    while cur < end:
        tasks.append((cur, min(cur + chunk, end), digits))
        cur += chunk

    print(
        f"\nBrute-forcing {digits}-digit numeric [{start}..{end - 1}] "
        f"with {workers} workers ({len(tasks)} chunks)...",
        flush=True,
    )
    t0 = time.perf_counter()
    done = 0
    with mp.Pool(processes=workers, initializer=_pool_init, initargs=(kwargs,)) as pool:
        for result in pool.imap_unordered(_pool_scan_range, tasks, chunksize=1):
            done += 1
            if result is not None:
                pool.terminate()
                elapsed = time.perf_counter() - t0
                print(f"\n*** FOUND: {result!r} *** ({elapsed:.1f}s)", flush=True)
                return result
            if done % max(1, len(tasks) // 20) == 0 or done == len(tasks):
                elapsed = time.perf_counter() - t0
                finished = min(end, start + done * chunk)
                rate = (finished - start) / max(elapsed, 1e-6)
                pct = 100.0 * (finished - start) / max(span, 1)
                eta = (end - finished) / max(rate, 1e-6)
                print(
                    f"  ... {pct:5.1f}%  ~{rate:.0f}/s  ETA {eta:.0f}s",
                    flush=True,
                )
    elapsed = time.perf_counter() - t0
    print(f"Not found in range ({span} tried, {elapsed:.1f}s)", flush=True)
    return None


def main() -> int:
    # Line-buffer stdout so progress shows up under pipes / Windows consoles.
    try:
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Crack PDF user password (R2/R3 fast verify)")
    ap.add_argument("pdf", type=Path, help="PDF 路径")
    ap.add_argument("--digits", type=int, default=6, help="纯数字口令位数（默认 6）")
    ap.add_argument("--wordlist", type=Path, help="可选字典文件")
    ap.add_argument("--also-empty", action="store_true", help="先试空密码")
    ap.add_argument("--birthday", action="store_true", help="额外尝试 YYYYMMDD（1960-2015）")
    ap.add_argument(
        "--workers",
        type=int,
        default=max(1, (mp.cpu_count() or 2) - 1),
        help="进程数（纯数字爆破时生效，默认 CPU-1）",
    )
    ap.add_argument("--start", type=int, default=0, help="数字口令起始（含）")
    ap.add_argument("--stop", type=int, default=None, help="数字口令结束（不含）")
    args = ap.parse_args()

    pdf_path: Path = args.pdf
    if not pdf_path.is_file():
        print(f"文件不存在: {pdf_path}", file=sys.stderr)
        return 1

    print(f"Reading {pdf_path} ...", flush=True)
    data = pdf_path.read_bytes()
    print(f"Size: {len(data)} bytes; parsing encrypt dict ...", flush=True)
    info = extract_encrypt_info(data)
    print(f"File: {pdf_path}", flush=True)
    print(
        f"Encrypt: V={info['V']} R={info['R']} Length={info['Length']} "
        f"P={info['P']} obj={info['obj']}",
        flush=True,
    )
    print(f"ID0: {info['ID0'].hex().upper()}", flush=True)
    print(f"O:   {info['O'].hex().upper()}", flush=True)
    print(f"U:   {info['U'].hex().upper()}", flush=True)

    kwargs = dict(
        o_entry=info["O"],
        u_entry=info["U"],
        p_entry=info["P"],
        file_id=info["ID0"],
        revision=info["R"],
        key_bits=info["Length"],
    )

    candidates = []
    if args.also_empty:
        candidates.append("")
    # Common BOC / bank defaults
    candidates.extend(
        [
            "123456",
            "000000",
            "111111",
            "888888",
            "666666",
            "12345678",
            "password",
            "boc",
            "BOC",
        ]
    )

    def try_one(pw: str) -> bool:
        return password_matches(pw, **kwargs)

    print("\nTrying common passwords...")
    for pw in candidates:
        if try_one(pw):
            print(f"\n*** FOUND: {pw!r} ***")
            return 0

    if args.wordlist:
        print(f"Trying wordlist: {args.wordlist}")
        t0 = time.perf_counter()
        n = 0
        for pw in iter_wordlist(args.wordlist):
            n += 1
            if try_one(pw):
                elapsed = time.perf_counter() - t0
                print(f"\n*** FOUND: {pw!r} *** ({n} tried, {elapsed:.1f}s)")
                return 0
            if n % 100000 == 0:
                rate = n / max(time.perf_counter() - t0, 1e-6)
                print(f"  ... {n} @ {rate:.0f}/s")
        print(f"Wordlist exhausted ({n})")

    if args.birthday:
        print("Trying birthdays YYYYMMDD (1960-01-01 .. 2015-12-31)...")
        t0 = time.perf_counter()
        n = 0
        import datetime as dt

        d = dt.date(1960, 1, 1)
        end = dt.date(2015, 12, 31)
        while d <= end:
            pw = d.strftime("%Y%m%d")
            n += 1
            if try_one(pw):
                elapsed = time.perf_counter() - t0
                print(f"\n*** FOUND: {pw!r} *** ({n} tried, {elapsed:.1f}s)")
                return 0
            d += dt.timedelta(days=1)
            if n % 2000 == 0:
                rate = n / max(time.perf_counter() - t0, 1e-6)
                print(f"  ... {pw} ({n}) @ {rate:.0f}/s")
        print(f"Birthday range exhausted ({n})")

    found = brute_digits_mp(
        kwargs,
        digits=args.digits,
        workers=args.workers,
        start=args.start,
        stop=args.stop,
    )
    if found is not None:
        # Double-check with pypdf when available.
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(pdf_path))
            ok = reader.decrypt(found)
            print(f"pypdf.decrypt confirm: {ok}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"(pypdf confirm skipped: {exc})", flush=True)
        return 0

    print("\nPassword not found in selected space.", flush=True)
    return 2


if __name__ == "__main__":
    # Windows needs freeze_support for multiprocessing spawn.
    mp.freeze_support()
    raise SystemExit(main())
