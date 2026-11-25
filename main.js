const { app, BrowserWindow, ipcMain, dialog, utilityProcess, shell, screen, net, clipboard, safeStorage, Menu } = require('electron');
const IS_MAC = process.platform === 'darwin';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const downloader = require('./downloader');
const live = require('./live');
const vkdvr = require('./vkdvr');
const http = require('http');
const freezeLib = require('./freeze');
const ai = require('./ai');
let ffmpegPath = require('ffmpeg-static');
// В упакованном .exe FFmpeg физически лежит рядом с app.asar (в app.asar.unpacked),
// но ffmpeg-static возвращает путь так, будто он всё ещё внутри архива — spawn не может
// запустить файл из asar, поэтому подменяем путь на реальный.
if (ffmpegPath && ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// Сохраняем прежнюю папку данных (настройки и проекты), чтобы при смене названия приложения ничего не потерялось
try { app.setPath('userData', path.join(app.getPath('appData'), 'hockey-video-analysis-itaa')); } catch (e) {}

// ---------- доступ по ключу ----------
// Ключ выписывает лаунчер Создателя на конкретный компьютер и до определённой даты (license-core.js).
// В программе лежит только открытая половина ключа (license/public.key) — ею ключ проверяется, но новый не создать.
// Ключ хранится в папке данных программы, поэтому обновления и переустановка его не сбрасывают.
const lic = require('./license-core');
const LIC_PRODUCT = (() => { try { return require('./package.json').xvProduct || 'xv'; } catch (e) { return 'xv'; } })();
const LIC_PUB = (() => { try { return fs.readFileSync(path.join(__dirname, 'license', 'public.key'), 'utf8').trim(); } catch (e) { return ''; } })();
const licFile = () => path.join(app.getPath('userData'), 'license.json');
function licRead() { try { return JSON.parse(fs.readFileSync(licFile(), 'utf8')) || {}; } catch (e) { return {}; } }
function licWrite(o) { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(licFile(), JSON.stringify(o, null, 1)); } catch (e) {} }
function licenseState() {
  const machine = lic.machineCode();
  const base = { machine, product: LIC_PRODUCT, productName: lic.PRODUCTS[LIC_PRODUCT] || 'xVision' };
  if (!LIC_PUB) {
    // без открытого ключа: при разработке (npm start) программа работает, а собранную раздавать нельзя
    return Object.assign(base, app.isPackaged ? { ok: false, status: 'nobuild', error: 'Сборка без ключа защиты.' } : { ok: true, status: 'dev' });
  }
  const st = licRead(), now = Date.now();
  if (!st.key) return Object.assign(base, { ok: false, status: 'none' });
  const r = lic.checkKey(st.key, { pub: LIC_PUB, machine, product: LIC_PRODUCT, now });
  const creator = r.payload && r.payload.k === 'creator';
  // дату перевели назад больше чем на полтора дня — ключ не принимаем, пока не поправят
  if (!creator && st.lastSeen && now < st.lastSeen - 36 * 3600 * 1000) return Object.assign(base, { ok: false, status: 'clock', payload: r.payload, error: 'Дата на компьютере раньше, чем при прошлом запуске программы.' });
  if (r.ok && (!st.lastSeen || now > st.lastSeen)) licWrite(Object.assign(st, { lastSeen: now }));
  return Object.assign(base, r, { expires: r.payload && r.payload.e ? lic.ruDate(r.payload.e) : '' });
}
const licOk = () => licenseState().ok;
const LIC_DENIED = { ok: false, error: 'Нет действующего ключа xVision.' };
let mainWin = null;
ipcMain.handle('license-info', () => licenseState());
ipcMain.handle('license-activate', (event, key) => {
  if (!LIC_PUB) return { ok: false, error: 'Сборка без ключа защиты.' };
  const text = String(key || '').replace(/\s+/g, '');
  const r = lic.checkKey(text, { pub: LIC_PUB, machine: lic.machineCode(), product: LIC_PRODUCT });
  if (!r.ok) return r;
  if (r.status === 'grace') return { ok: false, status: 'expired', error: 'Срок этого ключа уже закончился (' + lic.ruDate(r.payload.e) + '). Попросите новый.' };
  licWrite({ key: text, lastSeen: Date.now(), activatedAt: new Date().toISOString() });
  return Object.assign(r, { expires: lic.ruDate(r.payload.e) });
});
ipcMain.handle('license-continue', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w && licOk()) w.loadFile('index.html');
  return licOk();
});
ipcMain.handle('license-open', (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.loadFile('license.html'); });
ipcMain.handle('clipboard-write', (event, text) => { clipboard.writeText(String(text || '')); return true; });
// раз в полчаса: ключ мог закончиться, пока программа открыта
setInterval(() => {
  try {
    if (!mainWin || mainWin.isDestroyed() || licOk()) return;
    if (!/license\.html$/.test(mainWin.webContents.getURL())) mainWin.loadFile('license.html');
  } catch (e) {}
}, 30 * 60 * 1000);

