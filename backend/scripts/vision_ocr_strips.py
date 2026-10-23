#!/usr/bin/env python3
"""Crop multi-color hangshot into vertical strips, rotate, OCR via vision_ocr binary.
Usage: vision_ocr_strips.py <image> <vision_bin> [N]
Prints unique lines joined by ' | '.
"""
import sys, os, tempfile, shutil, subprocess
from PIL import Image, ImageEnhance

def main():
  if len(sys.argv) < 3:
    print("usage: vision_ocr_strips.py <image> <vision_bin> [N]", file=sys.stderr)
    sys.exit(2)
  path, bin_path = sys.argv[1], sys.argv[2]
  n = int(sys.argv[3]) if len(sys.argv) > 3 else 6
  n = max(2, min(24, n))
  img = Image.open(path).convert("RGB")
  W, H = img.size
  # Auto strip count by aspect: wider → more strips
  if len(sys.argv) <= 3:
    ar = W / max(1, H)
    if ar >= 1.4:
      n = 14
    elif ar >= 1.1:
      n = 8
    else:
      n = 4
  seen, out = set(), []
  tmp = tempfile.mkdtemp(prefix="ocrstrips_")
  try:
    for i in range(n):
      x0 = max(0, int(i * W / n) - 8)
      x1 = min(W, int((i + 1) * W / n) + 16)
      y0 = int(H * 0.14)
      y1 = int(H * 0.76)
      crop = img.crop((x0, y0, x1, y1))
      crop = crop.resize(
        (max(1, crop.width * 2), max(1, crop.height * 2)),
        Image.Resampling.LANCZOS,
      )
      crop = ImageEnhance.Contrast(crop).enhance(1.7)
      for ang in (0, 90, -90):
        c = crop.rotate(ang, expand=True) if ang else crop
        p = os.path.join(tmp, f"{i}_{ang}.jpg")
        c.save(p, quality=95)
        try:
          r = subprocess.run(
            [bin_path, p], capture_output=True, text=True, timeout=25
          )
        except Exception:
          continue
        t = (r.stdout or "").strip()
        if not t:
          continue
        for part in t.split(" | "):
          part = part.strip()
          if part and part not in seen:
            seen.add(part)
            out.append(part)
  finally:
    shutil.rmtree(tmp, ignore_errors=True)
  print(" | ".join(out))

if __name__ == "__main__":
  main()
