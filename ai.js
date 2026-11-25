// ИИ-подсветка игроков: загрузка модели, запуск нейросети (onnxruntime-node), слежение за игроком.
// Работает в главном процессе Electron. Нейросеть YOLOX-S лежит в папке models/ рядом с программой;
// если файла нет — докачивается с GitHub при первом запуске.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tracker = require('./tracker');

const MODEL_NAME = 'yolox_s.onnx';
const MODEL_URL = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx';
const MODEL_MIN_BYTES = 30 * 1024 * 1024;

let session = null, inputName = null, ort = null, providerUsed = '';
let loading = null;
let modelFile = '', userDir = '', crossChecked = false, gpuNote = '';

// ---------- журнал нейросети: %APPDATA%\...\ai-log.txt — по нему видно, что происходило на чужом компьютере ----------
function log(line) {
  if (!userDir) return;
  try {
    const f = path.join(userDir, 'ai-log.txt');
    try { if (fs.statSync(f).size > 300 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').slice(-120 * 1024)); } catch (e) {}
    fs.appendFileSync(f, new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + line + '\n');
  } catch (e) {}
}
function logPath(userData) { return path.join(userData, 'ai-log.txt'); }
// Запомненный результат проверки видеокарты: { dml: 'ok' | 'bad', at, why }
function verdictFile() { return path.join(userDir, 'ai-check.json'); }
function readVerdict() { try { return JSON.parse(fs.readFileSync(verdictFile(), 'utf-8')) || {}; } catch (e) { return {}; } }
function saveVerdict(v) { try { fs.writeFileSync(verdictFile(), JSON.stringify(Object.assign({ at: Date.now() }, v))); } catch (e) {} }
const DAY = 24 * 3600 * 1000;

// проверочная картинка: цветные блоки, всегда одни и те же
function testPattern() {
  const N = 640, plane = N * N, out = new Float32Array(3 * plane);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const B = 32, cols = N / B, blocks = [];
  for (let i = 0; i < cols * cols * 3; i++) blocks.push(Math.round(rnd() * 255));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const b = (Math.floor(y / B) * cols + Math.floor(x / B)) * 3;
    for (let c = 0; c < 3; c++) out[c * plane + y * N + x] = blocks[b + c] * 0.8 + ((x + y * 3 + c * 7) % 50);
  }
  return out;
}
// сравнение ответа видеокарты с ответом процессора на одну и ту же картинку
function compareOutputs(g, c) {
  if (!g || !c || g.length !== c.length || !g.length) return { ok: false, why: 'разный размер ответа' };
  let diff = 0, ref = 0;
  for (let i = 0; i < c.length; i++) {
    const a = g[i], b = c[i];
    if (!Number.isFinite(a)) return { ok: false, why: 'в ответе видеокарты не числа' };
    diff += Math.abs(a - b); ref += Math.abs(b);
  }
  const rel = diff / (ref + 1e-6);
  return { ok: rel < 0.08, rel, why: rel < 0.08 ? '' : 'ответ видеокарты расходится с процессором на ' + Math.round(rel * 100) + '%' };
}
const CPU_OPTS = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
async function runOn(sess, tensor) {
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 640, 640]) });
  return out[sess.outputNames[0]].data;
}
async function release(sess) { try { if (sess && sess.release) await sess.release(); } catch (e) {} }

function bundledModelPath(appDir) {
  // в упакованном приложении модель лежит рядом с app.asar (extraResources) либо в папке проекта
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'models', MODEL_NAME));
  cands.push(path.join(appDir, 'models', MODEL_NAME));
  return cands.find((p) => { try { return fs.statSync(p).size > MODEL_MIN_BYTES; } catch (e) { return false; } }) || null;
}
function downloadedModelPath(userData) { return path.join(userData, 'models', MODEL_NAME); }

function findModel(appDir, userData) {
  const b = bundledModelPath(appDir);
  if (b) return b;
  const d = downloadedModelPath(userData);
  try { if (fs.statSync(d).size > MODEL_MIN_BYTES) return d; } catch (e) {}
  return null;
}

function download(url, dest, onProgress, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Слишком много перенаправлений при скачивании модели'));
    const req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'User-Agent': 'xVision' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Сервер ответил ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = dest + '.part';
      const out = fs.createWriteStream(part);
      res.on('data', (c) => { got += c.length; if (total && onProgress) onProgress(Math.round(got / total * 100)); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { try { fs.renameSync(part, dest); resolve(dest); } catch (e) { reject(e); } }));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Нет ответа от сервера загрузки модели')));
  });
}

