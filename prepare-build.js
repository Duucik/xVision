// Подготовка к сборке установщика на Windows (запускается сама из «npm run dist»).
//
// Сборщик electron-builder при первой сборке скачивает служебный архив winCodeSign (там утилита rcedit, которая
// вшивает иконку и версию в xVision.exe). В архиве есть файлы для macOS в виде символических ссылок, а Windows
// без прав администратора не даёт их создать — сборка падает с ошибкой «Cannot create symbolic link».
// Здесь мы сами скачиваем этот архив и распаковываем его в кэш сборщика, пропуская ненужную папку macOS (darwin).
// После этого сборщик находит готовую папку и ничего не распаковывает. Делается один раз.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const VERSION = 'winCodeSign-2.6.0';
const ARCHIVE_URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/' + VERSION + '/' + VERSION + '.7z';

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  const local = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(local, 'electron-builder', 'Cache');
}

function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 8) return reject(new Error('слишком много перенаправлений'));
    https.get(url, { headers: { 'User-Agent': 'xVision-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('сервер ответил ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// Библиотеки Microsoft Visual C++ для нейросети.
// onnxruntime.dll (ИИ-подсветка) работает только при установленном «Microsoft Visual C++ Redistributable».
// На компьютере разработчика он обычно есть, а на «чистом» ПК — нет, и нейросеть не загружается.
// Поэтому кладём нужные DLL рядом с модулем нейросети — Windows найдёт их там, установка ничего не требует.
const VC_DLLS = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll',
  'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'];
function copyVcRuntime() {
  const dest = path.join(__dirname, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64');
  if (!fs.existsSync(path.join(dest, 'onnxruntime_binding.node'))) {
    console.log('[подготовка] модуль нейросети не найден в node_modules — выполните npm install');
    return;
  }
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  // 32-битный node видит вместо System32 папку SysWOW64 — 64-битные DLL тогда лежат в Sysnative
  const sys = path.join(root, process.arch === 'x64' || process.arch === 'arm64' ? 'System32' : 'Sysnative');
  const copied = [];
  VC_DLLS.forEach((n) => {
    const src = path.join(sys, n);
    if (!fs.existsSync(src)) return;
    try { fs.copyFileSync(src, path.join(dest, n)); copied.push(n); } catch (e) {}
  });
  if (copied.indexOf('vcruntime140.dll') === -1 || copied.indexOf('msvcp140.dll') === -1) {
    console.log('[подготовка] ВНИМАНИЕ: на этом компьютере не найдены библиотеки Visual C++ (msvcp140.dll / vcruntime140.dll).');
    console.log('[подготовка] Установите «Microsoft Visual C++ Redistributable x64» с сайта Microsoft и повторите npm run dist —');
    console.log('[подготовка] иначе ИИ-подсветка может не запуститься на других компьютерах.');
  } else console.log('[подготовка] библиотеки Visual C++ для нейросети: ' + copied.length + ' шт. добавлены в сборку');
}

// Загрузчик видео (yt-dlp) вшивается в установщик: у тренеров загрузка матча по ссылке работает сразу,
// программе не нужно ничего докачивать с GitHub при первом запуске. Файл обновляется при каждой сборке
// (если он старше трёх дней); не удалось скачать — берём тот, что уже лежит в папке bin.
const LOADER_ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const LOADER_URLS = ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + LOADER_ASSET,
  'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/' + LOADER_ASSET];
function downloadLoader(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 8) return reject(new Error('слишком много перенаправлений'));
    const req = https.get(url, { headers: { 'User-Agent': 'xVision-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadLoader(new URL(res.headers.location, url).toString(), dest, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('сервер ответил ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('сервер не отвечает')));
  });
}
async function prepareLoader() {
  const dir = path.join(__dirname, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const size = () => { try { return fs.statSync(file).size; } catch (e) { return 0; } };
  const have = size() > 3 * 1024 * 1024;
  if (have && Date.now() - fs.statSync(file).mtimeMs < 3 * 24 * 3600 * 1000) {
    console.log('[подготовка] загрузчик видео (yt-dlp) уже в сборке');
    return;
  }
  console.log('[подготовка] скачиваю загрузчик видео yt-dlp (≈18 МБ) — он войдёт в установщик…');
  const tmp = file + '.download';
  let err = null;
  for (const url of LOADER_URLS.concat(LOADER_URLS[0])) {
    try {
      fs.rmSync(tmp, { force: true });
      await downloadLoader(url, tmp);
      if (fs.statSync(tmp).size < 3 * 1024 * 1024) throw new Error('файл скачался не полностью');
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
      console.log('[подготовка] загрузчик видео добавлен в сборку');
      return;
    } catch (e) { err = e; }
  }
  fs.rmSync(tmp, { force: true });
  if (have) { console.log('[подготовка] обновить загрузчик не удалось (' + err.message + ') — в сборку пойдёт прежний файл из папки bin'); return; }
  console.log('[подготовка] ВНИМАНИЕ: не удалось скачать загрузчик видео: ' + err.message);
  console.log('[подготовка] Установщик соберётся БЕЗ него — программа будет скачивать загрузчик сама при первой загрузке матча.');
  console.log('[подготовка] Чтобы вшить его: скачайте yt-dlp.exe с github.com/yt-dlp/yt-dlp/releases, положите в папку bin и повторите npm run dist.');
}

// Модель распознавания игроков (yolox_s.onnx, 36 МБ) тоже вшивается в установщик — тогда ИИ-подсветка
// работает у тренеров сразу и без интернета. Скачивается один раз в папку models.
const MODEL_FILE = 'yolox_s.onnx';
const MODEL_SRC = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx';
async function prepareModel() {
  const dir = path.join(__dirname, 'models');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MODEL_FILE);
  const size = () => { try { return fs.statSync(file).size; } catch (e) { return 0; } };
  if (size() > 30 * 1024 * 1024) { console.log('[подготовка] модель распознавания игроков уже в сборке'); return; }
  // модель могла уже скачать сама программа — берём оттуда
  const appData = process.env.APPDATA || '';
  for (const n of ['hockey-video-analysis', 'hockey-video-analysis-itaa']) {
    const src = path.join(appData, n, 'models', MODEL_FILE);
    try { if (appData && fs.statSync(src).size > 30 * 1024 * 1024) { fs.copyFileSync(src, file); console.log('[подготовка] модель распознавания игроков взята из установленной программы'); return; } } catch (e) {}
  }
  console.log('[подготовка] скачиваю модель распознавания игроков (36 МБ, один раз) — она войдёт в установщик…');
  const tmp = file + '.download';
  let err = null;
  for (let i = 0; i < 2; i++) {
    try {
      fs.rmSync(tmp, { force: true });
      await downloadLoader(MODEL_SRC, tmp);
      if (fs.statSync(tmp).size < 30 * 1024 * 1024) throw new Error('файл скачался не полностью');
      fs.renameSync(tmp, file);
      console.log('[подготовка] модель распознавания игроков добавлена в сборку');
      return;
    } catch (e) { err = e; }
  }
  fs.rmSync(tmp, { force: true });
  console.log('[подготовка] ВНИМАНИЕ: не удалось скачать модель распознавания игроков: ' + err.message);
  console.log('[подготовка] Установщик соберётся БЕЗ неё — программа будет скачивать модель сама при первой подсветке.');
  console.log('[подготовка] Чтобы вшить её: скачайте ' + MODEL_FILE + ' по адресу ' + MODEL_SRC + ', положите в папку models и повторите npm run dist.');
}