// ---------- автообновление ----------
// Новые версии выкладываются в «Релизы» репозитория GitHub (их собирает GitHub Actions). Программа сама проверяет
// их при запуске и каждые 3 часа, тихо скачивает и ставит при следующем закрытии — или сразу по кнопке «Обновить».
// Проекты, настройки, ключ и тренировки лежат в папке данных — обновление их не трогает.
let updater = null, updState = { state: 'idle' };
const updLogFile = () => path.join(app.getPath('userData'), 'update-log.txt');
function updLog(...a) {
  try {
    const f = updLogFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, new Date().toISOString() + ' ' + a.map((x) => (x && x.stack) || String(x)).join(' ') + '\n');
  } catch (e) {}
}
function updSend(o) {
  updState = Object.assign({}, updState, o);
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-status', updState); } catch (e) {}
}
function updFriendly(e) {
  const s = String((e && e.message) || e || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|EAI_AGAIN|net::|socket|network/i.test(s)) return 'нет связи с GitHub — проверим позже';
  if (/404|Cannot find .*latest\.yml|No published versions/i.test(s)) return 'на GitHub ещё нет выпущенных версий';
  return s.split('\n')[0].slice(0, 160);
}
// Тестовые версии: новые сборки выходят на GitHub как «пре-релиз» и приходят только Создателю (галочка в настройках).
// Остальные получают версию, когда её отметят «для всех» (GitHub → Actions → «Выпустить для всех»).
const betaFile = () => path.join(app.getPath('userData'), 'update-beta.json');
function isCreator() { try { const st = licenseState(); return !!(st && st.payload && st.payload.k === 'creator'); } catch (e) { return false; } }
function betaOn() { if (!isCreator()) return false; try { return !!JSON.parse(fs.readFileSync(betaFile(), 'utf8')).beta; } catch (e) { return false; } }
// Mac без сертификата Apple не умеет ставить обновления сам: проверяем GitHub и даём кнопку «Скачать».
function macUpdater() {
  const EE = require('events'); const u = new EE();
  u.allowPrerelease = false;
  u.checkForUpdates = async () => {
    u.emit('checking-for-update');
    const r = await ghReq('GET', u.allowPrerelease ? '/repos/' + ghRepo() + '/releases?per_page=15' : '/repos/' + ghRepo() + '/releases/latest', null, '');
    if (r.status !== 200 || !r.json) { const e = new Error('GitHub ответил ' + (r.status || r.error)); u.emit('error', e); throw e; }
    const list = Array.isArray(r.json) ? r.json.filter((x) => !x.draft) : [r.json];
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    // самая новая версия, у которой есть сборка для этого Mac
    const rel = list.map((x) => ({ x, v: relVer(x.tag_name), a: (x.assets || []).find((a) => a.name.endsWith('-' + arch + '.dmg')) }))
      .filter((y) => y.a).sort((p, q) => verNum(q.v) - verNum(p.v))[0];
    if (rel && verNum(rel.v) > verNum(app.getVersion())) { u.url = rel.a.browser_download_url; u.emit('update-manual', { version: rel.v }); }
    else u.emit('update-not-available', {});
  };
  u.quitAndInstall = () => { if (u.url) shell.openExternal(u.url); };
  return u;
}
function setupUpdater() {
  if (!app.isPackaged) { updState = { state: 'dev' }; return; }
  if (IS_MAC) {
    updater = macUpdater();
    updater.allowPrerelease = betaOn(); updState.beta = updater.allowPrerelease;
    updater.on('checking-for-update', () => updSend({ state: updState.state === 'manual' ? 'manual' : 'checking', error: '' }));
    updater.on('update-manual', (i) => updSend({ state: 'manual', version: i.version }));
    updater.on('update-not-available', () => updSend({ state: 'latest', checkedAt: Date.now() }));
    updater.on('error', (e) => { updLog('ошибка', e); if (updState.state !== 'manual') updSend({ state: 'error', error: updFriendly(e), checkedAt: Date.now() }); });
    const check = () => updater.checkForUpdates().catch((e) => updLog('проверка', e));
    setTimeout(check, 8000); setInterval(check, 3 * 3600 * 1000);
    return;
  }
  try { updater = require('electron-updater').autoUpdater; } catch (e) { updState = { state: 'off', error: 'модуль обновлений не установлен' }; updLog('нет electron-updater', e); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = betaOn();
  updState.beta = updater.allowPrerelease;
  updater.logger = { info: (m) => updLog('[i]', m), warn: (m) => updLog('[!]', m), error: (m) => updLog('[x]', m), debug() {} };
  updater.on('checking-for-update', () => updSend({ state: updState.state === 'ready' ? 'ready' : 'checking', error: '' }));
  updater.on('update-available', (i) => updSend({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => updSend({ state: 'latest', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => updSend({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }));
  updater.on('update-downloaded', (i) => updSend({ state: 'ready', version: i.version, percent: 100 }));
  updater.on('error', (e) => { updLog('ошибка', e); if (updState.state !== 'ready') updSend({ state: 'error', error: updFriendly(e), checkedAt: Date.now() }); });
  const check = () => { if (updState.state === 'downloading' || updState.state === 'ready') return; updater.checkForUpdates().catch((e) => updLog('проверка', e)); };
  setTimeout(check, 8000);
  setInterval(check, 3 * 3600 * 1000);
}
// «Что нового»: разделы журнала изменений (файл «Что нового.txt» в программе)
function changelogSections() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(__dirname, 'Что нового.txt'), 'utf8'); } catch (e) { return []; }
  const out = []; let cur = null;
  txt.replace(/\r/g, '').split('\n').forEach((line) => {
    const mm = /^xVision\s+(\d+\.\d+\.\d+)\s+—/.exec(line);
    if (mm) { cur = { version: mm[1], lines: [line] }; out.push(cur); } else if (/^xVision ITAA \(|^Ранее \(/.test(line)) cur = null; else if (cur) cur.lines.push(line);
  });
  return out.map((s) => ({ version: s.version, text: s.lines.join('\n').replace(/\s+$/, '') }));
}
const verNum = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0).reduce((a, x) => a * 1000 + x, 0);
ipcMain.handle('update-info', () => {
  const cur = app.getVersion(), f = path.join(app.getPath('userData'), 'last-version.txt');
  let prev = null; try { prev = fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  let whatsNew = null;
  if (prev && prev !== cur && verNum(cur) > verNum(prev)) {
    const secs = changelogSections().filter((s) => verNum(s.version) > verNum(prev) && verNum(s.version) <= verNum(cur));
    if (secs.length) whatsNew = { from: prev, to: cur, text: secs.map((s) => s.text).join('\n\n\n') };
  }
  if (prev !== cur) { try { fs.writeFileSync(f, cur); } catch (e) {} }
  return Object.assign({}, updState, { current: cur, whatsNew });
});
ipcMain.handle('update-notes', () => changelogSections().slice(0, 6).map((s) => s.text).join('\n\n\n'));

// ---------- выпуск версий (только Создатель) ----------
// Новые версии выходят на GitHub тестовыми. Здесь Создатель сам решает, какая версия — «для всех»:
// программа меняет отметки релизов на GitHub. Для этого нужен токен GitHub (вводится один раз, хранится зашифрованным).
const GH_API = process.env.XV_GH_API || 'https://api.github.com';
const ghRepo = () => { try { const p = require('./package.json').build.publish[0]; return p.owner + '/' + p.repo; } catch (e) { return 'Duucik/xVision'; } };
const ghTokenFile = () => path.join(app.getPath('userData'), 'gh-token.bin');
function ghTokenGet() {
  try {
    const b = fs.readFileSync(ghTokenFile());
    return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8');
  } catch (e) { return ''; }
}
function ghTokenPut(tok) {
  if (!tok) { try { fs.unlinkSync(ghTokenFile()); } catch (e) {} return; }
  const b = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(tok) : Buffer.from(tok, 'utf8');
  fs.writeFileSync(ghTokenFile(), b);
}
function ghReq(method, p, body, tok) {
  return new Promise((resolve) => {
    let req, done = false, timer;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { req = net.request({ method, url: GH_API + p, redirect: 'follow' }); } catch (e) { return fin({ status: 0, error: e.message }); }
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', 'xVision');
    req.setHeader('X-GitHub-Api-Version', '2022-11-28');
    if (tok) req.setHeader('Authorization', 'Bearer ' + tok);
    if (body) req.setHeader('Content-Type', 'application/json');
    timer = setTimeout(() => { try { req.abort(); } catch (e) {} fin({ status: 0, error: 'GitHub не отвечает' }); }, 20000);
    req.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} fin({ status: res.statusCode, json: j }); }); });
    req.on('error', (e) => fin({ status: 0, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const relVer = (tag) => String(tag || '').replace(/^v/i, '');
ipcMain.handle('rel-state', async () => {
  if (!isCreator()) return { allowed: false };
  return { allowed: true, hasToken: !!ghTokenGet(), repo: ghRepo() };
});
ipcMain.handle('rel-token', async (e, tok) => {
  if (!isCreator()) return { ok: false, error: 'Только для ключа Создателя.' };
  tok = String(tok || '').trim();
  if (!tok) { ghTokenPut(''); return { ok: true }; }
  const r = await ghReq('GET', '/repos/' + ghRepo(), null, tok);
  if (r.status === 401) return { ok: false, error: 'GitHub не принял токен — проверьте, что он скопирован целиком и не просрочен.' };
  if (r.status !== 200) return { ok: false, error: 'Нет доступа к репозиторию ' + ghRepo() + (r.status ? ' (ответ ' + r.status + ')' : ': ' + (r.error || 'нет связи')) };
  if (r.json && r.json.permissions && !r.json.permissions.push) return { ok: false, error: 'У токена нет права записи в ' + ghRepo() + ' — дайте ему «Contents: Read and write».' };
  ghTokenPut(tok);
  return { ok: true };
});
ipcMain.handle('rel-list', async () => {
  if (!isCreator()) return { ok: false, error: 'Только для ключа Создателя.' };
  const tok = ghTokenGet();
  const [a, l] = await Promise.all([ghReq('GET', '/repos/' + ghRepo() + '/releases?per_page=15', null, tok), ghReq('GET', '/repos/' + ghRepo() + '/releases/latest', null, tok)]);
  if (a.status !== 200 || !Array.isArray(a.json)) return { ok: false, error: a.status === 403 ? 'GitHub временно ограничил запросы — попробуйте через несколько минут.' : 'Не удалось получить список версий' + (a.error ? ': ' + a.error : ' (ответ ' + a.status + ')') };
  const latest = l.status === 200 && l.json ? l.json.tag_name : '';
  const items = a.json.filter((x) => !x.draft).map((x) => ({ id: x.id, tag: x.tag_name, version: relVer(x.tag_name), prerelease: !!x.prerelease, latest: x.tag_name === latest, date: x.published_at || x.created_at, url: x.html_url }))
    .sort((x, y) => verNum(y.version) - verNum(x.version));
  return { ok: true, items, latest: relVer(latest), current: app.getVersion() };
});
// сделать версию «для всех»: она становится последней обычной, более новые — снова тестовыми
ipcMain.handle('rel-publish', async (e, tag) => {
  if (!isCreator()) return { ok: false, error: 'Только для ключа Создателя.' };
  const tok = ghTokenGet(); if (!tok) return { ok: false, error: 'Сначала введите токен GitHub.' };
  const all = await ghReq('GET', '/repos/' + ghRepo() + '/releases?per_page=30', null, tok);
  if (all.status !== 200 || !Array.isArray(all.json)) return { ok: false, error: 'Не удалось получить список версий (ответ ' + all.status + ')' };
  const target = all.json.find((x) => x.tag_name === tag);
  if (!target) return { ok: false, error: 'Версия ' + tag + ' не найдена.' };
  const r = await ghReq('PATCH', '/repos/' + ghRepo() + '/releases/' + target.id, { prerelease: false, make_latest: 'true' }, tok);
  if (r.status !== 200) return { ok: false, error: r.status === 403 || r.status === 404 ? 'У токена нет права менять релизы (нужно «Contents: Read and write»).' : 'GitHub ответил ' + (r.status || r.error) };
  const newer = all.json.filter((x) => !x.draft && !x.prerelease && x.id !== target.id && verNum(relVer(x.tag_name)) > verNum(relVer(tag))).sort((x, y) => verNum(relVer(x.tag_name)) - verNum(relVer(y.tag_name)));
  for (const x of newer) await ghReq('PATCH', '/repos/' + ghRepo() + '/releases/' + x.id, { prerelease: true }, tok);
  updLog('выпуск для всех: ' + tag + (newer.length ? ' (снова тестовые: ' + newer.map((x) => x.tag_name).join(', ') + ')' : ''));
  return { ok: true, tag, demoted: newer.map((x) => relVer(x.tag_name)) };
});
ipcMain.handle('open-github', (e, url) => { if (/^https:\/\/github\.com\//.test(String(url || ''))) shell.openExternal(url); return true; });
ipcMain.handle('update-beta', (e, on) => {
  if (on == null || !isCreator()) return { on: betaOn(), allowed: isCreator() };
  try { fs.writeFileSync(betaFile(), JSON.stringify({ beta: !!on })); } catch (err) {}
  if (updater) updater.allowPrerelease = !!on;
  updLog('тестовые версии: ' + (on ? 'вкл' : 'выкл'));
  updSend({ beta: !!on });
  return { on: !!on, allowed: true };
});
ipcMain.handle('update-check', async () => {
  if (!updater) return Object.assign({}, updState);
  if (updState.state === 'ready' || updState.state === 'downloading') return Object.assign({}, updState);
  updSend({ state: 'checking', error: '' });
  try { await updater.checkForUpdates(); } catch (e) { updLog('проверка', e); updSend({ state: 'error', error: updFriendly(e), checkedAt: Date.now() }); }
  return Object.assign({}, updState);
});
ipcMain.handle('update-install', () => {
  if (updater && updState.state === 'manual') { updLog('Mac: открываю загрузку ' + updState.version); updater.quitAndInstall(); return true; }
  if (!updater || updState.state !== 'ready') return false;
  updLog('устанавливаю ' + updState.version);
  setImmediate(() => { try { updater.quitAndInstall(true, true); } catch (e) { updLog('установка', e); } });
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131315',
    title: 'xVision',
    show: false, // показываем уже развёрнутым на весь экран
    // собственная шапка в стиле приложения; кнопки окна (свернуть/закрыть) остаются системными, но в цвет шапки
    titleBarStyle: 'hidden',
    // Windows: кнопки окна справа, в цвет шапки; Mac: «светофор» слева
    ...(IS_MAC ? { trafficLightPosition: { x: 14, y: 15 } } : { titleBarOverlay: { color: '#0E0E10', symbolColor: '#D9D9D6', height: 44 } }),
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Тренерская открывается внутри главного окна (iframe coach.html) — ей тоже нужен мост window.api
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  hookUiZoom(win);
  win.maximize();
  win.show();
  mainWin = win;
  win.loadFile(licOk() ? 'index.html' : 'license.html');
  // win.webContents.openDevTools();
}

// ---------- единый масштаб интерфейса ----------
// Один масштаб на всё окно — и для Видеоаналитики, и для Тренерской. Базовый подбирается под экран
// (на большом мониторе крупнее), Ctrl + / Ctrl − / Ctrl 0 меняют его в любом разделе, выбор запоминается.
const zoomFile = () => path.join(app.getPath('userData'), 'ui-zoom.json');
let uiUserZoom = 1;
try { uiUserZoom = Math.min(1.8, Math.max(0.6, Number(JSON.parse(fs.readFileSync(zoomFile(), 'utf-8')).user) || 1)); } catch (e) {}
function uiAutoZoom(win) {
  try {
    const s = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    return Math.min(1.5, Math.max(0.8, Math.min(s.width / 1600, s.height / 900))); // на небольших экранах интерфейс чуть мельче — больше места видео
  } catch (e) { return 1; }
}
function applyUiZoom(win, announce) {
  if (!win || win.isDestroyed()) return;
  const f = Math.round(Math.min(2.2, Math.max(0.6, uiAutoZoom(win) * uiUserZoom)) * 100) / 100;
  try { win.webContents.setZoomFactor(f); } catch (e) {}
  // системные кнопки окна (свернуть/закрыть) — той же высоты, что и шапка
  try { if (win.setTitleBarOverlay) win.setTitleBarOverlay({ color: '#0E0E10', symbolColor: '#D9D9D6', height: Math.round(44 * f) }); } catch (e) {}
  if (announce) { try { win.webContents.send('ui-zoom', { factor: f, user: uiUserZoom }); } catch (e) {} }
}
function hookUiZoom(win) {
  win.webContents.on('did-finish-load', () => applyUiZoom(win));
  win.on('moved', () => applyUiZoom(win)); // перетащили на другой монитор
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const k = input.key, c = input.code;
    let d = null;
    if (k === '+' || k === '=' || c === 'NumpadAdd' || c === 'Equal') d = 1;
    else if (k === '-' || k === '_' || c === 'NumpadSubtract' || c === 'Minus') d = -1;
    else if (k === '0' || c === 'Numpad0' || c === 'Digit0') d = 0;
    if (d === null) return;
    event.preventDefault();
    uiUserZoom = d === 0 ? 1 : Math.min(1.8, Math.max(0.6, uiUserZoom * (d > 0 ? 1.1 : 1 / 1.1)));
    if (Math.abs(uiUserZoom - 1) < 0.02) uiUserZoom = 1;
    try { fs.writeFileSync(zoomFile(), JSON.stringify({ user: uiUserZoom })); } catch (e) {}
    applyUiZoom(win, true);
  });
}

// Mac: без меню не работают Cmd+C / Cmd+V / Cmd+Q — ставим стандартное
if (IS_MAC) app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about', label: 'О программе' }, { type: 'separator' }, { role: 'hide', label: 'Скрыть' }, { role: 'hideOthers', label: 'Скрыть остальные' }, { type: 'separator' }, { role: 'quit', label: 'Выйти' }] },
    { label: 'Правка', submenu: [{ role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выбрать всё' }] },
    { label: 'Окно', submenu: [{ role: 'minimize', label: 'Свернуть' }, { role: 'zoom', label: 'Развернуть' }, { role: 'togglefullscreen', label: 'Во весь экран' }, { role: 'close', label: 'Закрыть' }] },
  ]));
});
app.whenReady().then(() => {
  try { setupUpdater(); } catch (e) { updLog('setupUpdater', e); }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit(); // и на Mac: закрыли окно — программа завершается (запись трансляции останавливается аккуратно)
});

// ---------- settings & project persistence ----------
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function defaultProjectsFolder() { return path.join(app.getPath('userData'), 'projects'); }
function defaultDownloadsFolder() { return path.join(app.getPath('videos'), 'xVision'); }
function defaultSettings() { return { language: 'ru', projectsFolder: defaultProjectsFolder(), downloadsFolder: defaultDownloadsFolder() }; }

ipcMain.handle('get-settings', async () => {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const saved = JSON.parse(raw);
    return Object.assign(defaultSettings(), saved);
  } catch (e) {
    return defaultSettings();
  }
});

// Настройка «Нейросеть»: auto — видеокарта с проверкой, cpu — только процессор (для компьютеров без видеокарты)
function aiDevicePref() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).aiDevice === 'cpu' ? 'cpu' : 'auto'; } catch (e) { return 'auto'; }
}
// Компьютер без видеокарты (или без её драйвера): Windows показывает только «базовый видеоадаптер Microsoft».
// Нейросеть на нём либо зависает, либо считает очень медленно — в режиме «Авто» сразу работаем на процессоре.
let aiGpuAbsent = null;
async function aiNoGpu() {
  if (aiGpuAbsent != null) return aiGpuAbsent;
  aiGpuAbsent = false;
  try {
    const info = await Promise.race([app.getGPUInfo('basic'), new Promise((r) => setTimeout(() => r(null), 3000))]);
    const devs = (info && info.gpuDevice) || [];
    const real = devs.filter((d) => d && d.vendorId && d.vendorId !== 0x1414); // 0x1414 — программный адаптер Microsoft
    aiGpuAbsent = devs.length > 0 && real.length === 0;
  } catch (e) { aiGpuAbsent = false; }
  return aiGpuAbsent;
}
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const before = aiDevicePref(), after = settings && settings.aiDevice === 'cpu' ? 'cpu' : 'auto';
    if (before !== after) {
      // режим поменяли — нейросеть запустится заново; при возврате к «Авто» видеокарта проверяется с нуля
      try { aiKill(); } catch (e) {}
      if (after === 'auto') { try { fs.unlinkSync(path.join(app.getPath('userData'), 'ai-check.json')); } catch (e) {} }
    }
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('select-projects-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Папка для сохранения проектов',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

function projectFileFor(projectsFolder, videoPath) {
  // "отпечаток" пути к видео — так один и тот же файл всегда находит свой прогресс,
  // даже если пользователь переименует папку проектов или переставит программу
  const hash = crypto.createHash('md5').update(videoPath).digest('hex').slice(0, 20);
  return path.join(projectsFolder, hash + '.json');
}

ipcMain.handle('load-project-for-video', async (event, { projectsFolder, videoPath }) => {
  try {
    const file = projectFileFor(projectsFolder || defaultProjectsFolder(), videoPath);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
});

ipcMain.handle('save-project', async (event, { projectsFolder, videoPath, data }) => {
  try {
    writeProjectFile(projectsFolder, videoPath, data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

function writeProjectFile(projectsFolder, videoPath, data) {
  const folder = projectsFolder || defaultProjectsFolder();
  fs.mkdirSync(folder, { recursive: true });
  const file = projectFileFor(folder, videoPath);
  const payload = Object.assign({ videoPath, updatedAt: Date.now() }, data);
  // запись через временный файл — сохранение не повредится, если программу закроют в этот момент
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  fs.renameSync(tmp, file);
}

// синхронное сохранение при закрытии окна
ipcMain.on('save-project-sync', (event, { projectsFolder, videoPath, data }) => {
  try { writeProjectFile(projectsFolder, videoPath, data); event.returnValue = true; }
  catch (e) { event.returnValue = false; }
});

// список всех сохранённых разборов (для главного экрана)
ipcMain.handle('list-projects', async (event, { projectsFolder }) => {
  const folder = projectsFolder || defaultProjectsFolder();
  const result = [];
  try {
    const names = fs.readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.json'));
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!p || !p.videoPath) continue;
        result.push({
          file,
          videoPath: p.videoPath,
          videoName: /vod\.m3u8$/i.test(p.videoPath) ? path.basename(path.dirname(p.videoPath)) : path.basename(p.videoPath),
          live: /vod\.m3u8$/i.test(p.videoPath),
          exists: fs.existsSync(p.videoPath),
          updatedAt: p.updatedAt || fs.statSync(file).mtimeMs,
          clipCount: Array.isArray(p.clips) ? p.clips.length : 0,
          duration: p.duration || 0,
          lastPosition: p.lastPosition || 0,
          sourceUrl: p.sourceUrl || '',
        });
      } catch (e) { /* битый файл пропускаем */ }
    }
  } catch (e) { /* папки ещё нет */ }
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
});

ipcMain.handle('read-project-file', async (event, { file }) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
});

ipcMain.handle('delete-project', async (event, { file, projectsFolder }) => {
  try {
    const folder = path.resolve(projectsFolder || defaultProjectsFolder());
    const target = path.resolve(file);
    if (path.dirname(target) !== folder || !target.toLowerCase().endsWith('.json')) return { ok: false, error: 'bad path' };
    fs.unlinkSync(target);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

ipcMain.handle('video-exists', async (event, { videoPath }) => {
  try { return fs.existsSync(videoPath); } catch (e) { return false; }
});

// ---------- загрузка видео по ссылке ----------
let currentDownload = null;

ipcMain.handle('select-downloads-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Папка для скачанных матчей',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// ---------- загрузчик видео (yt-dlp) ----------
// Лежит в папке данных программы. В установщик вшита его копия (папка bin) — первый запуск не требует интернета.
const loaderBinDir = () => path.join(app.getPath('userData'), 'bin');
// Скачивание сетевым механизмом самой программы (Chromium): в отличие от обычного https он использует
// системные настройки сети — прокси, VPN, сертификаты организации.
function netDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.download';
    let done = false, timer = null, out = null, req = null, got = 0;
    const fail = (e) => {
      if (done) return; done = true; clearTimeout(timer);
      try { req && req.abort(); } catch (_) {}
      try { out && out.destroy(); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('сервер не отвечает')), ms); };
    try { req = net.request({ url, redirect: 'follow' }); } catch (e) { return fail(e); }
    req.setHeader('User-Agent', 'xVision');
    req.on('response', (res) => {
      if (res.statusCode !== 200) return fail(new Error('сервер ответил ' + res.statusCode));
      let len = res.headers['content-length']; if (Array.isArray(len)) len = len[0];
      const total = parseInt(len || '0', 10);
      out = fs.createWriteStream(tmp);
      out.on('error', fail);
      res.on('data', (chunk) => { arm(45000); got += chunk.length; out.write(chunk); if (onProgress && total) onProgress(Math.min(1, got / total)); });
      res.on('end', () => {
        if (done) return;
        out.end(() => { if (done) return; done = true; clearTimeout(timer); try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } });
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('соединение прервано')));
    });
    req.on('error', fail);
    arm(25000);
    req.end();
  });
}
function loaderOpts() {
  const appData = app.getPath('appData');
  const file = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return {
    bundled: app.isPackaged ? path.join(process.resourcesPath, 'bin', file) : path.join(__dirname, 'bin', file),
    // обе версии xVision (обычная и ITAA) делятся загрузчиком: если он есть у одной, вторая его просто копирует
    siblingDirs: ['hockey-video-analysis', 'hockey-video-analysis-itaa'].map((n) => path.join(appData, n, 'bin')),
    fetch: netDownload,
    isBusy: () => !!currentDownload,
  };
}
// через 12 секунд после запуска тихо проверяем обновление загрузчика — загрузке матча это не мешает
app.whenReady().then(() => setTimeout(() => { downloader.updateInBackground(loaderBinDir(), loaderOpts()).catch(() => {}); }, 12000));

ipcMain.handle('loader-pick', async () => {
  if (currentDownload) return { ok: false, error: 'Сначала дождитесь конца загрузки.' };
  const result = await dialog.showOpenDialog({
    title: 'Файл загрузчика yt-dlp',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'yt-dlp.exe', extensions: ['exe'] }] : [],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try { return await downloader.setLoaderFile(loaderBinDir(), result.filePaths[0]); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});

ipcMain.handle('download-video', async (event, { url, quality, cookiesBrowser, outDir }) => {
  if (currentDownload) return { ok: false, kind: 'busy', error: 'Уже идёт другая загрузка' };
  let settings = defaultSettings();
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))); } catch (e) {}
  const send = (msg) => { try { event.sender.send('download-progress', msg); } catch (e) {} };
  const state = { proc: null, cancelled: false };
  currentDownload = state;
  try {
    const res = await downloader.downloadVideo({
      binDir: loaderBinDir(),
      loader: loaderOpts(),
      ffmpegPath,
      url: String(url || '').trim(),
      quality: quality || 'best',
      outDir: outDir || settings.downloadsFolder || defaultDownloadsFolder(),
      cookiesBrowser: cookiesBrowser || '',
      onProgress: (p) => send({ type: 'progress', ...p }),
      onStatus: (text) => send({ type: 'status', text }),
      registerProc: (proc) => { state.proc = proc; if (state.cancelled) { proc.cancelledFlag && proc.cancelledFlag(); downloader.killTree(proc); } },
    });
    return res;
  } catch (e) {
    return { ok: false, kind: 'other', error: e.message || String(e) };
  } finally {
    currentDownload = null;
  }
});

