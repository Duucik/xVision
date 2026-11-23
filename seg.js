// «Позиция»: вырезать игрока с остановленного кадра, чтобы перетащить его на другое место.
//
// Два способа, результат одинаковый (контур + картинка игрока с прозрачным фоном):
//  • щелчок по игроку — нейросеть MobileSAM сама находит его контур (вместе с клюшкой);
//    если на кадре уже найдена рамка игрока (YOLOX, как в ИИ-подсветке), она подсказывает нейросети, где он;
//  • обвести игрока мышью — контур берётся как нарисован.
// MobileSAM работает на процессоре: считается один кадр, это 1–2 секунды и не требует видеокарты.
// Модели (Apache-2.0, выгрузка Acly/MobileSAM): кодировщик кадра ~28 МБ и декодер маски ~16 МБ.
const fs = require('fs');
const path = require('path');
const tracker = require('./tracker');

const FILES = {
  enc: { name: 'mobile_sam_image_encoder.onnx', url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx', min: 20 * 1024 * 1024 },
  dec: { name: 'sam_mask_decoder_single.onnx', url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx', min: 10 * 1024 * 1024 },
};
const MAX_W = 1920; // кадр больше Full HD уменьшаем — точнее для перетаскивания не нужно

let ort = null, enc = null, dec = null, encMode = null, loading = null, userDir = '';
const embCache = []; // последние кадры: { key, emb, scale, w, h, frame }

function log(line) {
  if (!userDir) return;
  try { fs.appendFileSync(path.join(userDir, 'ai-log.txt'), new Date().toISOString().replace('T', ' ').slice(0, 19) + '  [позиция] ' + line + '\n'); } catch (e) {}
}

// ---------- модели ----------
function filePath(appDir, userData, f) {
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'models', f.name));
  cands.push(path.join(appDir, 'models', f.name), path.join(userData, 'models', f.name));
  return cands.find((p) => { try { return fs.statSync(p).size > f.min; } catch (e) { return false; } }) || null;
}
// чего не хватает: [{ key, url, dest, min }]
function missing(appDir, userData) {
  return Object.keys(FILES).filter((k) => !filePath(appDir, userData, FILES[k]))
    .map((k) => ({ key: k, url: FILES[k].url, dest: path.join(userData, 'models', FILES[k].name), min: FILES[k].min }));
}
async function prepare({ appDir, userData }) {
  userDir = userData || userDir;
  if (enc && dec) return { ok: true };
  if (loading) return loading;
  loading = (async () => {
    const pe = filePath(appDir, userData, FILES.enc), pd = filePath(appDir, userData, FILES.dec);
    if (!pe || !pd) return { ok: false, kind: 'model', error: 'Нет модели для выделения игрока' };
    try { ort = ort || require('onnxruntime-node'); }
    catch (e) { return { ok: false, kind: 'runtime', error: 'Не удалось загрузить модуль нейросети: ' + ((e && e.message) || e) }; }
    const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
    try {
      enc = await ort.InferenceSession.create(pe, opts);
      dec = await ort.InferenceSession.create(pd, opts);
      log('модели загружены: кодировщик (' + enc.inputNames.join(',') + ' → ' + enc.outputNames.join(',') + '), декодер (' + dec.inputNames.join(',') + ' → ' + dec.outputNames.join(',') + ')');
      return { ok: true };
    } catch (e) {
      enc = null; dec = null;
      log('модели не загрузились: ' + ((e && e.message) || e));
      return { ok: false, kind: 'runtime', error: 'Не удалось запустить нейросеть выделения: ' + ((e && e.message) || e) };
    }
  })();
  try { return await loading; } finally { loading = null; }
}

// ---------- кадр ----------
function frameSize(srcW, srcH) {
  const w = Math.min(MAX_W, srcW || 1280) & ~1;
  return { w, h: Math.round((srcH || 720) * w / (srcW || 1280) / 2) * 2 };
}
// в плеере на паузе виден кадр, который начался не позже t; ffmpeg отдаёт первый кадр не раньше точки перехода
function frameStart(t, fps) { return Math.max(0, (Number(t) || 0) - (fps > 1 ? 0.98 / fps : 0)); }
async function grab({ ffmpegPath, sourcePath, t, fps, srcW, srcH }) {
  const { w, h } = frameSize(srcW, srcH);
  const frame = await tracker.grabFrame({ ffmpegPath, sourcePath, start: frameStart(t, fps), fw: w, fh: h });
  if (!frame) throw new Error('Не удалось получить кадр видео');
  return frame;
}

