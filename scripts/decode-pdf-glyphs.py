#!/usr/bin/env python3
"""
PDF Glyph-to-Unicode Reverse Decoder
Used as a fallback extractor when PDF /ToUnicode CMap is missing, corrupt, or empty.
"""

import sys
import io
import json
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
    # 1. NFKC normalizes Kangxi radicals (2F00-2FD5), fullwidth chars, compatibility ideographs
    s = unicodedata.normalize('NFKC', s)
    # 2. Map CJK radical supplements (2E80-2EF3)
    chars = [RADICAL_SUPPLEMENT_MAP.get(ord(c), c) for c in s]
    return ''.join(chars)

def build_font_glyph_map(doc):
    fonts_map = {}
    for page in doc:
        for f_info in page.get_fonts():
            xref = f_info[0]
            font_name = f_info[3]
            if font_name in fonts_map:
                continue

            try:
                name, ext, subtype, font_buffer = doc.extract_font(xref)
                if not font_buffer:
                    continue

                fb = bytearray(font_buffer)
                # Fix corrupt post table header if byte order is inverted (0x00000300 -> 0x00030000)
                post_idx = fb.find(b'post')
                if post_idx != -1 and post_idx + 12 <= len(fb):
                    post_offset = int.from_bytes(fb[post_idx+8:post_idx+12], 'big')
                    if post_offset + 4 <= len(fb) and fb[post_offset:post_offset+4] == b'\x00\x00\x03\x00':
                        fb[post_offset:post_offset+4] = b'\x00\x03\x00\x00'

                tt = TTFont(io.BytesIO(fb))
                glyph_order = tt.getGlyphOrder()
                gid_to_char = {}

                for gid, gname in enumerate(glyph_order):
                    # 1. uniXXXX format (e.g. uni7F16 -> 编)
                    if gname.startswith('uni') and len(gname) == 7:
                        try:
                            gid_to_char[gid] = chr(int(gname[3:], 16))
                            continue
                        except Exception:
                            pass

                    # 2. uXXXX / uXXXXX format
                    if gname.startswith('u') and (len(gname) == 5 or len(gname) == 6):
                        try:
                            gid_to_char[gid] = chr(int(gname[1:], 16))
                            continue
                        except Exception:
                            pass

                    # 3. Standard Adobe Glyph List
                    u_str = toUnicode(gname)
                    if u_str:
                        gid_to_char[gid] = u_str
                        continue

                    # 4. Fallback lookup from common symbols
                    if gname in STANDARD_GLYPH_NAMES:
                        gid_to_char[gid] = STANDARD_GLYPH_NAMES[gname]
                        continue

                fonts_map[font_name] = gid_to_char
            except Exception:
                # If font extraction or parsing fails for a specific font, skip it
                continue

    return fonts_map

def decode_pdf(file_path, password=None):
    doc = fitz.open(file_path)
    if doc.is_encrypted:
        if password:
            doc.authenticate(password)
        else:
            # Try empty password
            doc.authenticate('')

    fonts_map = build_font_glyph_map(doc)

    all_pages_text = []
    for page in doc:
        raw_json = page.get_text('rawjson')
        raw = json.loads(raw_json)
        page_lines = []
        for b in raw.get('blocks', []):
            for line in b.get('lines', []):
                line_text = ''
                for span in line.get('spans', []):
                    font = span.get('font', '')
                    # Find matching font map
                    fmap = next((v for k, v in fonts_map.items() if font in k or k in font), None)
                    for c in span.get('chars', []):
                        ch = c.get('c', '')
                        gid = ord(ch) if ch else 0
                        if fmap and gid in fmap:
                            line_text += fmap[gid]
                        else:
                            line_text += ch
                page_lines.append(line_text)
        all_pages_text.append('\n'.join(page_lines))

    raw_text = '\n\n'.join(all_pages_text)
    return clean_cjk(raw_text)

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: decode-pdf-glyphs.py <pdf_path> [password]\n")
        sys.exit(1)

    pdf_path = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        text = decode_pdf(pdf_path, password)
        # Ensure utf-8 output to stdout
        sys.stdout.buffer.write(text.encode('utf-8'))
    except Exception as e:
        sys.stderr.write(f"Error decoding PDF glyphs: {e}\n")
        sys.exit(2)

if __name__ == '__main__':
    main()