// Нейросеть для «Позиции» (вырезать игрока щелчком): MobileSAM, два файла ~45 МБ — тоже в установщик.
const SAM_FILES = [
  ['mobile_sam_image_encoder.onnx', 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx', 20 * 1024 * 1024],
  ['sam_mask_decoder_single.onnx', 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx', 10 * 1024 * 1024],
];
async function prepareSam() {
  const dir = path.join(__dirname, 'models');
  fs.mkdirSync(dir, { recursive: true });
  const appData = process.env.APPDATA || '';
  for (const [name, url, min] of SAM_FILES) {
    const file = path.join(dir, name);
    const size = () => { try { return fs.statSync(file).size; } catch (e) { return 0; } };
    if (size() > min) continue;
    let copied = false;
    for (const n of ['hockey-video-analysis', 'hockey-video-analysis-itaa']) {
      const src = path.join(appData, n, 'models', name);
      try { if (appData && fs.statSync(src).size > min) { fs.copyFileSync(src, file); copied = true; break; } } catch (e) {}
    }
    if (copied) { console.log('[подготовка] ' + name + ' взят из установленной программы'); continue; }
    console.log('[подготовка] скачиваю ' + name + ' (нейросеть для «Позиции», один раз)…');
    const tmp = file + '.download';
    let err = null;
    for (let i = 0; i < 2; i++) {
      try { fs.rmSync(tmp, { force: true }); await downloadLoader(url, tmp); if (fs.statSync(tmp).size < min) throw new Error('файл скачался не полностью'); fs.renameSync(tmp, file); err = null; break; }
      catch (e) { err = e; }
    }
    fs.rmSync(tmp, { force: true });
    if (err) {
      console.log('[подготовка] ВНИМАНИЕ: не удалось скачать ' + name + ': ' + err.message);
      console.log('[подготовка] Установщик соберётся без неё — программа скачает её сама при первой «Позиции».');
    } else console.log('[подготовка] ' + name + ' добавлен в сборку');
  }
}

// Фон окна установки на Mac: обычная и «ретина»-картинки склеиваются в один файл background.tiff
function prepareDmgBackground() {
  const b = path.join(__dirname, 'build');
  const out = path.join(b, 'background.tiff');
  let r = spawnSync('tiffutil', ['-cathidpicheck', path.join(b, 'dmg-background.png'), path.join(b, 'dmg-background@2x.png'), '-out', out], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(out)) {
    r = spawnSync('sips', ['-s', 'format', 'tiff', path.join(b, 'dmg-background.png'), '--out', out], { stdio: 'inherit' });
  }
  if (!fs.existsSync(out)) throw new Error('не удалось подготовить build/background.tiff');
  console.log('[подготовка] фон окна установки готов');
}

async function main() {
  // Без открытого ключа защиты собирать установщик нельзя: такую программу сможет запустить кто угодно.
  if (!fs.existsSync(path.join(__dirname, 'license', 'public.key'))) {
    console.log('');
    console.log('[подготовка] СТОП: в папке программы нет ключа защиты (license\\public.key).');
    console.log('[подготовка] Откройте xVision Launcher → «Настройки» → «Записать открытый ключ в папку программы»,');
    console.log('[подготовка] выберите эту папку (' + __dirname + ') и запустите npm run dist ещё раз.');
    console.log('');
    process.exit(1);
  }
  try { await prepareLoader(); } catch (e) { console.log('[подготовка] загрузчик видео: ' + e.message); }
  try { await prepareModel(); } catch (e) { console.log('[подготовка] модель распознавания: ' + e.message); }
  try { await prepareSam(); } catch (e) { console.log('[подготовка] нейросеть для «Позиции»: ' + e.message); }
  if (process.platform === 'darwin') { try { prepareDmgBackground(); } catch (e) { console.log('[подготовка] фон окна установки: ' + e.message); } }
  if (process.platform !== 'win32') return; // дальше — только для Windows
  try { copyVcRuntime(); } catch (e) { console.log('[подготовка] библиотеки Visual C++: ' + e.message); }
  const base = path.join(cacheRoot(), 'winCodeSign');
  const target = path.join(base, VERSION);
  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) return; // уже готово

  let sevenZip;
  try { sevenZip = require('7zip-bin').path7za; } catch (e) {
    console.log('[подготовка] 7zip-bin не найден — пропускаю (выполните npm install)');
    return;
  }
  fs.mkdirSync(base, { recursive: true });
  const archive = path.join(base, VERSION + '-xvision.7z');
  const tmp = path.join(base, VERSION + '-xvision-tmp');
  console.log('[подготовка] скачиваю ' + VERSION + ' (5 МБ, один раз)…');
  await download(ARCHIVE_URL, archive);
  fs.rmSync(tmp, { recursive: true, force: true });
  // -xr!darwin — не распаковывать папку для macOS (из-за неё и была ошибка с символическими ссылками)
  const r = spawnSync(sevenZip, ['x', '-bd', '-y', archive, '-o' + tmp, '-xr!darwin'], { stdio: 'inherit', windowsHide: true });
  if (!fs.existsSync(path.join(tmp, 'rcedit-x64.exe'))) {
    throw new Error('не удалось распаковать архив (код ' + r.status + ')');
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
  fs.rmSync(archive, { force: true });
  console.log('[подготовка] готово: ' + target);
}

main().catch((e) => {
  // не останавливаем сборку: если что-то пошло не так, electron-builder попробует сам
  console.log('[подготовка] не получилось подготовить winCodeSign: ' + e.message);
  console.log('[подготовка] если сборка снова упадёт с «Cannot create symbolic link» — запустите PowerShell от имени администратора и повторите npm run dist');
});
