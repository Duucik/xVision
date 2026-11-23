// Слежение за игроками: детектор людей (YOLOX) + привязка по положению, движению и цвету формы.
// Следим за ВСЕМИ людьми в кадре (а не только за выбранными): чужие игроки «занимают» свои рамки, поэтому подсветка не может
// перескочить на соседа. Движение камеры оценивается отдельно (motion.js) и вычитается из движения игроков.
// Модуль не зависит от Electron: кадры берёт у ffmpeg, нейросеть (infer) получает снаружи.
const { spawn } = require('child_process');
const { detectPeople, iou } = require('./yolox');
const motion = require('./motion');

const TRACK_W = 1024;      // ширина кадра для анализа: баланс скорости и точности
const MAX_PASS_SEC = 40;   // защита от слишком длинных проходов вперёд
const MAX_BACK_SEC = 15;   // назад кадры копятся в памяти — ограничиваем
const HIST_BINS = 12 + 3;  // 12 оттенков + белый/серый/тёмный

// ---------- кадры ----------
const HI_W = 1920;         // «крупный» кадр: общий план или панорамная камера, игроки мелкие — при ширине 1024 их не видно
function scaledSize(srcW, srcH, wantW) {
  const w = Math.min(wantW > 0 ? wantW : TRACK_W, srcW), h = Math.round((srcH * w / srcW) / 2) * 2;
  return { w: Math.round(w / 2) * 2, h };
}

// Поток кадров RGB из ffmpeg. onFrame(frame, index) может быть асинхронной — ffmpeg ждёт (обратное давление канала).
async function streamFrames(opts, onFrame, token) {
  const { ffmpegPath, sourcePath, start, duration, fps, fw, fh } = opts;
  const args = ['-v', 'error', '-nostdin', '-ss', Math.max(0, start).toFixed(3), '-t', duration.toFixed(3), '-i', sourcePath,
    '-vf', (fps ? 'fps=' + fps + ',' : '') + 'scale=' + fw + ':' + fh, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  proc.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
  if (token) token.kill = () => { try { proc.kill(); } catch (e) {} };
  const size = fw * fh * 3;
  let buf = Buffer.alloc(0), idx = 0;
  const done = new Promise((resolve) => proc.on('close', resolve));
  try {
    for await (const chunk of proc.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= size) {
        const data = Buffer.from(buf.subarray(0, size)); // копия, чтобы кадр жил дольше буфера
        buf = buf.subarray(size);
        await onFrame({ data, w: fw, h: fh }, idx++);
        if (token && token.cancelled) { proc.kill(); return idx; }
      }
    }
  } finally { try { proc.kill(); } catch (e) {} }
  await done;
  return idx;
}

async function grabFrame(opts) {
  let frame = null;
  const token = { cancelled: false };
  // без фильтра fps: он подбирает ближайший кадр к «сетке» времени и мог бы взять кадр на десятые доли секунды в стороне
  await streamFrames(Object.assign({}, opts, { duration: 0.3, fps: 0 }), async (f, i) => { if (i === 0) { frame = f; token.cancelled = true; } }, token);
  return frame;
}

// ---------- внешний вид (цветовая гистограмма формы) ----------
function histogram(frame, b) {
  const h = new Float32Array(HIST_BINS);
  const x1 = Math.max(0, Math.round(b.x1 + (b.x2 - b.x1) * 0.2)), x2 = Math.min(frame.w, Math.round(b.x1 + (b.x2 - b.x1) * 0.8));
  const y1 = Math.max(0, Math.round(b.y1 + (b.y2 - b.y1) * 0.12)), y2 = Math.min(frame.h, Math.round(b.y1 + (b.y2 - b.y1) * 0.6));
  let n = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * frame.w + x) * 3;
      const r = frame.data[i] / 255, g = frame.data[i + 1] / 255, bl = frame.data[i + 2] / 255;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn;
      const v = mx, s = mx === 0 ? 0 : d / mx;
      let bin;
      if (v < 0.28) bin = 14;                       // тёмное
      else if (s < 0.22) bin = v > 0.7 ? 12 : 13;   // белое / серое
      else {
        let hue;
        if (d === 0) hue = 0;
        else if (mx === r) hue = ((g - bl) / d) % 6;
        else if (mx === g) hue = (bl - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue = (hue * 60 + 360) % 360;
        bin = Math.min(11, Math.floor(hue / 30));
      }
      h[bin]++; n++;
    }
  }
  if (n > 0) for (let k = 0; k < HIST_BINS; k++) h[k] /= n;
  return h;
}
function histDist(a, b) { // расстояние Бхаттачарьи: 0 — одинаково, 1 — совсем разное
  let bc = 0;
  for (let k = 0; k < HIST_BINS; k++) bc += Math.sqrt(a[k] * b[k]);
  return Math.sqrt(Math.max(0, 1 - bc));
}

