#!/usr/bin/env python3
"""
High-Performance PDF Glyph-to-Unicode Reverse Decoder
Uses CMap Injection to let MuPDF's native C++ engine extract text at maximum speed.
"""

import sys
import io
import re
import unicodedata
import fitz  # PyMuPDF
from fontTools.ttLib import TTFont
from fontTools.agl import toUnicode

STANDARD_GLYPH_NAMES = {
    'space': ' ',
    'period': '.',
    'comma': ',',
    'colon': ':',
    'semicolon': ';',
    'slash': '/',
    'backslash': '\\',
    'hyphen': '-',
    'minus': '-',
    'underscore': '_',
    'plus': '+',
    'equal': '=',
    'asterisk': '*',
    'numbersign': '#',
    'percent': '%',
    'ampersand': '&',
    'at': '@',
    'exclam': '!',
    'question': '?',
    'parenleft': '(',
    'parenright': ')',
    'bracketleft': '[',
    'bracketright': ']',
    'braceleft': '{',
    'braceright': '}',
    'quotesingle': "'",
    'quotedbl': '"',
    'grave': '`',
    'asciitilde': '~',
    'asciicircum': '^',
    'less': '<',
    'greater': '>',
    'bar': '|',
    'zero': '0',
    'one': '1',
    'two': '2',
    'three': '3',
    'four': '4',
    'five': '5',
    'six': '6',
    'seven': '7',
    'eight': '8',
    'nine': '9',
}

# CJK Radical Supplement (2E80-2EF3) mapping to standard CJK ideographs
RADICAL_SUPPLEMENT_MAP = {
    0x2E81: '厂', 0x2E82: '乚', 0x2E83: '乙', 0x2E84: '卜', 0x2E85: '亻',
    0x2E86: '冂', 0x2E87: '勹', 0x2E88: '刀', 0x2E89: '刂', 0x2E8A: '卜',
    0x2E8B: '又', 0x2E8C: '小', 0x2E8D: '小', 0x2E8E: '尢', 0x2E8F: '尢',
    0x2E90: '尣', 0x2E91: '尢', 0x2E92: '巳', 0x2E93: '幺', 0x2E94: '彑',
    0x2E95: '彑', 0x2E96: '心', 0x2E97: '忄', 0x2E98: '手', 0x2E99: '号',
    0x2E9A: '扌', 0x2E9B: '攴', 0x2E9C: '攵', 0x2E9D: '文', 0x2E9E: '斗',
    0x2E9F: '斤', 0x2EA0: '民', 0x2EA1: '旡', 0x2EA2: '日', 0x2EA3: '曰',
    0x2EA4: '月', 0x2EA5: '木', 0x2EA6: '欠', 0x2EA7: '止', 0x2EA8: '歹',
    0x2EA9: '殳', 0x2EAA: '毋', 0x2EAB: '比', 0x2EAC: '毛', 0x2EAD: '氏',
    0x2EAE: '气', 0x2EAF: '水', 0x2EB0: '氵', 0x2EB1: '氺', 0x2EB2: '火',
    0x2EB3: '灬', 0x2EB4: '爪', 0x2EB5: '爫', 0x2EB6: '父', 0x2EB7: '爻',
    0x2EB8: '爿', 0x2EB9: '片', 0x2EBA: '牙', 0x2EBB: '牛', 0x2EBC: '牜',
    0x2EBD: '犬', 0x2EBE: '犭', 0x2EBF: '玄', 0x2EC0: '玉', 0x2EC1: '瓜',
    0x2EC2: '瓦', 0x2EC3: '甘', 0x2EC4: '生', 0x2EC5: '见', 0x2EC6: '田',
    0x2EC7: '疋', 0x2EC8: '疒', 0x2EC9: '癶', 0x2ECA: '白', 0x2ECB: '皮',
    0x2ECC: '皿', 0x2ECD: '目', 0x2ECE: '矛', 0x2ECF: '矢', 0x2ED0: '石',
    0x2ED1: '示', 0x2ED2: '礻', 0x2ED3: '禸', 0x2ED4: '禾', 0x2ED5: '穴',
    0x2ED6: '立', 0x2ED7: '竹', 0x2ED8: '米', 0x2ED9: '糸', 0x2EDA: '糹',
    0x2EDB: '缶', 0x2EDC: '网', 0x2EDD: '罒', 0x2EDE: '罓', 0x2EDF: '羊',
    0x2EE0: '民', 0x2EE1: '羽', 0x2EE2: '老', 0x2EE3: '而', 0x2EE4: '耒',
    0x2EE5: '耳', 0x2EE6: '聿', 0x2EE7: '肉', 0x2EE8: '臣', 0x2EE9: '自',
    0x2EEA: '至', 0x2EEB: '臼', 0x2EEC: '舌', 0x2EED: '舛', 0x2EEE: '舟',
    0x2EEF: '艮', 0x2EF0: '色', 0x2EF1: '艸', 0x2EF2: '艹', 0x2EF3: '虍',
}

