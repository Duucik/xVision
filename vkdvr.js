// VK Видео: запись идущего эфира С САМОГО НАЧАЛА.
// У VK в «ondemand»-списке эфира кусочки называются по времени от начала трансляции: t0.ts, t2000.ts, t4520.ts …
// (число — миллисекунды). Сам список отдаёт только последние ~45 секунд, но любой прошлый кусочек можно скачать по имени.
// Имя следующего = имя текущего + его длительность. Длительность берём из самого кусочка (метки времени кадров).
// Так проходим эфир от t0 до живого края (быстрее реального времени), дальше просто идём за списком.
// На выходе — непрерывный поток MPEG-TS (кусочки подряд) для ffmpeg.
const { Readable } = require('stream');

// длительность кусочка MPEG-TS в мс: по меткам PTS видео (последний кадр + длительность кадра − первый)
function tsDurationMs(buf) {
  const pts = [];
  for (let off = 0; off + 188 <= buf.length; off += 188) {
    if (buf[off] !== 0x47) { // потеряли синхронизацию — ищем следующий 0x47
      const n = buf.indexOf(0x47, off + 1); if (n < 0) break; off = n - 188; continue;
    }
    const pusi = (buf[off + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const afc = (buf[off + 3] >> 4) & 3;
    let p = off + 4;
    if (afc === 2) continue;
    if (afc === 3) p += 1 + buf[off + 4];
    if (p + 14 > off + 188) continue;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
    const sid = buf[p + 3];
    if (sid < 0xE0 || sid > 0xEF) continue; // только видео
    const flags = buf[p + 7];
    if (!(flags & 0x80)) continue;
    const b = buf.subarray(p + 9, p + 14);
    const v = ((b[0] >> 1) & 7) * 1073741824 + ((b[1] << 7) | (b[2] >> 1)) * 32768 + ((b[3] << 7) | (b[4] >> 1));
    pts.push(v);
  }
  if (pts.length < 2) return 0;
  // PTS могут идти не по порядку (B-кадры) и переходить через 2^33 — для 2–4 с это не важно, кроме перехода
  const sorted = pts.slice().sort((a, b) => a - b);
  if (sorted[sorted.length - 1] - sorted[0] > 90000 * 60) return 0; // переход через ноль — пусть решает запасной путь
  const diffs = []; for (let i = 1; i < sorted.length; i++) { const d = sorted[i] - sorted[i - 1]; if (d > 0) diffs.push(d); }
  diffs.sort((a, b) => a - b);
  const frame = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 3600;
  return Math.round((sorted[sorted.length - 1] - sorted[0] + frame) / 90);
}

function parseVkList(txt, baseUrl) {
  const out = { items: [], total: 0, start: '', ok: false };
  const m = /#EXT-X-VK-PLAYBACK-DURATION:(\d+)/.exec(txt); if (m) out.total = parseInt(m[1], 10);
  const s0 = /#EXT-X-VK-START-TIME:(\S+)/.exec(txt); if (s0) out.start = s0[1];
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const e = /^#EXTINF:([\d.]+)/.exec(lines[i]); if (!e) continue;
    let j = i + 1; while (j < lines.length && (!lines[j] || lines[j][0] === '#')) j++;
    const name = (lines[j] || '').trim(), t = /(?:^|\/)t(\d+)\.ts(?:\?|$)/.exec(name);
    if (t) out.items.push({ t: parseInt(t[1], 10), d: Math.round(parseFloat(e[1]) * 1000), url: new URL(name, baseUrl).toString() });
    i = j;
  }
  out.ok = out.items.length > 0;
  return out;
}

// Похоже ли на VK-эфир с перемоткой: «ondemand»-список с кусочками t<мс>.ts
async function probe(fetchText, url, headers) {
  const txt = await fetchText(url, headers);
  const l = parseVkList(txt, url);
  return l.ok ? { ok: true, total: l.total, windowStart: l.items[0].t, start: l.start } : { ok: false };
}

// Поток от позиции pos (мс от начала эфира). fetchBuf(url, headers) → { status, buf }, fetchText(url, headers) → string.
// state: { pos, total, live (дошли до края), url } — обновляется по ходу (нужно для продолжения после обрыва).
function createStream({ url, headers, fetchBuf, fetchText, state, onProgress, log }) {
  const base = url;
  const segUrl = (t) => new URL('t' + t + '.ts', base).toString();
  let stopped = false, list = null, listAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function refreshList(force) {
    if (!force && list && Date.now() - listAt < 1500) return list;
    const txt = await fetchText(base, headers);
    const L = parseVkList(txt, base);
    if (L.ok) { list = L; listAt = Date.now(); if (L.total) state.total = L.total; }
    return list;
  }
  async function getSeg(t) {
    const r = await fetchBuf(segUrl(t), headers);
    if (r.status === 200 && r.buf && r.buf.length > 188) return r.buf;
    if (r.status === 403 || r.status === 401 || r.status === 410) { const e = new Error('ссылка на эфир устарела (' + r.status + ')'); e.expired = true; throw e; }
    return null;
  }
  async function* gen() {
    let lastProg = 0;
    while (!stopped) {
      let L = null; try { L = await refreshList(false); } catch (e) { L = list; }
      const has = !!(L && L.items.length);
      const winStart = has ? L.items[0].t : Infinity, winEnd = has ? L.items[L.items.length - 1].t : -1;
      if (has && state.pos > winEnd) { state.live = true; await sleep(1000); try { await refreshList(true); } catch (e) {} continue; } // на живом краю — ждём новые
      const known = has ? L.items.find((x) => x.t === state.pos) : null;
      let t = state.pos, buf = await getSeg(t);
      if (!buf) { // имя не угадали на кадр-другой — пробуем соседние
        for (const dt of [40, -40, 80, -80, 33, -33, 67, -67, 20, -20, 120, -120]) { buf = await getSeg(state.pos + dt); if (buf) { t = state.pos + dt; break; } }
      }
      if (!buf) {
        if (has && state.pos < winStart) { // в архиве дыра — дальше с начала окна
          if (log) log('кусочек t' + state.pos + ' не найден — перехожу к t' + winStart);
          state.gaps = (state.gaps || 0) + 1; state.pos = winStart; continue;
        }
        await sleep(1000); try { await refreshList(true); } catch (e) {}
        continue;
      }
      let d = known ? known.d : tsDurationMs(buf);
      if (!d || d < 200 || d > 20000) { const nx = has ? L.items.find((x) => x.t > t) : null; d = nx ? nx.t - t : 2000; }
      state.pos = t + d;
      state.live = has && state.pos >= winStart;
      if (onProgress && Date.now() - lastProg > 1000) { lastProg = Date.now(); onProgress({ pos: state.pos, total: state.total, live: state.live }); }
      yield buf;
    }
  }
  const rs = Readable.from(gen(), { objectMode: false, highWaterMark: 4 });
  rs.stopFeed = () => { stopped = true; rs.destroy(); };
  return rs;
}

module.exports = { tsDurationMs, parseVkList, probe, createStream };
