// Запись идущей трансляции (YouTube, VK Видео) для разметки «вживую».
// Загрузчик (yt-dlp) отдаёт поток, ffmpeg без перекодирования режет его на кусочки по 4 секунды:
//   index.m3u8 + seg00000.ts, seg00001.ts, … — эту запись программа показывает плеером HLS (можно отматывать назад
//   и возвращаться в эфир), а vod.m3u8 — та же запись «как готовое видео» — нужна для выгрузки клипов, ИИ и стоп-кадров.
// Если связь пропала — переподключаемся и продолжаем запись с того же места шкалы (дыра во времени эфира просто пропускается).
// После «Завершить» запись склеивается в обычный MP4.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const SEG = 4; // секунд в кусочке

function killTree(proc) {
  if (!proc || proc.exitCode != null || proc.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGTERM');
  } catch (e) {}
}

// разбор плейлиста: кусочки (длина, файл), записано секунд, закрыт ли список
function readPlaylist(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return { segs: 0, dur: 0, ended: false, txt: '', items: [] }; }
  const items = []; let dur = 0;
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1; while (j < lines.length && (!lines[j] || lines[j][0] === '#')) j++;
    if (j < lines.length) { const d = parseFloat(m[1]) || 0; items.push({ d, f: lines[j].trim() }); dur += d; i = j; }
  }
  return { segs: items.length, dur, ended: /#EXT-X-ENDLIST/.test(txt), txt, items };
}
// общий список из кусков отдельных подключений: шкала одна, без разрывов (время каждого подключения уже сдвинуто)
function composePlaylist(items, ended) {
  const td = Math.max(1, ...items.map((x) => Math.ceil(x.d)));
  return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + td + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:' + (ended ? 'VOD' : 'EVENT') + '\n' +
    items.map((x) => '#EXTINF:' + x.d.toFixed(6) + ',\n' + x.f + '\n').join('') + (ended ? '#EXT-X-ENDLIST\n' : '');
}
function writeAtomic(file, body) { fs.writeFileSync(file + '.tmp', body); fs.renameSync(file + '.tmp', file); }

// формат: H.264 + AAC до нужной высоты, одним потоком (HLS) — его можно отдавать в ffmpeg без перекодирования
function liveFormat(quality) {
  const h = quality && quality !== 'best' ? '[height<=' + parseInt(quality, 10) + ']' : '';
  return 'b' + h + '[vcodec^=avc1]/b' + h + '[protocol*=m3u8]/b' + h + '/bv*' + h + '+ba/b';
}

