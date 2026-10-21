#!/usr/bin/env python3
"""Cut one problem, and its solution when the same file has one, out of a PDF (SPEC §20.73).

    <venv>/bin/python scripts/problem-crop.py locate <file.pdf> --n 3[,4,…] [--after Problems] [--scheme auto|paren|dot|q|word]
    <venv>/bin/python scripts/problem-crop.py render <out.png> --part "<file.pdf>@<page>:<x0>,<y0>,<x1>,<y1>" [--part …] [--zoom 2]
    <venv>/bin/python scripts/problem-crop.py lines <file.pdf> [--pages 1,3-5]

`locate` prints JSON: {"scheme", "found": [1, 2, …], "anchor": bool|null, "ocr": [pages read by Vision], "items": {"3":
{"question": [{"page", "rect": [x0, y0, x1, y1]}], "solution": [...] | null} or {"error": "..."}}} — one read of the
file for every number asked; a file that cannot be read at all is {"error": "..."} and exit 1.
`render` stacks the parts top to bottom on one sheet (a hairline where a page breaks) and writes a PNG at `--zoom`
(2 = two pixels per point, sharp on a retina screen); it prints {"out", "width", "height"} in pixels.

How a problem is found. The page's rows of text — PyMuPDF's text layer, or Apple Vision's reading of the page image
when the page has no text (a screenshot PDF) — are put in reading order, and running heads, footers and bare page
numbers are set aside. A question starts at a row that begins with its number in the file's own style: `3)` (ECO206's
sets), `3.` (Williamson's end-of-chapter problems), `Q3` / `Question 3` (ECO227's reviews), `Problem 3`. The style is
the one whose numbers run 1, 2, 3 … longest after the anchor (`--after Problems`: the last row that says exactly that,
so the chapter's own Problems section and not a mention of the word). It ends where the next number starts, at a
heading that closes the section, or at the end of the file. A row starting `Solution` or `Answer` inside it splits it
into the question and its solution. The rectangle on each page runs from that start to the next start (so a figure
drawn between two lines of text is inside it) across the text column of the whole file.
"""
import json, os, re, sys, tempfile

try:
    import fitz
except ImportError as e:
    print(json.dumps({"error": f"missing dependency: {e}. Run bin/install-ocr.sh"}))
    sys.exit(1)

ACCURATE = 0          # VNRequestTextRecognitionLevel: Accurate = 0, Fast = 1 (scripts/ocr-pdf.py says why it matters)
SCHEMES = {
    "paren": re.compile(r"^(\d{1,2})\)\s*\S"),
    "dot": re.compile(r"^(\d{1,2})\.\s+\S"),
    "q": re.compile(r"^(?:[•·\-–]\s*)?(?:Q|Question)\s*(\d{1,2})\b", re.I),
    "word": re.compile(r"^(?:Problem|Exercise)\s+(\d{1,2})\b", re.I),
}
SOLUTION = re.compile(r"^(?:[•·\-–]\s*)?(?:Solutions?|Answers?)\s*(?::|\.|$)", re.I)
# What closes an end-of-chapter problems section in the books slate holds.
TERMINATORS = re.compile(r"^(?:Working with the Data|Questions for Review|Chapter Summary|Key Terms|Notes|References|Appendix\b.*|Supplementary Exercises)$", re.I)
# What follows the last question of a handout and is not part of it: the author's closing note, an appendix table or figure.
AFTER_LAST = re.compile(r"^(?:Drafted with the help of\b|(?:Table|Figure|Exhibit) [A-Z]?\d+[.:]?\s)", re.I)
FOOTER = re.compile(r"\b\d+ of \d+\b")
CAPS_HEAD = re.compile(r"^[A-Z][A-Z &\-]{2,30}$")        # STANDARD, CHALLENGE — a set's own section heads
PAGE_NO = re.compile(r"^(?:\d{1,4}|page \d+|\d+ of \d+)$", re.I)


