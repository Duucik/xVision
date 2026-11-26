'use strict';
// «Склейка» без склейки: несколько роликов открываются как одно видео.
// Каждый ролик один раз готовится в своём файле (p<id>.mp4 + p<id>.m3u8, фрагментированный MP4 с общей шкалой времени).
// Плеер получает общий список sequence.m3u8 (ролики по порядку, между ними — разрыв), ffmpeg (выгрузка, ИИ,
// «Позиция») — список sequence.ffconcat с теми же длительностями. Поменять ролики местами = переписать оба списка;
// сами ролики не перекодируются. «Склеить в один файл» соединяет готовые части без перекодирования.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SEQ_M3U8 = 'sequence.m3u8';
const SEQ_CONCAT = 'sequence.ffconcat';
const SEQ_JSON = 'seq.json';
const isSeqPath = (p) => path.basename(String(p || '')).toLowerCase() === SEQ_M3U8;
const ffSource = (p) => (isSeqPath(p) ? path.join(path.dirname(p), SEQ_CONCAT) : p);

function snapFps(f) {
  f = Number(f) || 0; if (!(f > 1 && f < 241)) return 0;
  for (const st of [23.976, 29.97, 47.952, 59.94, 119.88]) if (Math.abs(f - st) < 0.02) return st;
  const r = Math.round(f); if (Math.abs(f - r) < 0.06) return r;
  return Math.round(f * 1000) / 1000;
}

// сведения о ролике по выводу ffmpeg -i
function parseProbe(err) {
  const v = (err.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/) || [''])[0];
  if (!v) return null;
  const a = (err.match(/Stream #\d+:\d+[^\n]*Audio:[^\n]*/) || [''])[0];
  const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const sz = /, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(v + ' ');
  const num = (re) => { const m = re.exec(v); return m ? parseFloat(m[1]) * (/k$/.test(m[2] || '') ? 1000 : 1) : 0; };
  const tbr = snapFps(num(/([\d.]+)(k?) tbr/)), avg = snapFps(num(/([\d.]+)(k?) fps/));
  const fps = tbr && (!avg || Math.abs(tbr - avg) / tbr < 0.1) ? tbr : avg;
  let w = sz ? parseInt(sz[1], 10) : 0, h = sz ? parseInt(sz[2], 10) : 0;
  const rotated = /rotation of -?(90|270)(\.0+)? degrees/.test(err) || /displaymatrix: rotation of -?(90|270)/.test(err);
  if (rotated) { const t = w; w = h; h = t; }
  const vcodec = ((/Video: (\w+)/.exec(v) || [])[1] || '').toLowerCase();
  const pix = /yuvj?420p\b/.test(v) ? 'yuv420p' : ((/Video: \w+[^,]*, (\w+)/.exec(v) || [])[1] || '');
  return {
    duration: dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0,
    w, h, fps, vcodec, pix, rotated, interlaced: /\b(top|bottom) first\b|interlaced/i.test(v),
    audio: !!a, acodec: a ? ((/Audio: (\w+)/.exec(a) || [])[1] || '').toLowerCase() : '',
  };
}
function probe(ffmpegPath, file) {
  return new Promise((resolve) => {
    let err = '', proc;
    try { proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }); } catch (e) { return resolve(null); }
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(0, 200000); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => resolve(parseProbe(err)));
  });
}

// общий вид роликов склейки — по первому: не шире 1920, чётные размеры, частота 24–60
function targetFormat(info) {
  let W = info.w, H = info.h;
  if (W > 1920) { H = Math.round(H * 1920 / W); W = 1920; }
  if (H > 1920) { W = Math.round(W * 1920 / H); H = 1920; }
  W = Math.max(2, Math.round(W / 2) * 2); H = Math.max(2, Math.round(H / 2) * 2);
  const F = snapFps(Math.min(60, Math.max(24, info.fps || 30)));
  return { W, H, F };
}
// ролик уже в нужном виде — картинку можно не перекодировать (быстро)
function canCopyVideo(info, fmt) {
  return info.vcodec === 'h264' && info.pix === 'yuv420p' && !info.rotated && !info.interlaced &&
    info.w === fmt.W && info.h === fmt.H && Math.abs((info.fps || 0) - fmt.F) < 0.02;
}