def clean_cjk(s):
    if not s:
        return ''
    # 1. NFKC normalizes Kangxi radicals (2F00-2FD5), fullwidth characters, compatibility forms
    s = unicodedata.normalize('NFKC', s)
    # 2. Map CJK radical supplements (2E80-2EF3)
    chars = [RADICAL_SUPPLEMENT_MAP.get(ord(c), c) for c in s]
    return ''.join(chars)

def generate_cmap_stream(gid_to_char):
    lines = [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo <<',
        '  /Registry (Adobe)',
        '  /Ordering (UCS)',
        '  /Supplement 0',
        '>> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000><FFFF>',
        'endcodespacerange',
    ]

    entries = []
    for gid, ch in gid_to_char.items():
        utf16_hex = ''.join(f'{ord(c):04X}' for c in ch)
        entries.append(f'<{gid:04X}> <{utf16_hex}>')

    chunk_size = 100
    for i in range(0, len(entries), chunk_size):
        chunk = entries[i:i + chunk_size]
        lines.append(f'{len(chunk)} beginbfchar')
        lines.extend(chunk)
        lines.append('endbfchar')

    lines.extend([
        'endcmap',
        'CMapName currentdict /CMap defineresource pop',
        'end',
        'end'
    ])
    return '\n'.join(lines).encode('utf-8')

def decode_pdf(file_path, password=None):
    doc = fitz.open(file_path)
    if doc.is_encrypted:
        if password:
            doc.authenticate(password)
        else:
            doc.authenticate('')

    # Step 1: Scan unique fonts from the first few pages (avoid scanning all 100+ pages repeatedly)
    seen_font_xrefs = set()
    patched_any_cmap = False

    sample_pages = doc[:min(5, len(doc))]
    for page in sample_pages:
        for f_info in page.get_fonts():
            font_xref = f_info[0]
            if font_xref in seen_font_xrefs:
                continue
            seen_font_xrefs.add(font_xref)

            try:
                font_obj = doc.xref_object(font_xref)
                m = re.search(r'/ToUnicode\s+(\d+)\s+0\s+R', font_obj)
                if not m:
                    continue
                tounicode_xref = int(m.group(1))

                name, ext, subtype, font_buffer = doc.extract_font(font_xref)
                if not font_buffer:
                    continue

                fb = bytearray(font_buffer)
                post_idx = fb.find(b'post')
                if post_idx != -1 and post_idx + 12 <= len(fb):
                    post_offset = int.from_bytes(fb[post_idx + 8:post_idx + 12], 'big')
                    if post_offset + 4 <= len(fb) and fb[post_offset:post_offset + 4] == b'\x00\x00\x03\x00':
                        fb[post_offset:post_offset + 4] = b'\x00\x03\x00\x00'

                tt = TTFont(io.BytesIO(fb))
                glyph_order = tt.getGlyphOrder()
                gid_to_char = {}

                for gid, gname in enumerate(glyph_order):
                    if gname.startswith('uni') and len(gname) == 7:
                        try:
                            gid_to_char[gid] = chr(int(gname[3:], 16))
                            continue
                        except Exception:
                            pass

                    if gname.startswith('u') and len(gname) in (5, 6):
                        try:
                            gid_to_char[gid] = chr(int(gname[1:], 16))
                            continue
                        except Exception:
                            pass

                    u_str = toUnicode(gname)
                    if u_str:
                        gid_to_char[gid] = u_str
                        continue

                    if gname in STANDARD_GLYPH_NAMES:
                        gid_to_char[gid] = STANDARD_GLYPH_NAMES[gname]
                        continue

                if gid_to_char:
                    cmap_bytes = generate_cmap_stream(gid_to_char)
                    doc.update_stream(tounicode_xref, cmap_bytes)
                    patched_any_cmap = True
            except Exception:
                continue

    # Step 2: If CMap was injected, reload from memory buffer so MuPDF's C++ engine applies it natively
    if patched_any_cmap:
        pdf_bytes = doc.tobytes()
        doc = fitz.open('pdf', pdf_bytes)

    # Step 3: Fast native C++ text extraction
    pages_text = [page.get_text('text') for page in doc]
    raw_text = '\n\n'.join(pages_text)

    return clean_cjk(raw_text)

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: decode-pdf-glyphs.py <pdf_path> [password]\n")
        sys.exit(1)

    pdf_path = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        text = decode_pdf(pdf_path, password)
        sys.stdout.buffer.write(text.encode('utf-8'))
    except Exception as e:
        sys.stderr.write(f"Error decoding PDF glyphs: {e}\n")
        sys.exit(2)

if __name__ == '__main__':
    main()