// Понятное объяснение, почему не загрузился модуль нейросети (раньше любая ошибка выглядела как «не найден модуль»).
function runtimeLoadError(e) {
  const msg = String((e && e.message) || e).split('\n')[0];
  if (e && e.code === 'MODULE_NOT_FOUND' && /onnxruntime-(node|common)['"]/.test(msg)) {
    return 'Не найден модуль нейросети (onnxruntime-node). Переустановите программу. (Для разработчика: npm install в папке программы.)';
  }
  if (/specified module could not be found|не найден указанный модуль|specified procedure|dlopen|\.node|\.dll/i.test(msg)) {
    return 'Не удалось загрузить библиотеку нейросети. Обычно это значит, что на компьютере нет «Microsoft Visual C++ Redistributable» — ' +
      'установите его с сайта Microsoft (файл vc_redist.x64.exe) и перезапустите программу. Подробности: ' + msg;
  }
  return 'Не удалось загрузить модуль нейросети: ' + msg;
}

// Готовит нейросеть: ищет/скачивает модель и создаёт сессию. Безопасно вызывать много раз.
// Видеокарта (DirectML) проверяется: её ответ на проверочную картинку сравнивается с ответом процессора.
// На части видеокарт нейросеть запускается без ошибок, но считает неверно — «не видит» игроков; тогда работаем
// на процессоре и запоминаем это, чтобы при следующих запусках не ждать видеокарту зря.
async function prepare({ appDir, userData, onStage, forceCpu, rememberCpu }) {
  if (session) return { ok: true, provider: providerUsed };
  if (loading) return loading;
  userDir = userData;
  loading = (async () => {
    let modelPath = findModel(appDir, userData);
    if (!modelPath) {
      onStage && onStage({ stage: 'download', percent: 0 });
      try { modelPath = await download(MODEL_URL, downloadedModelPath(userData), (p) => onStage && onStage({ stage: 'download', percent: p })); }
      catch (e) { log('модель не скачалась: ' + (e.message || e)); return { ok: false, kind: 'model', error: 'Не удалось скачать модель распознавания игроков: ' + (e.message || e) }; }
    }
    modelFile = modelPath;
    onStage && onStage({ stage: 'load', percent: 0 });
    try { ort = require('onnxruntime-node'); }
    catch (e) { log('модуль нейросети не загрузился: ' + ((e && e.message) || e)); return { ok: false, kind: 'runtime', error: runtimeLoadError(e) }; }
    let size = 0; try { size = fs.statSync(modelPath).size; } catch (e) {}
    const verdict = readVerdict();
    if (forceCpu && rememberCpu) saveVerdict({ dml: 'bad', why: 'видеокарта не ответила за отведённое время' });
    const gpuBad = verdict.dml === 'bad' && Date.now() - (verdict.at || 0) < 30 * DAY; // раз в месяц пробуем видеокарту снова (драйвер могли обновить)
    log('запуск: модель ' + Math.round(size / 1048576) + ' МБ, ' + (forceCpu ? 'только процессор (видеокарта не ответила)' : gpuBad ? 'только процессор (видеокарта отклонена: ' + (verdict.why || '') + ')' : 'пробую видеокарту'));
    const pattern = testPattern();
    let lastErr = null;
    if (!forceCpu && !gpuBad && process.platform === 'win32') { // видеокарта через DirectML — только на Windows; на Mac — процессор
      let g = null;
      try {
        g = await ort.InferenceSession.create(modelPath, { executionProviders: ['dml', 'cpu'], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential' });
        const outG = await runOn(g, pattern); // некоторые видеокарты создают сессию, но падают на первом запуске
        let good = verdict.dml === 'ok' && Date.now() - (verdict.at || 0) < 14 * DAY;
        if (!good) {
          const c = await ort.InferenceSession.create(modelPath, CPU_OPTS);
          const cmp = compareOutputs(outG, await runOn(c, pattern));
          log('проверка видеокарты: ' + (cmp.ok ? 'совпадает с процессором' : 'НЕ совпадает — ' + cmp.why) + (cmp.rel != null ? ' (расхождение ' + cmp.rel.toFixed(4) + ')' : ''));
          if (cmp.ok) { saveVerdict({ dml: 'ok' }); await release(c); good = true; }
          else {
            saveVerdict({ dml: 'bad', why: cmp.why });
            await release(g);
            session = c; inputName = c.inputNames[0]; providerUsed = 'CPU'; gpuNote = cmp.why;
            return { ok: true, provider: 'CPU', gpuRejected: cmp.why };
          }
        }
        session = g; inputName = g.inputNames[0]; providerUsed = 'DirectML (видеокарта)';
        return { ok: true, provider: providerUsed };
      } catch (e) { lastErr = e; log('видеокарта: ошибка — ' + ((e && e.message) || e)); await release(g); }
    }
    try {
      const c = await ort.InferenceSession.create(modelPath, CPU_OPTS);
      await runOn(c, pattern);
      session = c; inputName = c.inputNames[0]; providerUsed = 'CPU';
      log('работаю на процессоре');
      return { ok: true, provider: 'CPU' };
    } catch (e) { lastErr = e; log('процессор: ошибка — ' + ((e && e.message) || e)); }
    return { ok: false, kind: 'runtime', error: 'Не удалось запустить нейросеть: ' + (lastErr && lastErr.message || lastErr) };
  })();
  try { return await loading; } finally { loading = null; }
}

async function infer(tensor) {
  const out = await session.run({ [inputName]: new ort.Tensor('float32', tensor, [1, 3, 640, 640]) });
  const first = out[session.outputNames[0]];
  return first.data;
}

function status({ appDir, userData }) {
  return { modelReady: !!findModel(appDir, userData), loaded: !!session, provider: providerUsed };
}

// Возвращает { boxes, info }. Если видеокарта не нашла ни одного человека — один раз за запуск тот же кадр
// проверяется на процессоре: нашёл — значит, видеокарта считает неверно, дальше работаем на процессоре.
// Для каждого видео запоминаем, помог ли крупный кадр: помог — сразу ищем по нему; дважды не помог — больше не пробуем
// (иначе каждая остановка на кадре без игроков стоила бы лишних секунд).
const hiMemo = new Map(); // путь к видео -> { w: ширина крупного кадра или 0, useless: сколько раз не помог }
async function detect(opts) {
  const info = {};
  const memo = hiMemo.get(opts.sourcePath) || { w: 0, useless: 0 };
  opts = Object.assign({}, opts, { trackW: memo.w || 0, noHi: memo.useless >= 2 });
  let boxes = await tracker.detectFrame(Object.assign({ infer, info }, opts));
  if (info.hi) memo.w = info.fw; else if (info.triedHi) memo.useless++;
  hiMemo.set(opts.sourcePath, memo);
  if (!boxes.length && !info.blank && providerUsed && providerUsed !== 'CPU' && !crossChecked && modelFile) {
    crossChecked = true;
    let c = null;
    try {
      c = await ort.InferenceSession.create(modelFile, CPU_OPTS);
      const info2 = {};
      const b2 = await tracker.detectFrame(Object.assign({}, opts, { infer: (tn) => runOn(c, tn), info: info2 }));
      log('перепроверка на процессоре: видеокарта нашла 0, процессор — ' + b2.length);
      if (b2.length) {
        const old = session;
        session = c; inputName = c.inputNames[0]; providerUsed = 'CPU'; gpuNote = 'на кадре видео видеокарта не нашла игроков, а процессор нашёл';
        saveVerdict({ dml: 'bad', why: gpuNote });
        await release(old);
        boxes = b2; Object.assign(info, info2, { switched: true });
        c = null;
      }
    } catch (e) { log('перепроверка на процессоре не удалась: ' + ((e && e.message) || e)); }
    if (c) await release(c);
  }
  info.provider = providerUsed;
  log('кадр ' + (opts.t != null ? Number(opts.t).toFixed(2) + ' с' : '') + ': видео ' + opts.srcW + 'x' + opts.srcH + ', анализ ' + info.fw + 'x' + info.fh + (info.hi ? ' (крупный кадр)' : '') +
    ', яркость ' + info.mean + '±' + info.spread + (info.blank ? ' — ПУСТОЙ КАДР' : '') + ', найдено людей: ' + boxes.length + ', ' + providerUsed);
  return { boxes, info };
}
async function track(opts) {
  const r = await tracker.trackPlayers(Object.assign({ infer }, opts));
  try {
    log('слежение ' + Number(opts.from).toFixed(1) + '–' + Number(opts.to).toFixed(1) + ' с' + (opts.trackW ? ', крупный кадр ' + opts.trackW : '') + ': ' +
      (r.results || []).map((x) => (x.samples || []).length + ' отсч.' + (x.ends && x.ends.after ? ' (потерян: ' + x.ends.after + ')' : '')).join('; '));
  } catch (e) {}
  return r;
}

module.exports = { prepare, status, detect, track, infer, download, findModel, downloadedModelPath, logPath, compareOutputs, testPattern, MODEL_URL, MODEL_NAME, MODEL_MIN_BYTES };
