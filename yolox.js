// Детектор людей YOLOX (ONNX) — подготовка кадра и разбор результата.
// Модуль не зависит от Electron и от onnxruntime: сам вывод нейросети (infer) передаётся снаружи.
// Модель: YOLOX-S, вход 640x640, BGR, значения 0–255 без нормализации; класс 0 = человек.
const SIZE = 640;
const STRIDES = [8, 16, 32];
const NCLS = 80;
const STRIDE_LEN = 5 + NCLS;

// сетка якорей: 80*80 + 40*40 + 20*20 = 8400
const GX = [], GY = [], GS = [];
STRIDES.forEach((s) => {
  const n = SIZE / s;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { GX.push(x); GY.push(y); GS.push(s); }
});
const ANCHORS = GX.length;

// frame: { data: Uint8Array|Buffer (RGB), w, h }; rect: { x, y, w, h } — область кадра, в которой ищем людей
function preprocess(frame, rect) {
  const out = new Float32Array(3 * SIZE * SIZE).fill(114);
  const r = Math.min(SIZE / rect.w, SIZE / rect.h);
  const dw = Math.min(SIZE, Math.round(rect.w * r)), dh = Math.min(SIZE, Math.round(rect.h * r));
  const { data, w: fw, h: fh } = frame;
  const plane = SIZE * SIZE;
  for (let dy = 0; dy < dh; dy++) {
    let sy = rect.y + (dy + 0.5) / r - 0.5;
    sy = Math.max(0, Math.min(fh - 1, sy));
    const y0 = Math.floor(sy), y1 = Math.min(fh - 1, y0 + 1), fy = sy - y0;
    for (let dx = 0; dx < dw; dx++) {
      let sx = rect.x + (dx + 0.5) / r - 0.5;
      sx = Math.max(0, Math.min(fw - 1, sx));
      const x0 = Math.floor(sx), x1 = Math.min(fw - 1, x0 + 1), fx = sx - x0;
      const i00 = (y0 * fw + x0) * 3, i01 = (y0 * fw + x1) * 3, i10 = (y1 * fw + x0) * 3, i11 = (y1 * fw + x1) * 3;
      const o = dy * SIZE + dx;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i01 + c] * fx;
        const bot = data[i10 + c] * (1 - fx) + data[i11 + c] * fx;
        out[(2 - c) * plane + o] = top * (1 - fy) + bot * fy; // RGB → BGR
      }
    }
  }
  return { tensor: out, scale: r, rect };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return u > 0 ? inter / u : 0;
}

// raw — выход сети [1, 8400, 85]; возвращает людей в координатах кадра
function postprocess(raw, prep, scoreThr, nmsThr) {
  scoreThr = scoreThr == null ? 0.25 : scoreThr;
  nmsThr = nmsThr == null ? 0.45 : nmsThr;
  const cands = [];
  for (let i = 0; i < ANCHORS; i++) {
    const o = i * STRIDE_LEN;
    const score = raw[o + 4] * raw[o + 5];
    if (score < scoreThr) continue;
    const s = GS[i];
    const cx = (raw[o] + GX[i]) * s, cy = (raw[o + 1] + GY[i]) * s;
    const bw = Math.exp(raw[o + 2]) * s, bh = Math.exp(raw[o + 3]) * s;
    cands.push({
      x1: (cx - bw / 2) / prep.scale + prep.rect.x, y1: (cy - bh / 2) / prep.scale + prep.rect.y,
      x2: (cx + bw / 2) / prep.scale + prep.rect.x, y2: (cy + bh / 2) / prep.scale + prep.rect.y, score,
    });
  }
  cands.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of cands) {
    if (keep.every((k) => iou(k, c) <= nmsThr)) keep.push(c);
  }
  return keep;
}

// infer: (Float32Array тензор 1x3x640x640) => Promise<Float32Array выход сети>
async function detectPeople(infer, frame, rect, scoreThr) {
  const prep = preprocess(frame, rect);
  const raw = await infer(prep.tensor);
  return postprocess(raw, prep, scoreThr).filter((b) => b.x2 > b.x1 && b.y2 > b.y1);
}

module.exports = { SIZE, preprocess, postprocess, detectPeople, iou };