function prepArgs(input, info, fmt, dir, id, enc, copy) {
  const a = ['-y', '-nostdin', '-i', input];
  if (!info.audio) a.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  a.push('-map', '0:v:0', '-map', info.audio ? '0:a:0' : '1:a');
  if (copy) a.push('-c:v', 'copy');
  else {
    const vf = 'scale=' + fmt.W + ':' + fmt.H + ':force_original_aspect_ratio=decrease,pad=' + fmt.W + ':' + fmt.H + ':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=' + fmt.F + ',format=yuv420p';
    a.push('-vf', vf, ...enc.args, '-force_key_frames', 'expr:gte(t,n_forced*2)');
  }
  a.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  if (!info.audio) a.push('-shortest');
  a.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'single_file',
    '-hls_segment_options', 'video_track_timescale=90000', '-hls_segment_filename', path.join(dir, 'p' + id + '.mp4'), path.join(dir, 'p' + id + '.m3u8'));
  return a;
}

// список одного ролика: строки от EXT-X-MAP до конца, длительность (сумма EXTINF)
function readPart(dir, id) {
  const txt = fs.readFileSync(path.join(dir, 'p' + id + '.m3u8'), 'utf8');
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const body = []; let dur = 0, target = 1, started = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Math.max(target, parseFloat(l.split(':')[1]) || 1);
    if (l.startsWith('#EXT-X-MAP')) started = true;
    if (!started || l === '#EXT-X-ENDLIST') continue;
    if (l.startsWith('#EXTINF:')) dur += parseFloat(l.slice(8)) || 0;
    body.push(l);
  }
  if (!body.length || !dur) throw new Error('пустой список ролика ' + id);
  return { body, dur, target };
}

function writeAtomic(file, text) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }

function readSeq(dir) { return JSON.parse(fs.readFileSync(path.join(dir, SEQ_JSON), 'utf8')); }
function writeSeq(dir, seq) { writeAtomic(path.join(dir, SEQ_JSON), JSON.stringify(seq, null, 1)); }

// готовые ролики по порядку и их место на общей шкале
function timeline(seq) {
  let acc = 0;
  return seq.order.map((id) => seq.parts.find((p) => p.id === id)).filter((p) => p && p.state === 'ready' && p.dur > 0)
    .map((p) => { const o = { id: p.id, name: p.name, start: acc, end: acc + p.dur, dur: p.dur }; acc += p.dur; return o; });
}

// переписать оба общих списка по текущему порядку
function compose(dir, seq) {
  const tl = timeline(seq);
  const m3u = ['#EXTM3U', '#EXT-X-VERSION:7', null, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const cc = ['ffconcat version 1.0'];
  let target = 1;
  tl.forEach((t, i) => {
    const r = readPart(dir, t.id);
    target = Math.max(target, r.target);
    if (i > 0) m3u.push('#EXT-X-DISCONTINUITY');
    m3u.push(...r.body);
    cc.push("file 'p" + t.id + ".mp4'", 'duration ' + r.dur.toFixed(6));
  });
  m3u[2] = '#EXT-X-TARGETDURATION:' + Math.ceil(target);
  m3u.push('#EXT-X-ENDLIST');
  writeAtomic(path.join(dir, SEQ_M3U8), m3u.join('\n') + '\n');
  writeAtomic(path.join(dir, SEQ_CONCAT), cc.join('\n') + '\n');
  return tl;
}

module.exports = { SEQ_M3U8, SEQ_CONCAT, SEQ_JSON, isSeqPath, ffSource, snapFps, parseProbe, probe, targetFormat, canCopyVideo, prepArgs, readPart, readSeq, writeSeq, timeline, compose };
