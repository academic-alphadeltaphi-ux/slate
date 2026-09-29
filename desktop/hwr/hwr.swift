// hwr — handwriting to text for slate, through Apple Vision (SPEC §20.9).
//
// Build with `npm run build:hwr` (scripts/build-hwr.mjs picks an SDK the compiler accepts; on this Mac the
// Command Line Tools' default 26.2 SDK is refused by Swift 6.1.2 and 15.5 works). Do not hand-run swiftc
// without `-sdk`. The same contract exists as desktop/hwr/hwr.py (PyObjC) for machines with no compiler.
//
// Contract
//   stdin   { "items": [ { "id", "strokes": [ { "tool", "width", "points": [[x, y, p, ms], …] } ] } ] }
//   stdout  one JSON line
//           { "ok": true, "engine": { "name": "vision", "revision", "languages", "level", "correction" },
//             "items": [ { "id", "text", "lines": [ { "text", "box": [x, y, w, h], "confidence" } ], "ms", "image": [W, H] } ] }
//           or { "ok": false, "error" }
//   flags   --probe            print ok + engine + `supported` languages and exit 0 (no stdin read)
//           --scale 3          raster pixels per page px (reduced so the longest side stays ≤ 8192)
//           --lang en-US,fr-FR recognition languages, filtered to what Vision offers
//           --no-correction    turn language correction off
//           --fast             VNRequestTextRecognitionLevel.fast instead of .accurate
//           --dump <prefix>    write <prefix>-<id>.png rasters for debugging
//   exit    0 ok · 2 bad input or argument · 3 Vision unavailable or failed
//
// Raster: bounding box of the pen strokes (highlighter strokes are marks, not writing, and are left out)
// plus 24 px of margin, 8-bit grey, white background, black round-capped and round-joined polylines of
// width max(2, width × k), y flipped because page y grows downwards, a single-point stroke drawn as a dot.
// `box` comes back in the strokes' own coordinate space (page px, or relative to the parent), clamped ≥ 0.
import Foundation
import CoreGraphics
import ImageIO
import Vision

func emit(_ obj: [String: Any]) {
  let out = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(out)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func fail(_ code: Int32, _ msg: String) -> Never {
  emit(["ok": false, "error": msg])
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

// ---- arguments -----------------------------------------------------------------------------------------
var args = CommandLine.arguments.dropFirst()
var scale = 3.0, langs = ["en-US", "fr-FR"], correction = true, fast = false, probe = false
var dump: String? = nil
while let a = args.popFirst() {
  switch a {
  case "--scale": scale = Double(args.popFirst() ?? "3") ?? 3
  case "--lang": langs = (args.popFirst() ?? "").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  case "--no-correction": correction = false
  case "--fast": fast = true
  case "--probe": probe = true
  case "--dump": dump = args.popFirst()
  default: fail(2, "unknown argument \(a)")
  }
}
if scale <= 0 { fail(2, "--scale must be positive") }

func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }

// ---- the request ---------------------------------------------------------------------------------------
let req = VNRecognizeTextRequest()
req.recognitionLevel = fast ? .fast : .accurate
req.usesLanguageCorrection = correction
let supported = (try? req.supportedRecognitionLanguages()) ?? []
let usable = langs.filter { supported.contains($0) }
if usable.isEmpty { fail(3, "none of \(langs) is supported; Vision offers \(supported)") }
req.recognitionLanguages = usable
let engine: [String: Any] = ["name": "vision", "revision": req.revision, "languages": usable, "level": fast ? "fast" : "accurate", "correction": correction]
if probe { emit(["ok": true, "engine": engine, "supported": supported]); exit(0) }

// ---- input ---------------------------------------------------------------------------------------------
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let items = root["items"] as? [[String: Any]] else {
  fail(2, "stdin must be JSON { items: [...] }")
}

let pad = 24.0
var outItems: [[String: Any]] = []
for item in items {
  let t0 = Date()
  let id = item["id"] as? String ?? ""
  let strokes = (item["strokes"] as? [[String: Any]] ?? []).filter { ($0["tool"] as? String) != "highlighter" }
  var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
  var polys: [(Double, [(Double, Double)])] = []
  for s in strokes {
    let w = (s["width"] as? Double) ?? 3
    var pts: [(Double, Double)] = []
    for p in (s["points"] as? [[Double]] ?? []) where p.count >= 2 {
      pts.append((p[0], p[1]))
      minX = min(minX, p[0]); maxX = max(maxX, p[0]); minY = min(minY, p[1]); maxY = max(maxY, p[1])
    }
    if !pts.isEmpty { polys.append((w, pts)) }
  }
  if polys.isEmpty { outItems.append(["id": id, "text": "", "lines": [], "ms": 0, "image": [0, 0]]); continue }

  // Raster geometry: 3 px per page px unless the longest side would pass 8192 px.
  let side = max(maxX - minX, maxY - minY) + 2 * pad
  let k = min(scale, 8192 / side)
  let W = max(1, Int(((maxX - minX + 2 * pad) * k).rounded())), H = max(1, Int(((maxY - minY + 2 * pad) * k).rounded()))
  guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { fail(3, "no bitmap context") }
  ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  ctx.translateBy(x: 0, y: CGFloat(H)); ctx.scaleBy(x: 1, y: -1)   // page y grows downwards
  ctx.setStrokeColor(gray: 0, alpha: 1); ctx.setLineCap(.round); ctx.setLineJoin(.round)
  for (w, pts) in polys {
    ctx.setLineWidth(max(2, w * k))
    ctx.move(to: CGPoint(x: (pts[0].0 - minX + pad) * k, y: (pts[0].1 - minY + pad) * k))
    for p in pts.dropFirst() { ctx.addLine(to: CGPoint(x: (p.0 - minX + pad) * k, y: (p.1 - minY + pad) * k)) }
    if pts.count == 1 { ctx.addLine(to: CGPoint(x: (pts[0].0 - minX + pad) * k + 0.1, y: (pts[0].1 - minY + pad) * k)) }   // a dot
    ctx.strokePath()
  }
  guard let img = ctx.makeImage() else { fail(3, "no image") }
  if let d = dump {
    let url = URL(fileURLWithPath: d + "-" + id + ".png")
    if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) { CGImageDestinationAddImage(dest, img, nil); CGImageDestinationFinalize(dest) }
  }

  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  do { try handler.perform([req]) } catch { fail(3, "Vision failed: \(error.localizedDescription)") }
  var lines: [[String: Any]] = []
  for obs in (req.results ?? []) {
    guard let c = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox   // normalised, origin bottom-left
    // Back to stroke space, clamped ≥ 0 (SPEC §5: coordinates are never negative).
    let x = max(0, Double(bb.minX) * Double(W) / k + minX - pad)
    let y = max(0, (1 - Double(bb.maxY)) * Double(H) / k + minY - pad)
    lines.append(["text": c.string, "box": [r1(x), r1(y), r1(Double(bb.width) * Double(W) / k), r1(Double(bb.height) * Double(H) / k)], "confidence": (Double(c.confidence) * 100).rounded() / 100])
  }
  let text = lines.map { $0["text"] as! String }.joined(separator: "\n")
  outItems.append(["id": id, "text": text, "lines": lines, "ms": Int(Date().timeIntervalSince(t0) * 1000), "image": [W, H]])
}
emit(["ok": true, "engine": engine, "items": outItems])
