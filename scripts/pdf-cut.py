#!/usr/bin/env python3
"""The textbook that is one PDF (SPEC §20.68): read its outline, copy a set of its pages out.

    <python> scripts/pdf-cut.py toc <book.pdf>
        → {"pages": N, "toc": [[level, title, page], ...], "labels": ["i", "ii", "1", "2", ... | null]}
          The outline as the PDF carries it (page 1-based), and each page's own label when the file has them —
          the book's printed numbers, which the index uses so that a cut says "pp. 61–75" like the book does.

    <python> scripts/pdf-cut.py cut <book.pdf> <out.pdf> --ranges 61-75,120-124 [--title T] [--subtitle S] [--book B] [--note N]
        → {"pages": N}
          The pages named (1-based, inclusive), in order, behind one cover page carrying the title block — the
          same block the printed MindTap cut opens with — so the page in slate says what it is and which week it
          is for. Links inside the copied pages are kept; nothing is re-rendered, so the text layer and every
          figure are the book's own.

Runs on the same interpreter as the OCR (bin/install-ocr.sh puts PyMuPDF in ~/.local/share/slate/venv); the
system python3 with PyMuPDF does as well. No network, nothing leaves the Mac.
"""
import json
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError as e:  # pragma: no cover
    print(json.dumps({"error": f"missing dependency: {e}. Run bin/install-ocr.sh"}))
    sys.exit(1)


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def labels_of(doc):
    out = []
    any_label = False
    for page in doc:
        try:
            lab = page.get_label()
        except Exception:
            lab = ""
        lab = (lab or "").strip()
        any_label = any_label or bool(lab)
        out.append(lab or None)
    return out if any_label else None


def cmd_toc(src):
    doc = fitz.open(src)
    toc = [[int(lvl), str(title), int(page)] for lvl, title, page in doc.get_toc(simple=True)]
    print(json.dumps({"pages": doc.page_count, "toc": toc, "labels": labels_of(doc)}))


def parse_ranges(text, page_count):
    out = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        a, _, b = part.partition("-")
        lo = int(a)
        hi = int(b) if b else lo
        lo, hi = max(1, min(lo, hi)), min(page_count, max(lo, hi))
        if lo <= hi:
            out.append((lo, hi))
    return out


# The house serif for the cover: Georgia, as the printed MindTap chapters use, from the Mac's own font files; the
# base-14 Times that PyMuPDF carries has no en dash or curly apostrophe and prints a "?" for each. Without Georgia,
# Times with those characters replaced.
GEORGIA = next((f for f in ("/System/Library/Fonts/Supplemental/Georgia.ttf", "/Library/Fonts/Georgia.ttf", os.path.expanduser("~/Library/Fonts/Georgia.ttf")) if os.path.exists(f)), None)
GEORGIA_ITALIC = next((f for f in ("/System/Library/Fonts/Supplemental/Georgia Italic.ttf", "/Library/Fonts/Georgia Italic.ttf") if os.path.exists(f)), None)


def plain(text):
    return (text or "").replace("\u2013", "-").replace("\u2014", "-").replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')


def cover(out, title, subtitle, book, note, width, height):
    page = out.new_page(width=width, height=height)
    x, y = 54, 72
    ink, dim = (0.08, 0.07, 0.06), (0.42, 0.35, 0.27)
    if GEORGIA:
        page.insert_font(fontname="serif", fontfile=GEORGIA)
        page.insert_font(fontname="serifit", fontfile=GEORGIA_ITALIC or GEORGIA)
        roman, italic, fix = "serif", "serifit", (lambda t: t or "")
    else:
        roman, italic, fix = "Times-Roman", "Times-Italic", plain
    if book:
        page.insert_text((x, y), fix(book).upper(), fontname=roman, fontsize=8.5, color=dim)
        y += 22
    rect = fitz.Rect(x, y, width - x, y + 120)
    used = page.insert_textbox(rect, fix(title), fontname=roman, fontsize=22, color=ink, align=0)
    y = rect.y1 - max(used, 0) + 8 if used >= 0 else rect.y1 + 8
    if subtitle:
        rect = fitz.Rect(x, y, width - x, y + 60)
        used = page.insert_textbox(rect, fix(subtitle), fontname=roman, fontsize=10, color=dim, align=0)
        y = rect.y1 - max(used, 0) + 6 if used >= 0 else rect.y1 + 6
    page.draw_line((x, y), (width - x, y), color=ink, width=1.2)
    y += 16
    if note:
        rect = fitz.Rect(x, y, width - x, y + 80)
        page.insert_textbox(rect, fix(note), fontname=italic, fontsize=9, color=dim, align=0)


def cmd_cut(src, dst):
    doc = fitz.open(src)
    ranges = parse_ranges(arg("--ranges", ""), doc.page_count)
    if not ranges:
        print(json.dumps({"error": "no pages to cut (--ranges 61-75,120-124)"}))
        sys.exit(2)
    out = fitz.open()
    first = doc[ranges[0][0] - 1].rect
    cover(out, arg("--title", ""), arg("--subtitle", ""), arg("--book", ""), arg("--note", ""), first.width, first.height)
    for lo, hi in ranges:
        out.insert_pdf(doc, from_page=lo - 1, to_page=hi - 1, links=True, annots=True)
    out.set_metadata({"title": arg("--title", ""), "subject": arg("--subtitle", ""), "producer": "slate"})
    out.save(dst, garbage=3, deflate=True)
    print(json.dumps({"pages": out.page_count}))


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("toc", "cut"):
        print(json.dumps({"error": __doc__.strip().split("\n")[0]}))
        sys.exit(2)
    if sys.argv[1] == "toc":
        cmd_toc(sys.argv[2])
    else:
        if len(sys.argv) < 4:
            print(json.dumps({"error": "cut needs <book.pdf> <out.pdf>"}))
            sys.exit(2)
        cmd_cut(sys.argv[2], sys.argv[3])
