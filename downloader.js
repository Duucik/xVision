// Загрузка видео по ссылке (VK Видео, YouTube и другие сайты) через yt-dlp.
// Модуль не зависит от Electron — его можно запускать и проверять отдельно.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|ts|flv)$/i;

// Запасной способ найти скачанный файл: самый свежий видеофайл в папке, появившийся во время этой загрузки.
// Нужен, если yt-dlp не сообщил путь (например, из-за кириллицы в названии и кодировки консоли Windows).
function findFreshVideo(dir, sinceMs) {
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!VIDEO_EXT.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size < 1024) continue;
      if (st.mtimeMs < sinceMs - 3000) continue;
      if (!best || st.mtimeMs > best.t) best = { full, t: st.mtimeMs };
    }
  } catch (e) {}
  return best ? best.full : '';
}

function binaryInfo() {
  if (process.platform === 'win32') return { file: 'yt-dlp.exe', asset: 'yt-dlp.exe' };
  if (process.platform === 'darwin') return { file: 'yt-dlp', asset: 'yt-dlp_macos' };
  return { file: 'yt-dlp', asset: 'yt-dlp_linux' };
}

// ---------- загрузчик yt-dlp: откуда берётся и как обновляется ----------
// 1) Загрузчик вшит в установщик (папка bin рядом с программой) — при первом запуске он просто копируется,
//    интернет для этого не нужен. Если рядом установлена другая версия xVision, берём загрузчик и у неё.
// 2) Обновление идёт в фоне при запуске программы и не задерживает загрузку матча.
// 3) Новая версия сначала скачивается рядом и проверяется запуском; рабочая подменяется только после проверки.
//    Не получилось обновить — остаёмся на прежней, она продолжает работать.
const UPDATE_EVERY_MS = 3 * 24 * 3600 * 1000; // как часто проверять обновление
const RETRY_AFTER_MS = 6 * 3600 * 1000;       // после неудачи не дёргать сеть чаще
const MIN_SIZE = 3 * 1024 * 1024;             // настоящий yt-dlp весит ≈18 МБ; меньше — файл скачался не полностью

function loaderUrls() {
  const a = binaryInfo().asset;
  return ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + a,
    'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/' + a];
}
function loaderPaths(binDir) {
  const info = binaryInfo();
  const ext = path.extname(info.file), base = path.basename(info.file, ext);
  return {
    bin: path.join(binDir, info.file),
    fresh: path.join(binDir, base + '-new' + ext),  // проверенная новая версия, ждёт подмены
    dl: path.join(binDir, base + '-dl' + ext),      // скачивается / проверяется
    old: path.join(binDir, base + '-old' + ext),    // предыдущая версия (на всякий случай)
    stamp: path.join(binDir, 'loader.json'),
  };
}
function readStamp(p) { try { return JSON.parse(fs.readFileSync(p.stamp, 'utf-8')) || {}; } catch (e) { return {}; } }
function writeStamp(p, patch) { try { fs.writeFileSync(p.stamp, JSON.stringify(Object.assign(readStamp(p), patch))); } catch (e) {} }
function sizeOf(file) { try { const st = fs.statSync(file); return st.isFile() ? st.size : 0; } catch (e) { return 0; } }
function rm(file) { try { fs.unlinkSync(file); } catch (e) {} }

// запасной способ скачивания — обычный https из Node (без системного прокси)
function httpsDownload(url, dest, onProgress, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('слишком много перенаправлений'));
    const tmp = dest + '.download';
    const req = https.get(url, { headers: { 'User-Agent': 'xVision' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsDownload(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('сервер ответил ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(tmp);
      const fail = (e) => { out.destroy(); rm(tmp); reject(e); };
      res.on('data', (d) => { got += d.length; if (onProgress && total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } }));
      out.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', (e) => { rm(tmp); reject(e); });
    req.setTimeout(25000, () => req.destroy(new Error('сервер не отвечает')));
  });
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let proc;
    try { proc = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out, err: String(e) }); }
    const timer = timeoutMs ? setTimeout(() => { try { proc.kill(); } catch (e) {} }, timeoutMs) : null;
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    proc.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// Скачивает загрузчик в файл dest. Несколько попыток: сначала сетевым механизмом самой программы
// (opts.fetch — он видит системный прокси и VPN), потом обычным https, потом с запасного адреса.
async function fetchLoader(dest, opts, onFrac, onTry) {
  const fetchers = [];
  if (opts && typeof opts.fetch === 'function') fetchers.push(opts.fetch);
  if (!(opts && opts.onlyCustomFetch)) fetchers.push(httpsDownload);
  const urls = loaderUrls();
  const plan = fetchers.map((f) => [f, urls[0]]);
  plan.push([fetchers[0], urls[1]]);
  let lastErr = null;
  for (let i = 0; i < plan.length; i++) {
    rm(dest);
    if (onTry) onTry(i + 1, plan.length);
    try {
      await plan[i][0](plan[i][1], dest, onFrac);
      if (sizeOf(dest) < MIN_SIZE) throw new Error('файл скачался не полностью');
      return;
    } catch (e) { lastErr = e; rm(dest); }
  }
  throw lastErr || new Error('не удалось скачать');
}

