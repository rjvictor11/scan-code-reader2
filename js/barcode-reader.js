// Full-resolution barcode reading, used where html5-qrcode falls short:
//  - the live camera on the 1D step. html5-qrcode crops its scan box at
//    on-screen size (~380px across), which turns thin Code 39 bars to mush,
//    and it runs ZXing with TRY_HARDER off.
//  - photo uploads, which html5-qrcode shrinks to ~300px wide before
//    decoding.
// This reads frames/photos at the camera's native resolution, with
// TRY_HARDER on, and uses the browser's built-in BarcodeDetector first when
// there is one (Chrome on Android). Needs vendor/zxing-library.min.js.
const BarcodeReader = (() => {
 const F = ZXing.BarcodeFormat;
 const ONE_D = [F.CODE_39, F.CODE_128, F.CODE_93, F.ITF, F.CODABAR];
 const TWO_D = [F.DATA_MATRIX, F.QR_CODE];
 const NATIVE_NAMES = {
  code_39: "CODE_39", code_128: "CODE_128", code_93: "CODE_93", itf: "ITF", codabar: "CODABAR",
  data_matrix: "DATA_MATRIX", qr_code: "QR_CODE",
 };

 function makeReader(formats) {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return reader;
 }
 const readers = { "1d": makeReader(ONE_D), "2d": makeReader(TWO_D), any: makeReader([...ONE_D, ...TWO_D]) };

 // 1D barcodes often binarize better with the global histogram; 2D codes
 // with the hybrid (local) one. Try both.
 function decodeCanvas(canvas, kind) {
  const reader = readers[kind];
  const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
  const binarizers = kind === "1d"
   ? [ZXing.GlobalHistogramBinarizer, ZXing.HybridBinarizer]
   : [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer];
  for (const Binarizer of binarizers) {
   try {
    const result = reader.decodeWithState(new ZXing.BinaryBitmap(new Binarizer(source)));
    return { decodedText: result.getText(), format: F[result.getBarcodeFormat()] };
   } catch (e) {
    // NotFound / Checksum / Format -- try the next one
   } finally {
    reader.reset();
   }
  }
  return null;
 }

 let nativeDetector; // undefined = not checked yet, null = unavailable
 async function getNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  if (!("BarcodeDetector" in window)) return null;
  try {
   const supported = await BarcodeDetector.getSupportedFormats();
   const formats = Object.keys(NATIVE_NAMES).filter(f => supported.includes(f));
   if (formats.length) nativeDetector = new BarcodeDetector({ formats });
  } catch (e) {}
  return nativeDetector;
 }

 function kindMatches(format, kind) {
  if (kind === "any") return true;
  const is1d = ["CODE_39", "CODE_128", "CODE_93", "ITF", "CODABAR"].includes(format);
  return kind === "1d" ? is1d : !is1d;
 }

 async function detectNative(source, kind) {
  const detector = await getNativeDetector();
  if (!detector) return null;
  try {
   const found = await detector.detect(source);
   for (const code of found) {
    const format = NATIVE_NAMES[code.format];
    if (format && kindMatches(format, kind) && code.rawValue) return { decodedText: code.rawValue, format };
   }
  } catch (e) {}
  return null;
 }

 // Copies a region of an image/video into a canvas, scaled so its long
 // side is at most maxSide (and upscaled up to 2x if it's small -- thin
 // bars need a few pixels each).
 function regionCanvas(src, sx, sy, sw, sh, maxSide) {
  let scale = Math.min(1, maxSide / Math.max(sw, sh));
  if (Math.max(sw, sh) * scale < 900) scale = Math.min(2, 900 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
 }

 const yieldToUI = () => new Promise(r => setTimeout(r, 0));

 // Photo: the built-in detector first, then the whole picture, then a 3x3
 // grid of overlapping half-size tiles. A label is usually a small part of
 // the photo, and a tile around it gives the decoder far more pixels per
 // bar. TRY_HARDER also retries each region rotated 90 degrees, so a
 // vertical barcode still reads.
 async function decodeImageFile(file, kind) {
  const url = URL.createObjectURL(file);
  try {
   const img = new Image();
   img.src = url;
   await img.decode();
   const native = await detectNative(img, kind);
   if (native) return native;
   const W = img.naturalWidth, H = img.naturalHeight;
   const regions = [[0, 0, W, H]];
   for (const fy of [0, 0.25, 0.5]) for (const fx of [0, 0.25, 0.5]) regions.push([fx * W, fy * H, W / 2, H / 2]);
   // Data Matrix detection is thrown off by clutter around the code, so a
   // finer grid of third-size tiles comes last.
   if (kind !== "1d") {
    for (let fy = 0; fy <= 2 / 3 + 1e-9; fy += 1 / 6) for (let fx = 0; fx <= 2 / 3 + 1e-9; fx += 1 / 6) regions.push([fx * W, fy * H, W / 3, H / 3]);
   }
   for (const [x, y, w, h] of regions) {
    await yieldToUI();
    const hit = decodeCanvas(regionCanvas(img, x, y, w, h, 2000), kind);
    if (hit) return hit;
   }
   throw new Error("No code found");
  } finally {
   URL.revokeObjectURL(url);
  }
 }

 // Live camera: asks for a high-resolution stream (most phones default to
 // 640x480 otherwise) and decodes the middle band of each frame at native
 // resolution, alternating with the full frame.
 async function startLive(container, deviceId, kind, onResult) {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.muted = true;
  video.className = "live-video";
  const guide = document.createElement("div");
  guide.className = "live-guide" + (kind === "1d" ? " wide" : "");
  const hint = document.createElement("div");
  hint.className = "live-hint";
  hint.textContent = kind === "1d" ? "Bars running left to right, filling the box" : "";
  container.innerHTML = "";
  container.append(video, guide, hint);

  const constraints = {
   audio: false,
   video: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }),
    width: { ideal: 1920 },
    height: { ideal: 1080 },
   },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  video.srcObject = stream;
  await video.play();

  let stopped = false;
  let frame = 0;
  async function tick() {
   if (stopped) return;
   const vw = video.videoWidth, vh = video.videoHeight;
   if (vw && vh) {
    let hit = await detectNative(video, kind);
    if (!hit && !stopped) {
     // Middle band (where the guide box is) most frames; the whole frame
     // every third one, in case the label isn't centered.
     hit = frame++ % 3 === 2
      ? decodeCanvas(regionCanvas(video, 0, 0, vw, vh, 1600), kind)
      : decodeCanvas(regionCanvas(video, 0, vh * 0.3, vw, vh * 0.4, 1600), kind);
    }
    if (hit && !stopped) { onResult(hit); return; }
   }
   setTimeout(tick, 120);
  }
  tick();

  const caps = track.getCapabilities ? track.getCapabilities() : {};
  return {
   torchSupported: Boolean(caps.torch),
   setTorch: on => track.applyConstraints({ advanced: [{ torch: on }] }),
   stop() {
    stopped = true;
    stream.getTracks().forEach(t => t.stop());
    container.innerHTML = "";
   },
  };
 }

 return { decodeImageFile, startLive, decodeCanvas, regionCanvas };
})();