# ---- rows of text ------------------------------------------------------------------------------------------------
def layer_rows(page):
    d = page.get_text("dict")
    pieces = []
    for b in d["blocks"]:
        if b.get("type") != 0:
            continue
        for l in b["lines"]:
            t = "".join(s["text"] for s in l["spans"]).strip()
            if t:
                pieces.append((t, fitz.Rect(l["bbox"])))
    return pieces


def vision_rows(page, dpi=300):
    import Vision, Quartz
    from Foundation import NSURL
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "p.png")
        page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY).save(png)
        src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(png), None)
        cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None) if src else None
        if cg is None:
            return []
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(ACCURATE)
        req.setUsesLanguageCorrection_(True)
        req.setRecognitionLanguages_(["en-US"])
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
        ok, _ = handler.performRequests_error_([req], None)
        if not ok:
            return []
        W, H = page.rect.width, page.rect.height
        out = []
        for obs in (req.results() or []):
            c = obs.topCandidates_(1)
            if not c or not len(c):
                continue
            bb = obs.boundingBox()          # normalised, origin bottom-left
            x, y, w, h = bb.origin.x, bb.origin.y, bb.size.width, bb.size.height
            out.append((c[0].string().strip(), fitz.Rect(x * W, (1 - y - h) * H, (x + w) * W, (1 - y) * H)))
        return out


def merge_rows(pieces):
    """PyMuPDF splits a visual line into pieces (`3)` and its text are often two); join pieces whose middles share a line."""
    pieces = sorted(pieces, key=lambda p: (p[1].y0, p[1].x0))
    rows = []
    for t, r in pieces:
        mid = (r.y0 + r.y1) / 2
        for row in rows[-4:]:
            rr = row["rect"]
            if rr.y0 - 1 <= mid <= rr.y1 + 1 and abs(((rr.y0 + rr.y1) / 2) - mid) < max(3, 0.45 * (rr.y1 - rr.y0)):
                row["parts"].append((t, r))
                row["rect"] = rr | r
                break
        else:
            rows.append({"parts": [(t, r)], "rect": fitz.Rect(r)})
    out = []
    for row in rows:
        parts = sorted(row["parts"], key=lambda p: p[1].x0)
        out.append({"text": " ".join(p[0] for p in parts).strip(), "rect": row["rect"]})
    out.sort(key=lambda r: (r["rect"].y0, r["rect"].x0))
    return out


def read_rows(doc, pages=None):
    """[(page_no, rows)] with each row {"text", "rect", "page", "ocr"}; pages with no usable text layer are read by Vision."""
    ocr = []
    out = []
    for i in (pages if pages is not None else range(doc.page_count)):
        page = doc[i]
        pieces = layer_rows(page)
        read = False
        if sum(len(t) for t, _ in pieces) < 40:
            try:
                pieces = vision_rows(page)
                ocr.append(i + 1)
                read = True
            except Exception:
                pieces = []
        rows = merge_rows(pieces)
        for r in rows:
            r["page"] = i + 1
            r["ocr"] = read
        out.append((i + 1, rows))
    return out, ocr


def mark_noise(pages_rows, doc):
    """Running heads, footers and bare page numbers: never a start, never content."""
    seen = {}
    for pno, rows in pages_rows:
        H = doc[pno - 1].rect.height
        for r in rows:
            band = r["rect"].y1 < H * 0.08 or r["rect"].y0 > H * 0.92
            key = re.sub(r"\d+", "#", r["text"].lower())
            r["band"] = band
            if band:
                seen.setdefault(key, set()).add(pno)
            r["key"] = key
    for pno, rows in pages_rows:
        for r in rows:
            # A one-page handout has nothing to repeat: its `202609 · 1 of 1 · Tutorial 1` foot is still a foot.
            r["noise"] = bool(PAGE_NO.match(r["text"].strip())) or (r["band"] and (len(seen.get(r["key"], ())) >= 2 or bool(FOOTER.search(r["text"]))))


# ---- finding the question ----------------------------------------------------------------------------------------
LEAD = re.compile(r"^[^\w(]+")       # a bullet, or a slide font's private-use glyph, before the number


