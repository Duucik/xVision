// «Пауза на рисунке»: в экспортированном клипе видео замирает на нужном кадре на заданное время,
// затем идёт дальше. Модуль не зависит от Electron — собирает фильтр для ffmpeg.

// freezes: [{ t, dur, src? }] — t в секундах от начала клипа, dur — длительность вставки.
// Без src — стоп-кадр. С src = { a, b, speed } — повтор: в момент t вставляется отрезок клипа a–b,
// замедленный в speed раз (0.5 — вдвое медленнее), длительностью (b − a) / speed.
function normalizeFreezes(freezes, clipDuration) {
  return (Array.isArray(freezes) ? freezes : [])
    .map((f) => {
      const t = Math.min(Math.max(0, Number(f && f.t) || 0), clipDuration);
      const s = f && f.src;
      if (s) {
        const a = Math.min(Math.max(0, Number(s.a) || 0), clipDuration), b = Math.min(Math.max(0, Number(s.b) || 0), clipDuration);
        const speed = Math.min(10, Math.max(0.1, Number(s.speed) || 1)); // больше 1 бывает у повтора внутри замедленного клипа (общее замедление делается потом)
        if (b - a < 0.05) return { t, dur: 0 };
        return { t, dur: Math.min(600, (b - a) / speed), src: { a, b, speed } };
      }
      return { t, dur: Math.min(60, Number(f && f.dur) || 0) };
    })
    .filter((f) => f.dur > 0.02)
    .sort((a, b) => a.t - b.t);
}

function totalHold(freezes) { return freezes.reduce((a, f) => a + f.dur, 0); }

// Замедленные участки клипа: slows = [{ a, b, speed }] — секунды от начала клипа, speed 0.1–1 (0.5 — вдвое медленнее).
// Участки не пересекаются (пересекающиеся склеиваются, берётся скорость первого).
function normalizeSlows(slows, clipDuration) {
  const list = (Array.isArray(slows) ? slows : [])
    .map((s) => ({ a: Math.min(Math.max(0, Number(s && s.a) || 0), clipDuration), b: Math.min(Math.max(0, Number(s && s.b) || 0), clipDuration), speed: Math.min(1, Math.max(0.1, Number(s && s.speed) || 1)) }))
    .filter((s) => s.b - s.a > 0.04 && s.speed < 0.999)
    .sort((x, y) => x.a - y.a);
  const out = [];
  list.forEach((s) => { const p = out[out.length - 1]; if (p && s.a < p.b) p.b = Math.max(p.b, s.b); else out.push(s); });
  return out;
}
function slowExtra(slows) { return slows.reduce((a, s) => a + (s.b - s.a) * (1 / s.speed - 1), 0); }
// цепочка atempo: один фильтр замедляет звук не больше чем вдвое
function atempoChain(speed) {
  const parts = []; let r = speed;
  while (r < 0.5 - 1e-9) { parts.push('atempo=0.5'); r /= 0.5; }
  if (Math.abs(r - 1) > 1e-6) parts.push('atempo=' + r.toFixed(5));
  return parts.join(',');
}

function num(x) { return Number(x).toFixed(3); }