// Проверка: загрузчик запускается и называет свою версию
async function verifyLoader(file) {
  if (sizeOf(file) < MIN_SIZE) return '';
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o755); } catch (e) {} }
  else rm(file + ':Zone.Identifier'); // метка «файл из интернета» — чтобы Windows не задавал вопросов
  const r = await runCapture(file, ['--version'], 120000);
  const m = /(\d{4}\.\d{1,2}\.\d{1,2}[\w.]*)/.exec(String(r.out || ''));
  return r.code === 0 && m ? m[1] : '';
}

// Подмена рабочего загрузчика проверенной новой версией. Если файл занят — подменим в следующий раз.
function applyPending(binDir) {
  const p = loaderPaths(binDir);
  if (!fs.existsSync(p.fresh)) return false;
  const had = fs.existsSync(p.bin);
  try {
    if (had) { rm(p.old); fs.renameSync(p.bin, p.old); }
    fs.renameSync(p.fresh, p.bin);
    return true;
  } catch (e) {
    try { if (had && !fs.existsSync(p.bin) && fs.existsSync(p.old)) fs.renameSync(p.old, p.bin); } catch (_) {}
    return false;
  }
}

// Первый запуск без интернета: берём загрузчик из установщика или у соседней версии xVision
function seedLoader(binDir, opts) {
  const p = loaderPaths(binDir);
  if (fs.existsSync(p.bin)) return true;
  const file = binaryInfo().file;
  const cands = [];
  if (opts && opts.bundled) cands.push(opts.bundled);
  ((opts && opts.siblingDirs) || []).forEach((d) => { if (path.resolve(d) !== path.resolve(binDir)) cands.push(path.join(d, file)); });
  let best = null;
  cands.forEach((c) => {
    if (sizeOf(c) < MIN_SIZE) return;
    let t = 0; try { t = fs.statSync(c).mtimeMs; } catch (e) {}
    if (!best || t > best.t) best = { c, t };
  });
  if (!best) return false;
  try {
    const tmp = p.bin + '.seed';
    fs.copyFileSync(best.c, tmp);
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, p.bin);
    writeStamp(p, { lastOk: 0, lastTry: 0, from: 'bundled' }); // копия может быть старой — обновим в фоне
    return true;
  } catch (e) { rm(p.bin + '.seed'); return false; }
}

let updating = null; // одно обновление одновременно
function updateLoader(binDir, opts, onStatus) {
  if (updating) return updating;
  const p = loaderPaths(binDir);
  const had = fs.existsSync(p.bin);
  const label = had ? 'Обновляю загрузчик…' : 'Скачиваю загрузчик…';
  let tryNo = 1;
  updating = (async () => {
    writeStamp(p, { lastTry: Date.now() });
    await fetchLoader(p.dl, opts,
      (f) => onStatus && onStatus(label + ' ' + Math.round(f * 100) + '%' + (tryNo > 1 ? ' (попытка ' + tryNo + ')' : '')),
      (n) => { tryNo = n; if (onStatus && n > 1) onStatus(label + ' попытка ' + n); });
    onStatus && onStatus('Проверяю загрузчик…');
    const ver = await verifyLoader(p.dl);
    if (!ver) { rm(p.dl); throw new Error('скачанный загрузчик не запускается (возможно, его блокирует антивирус)'); }
    rm(p.fresh);
    fs.renameSync(p.dl, p.fresh);
    if (!(opts && opts.isBusy && opts.isBusy())) applyPending(binDir);
    writeStamp(p, { lastOk: Date.now(), version: ver, from: 'net' });
    return ver;
  })();
  const done = () => { updating = null; };
  updating.then(done, done);
  return updating;
}

// Фоновая проверка при запуске программы: ничего не показывает и ничему не мешает
async function updateInBackground(binDir, opts) {
  try {
    fs.mkdirSync(binDir, { recursive: true });
    if (!(opts && opts.isBusy && opts.isBusy())) applyPending(binDir);
    seedLoader(binDir, opts);
    const p = loaderPaths(binDir);
    const st = readStamp(p), now = Date.now();
    if (fs.existsSync(p.bin) && now - (st.lastOk || 0) < UPDATE_EVERY_MS) return 'fresh';
    if (now - (st.lastTry || 0) < RETRY_AFTER_MS) return 'later';
    await updateLoader(binDir, opts, null);
    return 'updated';
  } catch (e) { return 'failed'; }
}

