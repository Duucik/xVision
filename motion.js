// Оценка движения камеры между двумя соседними кадрами (панорама, наклон, приближение).
// Нужна, чтобы отделить движение камеры от движения игрока: когда оператор резко ведёт камеру,
// все игроки в кадре «едут» вместе с фоном, и без этой поправки слежение путает соседей.
//
// Два шага:
//  1) фазовая корреляция (БПФ) по уменьшенным кадрам — грубо находит общий сдвиг даже при резком повороте;
//  2) сопоставление блоков фона вокруг найденного сдвига + устойчивая подгонка модели «сдвиг + масштаб».
// Модуль не зависит от Electron. Кадр: { data: RGB, w, h }.

const PW = 256, PH = 128;   // размер картинки для фазовой корреляции (степени двойки — для БПФ)
const BLOCK = 40;           // размер блока (в половинном разрешении)
const BSTEP = 56;           // шаг сетки блоков
const SEARCH = 6;           // поиск блока вокруг ожидаемого положения, ±пикселей (в половинном разрешении)

// ---------- БПФ ----------
const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const bits = Math.round(Math.log2(n)), rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}
function fft1d(re, im, n, inverse) {
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = sgn * sin[w];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}
function fft2d(re, im, W, H, inverse) {
  const rr = new Float64Array(Math.max(W, H)), ri = new Float64Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) { rr[x] = re[y * W + x]; ri[x] = im[y * W + x]; }
    fft1d(rr, ri, W, inverse);
    for (let x = 0; x < W; x++) { re[y * W + x] = rr[x]; im[y * W + x] = ri[x]; }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { rr[y] = re[y * W + x]; ri[y] = im[y * W + x]; }
    fft1d(rr, ri, H, inverse);
    for (let y = 0; y < H; y++) { re[y * W + x] = rr[y]; im[y * W + x] = ri[y]; }
  }
}

// ---------- подготовка кадра ----------
// gray — яркость в половинном разрешении; spec — спектр картинки границ (для фазовой корреляции)
function prepare(frame) {
  const gw = frame.w >> 1, gh = frame.h >> 1, d = frame.data;
  const gray = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i0 = ((2 * y) * frame.w + 2 * x) * 3, i1 = i0 + frame.w * 3;
      const s = d[i0] * 0.299 + d[i0 + 1] * 0.587 + d[i0 + 2] * 0.114 + d[i0 + 3] * 0.299 + d[i0 + 4] * 0.587 + d[i0 + 5] * 0.114
        + d[i1] * 0.299 + d[i1 + 1] * 0.587 + d[i1 + 2] * 0.114 + d[i1 + 3] * 0.299 + d[i1 + 4] * 0.587 + d[i1 + 5] * 0.114;
      gray[y * gw + x] = s / 4;
    }
  }
  // картинка PWxPH: берём кадр без верхних/нижних полос (там чаще всего табло и титры, неподвижные относительно экрана)
  const y0 = Math.floor(gh * 0.08), y1 = Math.floor(gh * 0.94);
  const sx = gw / PW, sy = (y1 - y0) / PH;
  const img = new Float64Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    const ya = y0 + y * sy;
    for (let x = 0; x < PW; x++) {
      const xa = x * sx;
      let s = 0, n = 0;
      for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
        const px = Math.min(gw - 1, Math.floor(xa + (xx + 0.5) * sx / 2)), py = Math.min(gh - 1, Math.floor(ya + (yy + 0.5) * sy / 2));
        s += gray[py * gw + px]; n++;
      }
      img[y * PW + x] = s / n;
    }
  }
  // границы: |dI/dx| + |dI/dy| — яркость льда и освещение почти не влияют
  const edge = new Float64Array(PW * PH);
  let mean = 0;
  for (let y = 1; y < PH - 1; y++) for (let x = 1; x < PW - 1; x++) {
    const v = Math.abs(img[y * PW + x + 1] - img[y * PW + x - 1]) + Math.abs(img[(y + 1) * PW + x] - img[(y - 1) * PW + x]);
    edge[y * PW + x] = v; mean += v;
  }
  mean /= PW * PH;
  const re = new Float64Array(PW * PH), im = new Float64Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / PH);
    for (let x = 0; x < PW; x++) {
      const wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / PW);
      re[y * PW + x] = (edge[y * PW + x] - mean) * wx * wy;
    }
  }
  fft2d(re, im, PW, PH, false);
  return { gw, gh, fw: frame.w, fh: frame.h, gray, re, im, sx, sy };
}