// ---------- нейросеть ----------
function resizeRGB(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh * 3);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const i00 = (y0 * w + x0) * 3, i01 = (y0 * w + x1) * 3, i10 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3, o = (y * nw + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (src[i00 + c] * (1 - wx) + src[i01 + c] * wx) * (1 - wy) + (src[i10 + c] * (1 - wx) + src[i11 + c] * wx) * wy;
      }
    }
  }
  return out;
}
const MEAN = [123.675, 116.28, 103.53], STD = [58.395, 57.12, 57.375];
// Кодировщик бывает двух видов: с подготовкой кадра внутри (вход — кадр H×W×3 в пикселях 0–255, длинная сторона 1024)
// и без неё (вход — 1×3×1024×1024, нормированный, дополненный нулями справа и снизу). Пробуем первый, при ошибке — второй.
async function encode(frame) {
  const scale = 1024 / Math.max(frame.w, frame.h);
  const nw = Math.round(frame.w * scale), nh = Math.round(frame.h * scale);
  const img = resizeRGB(frame.data, frame.w, frame.h, nw, nh);
  const inName = enc.inputNames[0];
  const tryHWC = async () => (await enc.run({ [inName]: new ort.Tensor('float32', img, [nh, nw, 3]) }))[enc.outputNames[0]];
  const tryCHW = async () => {
    const t = new Float32Array(3 * 1024 * 1024);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 3;
      for (let c = 0; c < 3; c++) t[c * 1048576 + y * 1024 + x] = (img[i + c] - MEAN[c]) / STD[c];
    }
    return (await enc.run({ [inName]: new ort.Tensor('float32', t, [1, 3, 1024, 1024]) }))[enc.outputNames[0]];
  };
  let emb = null;
  const order = encMode === 'chw' ? [['chw', tryCHW], ['hwc', tryHWC]] : [['hwc', tryHWC], ['chw', tryCHW]];
  let lastErr = null;
  for (const [mode, fn] of order) {
    try { emb = await fn(); if (encMode !== mode) log('кодировщик: вход ' + (mode === 'hwc' ? 'кадр H×W×3 (подготовка внутри модели)' : '1×3×1024×1024')); encMode = mode; break; }
    catch (e) { lastErr = e; }
  }
  if (!emb) throw new Error('кодировщик не принял кадр: ' + ((lastErr && lastErr.message) || lastErr));
  return { emb, scale };
}
async function decode(embInfo, frame, points) {
  const { emb, scale } = embInfo;
  const n = points.length;
  const coords = new Float32Array(n * 2), labels = new Float32Array(n);
  points.forEach((p, i) => { coords[i * 2] = p.x * scale; coords[i * 2 + 1] = p.y * scale; labels[i] = p.label; });
  const all = {
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([frame.h, frame.w]), [2]),
  };
  const feeds = {};
  dec.inputNames.forEach((k) => { if (all[k]) feeds[k] = all[k]; else if (/embed/i.test(k)) feeds[k] = emb; });
  const out = await dec.run(feeds);
  const mName = dec.outputNames.find((k) => /^masks$/i.test(k)) || dec.outputNames[0];
  const m = out[mName];
  const iouName = dec.outputNames.find((k) => /iou/i.test(k));
  const dims = m.dims; // [1, k, H, W]
  const k = dims.length === 4 ? dims[1] : 1, H = dims[dims.length - 2], W = dims[dims.length - 1];
  let best = 0;
  if (k > 1 && iouName) { const iou = out[iouName].data; for (let i = 1; i < k; i++) if (iou[i] > iou[best]) best = i; }
  const plane = m.data.subarray(best * H * W, (best + 1) * H * W);
  // маска в размере кадра; если пришла маленькая (256×256 в квадрате 1024) — пересчитываем
  const mask = new Uint8Array(frame.w * frame.h);
  if (W === frame.w && H === frame.h) { for (let i = 0; i < mask.length; i++) mask[i] = plane[i] > 0 ? 1 : 0; }
  else {
    const f = (W / 1024) * scale;
    for (let y = 0; y < frame.h; y++) {
      const my = Math.min(H - 1, Math.floor((y + 0.5) * f));
      for (let x = 0; x < frame.w; x++) { const mx = Math.min(W - 1, Math.floor((x + 0.5) * f)); mask[y * frame.w + x] = plane[my * W + mx] > 0 ? 1 : 0; }
    }
  }
  return mask;
}