// Гарантирует наличие yt-dlp перед загрузкой матча. Сеть нужна, только если загрузчика нет вообще
// (ни в программе, ни у соседней версии) или forceUpdate — когда сайт поменялся и старая версия не справилась.
async function ensureYtDlp(binDir, onStatus, forceUpdate, opts) {
  fs.mkdirSync(binDir, { recursive: true });
  const p = loaderPaths(binDir);
  applyPending(binDir);
  if (!fs.existsSync(p.bin)) seedLoader(binDir, opts);
  if (!fs.existsSync(p.bin)) {
    onStatus && onStatus('Первый запуск: скачиваю загрузчик (один раз, ≈20 МБ)…');
    try { await updateLoader(binDir, opts, onStatus); applyPending(binDir); }
    catch (e) {
      const err = new Error('Не удалось скачать загрузчик видео (yt-dlp): ' + (e.message || e));
      err.kind = 'loader';
      throw err;
    }
    if (!fs.existsSync(p.bin)) { const err = new Error('Загрузчик видео скачан, но файл недоступен: ' + p.bin); err.kind = 'loader'; throw err; }
  } else if (forceUpdate) {
    onStatus && onStatus('Обновляю загрузчик…');
    try { await updateLoader(binDir, opts, onStatus); applyPending(binDir); } catch (e) { /* не вышло — работаем с прежней версией */ }
  }
  return p.bin;
}

// Загрузчик, выбранный вручную (кнопка «Указать файл» в окне ошибки)
async function setLoaderFile(binDir, srcPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const p = loaderPaths(binDir);
  if (sizeOf(srcPath) < MIN_SIZE) return { ok: false, error: 'Это не похоже на загрузчик yt-dlp: файл слишком маленький.' };
  try { rm(p.dl); fs.copyFileSync(srcPath, p.dl); } catch (e) { return { ok: false, error: 'Не удалось скопировать файл: ' + (e.message || e) }; }
  const ver = await verifyLoader(p.dl);
  if (!ver) { rm(p.dl); return { ok: false, error: 'Файл не запускается как yt-dlp. Нужен ' + binaryInfo().asset + ' со страницы github.com/yt-dlp/yt-dlp/releases' }; }
  try { rm(p.fresh); fs.renameSync(p.dl, p.fresh); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  if (!applyPending(binDir)) return { ok: false, error: 'Не удалось заменить загрузчик — закройте идущую загрузку и повторите.' };
  writeStamp(p, { lastOk: 0, lastTry: 0, version: ver, from: 'manual' });
  return { ok: true, version: ver };
}

function classifyError(text) {
  const s = String(text).toLowerCase();
  if (/unsupported url|no suitable extractor|unable to extract|extractor error/.test(s)) return /unsupported url/.test(s) ? 'unsupported' : 'extractor';
  if (/http error 404|video (has been )?(removed|deleted)|does not exist|video unavailable|not found/.test(s) && !/private|login|sign in/.test(s)) return 'notfound';
  if (/private|login|log in|sign in|authoriz|403|401|only available for registered|requires authentication|members only|confirm your age|age-restrict/.test(s)) return 'auth';
  if (/getaddrinfo|timed out|connection|network|name or service|unreachable|proxy|ssl/.test(s)) return 'network';
  if (/no space left|disk full|not enough space/.test(s)) return 'disk';
  return 'other';
}

function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGTERM');
  } catch (e) {}
}

function buildFormat(quality) {
  const h = quality && quality !== 'best' ? '[height<=' + parseInt(quality, 10) + ']' : '';
  // сначала H.264 + AAC (без проблем проигрывается в программе), потом любые варианты
  return 'bv*' + h + '[vcodec^=avc1]+ba[acodec^=mp4a]/b' + h + '[ext=mp4]/bv*' + h + '+ba/b' + h + '/b';
}

function num(x) { const n = Number(x); return isFinite(n) && x !== 'NA' && x !== '' ? n : 0; }