// ---------- шаг 1: общий сдвиг по фазовой корреляции ----------
function phaseShift(A, B) {
  const n = PW * PH, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // B * conj(A)
    const r = B.re[i] * A.re[i] + B.im[i] * A.im[i], m = B.im[i] * A.re[i] - B.re[i] * A.im[i];
    const mag = Math.hypot(r, m) + 1e-9;
    re[i] = r / mag; im[i] = m / mag;
  }
  fft2d(re, im, PW, PH, true);
  for (let i = 0; i < n; i++) re[i] /= n; // нормировка: пик 1 — полное совпадение
  let best = -1e9, bi = 0;
  for (let i = 0; i < n; i++) if (re[i] > best) { best = re[i]; bi = i; }
  const px = bi % PW, py = (bi / PW) | 0;
  // вторая вершина (вне окрестности первой) — для оценки уверенности
  let second = -1e9;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const ddx = Math.min(Math.abs(x - px), PW - Math.abs(x - px)), ddy = Math.min(Math.abs(y - py), PH - Math.abs(y - py));
    if (ddx <= 3 && ddy <= 3) continue;
    const v = re[y * PW + x]; if (v > second) second = v;
  }
  const at = (x, y) => re[((y + PH) % PH) * PW + ((x + PW) % PW)];
  const sub = (m1, c, p1) => { const d = m1 - 2 * c + p1; return Math.abs(d) < 1e-12 ? 0 : 0.5 * (m1 - p1) / d; };
  const fx = sub(at(px - 1, py), best, at(px + 1, py)), fy = sub(at(px, py - 1), best, at(px, py + 1));
  let sx = px + fx, sy = py + fy;
  if (sx > PW / 2) sx -= PW;
  if (sy > PH / 2) sy -= PH;
  // несколько лучших пиков (разные гипотезы сдвига): при размытии лучший пик иногда оказывается ложным
  const peaks = [{ sx, sy, v: best }];
  const used = [[px, py]];
  for (let k = 1; k < 5; k++) {
    let bv = -1e9, bx = 0, by = 0;
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      if (used.some(([ux, uy]) => Math.min(Math.abs(x - ux), PW - Math.abs(x - ux)) <= 4 && Math.min(Math.abs(y - uy), PH - Math.abs(y - uy)) <= 4)) continue;
      const v = re[y * PW + x]; if (v > bv) { bv = v; bx = x; by = y; }
    }
    used.push([bx, by]);
    let ax = bx, ay = by; if (ax > PW / 2) ax -= PW; if (ay > PH / 2) ay -= PH;
    peaks.push({ sx: ax, sy: ay, v: bv });
  }
  return { sx, sy, peak: best, ratio: best / Math.max(1e-6, second), peaks };
}