// ---------- смена плана ----------
// Миниатюра кадра 32x18 (среднее по блокам) — по ней видно жёсткую склейку камеры: плавный поворот камеры
// меняет картинку мало, а склейка — почти целиком.
function thumb(frame) {
  const TW = 32, TH = 18, out = new Float32Array(TW * TH * 3), cnt = new Float32Array(TW * TH);
  const sx = frame.w / TW, sy = frame.h / TH;
  for (let y = 0; y < frame.h; y += 3) {
    const ty = Math.min(TH - 1, Math.floor(y / sy));
    for (let x = 0; x < frame.w; x += 3) {
      const tx = Math.min(TW - 1, Math.floor(x / sx)), k = ty * TW + tx, i = (y * frame.w + x) * 3;
      out[k * 3] += frame.data[i]; out[k * 3 + 1] += frame.data[i + 1]; out[k * 3 + 2] += frame.data[i + 2]; cnt[k]++;
    }
  }
  for (let k = 0; k < TW * TH; k++) if (cnt[k]) { out[k * 3] /= cnt[k]; out[k * 3 + 1] /= cnt[k]; out[k * 3 + 2] /= cnt[k]; }
  return out;
}
function thumbDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
const MAX_COAST = 6;       // сколько отсчётов подряд (при 8 к/с ≈ 0,75 с) терпим без детектора, дальше выбранный игрок потерян
const MAX_COAST_OTHER = 5; // то же для «чужих» игроков (они нужны, чтобы занимать свои рамки)
const SPAWN_SCORE = 0.35;  // новый «чужой» трек заводим только по уверенной рамке детектора
const MAX_COST = 0.55;     // выше этой «цены» рамку игроку не отдаём
const TILE = 640, TILE_OVERLAP = 256; // окна детектора: нейросеть смотрит 640x640 — кадр шире режем на перекрывающиеся окна

// Склейка (смена плана): сравниваем миниатюры и проверяем, нашла ли оценка движения камеры общее смещение фона.
// Плавный поворот камеры меняет картинку заметно, но фон при этом «сходится»; при склейке — нет.
function isCut(mad, mot) {
  if (mad > 22 && mot.conf === 0) return true;
  if (mad > 30 && mot.qIn > 28) return true;
  return false;
}

// ---------- задача о назначениях (венгерский алгоритм) ----------
// a — квадратная матрица стоимостей; возвращает для каждой строки номер столбца
function hungarian(a) {
  const n = a.length, INF = 1e9;
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF), used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Int32Array(n);
  for (let j = 1; j <= n; j++) res[p[j] - 1] = j - 1;
  return res;
}
// cost[i][j] — «цена» пары трек i — рамка j (Infinity — нельзя). Возвращает Map: трек -> рамка. Пара берётся, только если цена < MAX_COST.
function assign(cost, n, m) {
  if (!n || !m) return new Map();
  const K = n + m, BIG = 1e4, UNM = MAX_COST / 2;
  const A = [];
  for (let i = 0; i < K; i++) {
    const row = new Array(K).fill(BIG);
    A.push(row);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) A[i][j] = cost[i][j] < MAX_COST ? cost[i][j] : BIG;
  for (let i = 0; i < n; i++) A[i][m + i] = UNM;
  for (let j = 0; j < m; j++) A[n + j][j] = UNM;
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) A[n + j][m + i] = 0;
  const r = hungarian(A), out = new Map();
  for (let i = 0; i < n; i++) if (r[i] < m && cost[i][r[i]] < MAX_COST) out.set(i, r[i]);
  return out;
}