def marker(scheme, row, left):
    if row["noise"] or row["rect"].x0 > left + 40:
        return None
    m = SCHEMES[scheme].match(LEAD.sub("", row["text"]))
    return int(m.group(1)) if m else None


def run_of(scheme, rows, lefts):
    """The longest 1, 2, 3 … run of this scheme's numbers, allowing one number the reading missed."""
    found, expect = [], 1
    for idx, r in enumerate(rows):
        n = marker(scheme, r, lefts[r["page"]])
        if n is None:
            continue
        if n == expect or (found and n == expect + 1):
            found.append((n, idx))
            expect = n + 1
        elif n == 1 and not found:
            found.append((1, idx)); expect = 2
    return found


def anchor_page(pdf, after):
    """The last page whose text (slate's `<file>.pdf.txt`, written when the PDF was filed) has a line saying `after`."""
    try:
        txt = open(pdf + ".txt", encoding="utf-8").read()
    except OSError:
        return None
    page, last = None, None
    for line in txt.splitlines():
        m = re.match(r"^\[page (\d+)\]$", line.strip())
        if m:
            page = int(m.group(1))
        elif page and line.strip().lower() == after.strip().lower():
            last = page
    return last


def locate(pdf, ns, after=None, scheme="auto"):
    doc = fitz.open(pdf)
    first = anchor_page(pdf, after) if after else None
    pages_rows, ocr = read_rows(doc, range(first - 1, doc.page_count) if first else None)
    mark_noise(pages_rows, doc)
    rows = [r for _, rs in pages_rows for r in rs]
    lefts = {}
    for pno, rs in pages_rows:
        xs = sorted(r["rect"].x0 for r in rs if not r["noise"])
        lefts[pno] = xs[min(len(xs) - 1, max(0, len(xs) // 20))] if xs else 0     # the margin, not a stray fragment at 0
    start = 0
    anchored = None
    if after:
        hits = [i for i, r in enumerate(rows) if r["text"].strip().lower() == after.strip().lower()]
        anchored = bool(hits)
        if hits:
            start = hits[-1] + 1
    body = rows[start:]
    schemes = [scheme] if scheme != "auto" else list(SCHEMES)
    best = max(((s, run_of(s, body, lefts)) for s in schemes), key=lambda x: len(x[1]))
    name, run = best
    nums = [k for k, _ in run]
    col = column(rows, doc)
    items = {}
    for n in ns:
        items[str(n)] = one(body, run, n, doc, col, name, nums)
    return {"scheme": name, "found": nums, "anchor": anchored, "ocr": ocr, "items": items}


def one(body, run, n, doc, col, name, nums):
    hit = [i for k, i in run if str(k) == str(n)]
    if not hit:
        return {"error": f"question {n} not found ({name} numbering found {nums[:30]})"}
    s = hit[0]
    later = [i for k, i in run if i > s]
    end = later[0] if later else None
    if end is None:                                         # the last one: up to a closing heading or note, else the end
        for j in range(s + 1, len(body)):
            t = LEAD.sub("", body[j]["text"].strip())
            if not body[j]["noise"] and (TERMINATORS.match(t) or AFTER_LAST.match(t)):
                end = j
                break
    if end is None:
        end = len(body)
    # A set's own section head just before the next question belongs to neither.
    while end - 1 > s and (body[end - 1]["noise"] or CAPS_HEAD.match(body[end - 1]["text"].strip())):
        end -= 1
    split = None
    for j in range(s + 1, end):
        if not body[j]["noise"] and SOLUTION.match(LEAD.sub("", body[j]["text"].strip())):
            split = j
            break
    nxt = body[end] if end < len(body) else None
    last = not later                                        # nothing numbered after it: a rule below it closes it
    q = rects(body, s, split if split is not None else end, doc, col, end_row=body[split] if split is not None else nxt, rule_ends=last and split is None)
    sol = rects(body, split, end, doc, col, end_row=nxt) if split is not None else None
    words = lambda a, b: "\n".join(r["text"] for r in body[a:b] if not r["noise"])
    return {"n": str(n), "question": q, "solution": sol, "text": words(s, split if split is not None else end),
            "solutionText": words(split, end) if split is not None else None}


def column(rows, doc):
    xs0 = sorted(r["rect"].x0 for r in rows if not r["noise"])
    xs1 = sorted(r["rect"].x1 for r in rows if not r["noise"])
    if not xs0:
        return (0, doc[0].rect.width)
    lo = xs0[max(0, len(xs0) // 50)]
    hi = xs1[min(len(xs1) - 1, len(xs1) - 1 - len(xs1) // 50)]
    return (lo, hi)


def rule_below(page, y, bottom):
    """The top of the first rule across most of the page between y and bottom, or None."""
    W = page.rect.width
    try:
        ys = [d["rect"].y0 for d in page.get_drawings() if d.get("rect") is not None and d["rect"].height < 2.5 and d["rect"].width > 0.6 * W and y < d["rect"].y0 < bottom]
    except Exception:
        return None
    return min(ys) if ys else None


def line_top(body, row):
    """The top of everything on a row's line: a fraction's numerator or a superscript is a text row of its own, just above."""
    tops = [r["rect"].y0 for r in body if r["page"] == row["page"] and r["rect"].y1 > row["rect"].y0 + 1 and r["rect"].y0 < row["rect"].y1 - 1]
    return min(tops + [row["rect"].y0])


def rects(body, a, b, doc, col, end_row=None, rule_ends=False):
    """The page rectangles holding rows [a, b): from the first row's top to the next start (or the page's content end)."""
    content = [r for r in body[a:b] if not r["noise"]]
    if end_row is not None:     # the next start's own line (its fraction's numerator sorts before it) is not ours
        e = end_row["rect"]
        content = [r for r in content if not (r["page"] == end_row["page"] and r["rect"].y1 > e.y0 + 1 and r["rect"].y0 < e.y1 - 1)]
    if not content:
        return []
    out = []
    pages = sorted({r["page"] for r in content})
    for pno in pages:
        page = doc[pno - 1]
        W, H = page.rect.width, page.rect.height
        on = [r for r in content if r["page"] == pno]
        first, last = on[0]["rect"], on[-1]["rect"]
        # On a page the problem only continues onto, everything above its first row is a running head or nothing, so the
        # rectangle starts under the head: a figure drawn before the first line of text stays in.
        above = [r["rect"].y1 for r in body if r["page"] == pno and r["noise"] and r["rect"].y1 <= first.y0 + 1]
        below = [r["rect"].y0 for r in body if r["page"] == pno and r["noise"] and r["rect"].y0 >= last.y1 - 1]
        top = line_top(body, on[0]) - 6 if pno == pages[0] else (max(above) + 4 if above else 8)
        if end_row is not None and end_row["page"] == pno:
            bottom = line_top(body, end_row) - 4
        elif pno != pages[-1] or (end_row is not None and end_row["page"] > pno):
            bottom = min(below) - 4 if below else H - 8
        else:
            bottom = last.y1 + 6
        bottom = max(bottom, last.y1 + 2)
        # The last question of a handout: the rule drawn under it, before an appendix table or the author's note, ends it.
        if rule_ends and pno == pages[-1] and not on[0].get("ocr"):
            r = rule_below(page, last.y1, bottom)
            if r is not None:
                bottom = r - 4
        x0, x1 = max(0, col[0] - 16), min(W, col[1] + 8)
        top, bottom = max(0, top), min(H, bottom)
        if not on[0].get("ocr"):
            top, bottom = trim(page, fitz.Rect(x0, top, x1, bottom), on, top, bottom)
        if bottom - top >= 6:
            out.append({"page": pno, "rect": [round(x0, 1), round(top, 1), round(x1, 1), round(bottom, 1)]})
    return out


def trim(page, box, on, top, bottom):
    """Close the rectangle on what is drawn in it: text, figures, pictures — not the page's rules or empty paper.

    A rule across most of the page is a running head's or a footer's line and is left out; whitespace above and below
    the problem goes. Only for pages with a text layer: a screenshot is one picture, so there it is the rows that count."""
    W = page.rect.width
    ys = [(r["rect"].y0, r["rect"].y1) for r in on]
    try:
        for d in page.get_drawings():
            r = d.get("rect")
            if r is None or not r.intersects(box):
                continue
            if r.height < 2.5 and r.width > 0.6 * W:
                continue
            ys.append((max(r.y0, box.y0), min(r.y1, box.y1)))
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"])
            if r.intersects(box) and r.width < 0.9 * W:
                ys.append((max(r.y0, box.y0), min(r.y1, box.y1)))
    except Exception:
        pass
    if not ys:
        return top, bottom
    return max(top, min(y0 for y0, _ in ys) - 6), min(bottom, max(y1 for _, y1 in ys) + 6)


# ---- the picture -------------------------------------------------------------------------------------------------
def render(out, parts, zoom=2.0, gap=10):
    docs = {}
    clips = []
    for spec in parts:
        m = re.match(r"^(.*)@(\d+):([\d.]+),([\d.]+),([\d.]+),([\d.]+)$", spec)
        if not m:
            raise ValueError(f"bad --part {spec!r}: want <file.pdf>@<page>:<x0>,<y0>,<x1>,<y1>")
        pdf, pno = m.group(1), int(m.group(2))
        doc = docs.setdefault(pdf, fitz.open(pdf))
        r = fitz.Rect(*(float(m.group(k)) for k in range(3, 7))) & doc[pno - 1].rect
        clips.append((doc, pno - 1, r))
    W = max(r.width for _, _, r in clips)
    H = sum(r.height for _, _, r in clips) + gap * (len(clips) - 1)
    sheet = fitz.open()
    pg = sheet.new_page(width=W, height=H)
    y = 0
    for k, (doc, i, r) in enumerate(clips):
        if k:
            pg.draw_line(fitz.Point(W * 0.04, y - gap / 2), fitz.Point(W * 0.96, y - gap / 2), color=(0.82, 0.82, 0.82), width=0.6)
        pg.show_pdf_page(fitz.Rect(0, y, r.width, y + r.height), doc, i, clip=r)
        y += r.height + gap
    pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    pix.save(out)
    return {"out": out, "width": pix.width, "height": pix.height}


def parse_pages(spec, n):
    if not spec:
        return list(range(n))
    want = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            want.update(range(int(a) - 1, int(b)))
        elif part:
            want.add(int(part) - 1)
    return sorted(i for i in want if 0 <= i < n)


def main():
    a = sys.argv[1:]
    get = lambda k, d=None: (a[a.index(k) + 1] if k in a else d)
    if len(a) < 2:
        print(json.dumps({"error": __doc__.strip().splitlines()[2].strip()}))
        return 1
    cmd = a[0]
    try:
        if cmd == "locate":
            ns = [x.strip() for x in str(get("--n", "")).split(",") if x.strip()]
            if not ns:
                raise ValueError("locate needs --n <number>[,<number>…]")
            r = locate(a[1], ns, after=get("--after"), scheme=get("--scheme", "auto"))
        elif cmd == "render":
            parts = [a[i + 1] for i, x in enumerate(a) if x == "--part"]
            if not parts:
                raise ValueError("render needs at least one --part")
            r = render(a[1], parts, zoom=float(get("--zoom", 2)))
        elif cmd == "lines":
            doc = fitz.open(a[1])
            pages_rows, ocr = read_rows(doc, parse_pages(get("--pages"), doc.page_count))
            mark_noise(pages_rows, doc)
            r = {"ocr": ocr, "pages": [{"page": p, "rows": [{"text": x["text"], "rect": [round(v, 1) for v in x["rect"]], "noise": x["noise"]} for x in rows]} for p, rows in pages_rows]}
        else:
            raise ValueError(f"unknown command {cmd!r}")
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
    print(json.dumps(r))
    return 1 if "error" in r else 0


if __name__ == "__main__":
    sys.exit(main())