// ---------- шаг 2: блоки фона + устойчивая подгонка ----------
function blockMatch(A, B, tx, ty) {
  const gw = A.gw, gh = A.gh, a = A.gray, b = B.gray;
  const pts = [];
  const mx = BLOCK / 2 + SEARCH + Math.max(0, 0);
  for (let by = Math.round(gh * 0.12); by + BLOCK <= gh * 0.97; by += BSTEP) {
    for (let bx = 4; bx + BLOCK <= gw - 4; bx += BSTEP) {
      // текстура блока: на пустом льду сопоставлять нечего
      let m = 0, c = 0;
      for (let y = 0; y < BLOCK; y += 2) for (let x = 0; x < BLOCK; x += 2) { m += a[(by + y) * gw + bx + x]; c++; }
      m /= c;
      let v = 0;
      for (let y = 0; y < BLOCK; y += 2) for (let x = 0; x < BLOCK; x += 2) { const q = a[(by + y) * gw + bx + x] - m; v += q * q; }
      if (Math.sqrt(v / c) < 7) continue;
      let bestCost = 1e18, bdx = 0, bdy = 0, second = 1e18;
      const cx0 = Math.round(tx), cy0 = Math.round(ty);
      for (let dy = -SEARCH; dy <= SEARCH; dy++) {
        for (let dx = -SEARCH; dx <= SEARCH; dx++) {
          const ox = bx + cx0 + dx, oy = by + cy0 + dy;
          if (ox < 0 || oy < 0 || ox + BLOCK > gw || oy + BLOCK > gh) continue;
          let mb = 0;
          for (let y = 0; y < BLOCK; y += 2) for (let x = 0; x < BLOCK; x += 2) mb += b[(oy + y) * gw + ox + x];
          mb /= c;
          let s = 0;
          for (let y = 0; y < BLOCK; y += 2) {
            const ra = (by + y) * gw + bx, rb = (oy + y) * gw + ox;
            for (let x = 0; x < BLOCK; x += 2) s += Math.abs((a[ra + x] - m) - (b[rb + x] - mb));
          }
          if (s < bestCost) { second = bestCost; bestCost = s; bdx = cx0 + dx; bdy = cy0 + dy; }
          else if (s < second) second = s;
        }
      }
      if (bestCost >= 1e17) continue;
      pts.push({ X: bx + BLOCK / 2 - gw / 2, Y: by + BLOCK / 2 - gh / 2, U: bdx, V: bdy, q: bestCost / c });
    }
  }
  return pts;
}

// решение системы 3x3 (правило Крамера)
function solve3(m, r) {
  const D = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const d0 = D(m);
  if (Math.abs(d0) < 1e-12) return null;
  const col = (k) => m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
  return [D(col(0)) / d0, D(col(1)) / d0, D(col(2)) / d0];
}

// Подгонка смещений блоков моделью «сдвиг + масштаб/поворот/перекос» (аффинной):
//   U = tx + a*X + b*Y,  V = ty + c*X + d*Y  (X, Y — от центра кадра, в сотнях пикселей).
// Метод наименьших квадратов с весами: надёжные блоки (мало различий) весят больше, выбросы (игроки, табло) отбрасываются.
function fitModel(pts, init, thr) {
  const simple = pts.length < 8; // мало блоков — только сдвиг и масштаб
  let m = { tx: init.tx, ty: init.ty, a: 0, b: 0, c: 0, d: 0 };
  let w = pts.map((p) => 1 / (1 + (p.q / 10) * (p.q / 10)));
  for (let it = 0; it < 7; it++) {
    let S = 0, SX = 0, SY = 0, SXX = 0, SXY = 0, SYY = 0, bU = 0, bXU = 0, bYU = 0, bV = 0, bXV = 0, bYV = 0;
    pts.forEach((p, i) => {
      const wi = w[i], X = p.X / 100, Y = p.Y / 100;
      S += wi; SX += wi * X; SY += wi * Y; SXX += wi * X * X; SXY += wi * X * Y; SYY += wi * Y * Y;
      bU += wi * p.U; bXU += wi * X * p.U; bYU += wi * Y * p.U; bV += wi * p.V; bXV += wi * X * p.V; bYV += wi * Y * p.V;
    });
    if (S < 1e-6) break;
    if (simple) {
      // U = tx + a*X, V = ty + a*Y
      const mm = [[S, 0, SX], [0, S, SY], [SX, SY, SXX + SYY]];
      const sol = solve3(mm, [bU, bV, bXU + bYV]);
      if (sol) m = { tx: sol[0], ty: sol[1], a: sol[2] / 100, b: 0, c: 0, d: sol[2] / 100 };
    } else {
      const mm = [[S, SX, SY], [SX, SXX, SXY], [SY, SXY, SYY]];
      const su = solve3(mm, [bU, bXU, bYU]), sv = solve3(mm, [bV, bXV, bYV]);
      if (su && sv) m = { tx: su[0], ty: sv[0], a: su[1] / 100, b: su[2] / 100, c: sv[1] / 100, d: sv[2] / 100 };
    }
    const tau = it < 3 ? 3.5 : 2.0;
    w = pts.map((p) => {
      const r = Math.hypot(p.U - (m.tx + m.a * p.X + m.b * p.Y), p.V - (m.ty + m.c * p.X + m.d * p.Y));
      return (r > 3 * tau ? 0 : 1 / (1 + (r / tau) * (r / tau))) / (1 + (p.q / 10) * (p.q / 10));
    });
  }
  let inl = 0, qs = 0;
  pts.forEach((p) => { if (Math.hypot(p.U - (m.tx + m.a * p.X + m.b * p.Y), p.V - (m.ty + m.c * p.X + m.d * p.Y)) < thr) { inl++; qs += p.q; } });
  m.inliers = inl;
  m.qIn = inl ? qs / inl : 99; // средняя «цена» совпадения подтверждённых блоков: чем меньше, тем лучше
  return m;
}

