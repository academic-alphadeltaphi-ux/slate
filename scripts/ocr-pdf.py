#!/usr/bin/env python3
"""OCR a PDF with macOS's Vision framework, for pages whose embedded text layer is unusable.

    <venv>/bin/python scripts/ocr-pdf.py <file.pdf> [--dpi 400] [--pages 1,2,5-9]

Prints JSON: {"pages": [{"page": 1, "text": "..."}, ...], "engine": "vision", "dpi": 400}

Why Vision and not tesseract/Paddle/a cloud API: measured 2026-09-18 against the two pages of FCS298's Kunka
scan whose embedded text layer happens to be intact, Vision in *accurate* mode scores 0.974 character
similarity / 0.966 word recall on a normal text page. That is as good as a paid engine would do here, costs
nothing, needs no account, and no page ever leaves the Mac.

The one thing that matters: VNRequestTextRecognitionLevel is **Accurate = 0, Fast = 1**. Passing 1 because it
"looks like the higher setting" drops word accuracy from 0.892 to 0.521 and produces plausible-looking output
with systematic c->L and m->ni confusions — wrong in a way that reads as a bad scan rather than a bad call.
"""
import json, sys, os

try:
    import fitz, Vision, Quartz
    from Foundation import NSURL
except ImportError as e:
    print(json.dumps({"error": f"missing dependency: {e}. Run bin/install-ocr.sh"}), file=sys.stdout)
    sys.exit(1)

ACCURATE = 0


def gutter_fraction(page, dpi=100):
    """Where a two-page book spread actually folds: the darkest vertical band in the middle third.

    Usually within 1% of the geometric midpoint, so this buys little on a flatbed scan — but a spread
    photographed off-centre (FCS298 p8 folded at 0.427) would otherwise be cut through a column of text.
    """
    pm = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
    W, H, buf = pm.width, pm.height, pm.samples
    lo, hi = int(W * 0.35), int(W * 0.65)
    best, bx = None, W // 2
    for x in range(lo, hi):
        s = sum(buf[y * W + x] for y in range(0, H, 8))
        if best is None or s < best:
            best, bx = s, x
    return bx / W


def ocr_png(path):
    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None:
        return ""
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        return ""
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(ACCURATE)
    req.setUsesLanguageCorrection_(True)
    req.setRecognitionLanguages_(["en-US"])
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, _ = handler.performRequests_error_([req], None)
    if not ok:
        return ""
    out = []
    for obs in (req.results() or []):
        c = obs.topCandidates_(1)
        if c and len(c):
            out.append(c[0].string())
    return "\n".join(out)


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
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "usage: ocr-pdf.py <file.pdf> [--dpi N] [--pages 1,3-5]"}))
        return 1
    pdf = args[0]
    get = lambda k, d: (args[args.index(k) + 1] if k in args else d)
    dpi = int(get("--dpi", 400))
    doc = fitz.open(pdf)
    import tempfile
    pages = []
    with tempfile.TemporaryDirectory() as tmp:
        for i in parse_pages(get("--pages", None), doc.page_count):
            p = doc[i]
            r = p.rect
            # A landscape page in a book PDF is a two-page spread; OCR each leaf separately or Vision reads
            # straight across the gutter and interleaves two columns of unrelated prose.
            if r.width >= r.height * 0.75:
                cut = r.x0 + r.width * gutter_fraction(p)
                clips = [fitz.Rect(r.x0, r.y0, cut, r.y1), fitz.Rect(cut, r.y0, r.x1, r.y1)]
            else:
                clips = [r]
            chunks = []
            for j, clip in enumerate(clips):
                png = os.path.join(tmp, f"p{i}_{j}.png")
                p.get_pixmap(dpi=dpi, clip=clip, colorspace=fitz.csGRAY).save(png)
                chunks.append(ocr_png(png))
                os.remove(png)
            pages.append({"page": i + 1, "text": "\n".join(c for c in chunks if c).strip()})
    print(json.dumps({"pages": pages, "engine": "vision", "dpi": dpi}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
