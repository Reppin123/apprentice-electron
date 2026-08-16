// apprentice-resolve — label→rect resolver for the Electron shell.
// Port of the app's ScreenResolver (AXElementResolver.swift): AX tier
// (bounded DFS over the target app's accessibility tree) then OCR tier
// (screencapture + Vision), whole-word token matching only.
// Output: one JSON line, topleft-global CSS points:
//   {"ok":true,"x":..,"y":..,"w":..,"h":..,"tier":"ax"|"ocr"}
//   {"ok":false,"reason":".."}
// Build: swiftc -O apprentice-resolve.swift -o apprentice-resolve

import AppKit
import ApplicationServices
import Vision

struct Out: Codable {
  var ok: Bool
  var x: Double?
  var y: Double?
  var w: Double?
  var h: Double?
  var tier: String?
  var reason: String?
}

func emit(_ o: Out) -> Never {
  let d = try! JSONEncoder().encode(o)
  print(String(data: d, encoding: .utf8)!)
  exit(o.ok ? 0 : 1)
}

// ── args ────────────────────────────────────────────────────────────────
var appName = ""
var label = ""
var role: String? = nil
var nth = 0
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  switch a {
  case "--app": appName = args.isEmpty ? "" : args.removeFirst()
  case "--label": label = args.isEmpty ? "" : args.removeFirst()
  case "--role": role = args.isEmpty ? nil : args.removeFirst()
  case "--nth": nth = Int(args.isEmpty ? "0" : args.removeFirst()) ?? 0
  default: break
  }
}
if label.isEmpty && role == nil { emit(Out(ok: false, reason: "no label or role")) }

let roleMap: [String: String] = [
  "button": "AXButton", "checkbox": "AXCheckBox", "radio": "AXRadioButton",
  "menuitem": "AXMenuItem", "menu": "AXMenu", "tab": "AXRadioButton",
  "text": "AXTextField", "textfield": "AXTextField", "field": "AXTextField",
  "textarea": "AXTextArea", "link": "AXLink", "image": "AXImage",
  "cell": "AXCell", "row": "AXRow", "column": "AXColumn", "group": "AXGroup",
  "toolbar": "AXToolbar", "static": "AXStaticText", "label": "AXStaticText",
  "slider": "AXSlider", "popup": "AXPopUpButton"
]
let wantRole: String? = role.map { r in
  roleMap[r.lowercased()] ?? (r.hasPrefix("AX") ? r : "AX" + r.prefix(1).uppercased() + r.dropFirst())
}
let needle = label.lowercased()

// ── AX tier ─────────────────────────────────────────────────────────────
func axAttr(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func axRect(_ el: AXUIElement) -> CGRect? {
  var posRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success
  else { return nil }
  var pos = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
  AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
  // AX position is already global top-left oriented (CG coords) — exactly
  // what Electron wants.
  return CGRect(origin: pos, size: size)
}

func findPid() -> pid_t? {
  let apps = NSWorkspace.shared.runningApplications
  let lower = appName.lowercased()
  if let a = apps.first(where: { $0.localizedName?.lowercased() == lower }) { return a.processIdentifier }
  if let a = apps.first(where: { ($0.localizedName?.lowercased() ?? "").contains(lower) }) { return a.processIdentifier }
  if let a = apps.first(where: { ($0.bundleIdentifier?.lowercased() ?? "").contains(lower) }) { return a.processIdentifier }
  return nil
}

func axResolve() -> CGRect? {
  guard !appName.isEmpty, let pid = findPid() else { return nil }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.4)
  var matches: [CGRect] = []
  var visited = 0
  let deadline = Date().addingTimeInterval(2.5)
  func walk(_ el: AXUIElement, depth: Int) {
    if visited >= 6000 || depth > 60 || matches.count > nth || Date() > deadline { return }
    visited += 1
    let elRole = axAttr(el, kAXRoleAttribute as String)
    var roleOK = wantRole == nil || elRole == wantRole
    var labelOK = needle.isEmpty
    if !labelOK && roleOK {
      for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute, "AXIdentifier"] {
        if let s = axAttr(el, attr as String), s.lowercased().contains(needle) { labelOK = true; break }
      }
    }
    if roleOK && labelOK, let r = axRect(el), r.width >= 3, r.height >= 3 {
      matches.append(r)
      if matches.count > nth { return }
    }
    var kidsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
          let kids = kidsRef as? [AXUIElement] else { return }
    for k in kids {
      walk(k, depth: depth + 1)
      if matches.count > nth || visited >= 6000 || Date() > deadline { return }
    }
  }
  walk(app, depth: 0)
  return matches.count > nth ? matches[nth] : matches.last
}

// ── OCR tier ────────────────────────────────────────────────────────────
func ocrResolve() -> CGRect? {
  guard !needle.isEmpty else { return nil }
  let tmp = NSTemporaryDirectory() + "apprentice_resolve_\(getpid()).png"
  defer { try? FileManager.default.removeItem(atPath: tmp) }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  p.arguments = ["-x", tmp]
  try? p.run()
  p.waitUntilExit()
  guard let img = NSImage(contentsOfFile: tmp),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(cgImage: cg)
  try? handler.perform([req])
  guard let results = req.results else { return nil }

  func tokens(_ s: String) -> Set<String> {
    Set(s.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count >= 2 })
  }
  let want = tokens(needle)
  guard !want.isEmpty else { return nil }
  let needCount = max(1, min(2, want.count))

  var best: (present: Int, coverage: Double, area: Double, box: CGRect)? = nil
  for r in results {
    guard let cand = r.topCandidates(1).first else { continue }
    let lineTokens = tokens(cand.string)
    let present = want.intersection(lineTokens).count
    guard present >= needCount else { continue }
    let coverage = lineTokens.isEmpty ? 0 : Double(present) / Double(lineTokens.count)
    let bb = r.boundingBox
    let area = Double(bb.width * bb.height)
    let cur = (present, coverage, area, bb)
    if best == nil || cur.0 > best!.present
      || (cur.0 == best!.present && cur.1 > best!.coverage)
      || (cur.0 == best!.present && cur.1 == best!.coverage && cur.2 > best!.area) {
      best = cur
    }
  }
  guard let b = best else { return nil }
  // Vision boxes are normalized bottom-left; convert to topleft-global points.
  let screenPts = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.size
    ?? NSScreen.main!.frame.size
  let x = Double(b.box.minX) * Double(screenPts.width)
  let yTop = (1.0 - Double(b.box.maxY)) * Double(screenPts.height)
  let w = max(Double(b.box.width) * Double(screenPts.width), 24)
  let h = max(Double(b.box.height) * Double(screenPts.height), 18)
  return CGRect(x: x, y: yTop, width: w, height: h)
}

// ── run ─────────────────────────────────────────────────────────────────
if let r = axResolve() {
  emit(Out(ok: true, x: r.minX, y: r.minY, w: r.width, h: r.height, tier: "ax"))
}
if let r = ocrResolve() {
  emit(Out(ok: true, x: r.minX, y: r.minY, w: r.width, h: r.height, tier: "ocr"))
}
emit(Out(ok: false, reason: "element not found"))