// ---------- маска → игрок ----------
// связная область, в которую попал щелчок (или ближайшая к нему)
function component(mask, w, h, sx, sy) {
  let seed = -1;
  sx = Math.round(sx); sy = Math.round(sy);
  if (sx >= 0 && sy >= 0 && sx < w && sy < h && mask[sy * w + sx]) seed = sy * w + sx;
  for (let r = 1; seed < 0 && r <= 40; r++) {
    for (let dy = -r; dy <= r && seed < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = sx + dx, y = sy + dy;
      if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) { seed = y * w + x; break; }
    }
  }
  if (seed < 0) return null;
  const comp = new Uint8Array(w * h), stack = [seed];
  comp[seed] = 1;
  let n = 0, x1 = w, y1 = h, x2 = -1, y2 = -1;
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    n++; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && mask[j] && !comp[j]) { comp[j] = 1; stack.push(j); }
  }
  return { comp, n, x1, y1, x2, y2 };
}
// внешний контур области (обход Мура), точки — углы пикселей
function contour(comp, w, h, c) {
  let sx = -1, sy = -1;
  for (let y = c.y1; y <= c.y2 && sx < 0; y++) for (let x = c.x1; x <= c.x2; x++) if (comp[y * w + x]) { sx = x; sy = y; break; }
  const inM = (x, y) => x >= 0 && y >= 0 && x < w && y < h && comp[y * w + x] === 1;
  const nb = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const dirOf = (dx, dy) => nb.findIndex((d) => d[0] === dx && d[1] === dy);
  const pts = [[sx, sy]];
  let cx = sx, cy = sy, bi = 0;
  const limit = (c.x2 - c.x1 + 3) * (c.y2 - c.y1 + 3) * 4;
  for (let it = 0; it < limit; it++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const i = (bi + k) % 8, nx = cx + nb[i][0], ny = cy + nb[i][1];
      if (inM(nx, ny)) {
        const p = (i + 7) % 8, bx = cx + nb[p][0], by = cy + nb[p][1];
        cx = nx; cy = ny; bi = dirOf(bx - cx, by - cy); if (bi < 0) bi = 0;
        moved = true; break;
      }
    }
    if (!moved || (cx === sx && cy === sy)) break;
    pts.push([cx, cy]);
  }
  return pts.map((p) => [p[0] + 0.5, p[1] + 0.5]);
}
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// картинка игрока: кусок кадра по рамке области, вне области — прозрачно, край чуть мягче
function cutout(frame, comp, c, pad) {
  const w = frame.w, h = frame.h;
  const x1 = Math.max(0, c.x1 - pad), y1 = Math.max(0, c.y1 - pad), x2 = Math.min(w - 1, c.x2 + pad), y2 = Math.min(h - 1, c.y2 + pad);
  const cw = x2 - x1 + 1, ch = y2 - y1 + 1, rgba = new Uint8Array(cw * ch * 4);
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const i = y * w + x, o = ((y - y1) * cw + (x - x1)) * 4, s = i * 3;
    rgba[o] = frame.data[s]; rgba[o + 1] = frame.data[s + 1]; rgba[o + 2] = frame.data[s + 2];
    if (!comp[i]) { rgba[o + 3] = 0; continue; }
    const edge = (x > 0 && !comp[i - 1]) || (x < w - 1 && !comp[i + 1]) || (y > 0 && !comp[i - w]) || (y < h - 1 && !comp[i + w]);
    rgba[o + 3] = edge ? 170 : 255;
  }
  return { x: x1, y: y1, w: cw, h: ch, rgba };
}
function result(frame, comp, c) {
  const poly = simplify(contour(comp, frame.w, frame.h, c), 1.1);
  const cut = cutout(frame, comp, c, 1);
  return { ok: true, frameW: frame.w, frameH: frame.h, area: c.n, contour: poly.slice(0, 600).map((p) => [p[0] / frame.w, p[1] / frame.h]),
    crop: { x: cut.x / frame.w, y: cut.y / frame.h, w: cut.w / frame.w, h: cut.h / frame.h, pw: cut.w, ph: cut.h }, rgba: cut.rgba };
}

