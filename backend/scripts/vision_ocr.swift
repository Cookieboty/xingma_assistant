import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: vision_ocr <image> [--strips N]\n", stderr)
  exit(2)
}
let path = CommandLine.arguments[1]
var stripCount = 0
if let idx = CommandLine.arguments.firstIndex(of: "--strips"),
   idx + 1 < CommandLine.arguments.count,
   let n = Int(CommandLine.arguments[idx + 1]), n >= 2, n <= 24 {
  stripCount = n
}

guard let img = NSImage(contentsOfFile: path),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else {
  fputs("load fail\n", stderr)
  exit(1)
}

func recognize(_ image: CGImage) -> [String] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["zh-Hans", "en-US"]
  req.usesLanguageCorrection = false
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
  } catch {
    return []
  }
  return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

func rotate90(_ src: CGImage, clockwise: Bool) -> CGImage? {
  let w = src.width, h = src.height
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
  guard let ctx = CGContext(
    data: nil, width: h, height: w,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace, bitmapInfo: bitmapInfo.rawValue
  ) else { return nil }
  if clockwise {
    ctx.translateBy(x: CGFloat(h), y: 0)
    ctx.rotate(by: .pi / 2)
  } else {
    ctx.translateBy(x: 0, y: CGFloat(w))
    ctx.rotate(by: -.pi / 2)
  }
  ctx.draw(src, in: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
  return ctx.makeImage()
}

var lines = Set(recognize(cg))

if stripCount > 0 {
  // Use NSImage draw crop (top-left friendly) instead of CGImage.cropping
  let W = Int(img.size.width)
  let H = Int(img.size.height)
  // Prefer pixel size if available
  let pw = rep.pixelsWide
  let ph = rep.pixelsHigh
  let outW = pw > 0 ? pw : W
  let outH = ph > 0 ? ph : H

  for i in 0..<stripCount {
    let x0 = max(0, Int(Double(i) * Double(outW) / Double(stripCount)) - 6)
    let x1 = min(outW, Int(Double(i + 1) * Double(outW) / Double(stripCount)) + 14)
    let ww = max(16, x1 - x0)
    let yTop = Int(Double(outH) * 0.14)
    let hh = Int(Double(outH) * 0.62)
    let rect = NSRect(x: x0, y: outH - yTop - hh, width: ww, height: hh) // convert top-based to bottom-left bitmap

    guard let bit = rep.cgImage?.cropping(to: CGRect(
      x: x0,
      y: outH - yTop - hh, // CG bottom-left
      width: ww,
      height: hh
    )) else { continue }

    // Upscale small strips for better OCR
    let scale = 3
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    var piece = bit
    if let ctx = CGContext(
      data: nil, width: ww * scale, height: hh * scale,
      bitsPerComponent: 8, bytesPerRow: 0,
      space: colorSpace, bitmapInfo: bitmapInfo.rawValue
    ) {
      ctx.interpolationQuality = .high
      ctx.draw(bit, in: CGRect(x: 0, y: 0, width: ww * scale, height: hh * scale))
      if let up = ctx.makeImage() { piece = up }
    }

    for s in recognize(piece) { lines.insert(s) }
    if let r90 = rotate90(piece, clockwise: true) {
      for s in recognize(r90) { lines.insert(s) }
    }
    if let rm90 = rotate90(piece, clockwise: false) {
      for s in recognize(rm90) { lines.insert(s) }
    }
  }
}

print(lines.sorted().joined(separator: " | "))
