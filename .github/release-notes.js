// Текст релиза на GitHub: верхний раздел «Что нового.txt» (раздел текущей версии).
const fs = require('fs'), path = require('path');
const v = require('../package.json').version;
const txt = fs.readFileSync(path.join(__dirname, '..', 'Что нового.txt'), 'utf8').replace(/\r/g, '');
const lines = txt.split('\n'), out = [];
let on = false;
for (const l of lines) {
  const m = /^xVision\s+(\d+\.\d+\.\d+)\s+—/.exec(l);
  if (m) { if (on) break; on = m[1] === v; }
  if (on) out.push(l);
}
const body = out.join('\n').trim() || ('xVision ITAA ' + v);
process.stdout.write('```text\n' + body + '\n```\n\nУстановка: скачайте **xVision-ITAA-Setup-' + v + '.exe** ниже. Уже установленная программа обновится сама.\n');