class LiveSession extends EventEmitter {
  // o: { dir, url, ytdlp, ffmpeg, quality, cookiesBrowser, extraArgs, sourceCmd (для проверки: [bin, args] вместо yt-dlp), fromStartUrl }
  constructor(o) {
    super();
    this.o = o;
    this.dir = o.dir;
    this.index = path.join(o.dir, 'index.m3u8');
    this.vod = path.join(o.dir, 'vod.m3u8');
    this.state = 'idle';
    this.runs = 0; this.fails = 0; this.error = ''; this.lastLog = '';
    this.src = null; this.ff = null; this.timer = null; this.stopping = false;
    this.rec = { segs: 0, dur: 0 };
    this.startedAt = Date.now(); this.lastSegAt = 0;
  }
  status() {
    return { state: this.state, dur: this.rec.dur, segs: this.rec.segs, error: this.error, lastSegAt: this.lastSegAt, startedAt: this.startedAt, runs: this.runs, index: this.index, vod: this.vod, dir: this.dir };
  }
  _set(state, extra) { this.state = state; Object.assign(this, extra || {}); this.emit('status', this.status()); }
  // куски подключений: r1.m3u8, r2.m3u8, … (у каждого свои кусочки r1_00000.ts …)
  _parts() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /^r\d+\.m3u8$/.test(n)); } catch (e) {}
    return names.sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  }
  _collect() {
    const items = [];
    this._parts().forEach((n) => { readPlaylist(path.join(this.dir, n)).items.forEach((x) => items.push(x)); });
    return items;
  }
  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    const items = this._collect(); // продолжение старой записи (программу перезапустили)
    this.rec = { segs: items.length, dur: items.reduce((a, x) => a + x.d, 0) };
    const parts = this._parts();
    this.runs = parts.length ? parseInt(parts[parts.length - 1].slice(1), 10) : 0;
    this._set('starting');
    this._run();
    this.poll = setInterval(() => this._poll(), 1000);
    return this;
  }
  _run() {
    if (this.stopping) return;
    this.runs++;
    const o = this.o, first = this.rec.segs === 0;
    const runStartSegs = this.rec.segs;
    this.runSegs0 = runStartSegs;
    // источник
    let bin, args;
    if (o.sourceCmd) { bin = o.sourceCmd[0]; args = o.sourceCmd[1]; }
    else if (first && o.fromStartUrl) { bin = o.ffmpeg; args = ['-hide_banner', '-loglevel', 'error', '-live_start_index', '0', '-i', o.fromStartUrl, '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1']; }
    else {
      bin = o.ytdlp;
      args = ['-q', '--no-warnings', '--no-part', '--no-playlist', '-f', liveFormat(o.quality), '--hls-use-mpegts', '-o', '-'];
      if (o.ffmpeg) args.push('--ffmpeg-location', o.ffmpeg);
      if (o.cookiesBrowser) args.push('--cookies-from-browser', o.cookiesBrowser);
      (o.extraArgs || []).forEach((a) => args.push(a));
      args.push(o.url);
    }
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, o.env || {});
    let src, ff;
    try { src = spawn(bin, args, { windowsHide: true, env }); } catch (e) { return this._runEnded('не запускается загрузчик: ' + e.message); }
    // нарезка: шкала продолжается с того места, где закончилась прошлая запись
    const k = this.runs;
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-i', 'pipe:0',
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
      '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', this.rec.dur.toFixed(3),
      '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(this.dir, 'r' + k + '_%05d.ts'), path.join(this.dir, 'r' + k + '.m3u8')];
    try { ff = spawn(o.ffmpeg, ffArgs, { windowsHide: true }); } catch (e) { killTree(src); return this._runEnded('не запускается ffmpeg: ' + e.message); }
    this.src = src; this.ff = ff;
    src.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {});
    src.stdout.on('error', () => {});
    let log = '';
    const keep = (d) => { log = (log + d.toString()).slice(-2000); };
    src.stderr.on('data', keep); ff.stderr.on('data', keep);
    let left = 2;
    const done = () => { if (--left > 0) return; this.lastLog = log.trim(); this._runEnded(); };
    src.on('error', (e) => { keep(String(e)); });
    ff.on('error', (e) => { keep(String(e)); });
    src.on('close', () => { try { ff.stdin.end(); } catch (e) {} done(); });
    ff.on('close', () => { killTree(src); done(); });
  }
  _runEnded(err) {
    this.src = null; this.ff = null;
    this._poll();
    if (err) this.lastLog = err;
    if (this.stopping) { this._finishStop(); return; }
    const gotNew = this.rec.segs > (this.runSegs0 || 0);
    this.fails = gotNew ? 0 : this.fails + 1;
    const msg = (this.lastLog.split('\n').filter((l) => /ERROR|error|Error/.test(l)).pop() || this.lastLog.split('\n').pop() || '').replace(/^ERROR:\s*/, '').slice(0, 300);
    // нет ни одного кусочка с самого начала — ссылка не работает
    if (this.rec.segs === 0 && this.fails >= 2) { this._set('error', { error: msg || 'не удалось подключиться к трансляции' }); this._clearPoll(); return; }
    // трансляция, похоже, закончилась: несколько попыток подряд без новых кусочков
    if (/has ended|not currently live|is offline|не в эфире|ended|finished/i.test(msg) || this.fails >= 4) { this._set('ended', { error: msg }); this._clearPoll(); return; }
    this._set('reconnecting', { error: msg });
    const wait = Math.min(30, 2 * Math.pow(2, this.fails)) * 1000;
    this.timer = setTimeout(() => this._run(), wait);
  }
  _clearPoll() { clearInterval(this.poll); this.poll = null; }
  _poll(final) {
    const items = this._collect();
    if (items.length !== this.rec.segs || final) {
      const grew = items.length > this.rec.segs;
      this.rec = { segs: items.length, dur: items.reduce((a, x) => a + x.d, 0) };
      if (grew) this.lastSegAt = Date.now();
      // index.m3u8 — для плеера (растёт), vod.m3u8 — снимок «готового видео» для ffmpeg (выгрузка, ИИ, стоп-кадры)
      try {
        writeAtomic(this.index, composePlaylist(items, !!final));
        writeAtomic(this.vod, composePlaylist(items, true));
      } catch (e) {}
      if (this.state === 'starting' || this.state === 'reconnecting') this._set('live', { error: '' });
      else this.emit('status', this.status());
    }
  }
  // остановить запись (запись остаётся, её можно склеить в MP4)
  stop() {
    if (this.stopping) return this.stopPromise;
    this.stopping = true;
    clearTimeout(this.timer);
    this.stopPromise = new Promise((resolve) => { this._stopResolve = resolve; });
    if (this.src || this.ff) { killTree(this.src); setTimeout(() => killTree(this.ff), 4000); } // ffmpeg дописывает последний кусочек сам
    else this._finishStop();
    return this.stopPromise;
  }
  _finishStop() {
    this._clearPoll();
    this._poll(true); // плейлист закрываем: теперь это готовое видео
    if (this.state !== 'error') this._set('stopped');
    if (this._stopResolve) this._stopResolve(this.status());
  }
}

// склеить запись в один MP4 (без перекодирования)
function finalizeToMp4(ffmpeg, vodPlaylist, outFile, onProgress, totalSec) {
  return new Promise((resolve) => {
    const tmp = outFile + '.part.mp4';
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', vodPlaylist, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
    let proc; try { proc = spawn(ffmpeg, args, { windowsHide: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let err = '', buf = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    proc.stdout.on('data', (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      lines.forEach((l) => { const m = /^out_time_ms=(\d+)/.exec(l); if (m && totalSec && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSec)); });
    });
    proc.on('close', (code) => {
      if (code === 0) { try { fs.renameSync(tmp, outFile); return resolve({ ok: true, file: outFile }); } catch (e) { return resolve({ ok: false, error: e.message }); } }
      try { fs.unlinkSync(tmp); } catch (e) {}
      resolve({ ok: false, error: err.trim().split('\n').pop() || 'ffmpeg: код ' + code });
    });
  });
}

module.exports = { LiveSession, finalizeToMp4, readPlaylist, composePlaylist, liveFormat, killTree, SEG };
