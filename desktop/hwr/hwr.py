#!/usr/bin/env python3
"""hwr.py — the no-compiler fallback for slate's handwriting recognition (SPEC §20.9).

The same Apple Vision calls as hwr.swift, through PyObjC, run by
  uv run --python 3.12 --with pyobjc-framework-Vision --with pyobjc-framework-Quartz desktop/hwr/hwr.py
Same flags (--probe, --scale, --lang, --no-correction, --fast, --dump), same JSON in and out, same exit codes
(0 ok · 2 bad input or argument · 3 Vision unavailable or failed); `engine.via` is "pyobjc" so a reply says
which runner answered. Never installed into the system Python: uv fetches the wheels into ~/.cache/uv once.
"""
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def fail(code, msg):
    emit({'ok': False, 'error': msg})
    sys.stderr.write(msg + '\n')
    sys.exit(code)


# ---- arguments (the same parser as hwr.swift) ---------------------------------------------------------
args = sys.argv[1:]
scale, langs, correction, fast, probe, dump = 3.0, ['en-US', 'fr-FR'], True, False, False, None
while args:
    a = args.pop(0)
    if a == '--scale':
        try:
            scale = float(args.pop(0)) if args else 3.0
        except ValueError:
            scale = 3.0
    elif a == '--lang':
        langs = [s.strip() for s in (args.pop(0) if args else '').split(',') if s.strip()]
    elif a == '--no-correction':
        correction = False
    elif a == '--fast':
        fast = True
    elif a == '--probe':
        probe = True
    elif a == '--dump':
        dump = args.pop(0) if args else None
    else:
        fail(2, 'unknown argument %s' % a)
if scale <= 0:
    fail(2, '--scale must be positive')

try:
    import Quartz as Q
    import Vision as V
    from Foundation import NSURL
except Exception as e:  # pragma: no cover - only without the wheels
    fail(3, 'PyObjC Vision/Quartz not importable: %s' % e)


def r1(v):
    return round(v * 10) / 10


# ---- the request ---------------------------------------------------------------------------------------
req = V.VNRecognizeTextRequest.alloc().init()
req.setRecognitionLevel_(V.VNRequestTextRecognitionLevelFast if fast else V.VNRequestTextRecognitionLevelAccurate)
req.setUsesLanguageCorrection_(correction)
supported, err = req.supportedRecognitionLanguagesAndReturnError_(None)
supported = [str(s) for s in (supported or [])]
usable = [l for l in langs if l in supported]
if not usable:
    fail(3, 'none of %s is supported; Vision offers %s' % (langs, supported))
req.setRecognitionLanguages_(usable)
engine = {'name': 'vision', 'revision': int(req.revision()), 'languages': usable, 'level': 'fast' if fast else 'accurate', 'correction': correction, 'via': 'pyobjc'}
if probe:
    emit({'ok': True, 'engine': engine, 'supported': supported})
    sys.exit(0)

# ---- input ---------------------------------------------------------------------------------------------
try:
    root = json.load(sys.stdin)
except Exception:
    root = None
if not isinstance(root, dict) or not isinstance(root.get('items'), list):
    fail(2, 'stdin must be JSON { items: [...] }')

PAD = 24.0
out_items = []
for item in root['items']:
    t0 = time.time()
    id_ = item.get('id', '') if isinstance(item, dict) else ''
    strokes = [s for s in (item.get('strokes') or []) if isinstance(s, dict) and s.get('tool') != 'highlighter']
    min_x = min_y = float('inf')
    max_x = max_y = float('-inf')
    polys = []
    for s in strokes:
        w = s.get('width')
        w = float(w) if isinstance(w, (int, float)) else 3.0
        pts = []
        for p in (s.get('points') or []):
            if not isinstance(p, list) or len(p) < 2:
                continue
            x, y = float(p[0]), float(p[1])
            pts.append((x, y))
            min_x, max_x, min_y, max_y = min(min_x, x), max(max_x, x), min(min_y, y), max(max_y, y)
        if pts:
            polys.append((w, pts))
    if not polys:
        out_items.append({'id': id_, 'text': '', 'lines': [], 'ms': 0, 'image': [0, 0]})
        continue

    # Raster geometry: 3 px per page px unless the longest side would pass 8192 px.
    side = max(max_x - min_x, max_y - min_y) + 2 * PAD
    k = min(scale, 8192 / side)
    W = max(1, int(round((max_x - min_x + 2 * PAD) * k)))
    H = max(1, int(round((max_y - min_y + 2 * PAD) * k)))
    ctx = Q.CGBitmapContextCreate(None, W, H, 8, 0, Q.CGColorSpaceCreateDeviceGray(), Q.kCGImageAlphaNone)
    if ctx is None:
        fail(3, 'no bitmap context')
    Q.CGContextSetGrayFillColor(ctx, 1.0, 1.0)
    Q.CGContextFillRect(ctx, Q.CGRectMake(0, 0, W, H))
    Q.CGContextTranslateCTM(ctx, 0, H)
    Q.CGContextScaleCTM(ctx, 1, -1)   # page y grows downwards
    Q.CGContextSetGrayStrokeColor(ctx, 0.0, 1.0)
    Q.CGContextSetLineCap(ctx, Q.kCGLineCapRound)
    Q.CGContextSetLineJoin(ctx, Q.kCGLineJoinRound)
    for w, pts in polys:
        Q.CGContextSetLineWidth(ctx, max(2.0, w * k))
        Q.CGContextMoveToPoint(ctx, (pts[0][0] - min_x + PAD) * k, (pts[0][1] - min_y + PAD) * k)
        for x, y in pts[1:]:
            Q.CGContextAddLineToPoint(ctx, (x - min_x + PAD) * k, (y - min_y + PAD) * k)
        if len(pts) == 1:   # a dot
            Q.CGContextAddLineToPoint(ctx, (pts[0][0] - min_x + PAD) * k + 0.1, (pts[0][1] - min_y + PAD) * k)
        Q.CGContextStrokePath(ctx)
    img = Q.CGBitmapContextCreateImage(ctx)
    if img is None:
        fail(3, 'no image')
    if dump:
        url = NSURL.fileURLWithPath_('%s-%s.png' % (dump, id_))
        dest = Q.CGImageDestinationCreateWithURL(url, 'public.png', 1, None)
        if dest is not None:
            Q.CGImageDestinationAddImage(dest, img, None)
            Q.CGImageDestinationFinalize(dest)

    handler = V.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        fail(3, 'Vision failed: %s' % (err.localizedDescription() if err is not None else 'unknown error'))
    lines = []
    for obs in (req.results() or []):
        cands = obs.topCandidates_(1)
        if not cands:
            continue
        c = cands[0]
        bb = obs.boundingBox()   # normalised, origin bottom-left
        bx, by, bw, bh = bb.origin.x, bb.origin.y, bb.size.width, bb.size.height
        # Back to stroke space, clamped ≥ 0 (SPEC §5: coordinates are never negative).
        x = max(0.0, bx * W / k + min_x - PAD)
        y = max(0.0, (1 - (by + bh)) * H / k + min_y - PAD)
        lines.append({'text': str(c.string()), 'box': [r1(x), r1(y), r1(bw * W / k), r1(bh * H / k)], 'confidence': round(float(c.confidence()), 2)})
    out_items.append({'id': id_, 'text': '\n'.join(l['text'] for l in lines), 'lines': lines, 'ms': int((time.time() - t0) * 1000), 'image': [W, H]})

emit({'ok': True, 'engine': engine, 'items': out_items})