// Основная функция: скачивает видео и возвращает путь к файлу.
// opts: { binDir, ffmpegPath, url, quality, outDir, cookiesBrowser, onProgress({percent,speed,eta,stream}), onStatus(text), registerProc(proc),
//         loader: { bundled, siblingDirs, fetch, isBusy } — откуда брать и чем скачивать сам загрузчик }
async function downloadVideo(opts) {
  const { binDir, ffmpegPath, url, quality, outDir, cookiesBrowser, onProgress, onStatus, registerProc, loader } = opts;
  if (!/^https?:\/\//i.test(url)) return { ok: false, kind: 'url', error: 'Это не похоже на ссылку. Вставьте адрес вида https://…' };
  fs.mkdirSync(outDir, { recursive: true });

  let bin;
  try { bin = await ensureYtDlp(binDir, onStatus, false, loader); }
  catch (e) { return { ok: false, kind: e.kind || 'loader', error: e.message || String(e) }; }

  const attempt = () => new Promise((resolve) => {
    const startedAt = Date.now();
    const pathFile = path.join(outDir, '.xvision-path-' + startedAt + '.txt');
    const readPathFile = () => {
      try {
        const lines = fs.readFileSync(pathFile, 'utf-8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : '';
      } catch (e) { return ''; }
    };
    const cleanup = () => { try { fs.unlinkSync(pathFile); } catch (e) {} };
    const args = [
      '--no-playlist', '--newline', '--no-colors', '--windows-filenames', '--no-mtime',
      '-f', buildFormat(quality), '--merge-output-format', 'mp4',
      '-o', path.join(outDir, '%(title).100B [%(id)s].%(ext)s'),
      '--print', 'after_move:filepath', '--no-simulate',
      // путь к итоговому файлу дополнительно пишется в UTF-8 файл — так кириллица в названии не ломается
      '--print-to-file', 'after_move:filepath', pathFile.replace(/%/g, '%%'),
      '--progress', '--progress-template',
      'download:XVP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
      '--concurrent-fragments', '4', '--retries', '5', '--fragment-retries', '5', '--socket-timeout', '30',
    ];
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
    if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
    args.push(url);

    let proc;
    try { proc = spawn(bin, args, { windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) }); }
    catch (e) { return resolve({ ok: false, kind: 'other', error: String(e) }); }
    registerProc && registerProc(proc);

    let stdoutBuf = '', stderrTail = '', finalPath = '', streamNo = 0, lastPct = 0, lastSent = 0, cancelled = false;
    proc.cancelledFlag = () => { cancelled = true; };
    onStatus && onStatus('Получаю информацию о видео…');

    const handleLine = (line) => {
      line = line.replace(/\r/g, '').trim();
      if (!line) return;
      if (line.indexOf('XVP|') === 0) {
        const p = line.split('|');
        const done = num(p[1]), total = num(p[2]) || num(p[3]);
        const fi = num(p[6]), fc = num(p[7]);
        let pct = total ? done / total * 100 : (fc ? fi / fc * 100 : 0);
        pct = Math.max(0, Math.min(100, pct));
        if (pct + 20 < lastPct) streamNo++; // процент «откатился» — пошёл следующий поток (аудио)
        lastPct = pct;
        const now = Date.now();
        if (onProgress && now - lastSent > 200) {
          lastSent = now;
          onProgress({ percent: pct, speed: num(p[4]), eta: num(p[5]), stream: streamNo + 1, bytes: done, total });
        }
        return;
      }
      if (/has already been downloaded/.test(line)) {
        const m = /^\[download\]\s+(.+?)\s+has already been downloaded/.exec(line);
        if (m) finalPath = m[1];
      }
      if (path.isAbsolute(line) && fs.existsSync(line)) finalPath = line;
      if (/^\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) onStatus && onStatus('Склеиваю видео и звук…');
    };
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const parts = stdoutBuf.split('\n'); stdoutBuf = parts.pop();
      parts.forEach(handleLine);
    });
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-3000); });
    proc.on('error', (e) => { cleanup(); resolve({ ok: false, kind: 'other', error: String(e) }); });
    proc.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      const fromFile = readPathFile();
      cleanup();
      if (cancelled) return resolve({ ok: false, kind: 'cancelled', error: 'Загрузка отменена' });
      if (code === 0) {
        // три способа найти файл по убыванию надёжности: путь из UTF-8 файла, путь из вывода, самый свежий видеофайл в папке
        const found = [fromFile, finalPath].find((x) => x && fs.existsSync(x)) || findFreshVideo(outDir, startedAt);
        if (found) return resolve({ ok: true, filePath: found });
        return resolve({ ok: false, kind: 'nofile', error: 'yt-dlp завершился без ошибок, но файл не найден в папке ' + outDir });
      }
      const errLine = (stderrTail.split('\n').filter((l) => /ERROR/.test(l)).pop() || stderrTail.trim().split('\n').pop() || 'Ошибка загрузки (код ' + code + ')');
      resolve({ ok: false, kind: classifyError(stderrTail), error: errLine.replace(/^ERROR:\s*/, '') });
    });
  });

  let res = await attempt();
  if (!res.ok && (res.kind === 'extractor' || res.kind === 'other')) { // повтор с обновлением — только при реальной ошибке загрузчика
    // чаще всего помогает свежая версия yt-dlp — обновляемся и пробуем ещё раз
    try { await ensureYtDlp(binDir, onStatus, true, loader); res = await attempt(); } catch (e) { /* оставляем первую ошибку */ }
  }
  return res;
}

module.exports = { downloadVideo, ensureYtDlp, updateInBackground, setLoaderFile, seedLoader, applyPending, loaderPaths, killTree, buildFormat, classifyError };
