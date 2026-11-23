// xVision · Тренерская — рисование хоккейной площадки и тактических обозначений (SVG).
// Один и тот же код рисует площадку в редакторе, в миниатюрах библиотеки, в печати/PDF и в PNG.
// Координаты — в футах, площадка 200 × 85 (размеры НХЛ), начало — левый верхний угол.
(function (global) {
  'use strict';
  const RW = 200, RH = 85, CR = 28;      // размеры и радиус углов
  const CY = RH / 2;
  const COL = {
    ice: '#FFFFFF', board: '#262A33', red: '#D4474E', blue: '#3D66B0', crease: '#CFE6F7', faint: '#E9EEF4',
  };
  // виды площадки: какую часть показываем (объекты хранятся в координатах всей площадки)
  const VIEWS = {
    full: { x: -2, y: -2, w: RW + 4, h: RH + 4, label: 'Вся площадка' },
    half: { x: 96, y: -2, w: 106, h: RH + 4, label: 'Половина' },
    zone: { x: 121, y: -2, w: 81, h: RH + 4, label: 'Зона' },
    neutral: { x: 64, y: -2, w: 72, h: RH + 4, label: 'Средняя зона' },
  };

  // Упражнение-картинка: вместо площадки — готовая схема (фото листа, картинка из другой программы).
  // Вид у такого упражнения называется 'img:<ширина/высота>'.
  function viewFor(name) {
    if (VIEWS[name]) return VIEWS[name];
    const m = /^img:([\d.]+)$/.exec(name || '');
    if (!m) return VIEWS.full;
    const ar = Math.min(3.2, Math.max(0.35, parseFloat(m[1]) || 1.6));
    // площадь кадра примерно как у площадки — тогда игроки и линии на картинке любого формата выглядят привычного размера
    const w = Math.round(Math.sqrt(20000 * ar) * 10) / 10;
    return (VIEWS[name] = { x: 0, y: 0, w, h: Math.round(w / ar * 100) / 100, label: 'Картинка', img: true });
  }
  function bgMarkup(bg, v) {
    return '<rect x="' + v.x + '" y="' + v.y + '" width="' + v.w + '" height="' + v.h + '" fill="#fff"/>' +
      '<image href="' + bg.data + '" x="' + v.x + '" y="' + v.y + '" width="' + v.w + '" height="' + v.h + '" preserveAspectRatio="xMidYMid meet"/>';
  }

  // ---------- обозначения ----------
  const LINE_STYLES = {
    skate: { label: 'Катание', arrow: true, straight: false },
    puck: { label: 'С шайбой', arrow: true, straight: false },
    back: { label: 'Спиной вперёд', arrow: true, straight: false },
    pass: { label: 'Передача', arrow: true, straight: true },
    shot: { label: 'Бросок', arrow: true, straight: true },
    lateral: { label: 'Приставными', arrow: true, straight: false },
    stop: { label: 'Остановка', arrow: false, straight: false },
    plain: { label: 'Линия', arrow: false, straight: false },
  };
  const PLAYERS = {
    F: { label: 'Нападающий', letter: 'Н', fill: '#1F7DC1' },
    D: { label: 'Защитник', letter: 'З', fill: '#D23C44' },
    G: { label: 'Вратарь', letter: 'В', fill: '#17171A' },
    C: { label: 'Тренер', letter: 'Т', fill: '#7A7F89' },
    O: { label: 'Игрок', letter: '', fill: '#FFFFFF' },
    X: { label: 'Соперник (X)', letter: '', fill: '#17171A' },
    T: { label: 'Соперник (треугольник)', letter: '', fill: '#17171A' },
  };
  const LINE_W = [0, 0.34, 0.5, 0.7, 0.95];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f2 = (n) => (Math.round(n * 100) / 100);

  // ---------- геометрия линий ----------
  // гладкая кривая через точки (Catmull-Rom), сразу в виде плотной ломаной
  function curvePoints(pts, seg) {
    if (pts.length < 2) return pts.slice();
    if (pts.length === 2) return pts.slice();
    seg = seg || 10;
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < seg; k++) {
        const t = k / seg, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }
  // равномерные точки по длине линии
  function resample(poly, step) {
    if (poly.length < 2) return poly.slice();
    const out = [poly[0].slice()];
    let carry = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 1e-9) continue;
      let pos = step - carry;
      while (pos <= d) { out.push([a[0] + (b[0] - a[0]) * pos / d, a[1] + (b[1] - a[1]) * pos / d]); pos += step; }
      carry = d - (pos - step);
    }
    const last = poly[poly.length - 1];
    const lo = out[out.length - 1];
    if (Math.hypot(last[0] - lo[0], last[1] - lo[1]) > step * 0.25) out.push(last.slice());
    else out[out.length - 1] = last.slice();
    return out;
  }
  function polyLen(p) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; }
  // обрезать линию с конца на длину d (место под наконечник)
  function trimEnd(p, d) {
    if (d <= 0 || p.length < 2) return p.slice();
    const out = p.slice();
    while (out.length > 1 && d > 0) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > d) { out[out.length - 1] = [b[0] - (b[0] - a[0]) * d / L, b[1] - (b[1] - a[1]) * d / L]; return out; }
      d -= L; out.pop();
    }
    return out;
  }
  function normals(p) {
    return p.map((pt, i) => {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      return [-dy / L, dx / L];
    });
  }
  function dPoly(p) { return p.length ? 'M' + p.map((q) => f2(q[0]) + ' ' + f2(q[1])).join('L') : ''; }
  function offsetPoly(p, off) { const n = normals(p); return p.map((q, i) => [q[0] + n[i][0] * off, q[1] + n[i][1] * off]); }
  function endDir(p) {
    const L = polyLen(p);
    const back = resample(p, 0.25);
    const e = back[back.length - 1];
    let k = back.length - 1, acc = 0;
    while (k > 0 && acc < Math.min(2, L * 0.4)) { acc += Math.hypot(back[k][0] - back[k - 1][0], back[k][1] - back[k - 1][1]); k--; }
    const s = back[k];
    const dx = e[0] - s[0], dy = e[1] - s[1], d = Math.hypot(dx, dy) || 1;
    return { x: e[0], y: e[1], ux: dx / d, uy: dy / d };
  }
  function arrowHead(p, size, color, open) {
    const d = endDir(p);
    const bx = d.x - d.ux * size, by = d.y - d.uy * size, nx = -d.uy, ny = d.ux, wv = size * 0.55;
    if (open) {
      return '<path d="M' + f2(bx + nx * wv) + ' ' + f2(by + ny * wv) + 'L' + f2(d.x) + ' ' + f2(d.y) + 'L' + f2(bx - nx * wv) + ' ' + f2(by - ny * wv) +
        '" fill="none" stroke="' + color + '" stroke-width="' + f2(size * 0.24) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    return '<path d="M' + f2(d.x) + ' ' + f2(d.y) + 'L' + f2(bx + nx * wv) + ' ' + f2(by + ny * wv) + 'L' + f2(bx - nx * wv) + ' ' + f2(by - ny * wv) + 'Z" fill="' + color + '"/>';
  }
  // линия с волной (с шайбой / спиной вперёд); волна гаснет у концов
  function wave(p, amp, len) {
    const r = resample(p, 0.2), n = normals(r), L = polyLen(r);
    let s = 0;
    return r.map((q, i) => {
      if (i) s += Math.hypot(q[0] - r[i - 1][0], q[1] - r[i - 1][1]);
      const fade = Math.min(1, s / 1.2, (L - s) / 1.2);
      const a = amp * Math.max(0, fade) * Math.sin(2 * Math.PI * s / len);
      return [q[0] + n[i][0] * a, q[1] + n[i][1] * a];
    });
  }

  function lineMarkup(o, opts) {
    const st = LINE_STYLES[o.style] || LINE_STYLES.skate;
    const pts = o.straight || o.pts.length < 3 ? [o.pts[0], o.pts[o.pts.length - 1]] : curvePoints(o.pts, 8);
    if (pts.length < 2) return '';
    const c = o.color || '#17171A', w = LINE_W[o.w || 2] || 0.5;
    const arrow = o.arrow != null ? o.arrow : st.arrow;
    const ah = Math.max(1.5, w * 3.4);
    const body = arrow ? trimEnd(pts, ah * 0.75) : pts;
    let h = '';
    const strokeAttr = ' fill="none" stroke="' + c + '" stroke-width="' + f2(w) + '" stroke-linecap="round" stroke-linejoin="round"';
    switch (o.style) {
      case 'puck': h += '<path d="' + dPoly(wave(body, 0.85, 2.3)) + '"' + strokeAttr + '/>'; break;
      case 'back': h += '<path d="' + dPoly(wave(body, 0.85, 2.3)) + '"' + strokeAttr + ' stroke-dasharray="' + f2(w * 3.4) + ' ' + f2(w * 1.9) + '"/>'; break;
      case 'pass': h += '<path d="' + dPoly(body) + '"' + strokeAttr + ' stroke-dasharray="' + f2(w * 4.5) + ' ' + f2(w * 3.2) + '"/>'; break;
      case 'shot': {
        const g = Math.max(0.55, w * 1.15);
        h += '<path d="' + dPoly(offsetPoly(resample(body, 0.3), g)) + '"' + strokeAttr + '/>';
        h += '<path d="' + dPoly(offsetPoly(resample(body, 0.3), -g)) + '"' + strokeAttr + '/>';
        break;
      }
      case 'lateral': {
        h += '<path d="' + dPoly(body) + '"' + strokeAttr + ' stroke-opacity="0.35"/>';
        const r = resample(body, 1.7), n = normals(r);
        let t = '';
        for (let i = 1; i < r.length - 1; i++) t += 'M' + f2(r[i][0] + n[i][0] * 1.1) + ' ' + f2(r[i][1] + n[i][1] * 1.1) + 'L' + f2(r[i][0] - n[i][0] * 1.1) + ' ' + f2(r[i][1] - n[i][1] * 1.1);
        h += '<path d="' + t + '"' + strokeAttr + '/>';
        break;
      }
      default: h += '<path d="' + dPoly(body) + '"' + strokeAttr + '/>';
    }
    if (o.style === 'stop') {
      const d = endDir(pts), nx = -d.uy, ny = d.ux, bl = Math.max(1.6, w * 3.2);
      h += '<path d="M' + f2(d.x + nx * bl) + ' ' + f2(d.y + ny * bl) + 'L' + f2(d.x - nx * bl) + ' ' + f2(d.y - ny * bl) + '"' + strokeAttr + ' stroke-width="' + f2(w * 1.4) + '"/>';
    }
    if (arrow) h += arrowHead(pts, o.style === 'shot' ? ah * 1.25 : ah, c, o.style === 'shot' || o.style === 'pass');
    if (opts && opts.interactive) h = '<path class="hit" d="' + dPoly(pts) + '" fill="none" stroke="transparent" stroke-width="3.2" stroke-linecap="round"/>' + h;
    return h;
  }

  function playerMarkup(o) {
    const P = PLAYERS[o.kind] || PLAYERS.O;
    const s = o.s || 1;
    const fill = o.color || P.fill;
    const label = o.label != null ? o.label : P.letter;
    let h = '';
    if (o.kind === 'X') {
      const k = 2.2 * s;
      h += '<path d="M' + -k + ' ' + -k + 'L' + k + ' ' + k + 'M' + k + ' ' + -k + 'L' + -k + ' ' + k + '" stroke="' + fill + '" stroke-width="' + f2(0.62 * s) + '" stroke-linecap="round"/>';
    } else if (o.kind === 'T') {
      const k = 2.9 * s;
      h += '<path d="M0 ' + f2(-k) + 'L' + f2(k * 0.95) + ' ' + f2(k * 0.72) + 'L' + f2(-k * 0.95) + ' ' + f2(k * 0.72) + 'Z" fill="' + fill + '"/>';
    } else {
      const light = o.kind === 'O' || isLight(fill);
      h += '<circle r="' + f2(2.75 * s) + '" fill="' + fill + '" stroke="' + (light ? '#17171A' : '#FFFFFF') + '" stroke-width="' + f2((light ? 0.4 : 0.32) * s) + '"/>';
    }
    // «З1», «Н12»: буква в кружке, номер — маленьким значком снизу справа (чтобы «З1» не читалось как «31»)
    const m = /^(\D+?)(\d+)$/.exec(String(label || ''));
    if (m && o.kind !== 'X' && o.kind !== 'T') {
      const fs = Math.max(1.5, (2.9 - 0.5 * Math.max(0, m[1].length - 1))) * s;
      const ink = isLight(fill) ? '#17171A' : '#FFFFFF';
      const bx = 2.5 * s, by = 2.05 * s, br = Math.max(1.2, 0.68 + 0.5 * m[2].length) * s;
      h += '<text font-size="' + f2(fs) + '" text-anchor="middle" dominant-baseline="central" fill="' + ink + '" font-weight="700" font-family="Inter, Segoe UI, Arial, sans-serif">' + esc(m[1]) + '</text>';
      h += '<rect x="' + f2(bx - br) + '" y="' + f2(by - 1.2 * s) + '" width="' + f2(br * 2) + '" height="' + f2(2.4 * s) + '" rx="' + f2(1.2 * s) + '" fill="#FFFFFF" stroke="#17171A" stroke-width="' + f2(0.22 * s) + '"/>';
      h += '<text x="' + f2(bx) + '" y="' + f2(by + 0.05 * s) + '" font-size="' + f2(1.75 * s) + '" text-anchor="middle" dominant-baseline="central" fill="#17171A" font-weight="800" font-family="Inter, Segoe UI, Arial, sans-serif">' + esc(m[2]) + '</text>';
    } else if (label) {
      const fs = Math.max(1.5, (2.9 - 0.5 * Math.max(0, String(label).length - 1))) * s;
      const ink = (o.kind === 'X' || o.kind === 'T') ? '#FFFFFF' : (isLight(fill) ? '#17171A' : '#FFFFFF');
      const dy = o.kind === 'T' ? 0.65 * s : 0;
      if (o.kind === 'X') {
        h += '<text y="' + f2(-3 * s) + '" font-size="' + f2(fs * 0.8) + '" text-anchor="middle" fill="#17171A" font-weight="700" font-family="Inter, Segoe UI, Arial, sans-serif">' + esc(label) + '</text>';
      } else {
        h += '<text y="' + f2(dy) + '" font-size="' + f2(fs) + '" text-anchor="middle" dominant-baseline="central" fill="' + ink + '" font-weight="700" font-family="Inter, Segoe UI, Arial, sans-serif">' + esc(label) + '</text>';
      }
    }
    return '<g transform="translate(' + f2(o.x) + ' ' + f2(o.y) + ')' + (o.rot ? ' rotate(' + f2(o.rot) + ')' : '') + '">' + h + '</g>';
  }
  function isLight(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62;
  }

  // инвентарь; ink — цвет тёмных деталей (в значках на тёмной панели он светлый)
  function netPath(k) {
    return '<path d="M0 ' + -3 * k + ' L' + -2.2 * k + ' ' + -3 * k + ' Q' + -3.6 * k + ' ' + -3 * k + ' ' + -3.6 * k + ' ' + -1.6 * k + ' L' + -3.6 * k + ' ' + 1.6 * k +
      ' Q' + -3.6 * k + ' ' + 3 * k + ' ' + -2.2 * k + ' ' + 3 * k + ' L0 ' + 3 * k + '" fill="rgba(212,71,78,0.08)" stroke="#D4474E" stroke-width="' + f2(0.5 * Math.max(0.7, k)) + '" stroke-linejoin="round"/>' +
      '<path d="M' + -1 * k + ' ' + -2.6 * k + 'L' + -1 * k + ' ' + 2.6 * k + 'M' + -2.2 * k + ' ' + -2.8 * k + 'L' + -2.2 * k + ' ' + 2.8 * k + 'M' + -3.2 * k + ' ' + -1.5 * k + 'L' + -0.2 * k + ' ' + -1.5 * k +
      'M' + -3.4 * k + ' 0L' + -0.2 * k + ' 0M' + -3.2 * k + ' ' + 1.5 * k + 'L' + -0.2 * k + ' ' + 1.5 * k + '" stroke="#D4474E" stroke-width="0.12" opacity="0.6"/>';
  }
  // собственный размер предметов на площадке (чтобы мелочь была заметна)
  const ITEM_BASE = { puck: 1.25, pucks: 1.15, cone: 1.15, marker: 1.35, pole: 1.1, tire: 1.1, mininet: 1.35, tripod: 1.1 };
  function itemMarkup(o) {
    const sc = (o.s || 1) * (ITEM_BASE[o.type] || 1);
    const tr = 'translate(' + f2(o.x) + ' ' + f2(o.y) + ')' + (o.rot ? ' rotate(' + f2(o.rot) + ')' : '') + (sc !== 1 ? ' scale(' + f2(sc) + ')' : '');
    const ink = o.ink || '#17171A';
    let h = '';
    switch (o.type) {
      case 'puck': h = '<circle r="0.8" fill="' + ink + '"/>'; break;
      case 'pucks':
        [[0, 0], [1.6, 0.4], [-1.5, 0.5], [0.4, 1.6], [-0.6, -1.4], [1.2, -1.3], [-1.6, -0.9]].forEach((p) => { h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="0.66" fill="' + ink + '"/>'; });
        break;
      case 'cone':
        h = '<path d="M0 -2.4L1.3 1.3L-1.3 1.3Z" fill="#F0761E"/><rect x="-1.9" y="1.2" width="3.8" height="0.75" rx="0.3" fill="#C9561A"/><path d="M-0.6 -0.55L0.6 -0.55" stroke="#fff" stroke-width="0.38"/>';
        break;
      case 'marker': { // плоская фишка
        const c = o.color || '#F2B21B';
        h = '<ellipse cx="0" cy="0.25" rx="1.75" ry="1.05" fill="rgba(0,0,0,0.18)"/><ellipse rx="1.65" ry="1" fill="' + c + '"/><ellipse cy="-0.15" rx="0.7" ry="0.4" fill="rgba(255,255,255,0.55)"/>';
        break;
      }
      case 'pole': // стойка для обводки
        h = '<ellipse cy="2.2" rx="1.5" ry="0.55" fill="#4A4D55"/><rect x="-0.38" y="-2.8" width="0.76" height="5" rx="0.3" fill="#E23B3B"/>' +
          '<rect x="-0.38" y="-1.6" width="0.76" height="0.7" fill="#fff"/><rect x="-0.38" y="0.2" width="0.76" height="0.7" fill="#fff"/>';
        break;
      case 'tire': h = '<circle r="2" fill="none" stroke="' + ink + '" stroke-width="0.9"/><circle r="2" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="0.18" stroke-dasharray="0.5 0.5"/>'; break;
      case 'stick': case 'stickL': { // клюшка: рукоять и крюк
        const m = o.type === 'stickL' ? -1 : 1;
        h = '<g transform="scale(' + m + ' 1)"><path d="M-3.6 -2.6L2.1 1.25" stroke="' + ink + '" stroke-width="0.5" stroke-linecap="round"/>' +
          '<path d="M1.85 1.05 Q2.4 1.75 3.9 1.55" fill="none" stroke="' + ink + '" stroke-width="0.95" stroke-linecap="round"/>' +
          '<path d="M-3.6 -2.6L-2.6 -1.9" stroke="#fff" stroke-opacity="0.5" stroke-width="0.25" stroke-linecap="round"/></g>';
        break;
      }
      case 'bar': { // планка/барьер на льду
        const c = o.color || '#E5B323';
        h = '<rect x="-3.8" y="-0.45" width="7.6" height="0.9" rx="0.35" fill="' + c + '" stroke="' + ink + '" stroke-width="0.18"/>' +
          '<rect x="-4.2" y="-0.85" width="0.7" height="1.7" rx="0.2" fill="' + ink + '"/><rect x="3.5" y="-0.85" width="0.7" height="1.7" rx="0.2" fill="' + ink + '"/>';
        break;
      }
      case 'ladder': { // координационная лестница
        const c = o.color || '#E5B323';
        let r = '';
        for (let x = -4.5; x <= 4.51; x += 1.5) r += 'M' + f2(x) + ' -1.2L' + f2(x) + ' 1.2';
        h = '<path d="M-5 -1.2H5M-5 1.2H5" stroke="' + c + '" stroke-width="0.32"/><path d="' + r + '" stroke="' + c + '" stroke-width="0.32"/>';
        break;
      }
      case 'tripod': { // тринога: три ножки из центра (вид сверху)
        let legs = '';
        [-90, 30, 150].forEach((a) => { const r = a * Math.PI / 180; legs += 'M0 0L' + f2(Math.cos(r) * 2.3) + ' ' + f2(Math.sin(r) * 2.3); });
        h = '<path d="' + legs + '" stroke="' + ink + '" stroke-width="0.42" stroke-linecap="round"/>';
        [-90, 30, 150].forEach((a) => { const r = a * Math.PI / 180; h += '<circle cx="' + f2(Math.cos(r) * 2.3) + '" cy="' + f2(Math.sin(r) * 2.3) + '" r="0.42" fill="#F0761E"/>'; });
        h += '<circle r="0.85" fill="#F0761E" stroke="' + ink + '" stroke-width="0.25"/>';
        break;
      }
      case 'mat': { // мат
        const c = o.color || '#2F6FC0';
        h = '<rect x="-4.2" y="-2.6" width="8.4" height="5.2" rx="0.5" fill="' + c + '" fill-opacity="0.85" stroke="' + ink + '" stroke-opacity="0.55" stroke-width="0.18"/>' +
          '<path d="M-1.4 -2.6V2.6M1.4 -2.6V2.6" stroke="#fff" stroke-opacity="0.45" stroke-width="0.16"/>';
        break;
      }
      case 'boarder': { // бордер — прямоугольный мат с бортиком, от которого отскакивает шайба
        const c = o.color || '#2E4A78';
        h = '<rect x="-4.6" y="-2.2" width="9.2" height="4.4" rx="0.45" fill="' + c + '" fill-opacity="0.88" stroke="' + ink + '" stroke-width="0.2"/>' +
          '<rect x="-4.6" y="-2.2" width="9.2" height="1" rx="0.4" fill="' + ink + '"/>' +
          '<path d="M-3.9 0.4H3.9M-3.9 1.3H3.9" stroke="#fff" stroke-opacity="0.35" stroke-width="0.14" stroke-dasharray="0.6 0.45"/>';
        break;
      }
      case 'dangler': { // тренажёр для дриблинга: рама и низкие дуги, под которыми проводят шайбу
        const c = o.color || '#E8801E';
        h = '<rect x="-4.4" y="-1.7" width="8.8" height="3.4" rx="0.5" fill="none" stroke="' + ink + '" stroke-width="0.4"/>';
        [-2.6, 0, 2.6].forEach((x) => { h += '<path d="M' + f2(x - 0.55) + ' -1.7Q' + f2(x + 0.75) + ' 0 ' + f2(x - 0.55) + ' 1.7" fill="none" stroke="' + c + '" stroke-width="0.5" stroke-linecap="round"/>'; });
        [[-4.4, -1.7], [4.4, -1.7], [-4.4, 1.7], [4.4, 1.7]].forEach((p) => { h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="0.42" fill="' + ink + '"/>'; });
        break;
      }
      case 'net': h = netPath(1); break;           // ворота: открытая сторона смотрит вправо (rot = 0)
      case 'mininet': h = netPath(0.55); break;
      default: h = '';
    }
    return '<g transform="' + tr + '">' + h + '</g>';
  }
  function textMarkup(o) {
    const lines = String(o.text || '').split('\n');
    const fs = o.size || 3;
    let h = '<text x="' + f2(o.x) + '" y="' + f2(o.y) + '" font-size="' + f2(fs) + '" fill="' + (o.color || '#17171A') + '" font-weight="700" font-family="Inter, Segoe UI, Arial, sans-serif"' +
      (o.rot ? ' transform="rotate(' + f2(o.rot) + ' ' + f2(o.x) + ' ' + f2(o.y) + ')"' : '') + '>';
    lines.forEach((ln, i) => { h += '<tspan x="' + f2(o.x) + '" dy="' + (i === 0 ? f2(fs * 0.85) : f2(fs * 1.2)) + '">' + (esc(ln) || ' ') + '</tspan>'; });
    return h + '</text>';
  }
  function zoneMarkup(o) {
    const c = o.color || '#E3343C';
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const rot = o.rot ? ' transform="rotate(' + f2(o.rot) + ' ' + f2(cx) + ' ' + f2(cy) + ')"' : '';
    const fill = o.fill === false ? 'none' : c;
    const attr = ' fill="' + fill + '" fill-opacity="' + (o.fill === false ? 0 : 0.26) + '" stroke="' + c + '" stroke-width="0.35"' + (o.fill === false ? ' stroke-dasharray="1.4 0.9"' : '');
    if (o.shape === 'ellipse') return '<ellipse cx="' + f2(cx) + '" cy="' + f2(cy) + '" rx="' + f2(Math.abs(o.w) / 2) + '" ry="' + f2(Math.abs(o.h) / 2) + '"' + attr + rot + '/>';
    return '<rect x="' + f2(o.x) + '" y="' + f2(o.y) + '" width="' + f2(o.w) + '" height="' + f2(o.h) + '" rx="0.6"' + attr + rot + '/>';
  }
  function objectMarkup(o, opts) {
    let inner;
    if (o.type === 'line') inner = lineMarkup(o, opts);
    else if (o.type === 'player') inner = playerMarkup(o);
    else if (o.type === 'text') inner = textMarkup(o);
    else if (o.type === 'zone') inner = zoneMarkup(o);
    else inner = itemMarkup(o);
    return '<g class="obj" data-id="' + esc(o.id) + '">' + inner + '</g>';
  }

  // ---------- площадка ----------
  function rinkOutline() {
    return 'M' + CR + ' 0H' + (RW - CR) + 'A' + CR + ' ' + CR + ' 0 0 1 ' + RW + ' ' + CR + 'V' + (RH - CR) + 'A' + CR + ' ' + CR + ' 0 0 1 ' + (RW - CR) + ' ' + RH +
      'H' + CR + 'A' + CR + ' ' + CR + ' 0 0 1 0 ' + (RH - CR) + 'V' + CR + 'A' + CR + ' ' + CR + ' 0 0 1 ' + CR + ' 0Z';
  }
  function faceoffCircle(cx, cy) {
    let h = '<circle cx="' + cx + '" cy="' + cy + '" r="15" fill="none" stroke="' + COL.red + '" stroke-width="0.4"/>';
    h += '<circle cx="' + cx + '" cy="' + cy + '" r="1" fill="' + COL.red + '"/>';
    // «усы» на окружности
    let m = '';
    [-1, 1].forEach((sy) => [-2.9, 2.9].forEach((dx) => {
      const y0 = cy + sy * Math.sqrt(225 - dx * dx);
      m += 'M' + f2(cx + dx) + ' ' + f2(y0) + 'L' + f2(cx + dx) + ' ' + f2(y0 + sy * 2);
    }));
    // L-образные метки у точки вбрасывания
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) => {
      const x0 = cx + sx * 2, y0 = cy + sy * 0.75;
      m += 'M' + f2(x0 + sx * 4) + ' ' + f2(y0) + 'L' + f2(x0) + ' ' + f2(y0) + 'L' + f2(x0) + ' ' + f2(y0 + sy * 3);
    }));
    h += '<path d="' + m + '" fill="none" stroke="' + COL.red + '" stroke-width="0.35"/>';
    return h;
  }
  function goalArea(xg, dir, trap) {
    // dir = +1: ворота слева (площадь смотрит вправо), -1: справа
    let h = '';
    h += '<path d="M' + xg + ' ' + (CY - 4) + 'L' + (xg + dir * 4.5) + ' ' + (CY - 4) + 'A6 6 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + (xg + dir * 4.5) + ' ' + (CY + 4) + 'L' + xg + ' ' + (CY + 4) + 'Z" fill="' + COL.crease + '" stroke="' + COL.red + '" stroke-width="0.3"/>';
    // ворота за линией
    const bx = xg - dir * 3.4;
    h += '<path d="M' + xg + ' ' + (CY - 3) + 'L' + f2(xg - dir * 2.2) + ' ' + (CY - 3) + 'Q' + bx + ' ' + (CY - 3) + ' ' + bx + ' ' + (CY - 1.6) + 'L' + bx + ' ' + (CY + 1.6) +
      'Q' + bx + ' ' + (CY + 3) + ' ' + f2(xg - dir * 2.2) + ' ' + (CY + 3) + 'L' + xg + ' ' + (CY + 3) + '" fill="#fff" stroke="' + COL.red + '" stroke-width="0.45"/>';
    if (trap) { // трапеция за воротами
      const xe = dir > 0 ? 0 : RW;
      h += '<path d="M' + xg + ' ' + (CY - 11) + 'L' + xe + ' ' + (CY - 14) + 'M' + xg + ' ' + (CY + 11) + 'L' + xe + ' ' + (CY + 14) + '" stroke="' + COL.red + '" stroke-width="0.3"/>';
    }
    return h;
  }
  function logoMarkup(logo) {
    if (!logo || !logo.data) {
      return '<circle cx="100" cy="' + CY + '" r="0.6" fill="' + COL.blue + '"/>';
    }
    let h = '';
    const r = 11.5;
    if (logo.bg === 'dark') h += '<circle cx="100" cy="' + CY + '" r="' + (r + 1.6) + '" fill="#17171B"/>';
    const ar = logo.ar || 1;
    let w = r * 2, hh = w / ar;
    if (hh > r * 2 * 0.86) { hh = r * 2 * 0.86; w = hh * ar; }
    h += '<image href="' + logo.data + '" x="' + f2(100 - w / 2) + '" y="' + f2(CY - hh / 2) + '" width="' + f2(w) + '" height="' + f2(hh) + '" preserveAspectRatio="xMidYMid meet"' + (logo.bg === 'dark' ? '' : ' opacity="0.95"') + '/>';
    return h;
  }
  function rinkMarkup(logo, uid, trap) {
    const clip = 'rk' + (uid || '');
    let h = '<defs><clipPath id="' + clip + '"><path d="' + rinkOutline() + '"/></clipPath></defs>';
    h += '<path d="' + rinkOutline() + '" fill="' + COL.ice + '"/>';
    h += '<g clip-path="url(#' + clip + ')">';
    // линии ворот, синие, красная
    h += '<path d="M11 0V' + RH + 'M189 0V' + RH + '" stroke="' + COL.red + '" stroke-width="0.35"/>';
    h += '<rect x="74.5" y="0" width="1" height="' + RH + '" fill="' + COL.blue + '"/><rect x="124.5" y="0" width="1" height="' + RH + '" fill="' + COL.blue + '"/>';
    h += '<rect x="99.5" y="0" width="1" height="' + RH + '" fill="' + COL.red + '"/>';
    // круги и точки
    [[31, 20.5], [31, 64.5], [169, 20.5], [169, 64.5]].forEach((p) => { h += faceoffCircle(p[0], p[1]); });
    [[80, 20.5], [80, 64.5], [120, 20.5], [120, 64.5]].forEach((p) => { h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="1" fill="' + COL.red + '"/>'; });
    h += '<circle cx="100" cy="' + CY + '" r="15" fill="' + (logo && logo.data ? '#fff' : 'none') + '" stroke="' + COL.blue + '" stroke-width="0.4"/>';
    h += '<path d="M90 ' + RH + 'A10 10 0 0 1 110 ' + RH + '" fill="none" stroke="' + COL.red + '" stroke-width="0.3"/>';
    h += goalArea(11, 1, trap) + goalArea(189, -1, trap);
    h += logoMarkup(logo);
    h += '</g>';
    h += '<path d="' + rinkOutline() + '" fill="none" stroke="' + COL.board + '" stroke-width="1.1"/>';
    return h;
  }

  // порядок слоёв: зоны внизу, затем линии, надписи, предметы, игроки сверху
  const LAYER = { zone: 0, ladder: 0.5, mat: 0.5, boarder: 0.5, line: 1, text: 2, player: 4 }; // остальной инвентарь — слой 3
  function layered(objs) {
    return (objs || []).map((o, i) => [o, i]).sort((a, b) => ((LAYER[a[0].type] != null ? LAYER[a[0].type] : 3) - (LAYER[b[0].type] != null ? LAYER[b[0].type] : 3)) || a[1] - b[1]).map((x) => x[0]);
  }
  let uidSeq = 0;
  // Полная картинка: { view, logo:{data,ar,bg}, objects, interactive, className, width, height, uid, bg:{data,ar} }
  function svg(opts) {
    const v = viewFor(opts.view);
    const uid = opts.uid || ('u' + (++uidSeq));
    const size = (opts.width ? ' width="' + opts.width + '"' : '') + (opts.height ? ' height="' + opts.height + '"' : '');
    let h = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' + v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h + '"' + size +
      ' preserveAspectRatio="xMidYMid meet"' + (opts.className ? ' class="' + opts.className + '"' : '') + '>';
    h += '<g class="rink">' + (opts.bg && opts.bg.data ? bgMarkup(opts.bg, v) : rinkMarkup(opts.logo, uid, opts.trapezoid != null ? opts.trapezoid : global.Rink.trapezoid)) + '</g>';
    h += '<g class="objs">' + layered(opts.objects).map((o) => objectMarkup(o, opts)).join('') + '</g>';
    if (opts.interactive) h += '<g class="ui"></g>';
    return h + '</svg>';
  }

  // упрощение нарисованной от руки линии (Рамер — Дуглас — Пекер)
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let md = 0, mi = -1;
      const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
      const L = Math.hypot(bx - ax, by - ay) || 1e-9;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / L;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps && mi > 0) { keep[mi] = true; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((p, i) => keep[i]);
  }

  global.Rink = { trapezoid: false, ITEM_BASE, RW, RH, VIEWS, viewFor, LINE_STYLES, PLAYERS, LINE_W, svg, layered, objectMarkup, rinkMarkup, simplify, curvePoints, isLight, esc };
})(typeof window !== 'undefined' ? window : globalThis);
