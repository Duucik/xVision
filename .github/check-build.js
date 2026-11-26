// Проверка собранной программы перед выпуском: автообновление и защита на месте.
const fs = require('fs'), path = require('path');
const res = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources');
const fail = (m) => { console.log('::error::' + m); process.exit(1); };
const upd = path.join(res, 'app-update.yml');
if (!fs.existsSync(upd)) fail('нет app-update.yml — автообновление не заработает');
console.log(fs.readFileSync(upd, 'utf8'));
let asar = null;
for (const n of ['@electron/asar', 'asar']) { try { asar = require(n); break; } catch (e) {} }
if (!asar) { console.log('::warning::модуль asar не найден — содержимое app.asar не проверено'); process.exit(0); }
const list = asar.listPackage(path.join(res, 'app.asar')).map((x) => x.replace(/\\/g, '/'));
for (const f of ['/license/public.key', '/license.html', '/Что нового.txt', '/node_modules/electron-updater/package.json', '/live.js', '/vkdvr.js', '/sequence.js', '/vendor/hls.min.js']) if (!list.includes(f)) fail('в сборке нет ' + f);
console.log('защита, «Что нового» и модуль обновлений на месте');