// Щелчок по игроку. x, y — доля ширины/высоты кадра; box — рамка игрока от YOLOX (доли), если есть.
async function segment(opts) {
  const { appDir, userData, ffmpegPath, sourcePath, t, fps, srcW, srcH, x, y, box } = opts;
  userDir = userData || userDir;
  const p = await prepare({ appDir, userData });
  if (!p.ok) return p;
  const t0 = Date.now();
  const frame = await grab({ ffmpegPath, sourcePath, t, fps, srcW, srcH });
  const key = sourcePath + '|' + frameStart(t, fps).toFixed(3) + '|' + frame.w;
  let ce = embCache.find((e) => e.key === key);
  if (!ce) {
    ce = Object.assign({ key }, await encode(frame));
    embCache.unshift(ce); embCache.length = Math.min(embCache.length, 3);
  }
  const t1 = Date.now();
  const px = x * frame.w, py = y * frame.h;
  const pts = [{ x: px, y: py, label: 1 }];
  if (box && box.w > 0 && box.h > 0) {
    // рамка чуть шире найденной: клюшка и конёк часто выходят за неё
    const mx = box.w * frame.w * 0.12, my = box.h * frame.h * 0.06;
    pts.push({ x: Math.max(0, box.x * frame.w - mx), y: Math.max(0, box.y * frame.h - my), label: 2 }, { x: Math.min(frame.w - 1, (box.x + box.w) * frame.w + mx), y: Math.min(frame.h - 1, (box.y + box.h) * frame.h + my), label: 3 });
  } else pts.push({ x: 0, y: 0, label: -1 });
  const mask = await decode(ce, frame, pts);
  const c = component(mask, frame.w, frame.h, px, py);
  log('кадр ' + Number(t).toFixed(2) + ' с, ' + frame.w + 'x' + frame.h + (box ? ', с рамкой игрока' : ', без рамки') + ': кодировщик ' + (t1 - t0) + ' мс, маска ' + (Date.now() - t1) + ' мс, область ' + (c ? c.n : 0) + ' пикс.');
  if (!c || c.n < 30) return { ok: false, error: 'Не получилось выделить игрока в этой точке.' };
  if (c.n > frame.w * frame.h * 0.25) return { ok: false, error: 'Выделилось слишком много — похоже, не игрок.' };
  return result(frame, c.comp, c);
}

// Игрока обвели мышью: polygon — точки контура (доли кадра)
async function cutPolygon({ ffmpegPath, sourcePath, t, fps, srcW, srcH, polygon }) {
  const frame = await grab({ ffmpegPath, sourcePath, t, fps, srcW, srcH });
  const w = frame.w, h = frame.h, poly = polygon.map((p) => [p[0] * w, p[1] * h]);
  const comp = new Uint8Array(w * h);
  let y1 = h, y2 = -1, x1 = w, x2 = -1, n = 0;
  poly.forEach(([px, py]) => { y1 = Math.min(y1, Math.floor(py)); y2 = Math.max(y2, Math.ceil(py)); });
  y1 = Math.max(0, y1); y2 = Math.min(h - 1, y2);
  for (let y = y1; y <= y2; y++) { // заливка по строкам (правило чёт-нечет)
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xa, ya] = poly[i], [xb, yb] = poly[j];
      if ((ya > yc) !== (yb > yc)) xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) { comp[y * w + x] = 1; n++; if (x < x1) x1 = x; if (x > x2) x2 = x; }
    }
  }
  if (n < 30) return { ok: false, error: 'Контур слишком маленький — обведите игрока целиком.' };
  const c = { n, x1, y1, x2, y2 };
  const cut = cutout(frame, comp, c, 1);
  return { ok: true, frameW: w, frameH: h, area: n, contour: polygon, crop: { x: cut.x / w, y: cut.y / h, w: cut.w / w, h: cut.h / h, pw: cut.w, ph: cut.h }, rgba: cut.rgba };
}

module.exports = { FILES, missing, prepare, segment, cutPolygon, component, contour, simplify, cutout };