// ---------- обнаружение людей по всему кадру ----------
function tileStarts(n) {
  if (n <= TILE) return [0];
  const k = Math.ceil((n - TILE) / (TILE - TILE_OVERLAP)) + 1, out = [];
  for (let i = 0; i < k; i++) out.push(Math.round((n - TILE) * i / (k - 1)));
  return out;
}
// Кадр режется на окна 640x640 в родном масштабе (мелкие игроки видны лучше, чем при сжатии всего кадра в 640 пикселей).
// region — если задано, смотрим только одно окно (окрестность выбранных игроков): так вдвое быстрее.
async function detectAll(infer, frame, thr, region) {
  const fw = frame.w, fh = frame.h, rw = Math.min(TILE, fw), rh = Math.min(TILE, fh);
  const xs = region ? [region.x] : tileStarts(fw), ys = region ? [region.y] : tileStarts(fh), all = [];
  for (const y0 of ys) for (const x0 of xs) {
    const dets = await detectPeople(infer, frame, { x: x0, y: y0, w: rw, h: rh }, thr);
    for (const b of dets) {
      // рамка, упирающаяся во внутренний край окна, обрезана окном — полную рамку даст соседнее окно
      if (x0 > 0 && b.x1 < x0 + 4) continue;
      if (x0 + rw < fw && b.x2 > x0 + rw - 4) continue;
      if (y0 > 0 && b.y1 < y0 + 4) continue;
      if (y0 + rh < fh && b.y2 > y0 + rh - 4) continue;
      all.push(b);
    }
  }
  all.sort((a, b) => b.score - a.score); // дубли из зон перекрытия окон
  const keep = [];
  for (const b of all) if (keep.every((k) => iou(k, b) <= 0.5 && ioa(b, k) < 0.85)) keep.push(b); // и «обрывки» внутри чужой рамки (голова, торс)
  return keep;
}

// доля площади рамки a, лежащая внутри рамки b
function ioa(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), area = (a.x2 - a.x1) * (a.y2 - a.y1);
  return area > 0 ? inter / area : 0;
}

function toBox(c) { // {cx,cy,w,h} -> {x1,y1,x2,y2}
  return { x1: c.cx - c.w / 2, y1: c.cy - c.h / 2, x2: c.cx + c.w / 2, y2: c.cy + c.h / 2 };
}
function fromBox(b) { return { cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, w: b.x2 - b.x1, h: b.y2 - b.y1 }; }

// ---------- обнаружение людей на одном кадре ----------
// Возвращает рамки в долях кадра (0–1)
// info (необязательно) — сюда пишется, что получилось: размер кадра анализа, пустой ли кадр, понадобился ли крупный кадр.
// trackW — ширина кадра анализа, если её уже выбрали раньше (тогда крупный кадр не подбирается заново).
async function detectFrame({ infer, ffmpegPath, sourcePath, t, srcW, srcH, info, trackW, noHi }) {
  let { w: fw, h: fh } = scaledSize(srcW, srcH, trackW);
  const frame = await grabFrame({ ffmpegPath, sourcePath, start: t, fw, fh });
  if (!frame) throw new Error('Не удалось получить кадр видео');
  const st = frameStats(frame);
  const blank = st.mean < 6 || st.spread < 5; // чёрный или одноцветный кадр — искать нечего
  let boxes = blank ? [] : await detectAll(infer, frame, 0.2);
  let hi = false;
  let triedHi = false;
  if (!blank && !noHi && !(trackW > 0) && boxes.length < 2 && srcW >= 1280) {
    const big = scaledSize(srcW, srcH, Math.min(srcW, HI_W));
    if (big.w >= fw * 1.2) {
      triedHi = true;
      const f2 = await grabFrame({ ffmpegPath, sourcePath, start: t, fw: big.w, fh: big.h });
      if (f2) {
        const b2 = await detectAll(infer, f2, 0.2);
        if (b2.length > boxes.length) { boxes = b2; fw = big.w; fh = big.h; hi = true; }
      }
    }
  }
  if (info) Object.assign(info, { fw, fh, hi, triedHi, trackW: hi ? fw : (trackW > 0 ? trackW : 0), blank, mean: Math.round(st.mean), spread: Math.round(st.spread), found: boxes.length });
  return boxes.map((b) => ({ x: b.x1 / fw, y: b.y1 / fh, w: (b.x2 - b.x1) / fw, h: (b.y2 - b.y1) / fh, score: b.score }));
}
// средняя яркость кадра и её разброс (по редкой сетке точек)
function frameStats(frame) {
  const { data, w, h } = frame;
  const stepX = Math.max(1, Math.floor(w / 64)), stepY = Math.max(1, Math.floor(h / 36));
  let n = 0, sum = 0, sum2 = 0;
  for (let y = 0; y < h; y += stepY) for (let x = 0; x < w; x += stepX) {
    const i = (y * w + x) * 3, v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    sum += v; sum2 += v * v; n++;
  }
  const mean = n ? sum / n : 0;
  return { mean, spread: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0 };
}