ipcMain.handle('download-cancel', async () => {
  if (!currentDownload) return { ok: true };
  currentDownload.cancelled = true;
  const proc = currentDownload.proc;
  if (proc) { proc.cancelledFlag && proc.cancelledFlag(); downloader.killTree(proc); }
  return { ok: true };
});


// ---------- трансляция: разметка поверх идущего эфира ----------
// Ссылку на эфир (VK Видео, YouTube) разбирает загрузчик, поток пишет ffmpeg в папку «Трансляции» кусочками по 4 с
// (live.js). Окно показывает эту запись плеером HLS через маленький локальный сервер: можно отматывать назад и
// возвращаться в эфир. Выгрузка клипов, ИИ и стоп-кадры работают с той же записью (vod.m3u8).
let liveSess = null, liveMeta = null;
function liveNormUrl(u) {
  u = String(u || '').trim();
  // vk.ru/live-123_456, vkvideo.ru/live-… → vk.com/video-123_456 (так ссылку понимает загрузчик)
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:vk\.(?:com|ru)|vkvideo\.ru)\/(?:live|video)(-?\d+_\d+)/i.exec(u);
  if (m) return 'https://vk.com/video' + m[1];
  if (!/^https?:\/\//i.test(u) && /^[\w.-]+\.[a-z]{2,}\//i.test(u)) return 'https://' + u;
  return u;
}
function liveSafe(name) { return String(name || 'Трансляция').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Трансляция'; }
// YouTube теперь требует движок JavaScript для разбора страницы. Его роль может сыграть сама программа (Electron = Node.js).
let ytUseJs = false;
function ytJson(bin, url, cookiesBrowser, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-J', '--no-warnings', '--no-playlist'];
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    if (ytUseJs && /youtu\.?be/i.test(url)) { args.push('--js-runtimes', 'node:' + process.execPath); env.ELECTRON_RUN_AS_NODE = '1'; }
    if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
    args.push(url);
    let out = '', err = '', done = false, proc;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { proc = spawn(bin, args, { windowsHide: true, env }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { downloader.killTree(proc); fin({ ok: false, kind: 'network', error: 'площадка долго не отвечает' }); }, timeoutMs || 90000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    proc.on('error', (e) => fin({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code === 0) { try { return fin({ ok: true, info: JSON.parse(out) }); } catch (e) {} }
      const line = (err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || 'код ' + code).replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
      fin({ ok: false, kind: downloader.classifyError(err), error: line });
    });
  });
}
// поток для ffmpeg: HLS нужной высоты; у VK обычный «hls_live» (без «ondemand»)
function livePickFormat(info, quality) {
  const maxH = quality && quality !== 'best' ? parseInt(quality, 10) : 100000;
  const fs0 = (info.formats || []).filter((f) => /m3u8/.test(f.protocol || '') && f.url && f.vcodec !== 'none');
  if (!fs0.length) return null;
  const score = (f) => { const h = f.height || 0; return (h <= maxH ? 1e6 + h : -h) + (/ondemand/.test(f.format_id || '') ? 0 : 0.5); };
  return fs0.slice().sort((a, b) => score(b) - score(a))[0];
}
// HTTP-запрос сетью программы (учитывает прокси/VPN): { status, buf }
function netGet(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let done = false, req, timer;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { req = net.request({ url, redirect: 'follow' }); } catch (e) { return fin({ status: 0, error: e.message }); }
    Object.entries(headers || {}).forEach(([k, v]) => { try { req.setHeader(k, v); } catch (e) {} });
    timer = setTimeout(() => { try { req.abort(); } catch (e) {} fin({ status: 0, error: 'timeout' }); }, timeoutMs || 20000);
    req.on('response', (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => fin({ status: res.statusCode, buf: Buffer.concat(ch) })); res.on('error', (e) => fin({ status: 0, error: e.message })); });
    req.on('error', (e) => fin({ status: 0, error: e.message }));
    req.end();
  });
}
async function netGetRetry(url, headers) {
  for (let i = 0; i < 4; i++) { const r = await netGet(url, headers); if (r.status) return r; await new Promise((ok) => setTimeout(ok, 800 * (i + 1))); }
  return { status: 0 };
}
const netText = async (url, headers) => { const r = await netGetRetry(url, headers); if (r.status !== 200) throw new Error('список эфира: ответ ' + r.status); return r.buf.toString('utf8'); };
// VK: «ondemand»-поток нужной высоты (у него кусочки t<мс>.ts — можно взять эфир с начала)
function vkOndemandFormat(info, quality) {
  const maxH = quality && quality !== 'best' ? parseInt(quality, 10) : 100000;
  const fs0 = (info.formats || []).filter((f) => /ondemand/.test(f.format_id || '') && /m3u8/.test(f.protocol || '') && f.url);
  return fs0.filter((f) => (f.height || 0) <= maxH).sort((a, b) => (b.height || 0) - (a.height || 0))[0] || fs0.sort((a, b) => (a.height || 0) - (b.height || 0))[0] || null;
}
function liveSend(msg) { BrowserWindow.getAllWindows().forEach((w) => { try { w.webContents.send('live-status', msg); } catch (e) {} }); }
function liveState() {
  if (!liveSess) return { active: false };
  return Object.assign({ active: !['stopped', 'error'].includes(liveSess.state) }, liveSess.status(), liveMeta || {});
}
async function liveBegin(opts, dir, meta, first) {
  const bin = await downloader.ensureYtDlp(loaderBinDir(), null, false, loaderOpts());
  let pre = first || null;
  // VK с начала эфира: позиция (мс от начала трансляции) — помним её, чтобы после обрыва продолжить ровно с того же места
  const dvr = meta.dvr ? { pos: meta.dvr.pos || 0, total: 0 } : null;
  let lastSave = 0;
  const saveMeta = () => { try { fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(meta, null, 1)); } catch (e) {} };
  const resolve = async ({ run }) => {
    let r = pre; pre = null;
    if (!r) r = await ytJson(bin, meta.url, opts.cookiesBrowser, 60000);
    if (!r.ok) return { ok: false, error: r.error, ended: /not currently live|has ended|offline|не в эфире|is not live/i.test(r.error || '') };
    const info = r.info;
    if (dvr) {
      const fo = vkOndemandFormat(info, opts.quality);
      if (fo) {
        const headers = fo.http_headers || {};
        const stream = vkdvr.createStream({ url: fo.url, headers, state: dvr, fetchBuf: netGetRetry, fetchText: netText,
          log: (m) => console.log('[vk] ' + m),
          onProgress: (p) => {
            meta.dvr.pos = p.pos; meta.behind = p.total ? Math.max(0, (p.total - p.pos) / 1000) : 0;
            if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveMeta(); }
            if (liveSess) liveSend(Object.assign({ active: true }, liveSess.status(), meta));
          } });
        return { ok: true, stream };
      }
      // перемотки больше нет (эфир закончился или VK сменил вид) — дальше с живого края
    }
    if (info.is_live === false || (info.live_status && info.live_status !== 'is_live')) return { ok: false, ended: true, error: 'трансляция закончилась' };
    const f = livePickFormat(info, opts.quality);
    if (!f) return { ok: false, error: 'площадка не отдала поток в подходящем виде' };
    return { ok: true, url: f.url, headers: f.http_headers || {} };
  };
  liveSess = new live.LiveSession({ dir, ffmpeg: ffmpegPath, resolve });
  liveMeta = meta;
  liveSess.on('status', (st) => liveSend(Object.assign({ active: !['stopped', 'error'].includes(st.state) }, st, liveMeta)));
  liveSess.start();
  // ждём первые кусочки (≈ 8 с видео) или ошибку — тогда окно сразу открывает запись
  const sess = liveSess;
  const st = await new Promise((resolve2) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s0 = sess.status();
      if (s0.segs >= 2 || ['error', 'ended', 'stopped'].includes(s0.state) || Date.now() - t0 > 120000) { clearInterval(iv); resolve2(s0); }
    }, 300);
  });
  if (dvr) saveMeta();
  if (st.segs < 1) {
    await sess.stop();
    if (liveSess === sess) { liveSess = null; liveMeta = null; }
    return { ok: false, error: st.error || 'поток не пошёл — попробуйте ещё раз' };
  }
  return { ok: true, vod: sess.vod, dir, title: meta.title, url: meta.url, fromStart: !!dvr };
}
ipcMain.handle('live-start', async (event, opts) => {
  if (liveSess && !['stopped', 'error', 'ended'].includes(liveSess.state)) return { ok: false, kind: 'busy', error: 'Уже идёт запись другой трансляции — сначала завершите её.' };
  if (currentDownload) return { ok: false, kind: 'busy', error: 'Сейчас идёт загрузка видео по ссылке — дождитесь её конца.' };
  const url = liveNormUrl(opts && opts.url);
  if (!/^https?:\/\//i.test(url)) return { ok: false, kind: 'url', error: 'Это не похоже на ссылку. Вставьте адрес трансляции вида https://…' };
  const send = (text) => { try { event.sender.send('live-status', { phase: 'connect', text }); } catch (e) {} };
  let bin;
  try { send('Готовлю загрузчик…'); bin = await downloader.ensureYtDlp(loaderBinDir(), (t) => send(t), false, loaderOpts()); }
  catch (e) { return { ok: false, kind: 'loader', error: e.message || String(e) }; }
  send('Получаю трансляцию…');
  let r = await ytJson(bin, url, opts.cookiesBrowser, 90000);
  if (!r.ok && /unsupported|extractor|unable to extract/i.test(r.error || '')) { // свежий загрузчик часто помогает
    send('Обновляю загрузчик…');
    try { await downloader.ensureYtDlp(loaderBinDir(), null, true, loaderOpts()); r = await ytJson(bin, url, opts.cookiesBrowser, 90000); } catch (e) {}
  }
  // YouTube без движка JavaScript может не отдать поток — пробуем ещё раз, движком служит сама программа
  if (/youtu\.?be/i.test(url) && !ytUseJs && (!r.ok || !livePickFormat(r.info, opts.quality))) {
    send('Получаю трансляцию YouTube…');
    ytUseJs = true;
    const r2 = await ytJson(bin, url, opts.cookiesBrowser, 90000);
    if (r2.ok && livePickFormat(r2.info, opts.quality)) r = r2; else ytUseJs = false;
  }
  if (!r.ok) return { ok: false, kind: r.kind || 'other', error: /confirm you.?re not a bot|sign in/i.test(r.error || '') ? 'YouTube просит войти в аккаунт — выберите браузер, где вы вошли в YouTube, в поле «Вход в аккаунт».' : r.error };
  const info = r.info;
  if (info.live_status === 'is_upcoming') return { ok: false, kind: 'upcoming', error: 'Трансляция ещё не началась — подключитесь, когда она пойдёт.' };
  if (!info.is_live) return { ok: false, kind: 'notlive', error: 'Это уже не прямой эфир — готовую запись откройте через «По ссылке».' };
  let settings = defaultSettings();
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))); } catch (e) {}
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const title = liveSafe(info.title || info.fulltitle || info.id);
  const dir = path.join(settings.downloadsFolder || defaultDownloadsFolder(), 'Трансляции', liveSafe(title + ' ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + '-' + pad(d.getMinutes())));
  const meta = { url, title, extractor: info.extractor || '', startedAt: Date.now(), quality: opts.quality || '720' };
  // с начала эфира: у VK — проверяем, что прошлые кусочки доступны
  let fromStartNote = '';
  if (opts.fromStart) {
    const fo = /^vk/i.test(info.extractor || '') ? vkOndemandFormat(info, opts.quality) : null;
    let ok = false;
    if (fo) { send('Проверяю запись эфира с начала…'); try { ok = (await vkdvr.probe(netText, fo.url, fo.http_headers || {})).ok; } catch (e) {} }
    if (ok) meta.dvr = { pos: 0 };
    else fromStartNote = /^vk/i.test(info.extractor || '') ? 'VK не отдаёт этот эфир с начала — запись идёт с текущего момента.' : 'С начала эфира пока можно только для VK Видео — запись идёт с текущего момента.';
  }
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(meta, null, 1)); } catch (e) { return { ok: false, kind: 'disk', error: 'Не удалось создать папку записи: ' + e.message }; }
  send('Подключаюсь к эфиру…');
  try { const res = await liveBegin(opts, dir, meta, r); if (res.ok && fromStartNote) res.note = fromStartNote; return res; }
  catch (e) { return { ok: false, kind: e.kind || 'other', error: e.message || String(e) }; }
});
// продолжить запись в ту же папку (программу закрывали или эфир прерывался)
ipcMain.handle('live-resume', async (event, { dir, cookiesBrowser }) => {
  if (liveSess && !['stopped', 'error', 'ended'].includes(liveSess.state)) return { ok: false, kind: 'busy', error: 'Уже идёт запись другой трансляции.' };
  let meta; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')); } catch (e) { return { ok: false, error: 'Это не папка записи трансляции.' }; }
  try { return await liveBegin({ quality: meta.quality, cookiesBrowser }, dir, meta, null); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('live-state', () => liveState());
ipcMain.handle('live-stop', async () => {
  if (!liveSess) return { ok: true };
  const st = await liveSess.stop();
  return Object.assign({ ok: true }, st);
});
// склеить запись в обычный MP4 и перенести на него разбор (клипы, рисунки)
ipcMain.handle('live-finalize', async (event, { vod, projectsFolder }) => {
  const dir = path.dirname(vod);
  if (liveSess && liveSess.dir === dir && !['stopped', 'error', 'ended'].includes(liveSess.state)) await liveSess.stop();
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')); } catch (e) {}
  const total = live.readPlaylist(vod).dur;
  const out = path.join(dir, liveSafe(meta.title || path.basename(dir)) + '.mp4');
  const r = await live.finalizeToMp4(ffmpegPath, vod, out, (f) => { try { event.sender.send('live-status', { phase: 'finalize', percent: Math.round(f * 100) }); } catch (e) {} }, total);
  if (!r.ok) return r;
  try { // разбор переезжает на MP4
    const folder = projectsFolder || defaultProjectsFolder();
    const oldF = projectFileFor(folder, vod);
    if (fs.existsSync(oldF)) {
      const p = JSON.parse(fs.readFileSync(oldF, 'utf8'));
      writeProjectFile(folder, out, Object.assign(p, { videoPath: out, liveDir: dir }));
      fs.unlinkSync(oldF);
    }
    meta.finalized = out; fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(meta, null, 1));
  } catch (e) {}
  if (liveSess && liveSess.dir === dir) { liveSess = null; liveMeta = null; }
  return { ok: true, file: out };
});

// маленький сервер для плеера HLS (только этот компьютер, только папки записей)
let hlsSrv = null, hlsPort = 0;
const hlsRoots = new Map();
function hlsEnsure() {
  if (hlsSrv && hlsPort) return Promise.resolve(hlsPort);
  return new Promise((resolve, reject) => {
    hlsSrv = http.createServer((req, res) => {
      const m = /^\/h\/([0-9a-f]{16})\/([\w.\-]+)$/.exec((req.url || '').split('?')[0]);
      const dir = m && hlsRoots.get(m[1]);
      const head = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      if (!dir || !/\.(m3u8|ts)$/i.test(m[2])) { res.writeHead(404, head); return res.end(); }
      fs.readFile(path.join(dir, m[2]), (err, buf) => {
        if (err) { res.writeHead(404, head); return res.end(); }
        res.writeHead(200, Object.assign(head, { 'Content-Type': /m3u8$/i.test(m[2]) ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Content-Length': buf.length }));
        res.end(buf);
      });
    });
    hlsSrv.on('error', reject);
    hlsSrv.listen(0, '127.0.0.1', () => { hlsPort = hlsSrv.address().port; resolve(hlsPort); });
  });
}
ipcMain.handle('hls-url', async (event, { path: p, live: wantLive }) => {
  const port = await hlsEnsure();
  const dir = path.dirname(p);
  const token = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16);
  hlsRoots.set(token, dir);
  // идёт запись — плеер берёт растущий список (index.m3u8), иначе — готовый (vod.m3u8)
  const recording = liveSess && liveSess.dir === dir && !['stopped', 'error', 'ended'].includes(liveSess.state);
  const name = wantLive && recording ? 'index.m3u8' : path.basename(p);
  return { url: 'http://127.0.0.1:' + port + '/h/' + token + '/' + encodeURIComponent(name), live: !!(wantLive && recording) };
});

// ---------- ИИ: подсветка игроков ----------
// Нейросеть работает в отдельном процессе (ai-host.js): так окно не «замерзает», пока она загружается
// и считает. Если тот процесс завис или упал — он перезапускается, программа продолжает работать.
const PREPARE_TIMEOUT_MS = Number(process.env.XV_AI_PREPARE_TIMEOUT_MS) || 120000; // запуск нейросети дольше 2 минут — считаем, что видеокарта зависла
let aiProc = null, aiSeq = 0, aiLoaded = false, aiForceCpu = false;
let aiBroken = false; // отдельный процесс не смог стартовать — работаем по-старому, в главном процессе
let aiLocalToken = null;
const aiPending = new Map(); // id -> { resolve, onEvent }
let aiJob = null; // идёт слежение

function aiStart() {
  if (aiProc) return aiProc;
  const proc = utilityProcess.fork(path.join(__dirname, 'ai-host.js'), [], { serviceName: 'xVision AI', stdio: 'inherit' });
  aiProc = proc;
  proc.ready = false;
  proc.on('message', (msg) => {
    if (msg && msg.ready) { proc.ready = true; return; }
    if (!msg || msg.id == null) return;
    const p = aiPending.get(msg.id);
    if (!p) return;
    if (msg.event) { p.onEvent && p.onEvent(msg.event, msg.data); return; }
    aiPending.delete(msg.id);
    p.resolve(msg);
  });
  proc.on('exit', (code) => {
    if (aiProc === proc) { aiProc = null; aiLoaded = false; }
    // всё, что ждало ответа, получает ошибку — следующий запрос запустит процесс заново
    const notReady = !proc.ready;
    aiPending.forEach((p, id) => {
      if (p.proc !== proc) return; // запросы к новому процессу не трогаем
      aiPending.delete(id);
      p.resolve({ ok: false, error: 'Процесс нейросети остановился (код ' + code + '). Попробуйте ещё раз.', crashed: true, notReady });
    });
  });
  return proc;
}
function aiKill() {
  const proc = aiProc;
  aiProc = null; aiLoaded = false;
  if (proc) { try { proc.kill(); } catch (e) {} }
}
// запасной путь: та же работа в главном процессе (как в версиях до 0.8.2)
async function aiLocal(method, args, onEvent) {
  try {
    if (method === 'prepare') return { ok: true, result: await ai.prepare(Object.assign({}, args, { onStage: (d) => onEvent && onEvent('stage', d) })) };
    if (method === 'detect') return { ok: true, result: await ai.detect(args) };
    if (method === 'segment') return { ok: true, result: await require('./seg').segment(args) };
    if (method === 'track') {
      const token = aiLocalToken = { cancelled: false, kill: null };
      try { return { ok: true, result: await ai.track(Object.assign({}, args, { token, onProgress: (p) => onEvent && onEvent('track', p) })) }; }
      finally { aiLocalToken = null; }
    }
    return { ok: false, error: 'unknown method' };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
async function aiCall(method, args, onEvent, timeoutMs) {
  if (aiBroken) return aiLocal(method, args, onEvent);
  const r = await aiCallProc(method, args, onEvent, timeoutMs);
  if (r && r.notReady && !aiBroken) { aiBroken = true; console.log('[ai] отдельный процесс не запустился — работаю в главном процессе'); return aiLocal(method, args, onEvent); }
  return r;
}
function aiCallProc(method, args, onEvent, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++aiSeq;
    let timer = null;
    const done = (msg) => { if (timer) clearTimeout(timer); resolve(msg); };
    const entry = { resolve: done, onEvent, proc: null };
    aiPending.set(id, entry);
    if (timeoutMs) timer = setTimeout(() => { if (aiPending.has(id)) { aiPending.delete(id); done({ ok: false, timeout: true, error: 'timeout' }); } }, timeoutMs);
    try { const pr = aiStart(); entry.proc = pr; pr.postMessage({ id, method, args }); }
    catch (e) { aiPending.delete(id); done({ ok: false, error: e.message || String(e), notReady: true }); }
  });
}
function aiBase() { return { appDir: __dirname, userData: app.getPath('userData') }; }
// Модель распознавания (36 МБ) обычно вшита в установщик. Если её нет — скачиваем здесь, в главном процессе:
// сетевым механизмом программы (он учитывает прокси и VPN), а при неудаче — обычным https.
async function aiEnsureModel(event) {
  const base = aiBase();
  if (ai.findModel(base.appDir, base.userData)) return { ok: true };
  const dest = ai.downloadedModelPath(base.userData);
  const prog = (f) => aiSend(event, { type: 'stage', stage: 'download', percent: Math.round(f * 100) });
  let err = null;
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await netDownload(ai.MODEL_URL, dest, prog);
      if (fs.statSync(dest).size > ai.MODEL_MIN_BYTES) return { ok: true };
      err = new Error('файл скачался не полностью');
    } catch (e) { err = e; }
    try { fs.unlinkSync(dest); } catch (e) {}
  }
  try { await ai.download(ai.MODEL_URL, dest, (p) => aiSend(event, { type: 'stage', stage: 'download', percent: p })); return { ok: true }; }
  catch (e) { err = e; }
  return { ok: false, kind: 'model', error: 'Не удалось скачать модель распознавания игроков (' + ((err && err.message) || err) + '). Проверьте интернет и попробуйте ещё раз.' };
}
async function aiPrepare(event) {
  if (aiLoaded && aiProc) return { ok: true };
  const onEvent = (ev, data) => { if (ev === 'stage') aiSend(event, Object.assign({ type: 'stage' }, data)); };
  const m = await aiEnsureModel(event);
  if (!m.ok) return m;
  // таймер ставим только на запуск нейросети, не на скачивание модели (скачивание может быть долгим)
  const cpuOnly = aiDevicePref() === 'cpu' || await aiNoGpu();
  let r = await aiCallPrepare(onEvent, aiForceCpu || cpuOnly, aiForceCpu);
  if (r.timeout && !aiForceCpu && !cpuOnly) {
    // видеокарта не ответила — перезапускаем процесс и работаем на процессоре до конца сеанса
    aiKill();
    aiForceCpu = true;
    aiSend(event, { type: 'stage', stage: 'load', cpu: true });
    r = await aiCallPrepare(onEvent, true, true);
  }
  if (r.timeout) { aiKill(); return { ok: false, kind: 'runtime', error: 'Нейросеть не запустилась за 2 минуты. Перезапустите программу и попробуйте снова.' }; }
  if (!r.ok) return { ok: false, kind: 'runtime', error: r.error };
  if (r.result && r.result.ok) aiLoaded = true;
  return r.result;
}
function aiCallPrepare(onEvent, forceCpu, remember) {
  return new Promise((resolve) => {
    let timer = null, settled = false;
    const finish = (m) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(m); };
    const startTimer = () => { if (!timer) timer = setTimeout(() => finish({ ok: false, timeout: true }), PREPARE_TIMEOUT_MS); };
    aiCall('prepare', Object.assign(aiBase(), { forceCpu, rememberCpu: !!remember }), (ev, data) => { // видеокарта зависла — запоминаем, чтобы в следующий раз не ждать её 2 минуты
      if (ev === 'stage' && data && data.stage === 'load') startTimer();
      onEvent(ev, data);
    }).then(finish);
  });
}
function aiSend(event, msg) { try { event.sender.send('ai-progress', msg); } catch (e) {} }
ipcMain.handle('ai-status', async () => ({ modelReady: !!ai.findModel(__dirname, app.getPath('userData')), loaded: aiLoaded }));
ipcMain.handle('ai-prepare', async (event) => {
  try { return await aiPrepare(event); }
  catch (e) { return { ok: false, kind: 'runtime', error: e.message || String(e) }; }
});
ipcMain.handle('ai-detect', async (event, { videoPath, t, srcW, srcH }) => {
  if (aiJob) return { ok: false, error: 'Нейросеть занята слежением. Подождите.' };
  try {
    const prep = await aiPrepare(event);
    if (!prep || !prep.ok) return prep || { ok: false, error: 'Нейросеть не запустилась' };
    const r = await aiCall('detect', { ffmpegPath, sourcePath: videoPath, t, srcW, srcH });
    if (!r.ok) return { ok: false, error: r.error };
    const res = r.result || [];
    return Array.isArray(res) ? { ok: true, boxes: res, info: {} } : { ok: true, boxes: res.boxes || [], info: res.info || {} };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ai-track', async (event, { videoPath, srcW, srcH, t0, players, from, to, trackW }) => {
  if (aiJob) return { ok: false, error: 'Слежение уже идёт' };
  aiJob = { cancelled: false };
  const job = aiJob;
  try {
    const prep = await aiPrepare(event);
    if (!prep || !prep.ok) return prep || { ok: false, error: 'Нейросеть не запустилась' };
    const r = await aiCall('track', { ffmpegPath, sourcePath: videoPath, srcW, srcH, t0, players, from, to, fps: 8, trackW: trackW > 0 ? trackW : 0 },
      (ev, p) => { if (ev === 'track') aiSend(event, { type: 'track', percent: p }); });
    if (job.cancelled || (!r.ok && /cancelled/.test(String(r.error)))) return { ok: false, cancelled: true };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, results: r.result.results };
  } catch (e) {
    if (job.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: e.message || String(e) };
  } finally { aiJob = null; }
});
// ---------- «Позиция»: вырезать игрока с кадра ----------
// Щелчок по игроку — нейросеть MobileSAM (в отдельном процессе нейросети, на процессоре). Если на кадре находится
// рамка игрока (та же нейросеть, что у ИИ-подсветки), она подсказывает, где он. Обвели мышью — режем по контуру.
const seg = require('./seg');
let posBusy = false;
async function posEnsureModels(event) {
  const need = seg.missing(__dirname, app.getPath('userData'));
  for (let k = 0; k < need.length; k++) {
    const f = need[k];
    const prog = (x) => { try { event.sender.send('pos-progress', { stage: 'download', percent: Math.round(((k + Math.min(1, x)) / need.length) * 100) }); } catch (e) {} };
    let err = null;
    for (let i = 0; i < 2 && !(err === null && fs.existsSync(f.dest)); i++) {
      try {
        fs.mkdirSync(path.dirname(f.dest), { recursive: true });
        const tmp = f.dest + '.download';
        await netDownload(f.url, tmp, prog);
        if (fs.statSync(tmp).size < f.min) throw new Error('файл скачался не полностью');
        fs.renameSync(tmp, f.dest); err = null; break;
      } catch (e) { err = e; try { fs.unlinkSync(f.dest + '.download'); } catch (e2) {} }
    }
    if (err || !fs.existsSync(f.dest)) {
      try { await ai.download(f.url, f.dest, (p) => prog(p / 100)); } catch (e) { err = e; }
      if (!fs.existsSync(f.dest)) return { ok: false, kind: 'model', error: 'Не удалось скачать нейросеть для выделения игрока (' + ((err && err.message) || err) + '). Проверьте интернет — или обведите игрока мышью.' };
    }
  }
  return { ok: true };
}
ipcMain.handle('pos-cut', async (event, a) => {
  if (!licOk()) return LIC_DENIED;
  if (posBusy) return { ok: false, error: 'Подождите: предыдущее выделение ещё идёт.' };
  posBusy = true;
  try {
    const base = { ffmpegPath, sourcePath: a.videoPath, t: a.t, fps: a.fps || 0, srcW: a.srcW, srcH: a.srcH };
    if (Array.isArray(a.polygon) && a.polygon.length >= 3) return await seg.cutPolygon(Object.assign(base, { polygon: a.polygon }));
    if (aiJob) return { ok: false, error: 'Нейросеть занята слежением за игроком. Подождите или обведите игрока мышью.' };
    const m = await posEnsureModels(event);
    if (!m.ok) return m;
    try { event.sender.send('pos-progress', { stage: 'work' }); } catch (e) {}
    // рамка игрока, на которого щёлкнули: подсказка для точного контура (не нашлась — режем по одному щелчку)
    let box = null;
    try {
      const prep = await aiPrepare(event);
      if (prep && prep.ok) {
        const d = await aiCall('detect', { ffmpegPath, sourcePath: a.videoPath, t: a.t, srcW: a.srcW, srcH: a.srcH }, null, 60000);
        const boxes = d && d.ok ? (Array.isArray(d.result) ? d.result : (d.result && d.result.boxes) || []) : [];
        const inside = boxes.filter((b) => a.x >= b.x && a.x <= b.x + b.w && a.y >= b.y && a.y <= b.y + b.h).sort((p, q) => p.w * p.h - q.w * q.h);
        box = inside[0] || null;
      }
    } catch (e) { box = null; }
    const r = await aiCall('segment', Object.assign(aiBase(), base, { x: a.x, y: a.y, box }), null, 180000);
    if (!r || !r.ok) return { ok: false, error: (r && r.timeout) ? 'Нейросеть не ответила. Обведите игрока мышью.' : 'Ошибка нейросети: ' + ((r && r.error) || 'неизвестно') };
    return Object.assign({ usedBox: !!box }, r.result);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally { posBusy = false; }
});
// журнал нейросети — показать файл в Проводнике, чтобы его можно было отправить разработчику
ipcMain.handle('ai-report', async () => {
  const f = ai.logPath(app.getPath('userData'));
  try { if (!fs.existsSync(f)) fs.writeFileSync(f, 'Журнал пока пуст: нейросеть ещё не запускалась.\n'); shell.showItemInFolder(f); return { ok: true, path: f }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ai-cancel', async () => {
  if (aiJob) {
    aiJob.cancelled = true;
    if (aiProc) { try { aiProc.postMessage({ method: 'cancel' }); } catch (e) {} }
    if (aiLocalToken) { aiLocalToken.cancelled = true; try { aiLocalToken.kill && aiLocalToken.kill(); } catch (e) {} }
  }
  return { ok: true };
});

// ---------- Тренерская: упражнения и тренировки на макете площадки ----------
// Работает внутри главного окна (coach.html во фрейме). Библиотека — %APPDATA%\hockey-video-analysis\coach\library.json.
function coachDir() { return path.join(app.getPath('userData'), 'coach'); }
function coachFile() { return path.join(coachDir(), 'library.json'); }
// Печать и PDF: документ собирается в невидимом окне — так печатается только план, без интерфейса программы
async function coachPrintWindow(html, title) {
  fs.mkdirSync(coachDir(), { recursive: true });
  const base = require('url').pathToFileURL(__dirname + path.sep).href;
  const doc = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><base href="' + base + '"><title>' + String(title || 'xVision').replace(/[<>&]/g, '') +
    '</title><link rel="stylesheet" href="coach-print.css"></head><body class="printdoc">' + html + '</body></html>';
  const file = path.join(coachDir(), 'print.html');
  fs.writeFileSync(file, doc, 'utf-8');
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await w.loadFile(file);
  // ждём шрифты и картинки
  try { await w.webContents.executeJavaScript('Promise.all([document.fonts.ready, ...Array.from(document.images).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))]).then(() => true)'); } catch (e) {}
  return w;
}
function fileToDataUrl(file) {
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}
ipcMain.handle('coach-load', async () => {
  let lib = null, isNew = false;
  try { lib = JSON.parse(fs.readFileSync(coachFile(), 'utf-8')); }
  catch (e) {
    // основной файл испорчен — пробуем резервную копию
    try { lib = JSON.parse(fs.readFileSync(coachFile() + '.bak', 'utf-8')); } catch (e2) { lib = null; isNew = !fs.existsSync(coachFile()); }
    // и её нет — берём самую свежую ежедневную копию
    if (!lib) {
      const b = coachBackups()[0];
      if (b) { try { lib = JSON.parse(fs.readFileSync(b, 'utf-8')); isNew = false; } catch (e3) {} }
    }
  }
  return {
    lib, isNew,
    builtinLogos: {
      xvision: fileToDataUrl(path.join(__dirname, 'logos', 'xvision.png')),
      avangard: fileToDataUrl(path.join(__dirname, 'logos', 'avangard.png')),
    },
  };
});
// Страховка библиотеки: раз в день — копия в coach\backups (хранятся последние 30 дней), и отдельная копия,
// если библиотеку вдруг собираются записать пустой, а на диске в ней что-то было.
function coachBackups() {
  const dir = path.join(coachDir(), 'backups');
  try { return fs.readdirSync(dir).filter((n) => /^library-.*\.json$/.test(n)).map((n) => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); }
  catch (e) { return []; }
}
function coachBackup(lib) {
  const file = coachFile();
  if (!fs.existsSync(file)) return;
  const dir = path.join(coachDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const daily = path.join(dir, 'library-' + day + '.json');
  if (!fs.existsSync(daily)) fs.copyFileSync(file, daily);
  const count = (l) => ((l && l.exercises) || []).length + ((l && l.trainings) || []).length;
  if (count(lib) === 0) {
    let old = null; try { old = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
    if (count(old) > 0) fs.copyFileSync(file, path.join(dir, 'library-before-empty-' + day + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.json'));
  }
  const daily30 = coachBackups().filter((f) => /library-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  daily30.slice(30).forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
}
// Тренировки из прошлых версий: библиотеки других копий программы на этом компьютере (обычная xVision и ITAA,
// старые названия) и резервные копии своей библиотеки. Тренерская показывает, чего в текущей библиотеке нет.
ipcMain.handle('coach-find-old', async () => {
  const appData = app.getPath('appData'), own = app.getPath('userData');
  const names = { 'hockey-video-analysis': 'xVision', 'hockey-video-analysis-itaa': 'xVision ITAA', 'xVision': 'xVision', 'xVision ITAA': 'xVision ITAA',
    'duucikvision': 'duucikvision', 'Hockey Video Analysis': 'Hockey Video Analysis', 'hockey-desktop-app': 'xVision', 'hockey-desktop-app-itaa': 'xVision ITAA' };
  const dirs = [own].concat(Object.keys(names).map((n) => path.join(appData, n)));
  const seen = new Set(), sources = [];
  for (const d of dirs) {
    const key = path.resolve(d).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const cdir = path.join(d, 'coach');
    const isOwn = path.resolve(d) === path.resolve(own);
    const label = isOwn ? 'резервная копия' : (names[path.basename(d)] || path.basename(d));
    let files = ['library.json', 'library.json.bak', 'library.json.tmp'].map((n) => path.join(cdir, n));
    try { files = files.concat(fs.readdirSync(path.join(cdir, 'backups')).filter((n) => /\.json$/i.test(n)).map((n) => path.join(cdir, 'backups', n))); } catch (e) {}
    for (const f of files) {
      if (isOwn && path.resolve(f) === path.resolve(coachFile())) continue; // текущая библиотека уже открыта
      let st = null; try { st = fs.statSync(f); } catch (e) { continue; }
      if (!st.isFile() || st.size > 300 * 1024 * 1024) continue;
      try {
        const lib = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (lib && (Array.isArray(lib.exercises) || Array.isArray(lib.trainings))) sources.push({ label, file: f, mtime: st.mtimeMs, lib: { exercises: lib.exercises || [], trainings: lib.trainings || [] } });
      } catch (e) {}
    }
  }
  sources.sort((a, b) => b.mtime - a.mtime);
  return { sources };
});
ipcMain.handle('coach-save', async (event, lib) => {
  try {
    fs.mkdirSync(coachDir(), { recursive: true });
    try { coachBackup(lib); } catch (e) {}
    const file = coachFile(), tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lib), 'utf-8');
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) {} }
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
function coachSafeName(name, fallback) { return (String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || fallback).slice(0, 120); }
ipcMain.handle('coach-pdf', async (event, { name, html }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить PDF', defaultPath: path.join(app.getPath('documents'), coachSafeName(name, 'Тренировка') + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  let w = null;
  try {
    w = await coachPrintWindow(html, name);
    const data = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } });
    fs.writeFileSync(res.filePath, data);
    return { ok: true, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
  finally { if (w && !w.isDestroyed()) w.destroy(); }
});
ipcMain.handle('coach-print', async (event, { html, name }) => {
  let w = null;
  try {
    w = await coachPrintWindow(html, name);
    return await new Promise((resolve) => {
      w.webContents.print({ silent: false, printBackground: true }, (ok, reason) => resolve({ ok, reason }));
    });
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
  finally { setTimeout(() => { if (w && !w.isDestroyed()) w.destroy(); }, 500); }
});
ipcMain.handle('coach-save-png', async (event, { dataUrl, name }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить картинку', defaultPath: path.join(app.getPath('pictures'), coachSafeName(name, 'Упражнение') + '.png'),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
    return { ok: true, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('coach-export', async (event, { json, name }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Экспорт из Тренерской', defaultPath: path.join(app.getPath('documents'), coachSafeName(name, 'Тренерская') + '.xvcoach'),
    filters: [{ name: 'Тренерская xVision', extensions: ['xvcoach'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(res.filePath, json, 'utf-8'); return { ok: true, path: res.filePath }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('coach-show-file', async (event, p) => { try { shell.showItemInFolder(p); } catch (e) {} return { ok: true }; });
// Видео-пример к упражнению: файл копируется в библиотеку Тренерской (coach\videos) — не пропадёт, если оригинал удалят
const COACH_VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
function coachVideoCopy(src) {
  if (!COACH_VIDEO_EXT.test(src)) return { ok: false, error: 'Нужен видеофайл (mp4, mov, m4v, webm).' };
  let st; try { st = fs.statSync(src); } catch (e) { return { ok: false, error: 'Файл не найден.' }; }
  if (st.size > 2 * 1024 * 1024 * 1024) return { ok: false, error: 'Файл больше 2 ГБ — обрежьте пример покороче.' };
  const dir = path.join(coachDir(), 'videos'); fs.mkdirSync(dir, { recursive: true });
  const file = crypto.randomBytes(6).toString('hex') + path.extname(src).toLowerCase();
  fs.copyFileSync(src, path.join(dir, file));
  return { ok: true, file, name: path.basename(src), size: st.size };
}
ipcMain.handle('coach-video-add', async (event, srcPath) => {
  try {
    let src = srcPath;
    if (!src) {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Видео — пример выполнения', properties: ['openFile'], filters: [{ name: 'Видео', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      src = r.filePaths[0];
    }
    return coachVideoCopy(src);
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('coach-video-path', async (event, file) => {
  const p = path.join(coachDir(), 'videos', path.basename(String(file || '')));
  return fs.existsSync(p) ? p : '';
});
ipcMain.handle('coach-open-url', async (event, url) => { if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(String(url)); return { ok: true }; });

let liveQuitting = false;
app.on('before-quit', (e) => {
  aiKill();
  if (currentDownload && currentDownload.proc) downloader.killTree(currentDownload.proc);
  // идёт запись трансляции — даём ffmpeg дописать последний кусочек и закрыть список (до 5 секунд)
  if (liveSess && (liveSess.ff || liveSess.src) && !liveQuitting) {
    e.preventDefault(); liveQuitting = true;
    const sess = liveSess;
    Promise.race([sess.stop(), new Promise((r) => setTimeout(r, 5000))]).then(() => { live.killTree(sess.ff); live.killTree(sess.src); app.quit(); });
  }
});

// ---------- helpers ----------
function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'clip';
}

function fmtTs(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(3);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(6, '0');
}

const TIME_RE = /time=(\d+):(\d+):(\d+\.\d+)/;

function runFfmpeg(args, onTime, onProc) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    if (onProc) onProc(proc);
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderrTail = (stderrTail + chunk).slice(-4000);
      if (onTime) {
        const m = TIME_RE.exec(chunk);
        if (m) {
          const seconds = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
          onTime(seconds);
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg завершился с ошибкой (код ' + code + '):\n' + stderrTail.slice(-800)));
    });
  });
}

// ---------- IPC: file dialogs ----------
ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите видео матча',
    properties: ['openFile'],
    filters: [{ name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'mts', 'mpg', 'wmv'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-videos', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите видеоролики для склейки',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'mts', 'mpg', 'wmv'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

// Склейка нескольких роликов в один файл. Ролики могут быть разного размера и формата, поэтому каждый сначала
// приводится к общему виду (размер и частота кадров первого ролика, звук 48 кГц стерео), потом части соединяются.
// Возвращает путь к файлу и границы каждой части — по ним окно создаёт клипы в журнале.
function probeMedia(file) {
  return new Promise((resolve) => {
    let err = '', proc;
    try { proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }); } catch (e) { return resolve(null); }
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const v = (err.match(/Stream #\d+:\d+.*Video:.*/) || [''])[0];
      if (!v) return resolve(null);
      const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      const sz = /, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(v + ' ');
      const num = (re) => { const m = re.exec(v); return m ? parseFloat(m[1]) * (/k$/.test(m[2] || '') ? 1000 : 1) : 0; };
      let fps = num(/([\d.]+)(k?) fps/); if (!(fps > 1 && fps < 241)) fps = num(/([\d.]+)(k?) tbr/);
      let w = sz ? parseInt(sz[1], 10) : 0, h = sz ? parseInt(sz[2], 10) : 0;
      if (/rotation of -?(90|270)(\.0+)? degrees/.test(err)) { const t = w; w = h; h = t; } // вертикальная съёмка телефоном
      resolve({ duration: dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0, w, h, fps: fps > 1 && fps < 241 ? fps : 0, audio: /Stream #\d+:\d+.*Audio:/.test(err) });
    });
  });
}
let mergeJob = null;
ipcMain.handle('merge-cancel', async () => {
  if (mergeJob) { mergeJob.cancelled = true; try { mergeJob.proc && mergeJob.proc.kill(); } catch (e) {} }
  return { ok: true };
});
ipcMain.handle('merge-videos', async (event, { paths, outDir }) => {
  if (!licOk()) return LIC_DENIED;
  if (mergeJob) return { ok: false, error: 'Склейка уже идёт' };
  const job = mergeJob = { cancelled: false, proc: null };
  const send = (percent, message) => { try { event.sender.send('merge-progress', { percent, message }); } catch (e) {} };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xvmerge-'));
  try {
    const list = (paths || []).filter(Boolean).slice(0, 40);
    if (list.length < 2) return { ok: false, error: 'Нужно хотя бы два видеоролика.' };
    send(0, 'Проверяю файлы…');
    const infos = [];
    for (const p of list) {
      const m = await probeMedia(p);
      if (!m || !m.w || !m.h) return { ok: false, error: 'Не удалось прочитать видео: ' + path.basename(p) };
      infos.push(m);
    }
    // общий вид: как у первого ролика (не шире 1920, чётные размеры), частота кадров 24–60
    let W = infos[0].w, H = infos[0].h;
    if (W > 1920) { H = Math.round(H * 1920 / W); W = 1920; }
    W = Math.max(2, Math.round(W / 2) * 2); H = Math.max(2, Math.round(H / 2) * 2);
    const F = Math.round(Math.min(60, Math.max(24, infos[0].fps || 30)) * 1000) / 1000;
    const totalDur = infos.reduce((a, m) => a + (m.duration || 0), 0) || 1;
    const vf = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=' + F + ',format=yuv420p';
    const pieceArgs = (i, enc) => {
      const a = ['-y', '-nostdin', '-i', list[i]];
      if (!infos[i].audio) a.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      a.push('-map', '0:v:0', '-map', infos[i].audio ? '0:a:0' : '1:a', '-vf', vf, ...enc.args,
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000');
      if (!infos[i].audio) a.push('-shortest');
      a.push(path.join(tmpDir, 'part_' + i + '.mp4'));
      return a;
    };
    const makeAll = async (enc) => {
      let done = 0;
      for (let i = 0; i < list.length; i++) {
        if (job.cancelled) throw new Error('cancelled');
        const d = infos[i].duration || 1;
        await runFfmpeg(pieceArgs(i, enc), (sec) => send(Math.min(94, Math.round((done + Math.min(d, sec)) / totalDur * 94)), 'Обрабатываю ролик ' + (i + 1) + ' из ' + list.length + '…'), (pr) => { job.proc = pr; });
        done += d;
      }
    };
    let enc = await detectEncoder();
    try { await makeAll(enc); }
    catch (e) {
      if (job.cancelled) throw e;
      if (!enc.hw) throw e;
      enc = SOFT_ENCODER; // аппаратный кодировщик не справился — всё заново на процессоре
      await makeAll(enc);
    }
    // точные границы частей — по готовым файлам
    const parts = [];
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      const m = await probeMedia(path.join(tmpDir, 'part_' + i + '.mp4'));
      const d = (m && m.duration) || infos[i].duration || 0;
      parts.push({ name: path.basename(list[i]).replace(/\.[a-z0-9]+$/i, ''), start: Math.round(acc * 1000) / 1000, end: Math.round(Math.max(acc + 0.1, acc + d - 1 / F) * 1000) / 1000 });
      acc += d;
    }
    send(96, 'Соединяю части…');
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, list.map((_, i) => "file '" + path.join(tmpDir, 'part_' + i + '.mp4').replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'), 'utf-8');
    const dir = outDir || defaultDownloadsFolder();
    fs.mkdirSync(dir, { recursive: true });
    const d0 = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const base = 'Склейка ' + d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate()) + ' ' + p2(d0.getHours()) + '-' + p2(d0.getMinutes());
    const out = uniquePath(dir, sanitizeFileName(base), '.mp4', new Set());
    await runFfmpeg(['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out], null, (pr) => { job.proc = pr; });
    send(100, 'Готово');
    return { ok: true, path: out, parts, duration: acc };
  } catch (e) {
    if (job.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: e.message || String(e) };
  } finally {
    mergeJob = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Куда сохранить клипы',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// ---------- encoder detection ----------
// Пробуем аппаратные кодировщики (видеокарта) — они в 3–8 раз быстрее процессора.
// Если не заработали — используем libx264.
let encoderPromise = null;
function detectEncoder() {
  if (encoderPromise) return encoderPromise;
  encoderPromise = (async () => {
    const candidates = [
      { id: 'h264_nvenc', label: 'NVIDIA NVENC', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'] },
      { id: 'h264_qsv', label: 'Intel QSV', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'] },
      { id: 'h264_amf', label: 'AMD AMF', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'] },
    ];
    for (const c of candidates) {
      try {
        await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=0.5', '-pix_fmt', 'yuv420p', ...c.args, '-f', 'null', '-']);
        return { id: c.id, label: c.label, args: c.args, hw: true };
      } catch (e) { /* пробуем следующий */ }
    }
    return { id: 'libx264', label: 'CPU (x264)', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22'], hw: false };
  })();
  return encoderPromise;
}
const SOFT_ENCODER = { id: 'libx264', label: 'CPU (x264)', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22'], hw: false };

function uniquePath(dir, baseName, ext, used) {
  let candidate = path.join(dir, baseName + ext);
  let n = 2;
  while (used.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    candidate = path.join(dir, baseName + ' (' + n + ')' + ext);
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// Есть ли в файле звуковая дорожка (нужно для сборки фильтра с паузами на рисунке)
const audioProbeCache = new Map();
function hasAudioTrack(file) {
  if (audioProbeCache.has(file)) return audioProbeCache.get(file);
  const p = new Promise((resolve) => {
    let err = '';
    let proc;
    try { proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }); } catch (e) { return resolve(true); }
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve(true));
    proc.on('close', () => resolve(/Stream #\d+:\d+.*Audio:/.test(err)));
  });
  audioProbeCache.set(file, p);
  return p;
}

// Частота кадров видео (для покадровой графики в экспорте). ffmpeg -i печатает «…, 50 fps, 50 tbr, …».
const videoInfoCache = new Map();
function probeVideoInfo(file) {
  if (videoInfoCache.has(file)) return videoInfoCache.get(file);
  const p = new Promise((resolve) => {
    let err = '';
    let proc;
    try { proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }); } catch (e) { return resolve({ fps: 0 }); }
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve({ fps: 0 }));
    proc.on('close', () => {
      const line = (err.match(/Stream #\d+:\d+.*Video:.*/) || [''])[0];
      const num = (re) => { const m = re.exec(line); return m ? parseFloat(m[1]) * (/k$/.test(m[2] || '') ? 1000 : 1) : 0; };
      let fps = num(/([\d.]+)(k?) fps/);
      if (!(fps > 1 && fps < 241)) fps = num(/([\d.]+)(k?) tbr/);
      resolve({ fps: fps > 1 && fps < 241 ? fps : 0 });
    });
  });
  videoInfoCache.set(file, p);
  return p;
}
ipcMain.handle('video-info', async (event, { videoPath }) => {
  try { return await probeVideoInfo(videoPath); } catch (e) { return { fps: 0 }; }
});

// Запись PNG-сегментов разметки и списка ffconcat. Возвращает путь к списку.
function writeOverlayTimeline(dir, overlay) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['ffconcat version 1.0'];
  const segs = overlay.segments;
  segs.forEach((seg, idx) => {
    const f = 'seg_' + idx + '.png';
    fs.writeFileSync(path.join(dir, f), Buffer.from(seg.png, 'base64'));
    lines.push("file '" + f + "'");
    lines.push('duration ' + Math.max(0.000001, seg.duration).toFixed(6)); // покадровая графика: отрезки по 1/fps (0,02 с при 50 к/с) — точность до микросекунды, иначе время «уплывает»
  });
  // ffconcat: последний файл нужно повторить, иначе его duration игнорируется
  lines.push("file 'seg_" + (segs.length - 1) + ".png'");
  const listPath = path.join(dir, 'overlay.ffconcat');
  fs.writeFileSync(listPath, lines.join('\n'), 'utf-8');
  return listPath;
}

// ---------- IPC: export ----------
// clips: [{ name, start, end, overlay: { segments: [{ duration, png(base64) }] } | null }]
// options: fastMode — клипы без разметки режутся без перекодирования (мгновенно, но начало может сдвинуться до ~2 с)
ipcMain.handle('export-clips', async (event, { sourcePath, outputDir, clips, mode, fastMode, mergedName }) => {
  if (!licOk()) return LIC_DENIED;
  const win = BrowserWindow.fromWebContents(event.sender);
  let lastSent = 0;
  const sendProgress = (percent, message, force) => {
    const now = Date.now();
    if (!force && now - lastSent < 200) return;
    lastSent = now;
    win && win.webContents.send('export-progress', { percent, message });
  };

  const startedAt = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hockeyclips-'));
  const merged = mode === 'merged';
  const trimWeight = merged ? 90 : 100;
  const total = clips.length;
  const fractions = new Array(total).fill(0);
  const doneNames = [];
  const usedNames = new Set();
  const createdFiles = [];

  const reportOverall = (label) => {
    const sum = fractions.reduce((a, b) => a + b, 0);
    sendProgress(Math.round((sum / total) * trimWeight), label || ('Обработано клипов: ' + doneNames.length + ' из ' + total));
  };

  try {
    sendProgress(0, 'Определяю режим кодирования...', true);
    // «Одним файлом»: клипы с паузой, повтором, замедлением получают звук 48 кГц стерео, а простые — как в исходнике.
    // Если их склеить как есть, звук уезжает от картинки. Поэтому в таком наборе звук всех клипов приводится к одному виду
    // (и клипы не копируются из исходника, а кодируются — тогда итоговая склейка идёт без повторного кодирования).
    const fxClip = (c) => (c.freezes && c.freezes.length) || (c.slows && c.slows.length) || (c.speed > 0 && c.speed < 0.999) || c.mute;
    const audioNorm = merged && clips.some(fxClip) ? ['-ar', '48000', '-ac', '2'] : [];
    const needEncode = clips.some((c) => (c.overlay && c.overlay.segments && c.overlay.segments.length) || (c.freezes && c.freezes.length) || (c.slows && c.slows.length) || (c.speed > 0 && c.speed < 0.999)) || !fastMode || audioNorm.length > 0;
    const encoder = needEncode ? await detectEncoder() : SOFT_ENCODER;

    const results = new Array(total);

    const processClip = async (i) => {
      const clip = clips[i];
      const clipDuration = Math.max(0.05, clip.end - clip.start);
      const hasOverlay = !!(clip.overlay && clip.overlay.segments && clip.overlay.segments.length);
      // паузы на рисунке: видео замирает на кадре, пока показывается разметка
      const freezes = freezeLib.normalizeFreezes(clip.freezes, clipDuration);
      // замедленные участки (кнопка «Замедление» в редакторе клипа) собираются тем же фильтром, что и паузы
      const slows = freezeLib.normalizeSlows(clip.slows, clipDuration);
      const hasFreezes = freezes.length > 0 || slows.length > 0;
      const outDuration = clipDuration + freezeLib.totalHold(freezes) + freezeLib.slowExtra(slows);
      // замедление всего клипа (скорость 0.1–1) и «без звука» делаются вторым проходом по уже готовому клипу
      const speed = clip.speed > 0 && clip.speed < 0.999 ? Math.max(0.1, Number(clip.speed)) : 1;
      const mute = !!clip.mute;
      const needFx = speed < 1 || mute;
      const copyMode = !!fastMode && !hasOverlay && !hasFreezes && speed === 1 && !audioNorm.length;
      const outPath = merged
        ? path.join(tmpDir, 'clip_' + i + '.mp4')
        : uniquePath(outputDir, sanitizeFileName(clip.name), '.mp4', usedNames);
      const stageOut = needFx ? path.join(tmpDir, 'p1_' + i + '.mp4') : outPath;
      const share1 = speed < 1 ? 0.45 : needFx ? 0.9 : 1; // доля первого прохода в общей работе над клипом
      const onTime = (seconds) => {
        fractions[i] = Math.min(0.99, seconds / outDuration) * share1;
        reportOverall();
      };

      const buildArgs = (enc, audioPresent) => {
        if (hasFreezes) {
          const g = freezeLib.buildFreezeGraph({ freezes, slows, clipDuration, hasAudio: audioPresent, hasOverlay, fps: srcFps });
          const args = ['-y', '-nostdin', '-ss', fmtTs(clip.start), '-t', clipDuration.toFixed(3), '-i', sourcePath];
          if (hasOverlay) args.push('-f', 'concat', '-safe', '0', '-i', writeOverlayTimeline(path.join(tmpDir, 'ov_' + i), clip.overlay));
          args.push('-t', outDuration.toFixed(3), '-filter_complex', g.filter, '-map', '[vout]');
          if (g.mapAudio) args.push('-map', g.mapAudio);
          args.push(...enc.args);
          if (g.mapAudio) args.push('-c:a', 'aac', '-b:a', '160k', ...audioNorm);
          args.push(stageOut);
          return args;
        }
        if (copyMode) {
          return ['-y', '-nostdin', '-ss', fmtTs(clip.start), '-i', sourcePath, '-t', clipDuration.toFixed(3),
            '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', stageOut];
        }
        if (hasOverlay) {
          const listPath = writeOverlayTimeline(path.join(tmpDir, 'ov_' + i), clip.overlay);
          return ['-y', '-nostdin',
            '-ss', fmtTs(clip.start), '-i', sourcePath,
            '-f', 'concat', '-safe', '0', '-i', listPath,
            '-t', clipDuration.toFixed(3),
            '-filter_complex', '[1:v]format=rgba[ov];[0:v][ov]overlay=eof_action=pass:format=auto,format=yuv420p[vout]',
            '-map', '[vout]', '-map', '0:a?',
            ...enc.args, '-c:a', 'aac', '-b:a', '160k', ...audioNorm, stageOut];
        }
        return ['-y', '-nostdin', '-ss', fmtTs(clip.start), '-i', sourcePath, '-t', clipDuration.toFixed(3),
          '-map', '0:v:0', '-map', '0:a?', '-pix_fmt', 'yuv420p',
          ...enc.args, '-c:a', 'aac', '-b:a', '160k', ...audioNorm, stageOut];
      };

      let usedEncoder = copyMode ? 'copy' : encoder.id;
      const audioPresent = hasFreezes ? await hasAudioTrack(sourcePath) : true;
      // частота кадров исходника — для повторов (замедленный отрезок выводится с той же частотой)
      let srcFps = Number(clip.fps) || 0;
      if (!(srcFps > 1) && freezes.some((f) => f.src)) { try { srcFps = (await probeVideoInfo(sourcePath)).fps || 0; } catch (e) { srcFps = 0; } }
      try {
        await runFfmpeg(buildArgs(encoder, audioPresent), onTime);
      } catch (e) {
        if (!copyMode && encoder.hw) {
          // аппаратный кодировщик не справился — повторяем на процессоре
          try { fs.unlinkSync(stageOut); } catch (_) {}
          usedEncoder = SOFT_ENCODER.id;
          await runFfmpeg(buildArgs(SOFT_ENCODER, audioPresent), onTime);
        } else {
          throw e;
        }
      }
      if (needFx) {
        const a1 = await hasAudioTrack(stageOut);
        let fxFps = srcFps;
        if (speed < 1 && !(fxFps > 1)) { try { fxFps = (await probeVideoInfo(sourcePath)).fps || 0; } catch (e) { fxFps = 0; } }
        const finalDur = outDuration / speed;
        const fxArgs = (enc) => {
          const a = ['-y', '-nostdin', '-i', stageOut];
          // Звуковая дорожка остаётся, но в ней тишина — и обязательно в том же формате (частота, каналы), что у остальных
          // клипов: иначе при выгрузке «одним файлом» звук и картинка расходятся. Поэтому глушится сама дорожка клипа.
          const silence = mute && a1;
          if (speed < 1) {
            let fc = '[0:v]setpts=PTS/' + speed.toFixed(4) + (fxFps > 1 ? ',fps=' + (Math.round(fxFps * 1000) / 1000) : '') + ',format=yuv420p[v]';
            let amap = null;
            if (!mute && a1) {
              const chain = []; let k = speed;
              while (k < 0.5) { chain.push('atempo=0.5'); k /= 0.5; }
              chain.push('atempo=' + k.toFixed(4));
              fc += ';[0:a]' + chain.join(',') + '[a]'; amap = '[a]';
            } else if (silence) { fc += ';[0:a]volume=0,apad[a]'; amap = '[a]'; }
            a.push('-filter_complex', fc, '-map', '[v]');
            if (amap) a.push('-map', amap);
            a.push(...enc.args);
            if (amap) a.push('-c:a', 'aac', '-b:a', '160k', ...audioNorm);
            a.push('-t', finalDur.toFixed(3));
          } else {
            a.push('-map', '0:v:0');
            if (silence) a.push('-map', '0:a:0', '-af', 'volume=0', '-c:a', 'aac', '-b:a', '160k', ...audioNorm);
            a.push('-c:v', 'copy');
          }
          a.push(outPath);
          return a;
        };
        const onTime2 = (seconds) => { fractions[i] = Math.min(0.99, share1 + (1 - share1) * Math.min(1, seconds / finalDur)); reportOverall(); };
        const enc2 = usedEncoder === SOFT_ENCODER.id || copyMode ? SOFT_ENCODER : encoder;
        try { await runFfmpeg(fxArgs(enc2), onTime2); }
        catch (e) {
          if (speed < 1 && enc2.hw) { try { fs.unlinkSync(outPath); } catch (_) {} usedEncoder = SOFT_ENCODER.id; await runFfmpeg(fxArgs(SOFT_ENCODER), onTime2); }
          else throw e;
        }
        try { fs.unlinkSync(stageOut); } catch (_) {}
      }
      fractions[i] = 1;
      doneNames.push(clip.name);
      reportOverall('Готово клипов: ' + doneNames.length + ' из ' + total);
      results[i] = { path: outPath, name: clip.name, copied: copyMode && !needFx };
      return usedEncoder;
    };

    // пул из 2 параллельных процессов
    const concurrency = Math.min(2, total);
    let next = 0;
    const usedEncoders = new Set();
    const workers = [];
    let failure = null;
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        while (!failure) {
          const i = next++;
          if (i >= total) return;
          try { usedEncoders.add(await processClip(i)); }
          catch (e) { failure = failure || e; return; }
        }
      })());
    }
    await Promise.all(workers);
    if (failure) throw failure;

    const encodersText = Array.from(usedEncoders).join(', ');
    let files;
    if (merged) {
      sendProgress(92, 'Объединяю клипы...', true);
      const listFile = path.join(tmpDir, 'list.txt');
      const listContent = results.map((t) => "file '" + t.path.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n');
      fs.writeFileSync(listFile, listContent, 'utf-8');
      // имя — по тегу клипов (передаёт окно); без тегов — как раньше, с датой
      const baseMerged = String(mergedName || '').trim().slice(0, 120) || ('Объединённый_клип_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
      const mergedOut = uniquePath(outputDir, sanitizeFileName(baseMerged), '.mp4', usedNames);
      const mixed = results.some((r) => r.copied) && results.some((r) => !r.copied);
      if (mixed) {
        // копии из исходника и перекодированные клипы могут отличаться по параметрам — собираем с перекодированием
        await runFfmpeg(['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile, '-pix_fmt', 'yuv420p',
          ...SOFT_ENCODER.args, '-c:a', 'aac', '-b:a', '160k', mergedOut]);
      } else {
        await runFfmpeg(['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', mergedOut]);
      }
      files = [mergedOut];
    } else {
      files = results.map((r) => r.path);
    }
    files.forEach((f) => createdFiles.push(f));
    sendProgress(100, 'Готово', true);
    return { ok: true, files, seconds: Math.round((Date.now() - startedAt) / 100) / 10, encoder: encodersText };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});