function buildFreezeGraph({ freezes, slows, clipDuration, hasAudio, hasOverlay, fps }) {
  const fz = normalizeFreezes(freezes, clipDuration);
  const sl = normalizeSlows(slows, clipDuration);
  const rateAt = (x) => { for (const s of sl) if (x >= s.a - 1e-6 && x < s.b - 1e-6) return s.speed; return 1; };
  // участки итогового клипа: «играет» исходник (в обычной скорости или замедленно), «стоп-кадр» или «повтор»
  const segs = [];
  const pushPlay = (a, b) => {
    const pts = [a].concat(...sl.map((s) => [s.a, s.b]).map((p) => p.filter((x) => x > a + 0.02 && x < b - 0.02)), [b]).sort((x, y) => x - y);
    for (let k = 0; k + 1 < pts.length; k++) {
      const x = pts[k], y = pts[k + 1];
      if (y - x > 0.02) segs.push({ kind: 'play', a: x, b: y, speed: rateAt((x + y) / 2) });
    }
  };
  let cursor = 0;
  fz.forEach((f) => {
    if (f.t - cursor > 0.02) pushPlay(cursor, f.t);
    if (f.src) segs.push({ kind: 'replay', a: f.src.a, b: f.src.b, speed: f.src.speed, dur: f.dur });
    else segs.push({ kind: 'freeze', t: f.t, dur: f.dur });
    cursor = Math.max(cursor, f.t);
  });
  if (clipDuration - cursor > 0.02 || !segs.length) pushPlay(cursor, Math.max(cursor + 0.05, clipDuration));
  segs.forEach((s) => { if (s.kind === 'play') s.dur = (s.b - s.a) / s.speed; });

  const parts = [];
  const n = segs.length;
  const vLabels = segs.map((_, i) => '[vs' + i + ']');
  parts.push('[0:v]setpts=PTS-STARTPTS,' + (n > 1 ? 'split=' + n + vLabels.join('') : 'null[vs0]'));
  segs.forEach((s, i) => {
    if (s.kind === 'play' && s.speed < 0.999) {
      parts.push('[vs' + i + ']trim=start=' + num(s.a) + ':end=' + num(s.b) + ',setpts=(PTS-STARTPTS)/' + s.speed.toFixed(4) +
        (fps > 1 ? ',fps=' + (Math.round(fps * 1000) / 1000) : '') + ',tpad=stop_mode=clone:stop_duration=1,trim=duration=' + num(s.dur) + ',setpts=PTS-STARTPTS[v' + i + ']');
    } else if (s.kind === 'play') parts.push('[vs' + i + ']trim=start=' + num(s.a) + ':end=' + num(s.b) + ',setpts=PTS-STARTPTS[v' + i + ']');
    else if (s.kind === 'replay') {
      // замедление: растягиваем время кадров; fps — ровная частота кадров (кадры повторяются, картинка не «плывёт»)
      parts.push('[vs' + i + ']trim=start=' + num(s.a) + ':end=' + num(s.b) + ',setpts=(PTS-STARTPTS)/' + s.speed.toFixed(4) +
        (fps > 1 ? ',fps=' + (Math.round(fps * 1000) / 1000) : '') + ',trim=duration=' + num(s.dur) + ',setpts=PTS-STARTPTS[v' + i + ']');
    } else parts.push('[vs' + i + ']trim=start=' + num(s.t) + ',setpts=PTS-STARTPTS,trim=end_frame=1,tpad=stop_mode=clone:stop_duration=' + num(s.dur) + ',trim=duration=' + num(s.dur) + ',setpts=PTS-STARTPTS[v' + i + ']');
  });

  if (hasAudio) {
    const playIdx = segs.map((s, i) => (s.kind === 'play' ? i : -1)).filter((i) => i >= 0);
    if (playIdx.length) {
      const aLabels = playIdx.map((i) => '[as' + i + ']');
      parts.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,' + (playIdx.length > 1 ? 'asplit=' + playIdx.length + aLabels.join('') : 'anull[as' + playIdx[0] + ']'));
    }
    segs.forEach((s, i) => {
      if (s.kind === 'play' && s.speed < 0.999) parts.push('[as' + i + ']atrim=start=' + num(s.a) + ':end=' + num(s.b) + ',asetpts=PTS-STARTPTS,' + atempoChain(s.speed) + ',apad,atrim=duration=' + num(s.dur) + ',asetpts=PTS-STARTPTS[a' + i + ']');
      else if (s.kind === 'play') parts.push('[as' + i + ']atrim=start=' + num(s.a) + ':end=' + num(s.b) + ',asetpts=PTS-STARTPTS[a' + i + ']');
      else parts.push('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=' + num(s.dur) + ',asetpts=PTS-STARTPTS[a' + i + ']');
    });
  }

  const concatIn = segs.map((_, i) => '[v' + i + ']' + (hasAudio ? '[a' + i + ']' : '')).join('');
  parts.push(concatIn + 'concat=n=' + n + ':v=1:a=' + (hasAudio ? 1 : 0) + '[vc]' + (hasAudio ? '[ac]' : ''));
  if (hasOverlay) parts.push('[1:v]format=rgba[ov];[vc][ov]overlay=eof_action=pass:format=auto,format=yuv420p[vout]');
  else parts.push('[vc]format=yuv420p[vout]');

  return { filter: parts.join(';'), mapAudio: hasAudio ? '[ac]' : null, outDuration: clipDuration + totalHold(fz) + slowExtra(sl) };
}

module.exports = { buildFreezeGraph, normalizeFreezes, totalHold, normalizeSlows, slowExtra };