// Возвращает движение кадра prev -> cur: точка (x,y) кадра prev оказывается на cur в
//   x' = x + tx + a*(x-cx) + b*(y-cy),  y' = y + ty + c*(x-cx) + d*(y-cy)
// conf: 0 — оценить не удалось, 1 — уверенно.
function estimate(A, B) {
  const ph = phaseShift(A, B);
  const k = A.fw / A.gw, INL = 3.0;
  const hyps = [{ tx: ph.peaks[0].sx * A.sx, ty: ph.peaks[0].sy * A.sy }];
  let best = null;
  const tryHyp = (h) => {
    const pts = blockMatch(A, B, h.tx, h.ty);
    if (pts.length < 4) return;
    const res = fitModel(pts, h, INL);
    res.n = pts.length;
    res.score = res.inliers / pts.length;
    if (!best || res.inliers > best.inliers) best = res;
  };
  tryHyp(hyps[0]);
  // первая гипотеза не подтвердилась (размытие, ложный пик) — пробуем другие пики и «камера стоит»
  if (!best || best.score < 0.5) {
    for (let i = 1; i < 4; i++) tryHyp({ tx: ph.peaks[i].sx * A.sx, ty: ph.peaks[i].sy * A.sy });
    tryHyp({ tx: 0, ty: 0 });
  }
  if (best && best.inliers >= Math.max(4, best.n * 0.35)) {
    return { tx: best.tx * k, ty: best.ty * k, a: best.a, b: best.b, c: best.c, d: best.d, conf: Math.min(1, best.inliers / 10), qIn: best.qIn, inliers: best.inliers, blocks: best.n, peak: ph.peak, method: 'blocks' };
  }
  if (ph.peak > 0.15 && ph.ratio > 1.5) {
    return { tx: ph.peaks[0].sx * A.sx * k, ty: ph.peaks[0].sy * A.sy * k, a: 0, b: 0, c: 0, d: 0, conf: 0.4, inliers: 0, blocks: best ? best.n : 0, peak: ph.peak, method: 'phase' };
  }
  return { tx: 0, ty: 0, a: 0, b: 0, c: 0, d: 0, conf: 0, inliers: 0, blocks: best ? best.n : 0, peak: ph.peak, method: 'none' };
}

// применить движение к точке (координаты кадра в пикселях)
function warpPoint(m, x, y, fw, fh) {
  const X = x - fw / 2, Y = y - fh / 2;
  return { x: x + m.tx + m.a * X + m.b * Y, y: y + m.ty + m.c * X + m.d * Y };
}
// масштаб изменения размера (приближение/отдаление камеры)
function zoomOf(m) { return 1 + (m.a + m.d) / 2; }

module.exports = { prepare, estimate, warpPoint, zoomOf, phaseShift, _blockMatch: blockMatch };