// ---------- слежение ----------
// players: [{ id, anchor }] — рамки выбранных игроков в долях кадра на момент t0. Идём от t0 вперёд до `to` и назад до `from`.
// На каждом кадре: оцениваем движение камеры, находим ВСЕХ людей, сопоставляем их со всеми известными треками одним глобальным
// назначением (венгерский алгоритм). Выбранные игроки — это просто помеченные треки среди остальных.
// Возвращает { results: [{ id, samples, ends }] }; отсчёты { t, x, y, w, h, f } — доли кадра,
// f: 'a' — опорный, 'd' — найден детектором, 'p' — предсказан (игрок пропал)
async function trackPlayers(opts) {
  const { infer, ffmpegPath, sourcePath, srcW, srcH, t0, players, onProgress, token, onDebug } = opts;
  const from = Math.min(opts.from, t0), to = Math.max(opts.to, t0);
  const fps = opts.fps || 8;
  const { w: fw, h: fh } = scaledSize(srcW, srcH, opts.trackW); // trackW — если игроков нашли только на крупном кадре, следим тоже по нему
  const dt = 1 / fps;

  const anchorFrame = await grabFrame({ ffmpegPath, sourcePath, start: t0, fw, fh });
  if (!anchorFrame) throw new Error('Не удалось получить кадр видео');
  const anchorDets = await detectAll(infer, anchorFrame, 0.2);
  const anchorShared = () => ({ prevThumb: thumb(anchorFrame), prevP: motion.prepare(anchorFrame), lastMot: null });

  const total = Math.max(0.001, (to - t0) + (t0 - from));
  let doneSec = 0;
  const report = () => onProgress && onProgress(Math.min(100, Math.round(doneSec / total * 100)));
  const norm = (s, t) => ({ t: Math.round(t * 1000) / 1000, x: (s.cx - s.w / 2) / fw, y: (s.cy - s.h / 2) / fh, w: s.w / fw, h: s.h / fh, f: s.f });

  let uidSeq = 1;
  function makeTrack(c, hist, hlId) {
    return { uid: uidSeq++, hl: hlId, cx: c.cx, cy: c.cy, w: c.w, h: c.h, vx: 0, vy: 0, hist, missed: 0, stop: null };
  }

  // начальный «мир» на опорном кадре: выбранные игроки (по рамкам пользователя) и все остальные люди, найденные детектором
  function initWorld() {
    const tracks = [], hl = [];
    const used = new Set();
    players.forEach((pl) => {
      const a0 = { x1: pl.anchor.x * fw, y1: pl.anchor.y * fh, x2: (pl.anchor.x + pl.anchor.w) * fw, y2: (pl.anchor.y + pl.anchor.h) * fh };
      const T = makeTrack(fromBox(a0), histogram(anchorFrame, a0), pl.id);
      hl.push(T); tracks.push(T);
      anchorDets.forEach((d, i) => { if (iou(d, a0) > 0.35) used.add(i); }); // эта рамка детектора — тот же человек, второй трек не нужен
    });
    anchorDets.forEach((d, i) => {
      if (used.has(i) || d.score < SPAWN_SCORE) return;
      tracks.push(makeTrack(fromBox(d), histogram(anchorFrame, d), null));
    });
    return { tracks, hl };
  }

  // Один кадр: движение камеры -> предсказание положения всех треков -> цены пар -> назначение -> обновление.
  // Возвращает отсчёты выбранных игроков или null (склейка: слежение окончено).
  async function stepAll(world, frame, shared) {
    if (token && token.cancelled) throw new Error('cancelled');
    const th = thumb(frame), P = motion.prepare(frame);
    const mad = thumbDiff(shared.prevThumb, th);
    let mot = motion.estimate(shared.prevP, P);
    shared.prevThumb = th; shared.prevP = P;
    if (isCut(mad, mot)) {
      world.hl.forEach((T) => { if (!T.stop) T.stop = 'cut'; });
      world.tracks = [];
      return null;
    }
    if (mot.conf === 0) { // оценить не удалось (сильное размытие): считаем, что камера продолжает двигаться как прежде, но с запасом по поиску
      const l = shared.lastMot;
      mot = l ? { tx: l.tx * 0.6, ty: l.ty * 0.6, a: l.a * 0.6, b: l.b * 0.6, c: l.c * 0.6, d: l.d * 0.6, conf: 0 } : { tx: 0, ty: 0, a: 0, b: 0, c: 0, d: 0, conf: 0 };
    } else shared.lastMot = mot;
    const z = motion.zoomOf(mot);
    const gateMul = mot.conf >= 0.8 ? 1 : mot.conf > 0 ? 1.3 : 1.6;

    const active = world.tracks.filter((T) => !T.stop);
    // предсказание: положение в новом кадре = положение, сдвинутое движением камеры, плюс собственная скорость игрока
    active.forEach((T) => {
      const wp = motion.warpPoint(mot, T.cx, T.cy, fw, fh);
      T.mx = wp.x; T.my = wp.y; T.mw = T.w * z; T.mh = T.h * z;
      T.px = wp.x + T.vx * dt; T.py = wp.y + T.vy * dt;
      T.pred = toBox({ cx: T.px, cy: T.py, w: T.mw, h: T.mh });
    });
    // Где искать людей. Если все выбранные игроки уверенно ведутся и помещаются в одно окно 640x640 вместе с соседями —
    // смотрим только это окно (один прогон нейросети). Иначе — весь кадр.
    let region = null;
    const hlA = active.filter((T) => T.hl !== null);
    if ((fw > TILE || fh > TILE) && hlA.length && hlA.every((T) => T.missed < 2)) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      hlA.forEach((T) => {
        const r = Math.max(120, 2.6 * T.mh);
        x1 = Math.min(x1, T.px - r); x2 = Math.max(x2, T.px + r);
        y1 = Math.min(y1, T.py - r * 0.8); y2 = Math.max(y2, T.py + r * 0.8);
      });
      const rw = Math.min(TILE, fw), rh = Math.min(TILE, fh);
      if (x2 - x1 <= rw && y2 - y1 <= rh) {
        region = {
          x: Math.round(Math.max(0, Math.min(fw - rw, (x1 + x2) / 2 - rw / 2))),
          y: Math.round(Math.max(0, Math.min(fh - rh, (y1 + y2) / 2 - rh / 2))),
        };
      }
    }
    const dets = (await detectAll(infer, frame, 0.2, region)).map((b) => ({ b, c: fromBox(b), score: b.score, hist: null }));

    const cost = active.map((T) => {
      const scale = Math.max(30, T.mh), widen = (1 + Math.min(1.5, T.missed * 0.25)) * gateMul, appMax = T.missed >= 2 ? 0.45 : 0.62;
      if (onDebug && T.hl !== null) T.diag = [];
      return dets.map((D, j) => {
        const dpos = Math.hypot(D.c.cx - T.px, D.c.cy - T.py) / scale;
        if (dpos > 2.2 * widen) return Infinity;
        const sizeRatio = Math.max(D.c.h, T.mh) / Math.max(1, Math.min(D.c.h, T.mh));
        if (sizeRatio > 2.2) { if (T.diag) T.diag.push({ j, dpos: +dpos.toFixed(2), why: 'size' }); return Infinity; }
        if (!D.hist) D.hist = histogram(frame, D.b);
        const dapp = histDist(D.hist, T.hist);
        if (dapp > appMax) { if (T.diag) T.diag.push({ j, dpos: +dpos.toFixed(2), dapp: +dapp.toFixed(2), why: 'app' }); return Infinity; }
        const cst = 0.40 * Math.min(1, dpos / (2.2 * widen)) + 0.38 * dapp + 0.22 * (1 - iou(D.b, T.pred));
        const r = T.hl !== null ? cst * 0.85 : cst; // выбранные игроки в спорных случаях выигрывают
        if (T.diag) T.diag.push({ j, dpos: +dpos.toFixed(2), dapp: +dapp.toFixed(2), cost: +r.toFixed(2) });
        return r;
      });
    });
    const match = assign(cost, active.length, dets.length);

    const outs = [];
    const matchedDets = new Set();
    active.forEach((T, i) => {
      const j = match.get(i);
      let flag;
      if (j !== undefined) {
        const D = dets[j]; matchedDets.add(j);
        const c = D.c, dapp = histDist(D.hist, T.hist);
        const nvx = (c.cx - T.mx) / dt, nvy = (c.cy - T.my) / dt;
        const vmax = 6 * Math.max(30, T.mh);
        const clampV = (v) => Math.max(-vmax, Math.min(vmax, v));
        const ncx = 0.8 * c.cx + 0.2 * T.px, ncy = 0.8 * c.cy + 0.2 * T.py;
        const nw = 0.6 * c.w + 0.4 * T.mw, nh = 0.6 * c.h + 0.4 * T.mh;
        const ovx = clampV(0.5 * T.vx + 0.5 * nvx), ovy = clampV(0.5 * T.vy + 0.5 * nvy);
        T.cx = ncx; T.cy = ncy; T.w = nw; T.h = nh; T.vx = ovx; T.vy = ovy;
        if (dapp < 0.35) for (let q = 0; q < HIST_BINS; q++) T.hist[q] = 0.92 * T.hist[q] + 0.08 * D.hist[q];
        T.missed = 0; flag = 'd';
      } else {
        T.cx = T.px; T.cy = T.py; T.w = T.mw; T.h = T.mh; T.vx *= 0.8; T.vy *= 0.8;
        T.missed++; flag = 'p';
        const out = T.px < -T.w * 0.2 || T.px > fw + T.w * 0.2 || T.py < -T.h * 0.2 || T.py > fh + T.h * 0.2;
        if (T.hl !== null) { if (T.missed > MAX_COAST || out) T.stop = 'lost'; }
        else if (T.missed > MAX_COAST_OTHER || out) T.stop = 'gone';
      }
      if (T.hl !== null && !T.stop) outs.push({ T, s: { cx: T.cx, cy: T.cy, w: T.w, h: T.h, f: flag } });
    });
    // новые люди в кадре — новые «чужие» треки (рамка, уже занятая кем-то, второй трек не получает)
    const live = world.tracks.filter((T) => !T.stop && T.missed === 0);
    dets.forEach((D, j) => {
      if (matchedDets.has(j) || D.score < SPAWN_SCORE) return;
      if (live.some((T) => iou(toBox(T), D.b) > 0.3 || ioa(D.b, toBox(T)) > 0.75)) return; // этого человека уже ведёт другой трек
      if (!D.hist) D.hist = histogram(frame, D.b);
      world.tracks.push(makeTrack(D.c, D.hist, null));
    });
    // два трека на одном человеке: «чужой» дубль убираем (выбранного игрока не трогаем)
    const alive = world.tracks.filter((T) => !T.stop);
    alive.forEach((T) => {
      if (T.hl !== null || T.stop) return;
      if (alive.some((U) => U !== T && !U.stop && (U.hl !== null || U.uid < T.uid) && iou(toBox(U), toBox(T)) > 0.55)) T.stop = 'dup';
    });
    world.tracks = world.tracks.filter((T) => !T.stop || T.hl !== null);
    if (onDebug) onDebug({ world, mot, dets, frame });
    return outs;
  }

  const fwd = initWorld(), back = initWorld();
  const results = players.map((pl) => ({ id: pl.id, samples: [{ t: t0, x: pl.anchor.x, y: pl.anchor.y, w: pl.anchor.w, h: pl.anchor.h, f: 'a' }] }));
  const idx = new Map(players.map((pl, i) => [pl.id, i]));

  // вперёд: кадры идут потоком и обрабатываются сразу — память не копится
  if (to - t0 > dt * 0.5) {
    const shared = anchorShared();
    const dur = Math.min(MAX_PASS_SEC, to - t0);
    const fwdTok = { get cancelled() { return fwd.hl.every((T) => T.stop) || !!(token && token.cancelled); }, set kill(f) { if (token) token.kill = f; } };
    await streamFrames({ ffmpegPath, sourcePath, start: t0 + dt, duration: dur, fps, fw, fh }, async (f, i) => {
      if (fwd.hl.every((T) => T.stop)) return;
      if (onDebug) opts.dbgCtx = { dir: 'fwd', t: t0 + dt * (i + 1) };
      const res = await stepAll(fwd, f, shared);
      if (res) res.forEach(({ T, s }) => { results[idx.get(T.hl)].samples.push(norm(s, t0 + dt * (i + 1))); });
      doneSec += dt; report();
    }, fwdTok);
  }
  // назад: кадры нужны в обратном порядке, поэтому на этом проходе их приходится копить в памяти (до MAX_BACK_SEC)
  if (t0 - from > dt * 0.5) {
    const shared = anchorShared();
    const dur = Math.min(MAX_BACK_SEC, t0 - from);
    const frames = [];
    await streamFrames({ ffmpegPath, sourcePath, start: t0 - dur, duration: Math.max(dt, dur - dt * 0.4), fps, fw, fh }, async (f) => { frames.push(f); }, token);
    for (let k = frames.length - 1, n = 0; k >= 0; k--, n++) {
      if (back.hl.every((T) => T.stop)) break;
      if (onDebug) opts.dbgCtx = { dir: 'back', t: t0 - dt * (n + 1) };
      const res = await stepAll(back, frames[k], shared);
      frames[k] = null;
      if (res) res.forEach(({ T, s }) => { results[idx.get(T.hl)].samples.push(norm(s, t0 - dt * (n + 1))); });
      doneSec += dt; report();
    }
  }

  return {
    results: results.map((r, i) => {
      const samples = r.samples.sort((a, b) => a.t - b.t);
      // хвосты из «предсказанных» отсчётов — это догадки, а не наблюдения: срезаем их по краям
      while (samples.length > 1 && samples[samples.length - 1].f === 'p') samples.pop();
      while (samples.length > 1 && samples[0].f === 'p') samples.shift();
      const sm = smoothSamples(samples);
      const lostEnd = fwd.hl[i].stop && sm[sm.length - 1].t < to - dt * 1.5;
      const lostStart = back.hl[i].stop && sm[0].t > from + dt * 1.5;
      return { id: r.id, samples: sm, ends: { after: lostEnd ? fwd.hl[i].stop : null, before: lostStart ? back.hl[i].stop : null } };
    }),
  };
}

// слежение за одним игроком (то же самое, но с одним трекером)
async function trackPlayer(opts) {
  const res = await trackPlayers(Object.assign({}, opts, { players: [{ id: '0', anchor: opts.anchor }] }));
  return { samples: res.results[0].samples, ends: res.results[0].ends };
}

// лёгкое сглаживание траектории (убирает дрожание рамки между отсчётами); опорный отсчёт не двигаем
function smoothSamples(s) {
  const out = s.map((p) => Object.assign({}, p));
  const wts = [0.25, 0.5, 0.25];
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i].f === 'a') continue;
    ['x', 'y', 'w', 'h'].forEach((key) => { out[i][key] = wts[0] * s[i - 1][key] + wts[1] * s[i][key] + wts[2] * s[i + 1][key]; });
  }
  return out;
}

module.exports = { HI_W, thumb, thumbDiff, detectFrame, detectAll, trackPlayer, trackPlayers, scaledSize, grabFrame, streamFrames, histogram, histDist, hungarian };
