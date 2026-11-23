// Ключи xVision: общая часть для программы и для лаунчера Создателя.
//
// Ключ — строка XV1.<данные>.<подпись>. Данные (JSON): имя, группа, коды компьютеров, последний день действия,
// вид ключа и программы, к которым он подходит. Подпись Ed25519 ставит только лаунчер Создателя — у него есть
// секретная половина. В программе лежит лишь открытая половина: ею можно проверить ключ, но нельзя выписать новый.
// Интернет не нужен ни программе, ни лаунчеру.
//
// Ключ Создателя — строка XVCREATOR1.<...>: секретная половина, зашифрованная паролем (PBKDF2 + AES-256-GCM).
// Без него и пароля лаунчер ключей не выдаёт, поэтому сам установщик лаунчера можно хранить где угодно.
const crypto = require('crypto');
const os = require('os');

const KEY_PREFIX = 'XV1';
const CREATOR_PREFIX = 'XVCREATOR1';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // без I, L, O, U — их путают
const DAY = 24 * 3600 * 1000;
const WARN_DAYS = 14;  // за сколько дней до конца предупреждать
const GRACE_DAYS = 3;  // сколько дней после конца программа ещё работает (с красной полосой)
const ANY = '*';       // подходит к любому компьютеру (аварийный ключ, ключ Создателя)
const PRODUCTS = { xv: 'xVision', itaa: 'xVision ITAA' };

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---------- код компьютера ----------
// Windows MachineGuid (реестр HKLM\SOFTWARE\Microsoft\Cryptography) → SHA-256 → XV-ABCD-EFGH.
// Меняется только при переустановке Windows.
function readMachineGuid() {
  if (process.platform === 'win32') {
    try {
      const out = require('child_process').execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{20,})/);
      if (m) return m[1];
    } catch (e) {}
  }
  if (process.platform === 'linux') { try { return require('fs').readFileSync('/etc/machine-id', 'utf8').trim(); } catch (e) {} }
  return 'host:' + os.hostname() + '|' + (os.userInfo().username || '');
}
function codeFromGuid(guid) {
  const h = crypto.createHash('sha256').update('xvision-machine|' + String(guid).trim().toLowerCase()).digest();
  let bits = 0, val = 0, out = '';
  for (let i = 0; i < h.length && out.length < 8; i++) {
    val = (val << 8) | h[i]; bits += 8;
    while (bits >= 5 && out.length < 8) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return 'XV-' + out.slice(0, 4) + '-' + out.slice(4, 8);
}
let cachedCode = null;
function machineCode() { if (!cachedCode) cachedCode = codeFromGuid(readMachineGuid()); return cachedCode; }
// человек мог прислать код как угодно: строчными, с пробелами, без дефисов
function normCode(s) {
  const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const body = t.startsWith('XV') ? t.slice(2) : t;
  if (body.length !== 8 || /[^0-9A-HJKMNP-TV-Z]/.test(body)) return null;
  return 'XV-' + body.slice(0, 4) + '-' + body.slice(4);
}

// ---------- даты ----------
const pad2 = (n) => String(n).padStart(2, '0');
function isoDay(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function dayEnd(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); }
function ruDate(iso) { const [y, m, d] = String(iso).split('-'); return d + '.' + m + '.' + y; }
function addDays(iso, n) { const [y, m, d] = String(iso).split('-').map(Number); return isoDay(new Date(y, m - 1, d + n)); }

// ---------- ключ ----------
function parseKey(str) {
  const s = String(str || '').replace(/\s+/g, '');
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  try {
    const data = fromB64u(parts[1]), sig = fromB64u(parts[2]);
    return { text: s, data, sig, payload: JSON.parse(data.toString('utf8')) };
  } catch (e) { return null; }
}
function publicKeyObject(pubB64) {
  const raw = Buffer.from(String(pubB64).trim(), 'base64');
  if (raw.length !== 32) throw new Error('открытый ключ повреждён');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}
function privateKeyObject(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
}
function publicFromSeed(seed) {
  const der = crypto.createPublicKey(privateKeyObject(seed)).export({ format: 'der', type: 'spki' });
  return der.slice(der.length - 32).toString('base64');
}
function signKey(payload, seed) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, data, privateKeyObject(seed));
  return KEY_PREFIX + '.' + b64u(data) + '.' + b64u(sig);
}
// Проверка ключа на этом компьютере. status:
//  ok — действует; soon — действует, но скоро конец; grace — срок вышел, ещё GRACE_DAYS дней работает;
//  expired, machine (другой компьютер), product (другая программа), bad (подделан или повреждён)
function checkKey(str, { pub, machine, product, now }) {
  now = now || Date.now();
  const k = parseKey(str);
  if (!k) return { ok: false, status: 'bad', error: 'Это не ключ xVision — скопируйте его целиком.' };
  let good = false;
  try { good = crypto.verify(null, k.data, publicKeyObject(pub), k.sig); } catch (e) { good = false; }
  if (!good) return { ok: false, status: 'bad', error: 'Ключ не подходит: он выписан не для этой программы или изменён.' };
  const p = k.payload || {};
  const codes = Array.isArray(p.m) ? p.m : [];
  if (!codes.includes(ANY) && !codes.includes(machine)) return { ok: false, status: 'machine', payload: p, error: 'Ключ выписан для другого компьютера. Код этого компьютера: ' + machine + '.' };
  if (Array.isArray(p.p) && p.p.length && product && !p.p.includes(product)) return { ok: false, status: 'product', payload: p, error: 'Ключ выписан для другой программы (' + p.p.map((x) => PRODUCTS[x] || x).join(', ') + ').' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.e || '')) return { ok: false, status: 'bad', payload: p, error: 'В ключе нет срока действия.' };
  // дни считаем по календарю: «до 30.11», а сегодня 23.11 — осталось 7 дней
  const [ey, em, ed] = p.e.split('-').map(Number), nd = new Date(now);
  const end = dayEnd(p.e), left = Math.round((new Date(ey, em - 1, ed) - new Date(nd.getFullYear(), nd.getMonth(), nd.getDate())) / DAY);
  if (now > end + GRACE_DAYS * DAY) return { ok: false, status: 'expired', payload: p, daysLeft: left, error: 'Срок ключа закончился ' + ruDate(p.e) + '.' };
  if (now > end) return { ok: true, status: 'grace', payload: p, daysLeft: left, graceLeft: Math.max(1, GRACE_DAYS + left + 1) };
  return { ok: true, status: left <= WARN_DAYS && p.k !== 'creator' ? 'soon' : 'ok', payload: p, daysLeft: left };
}

// ---------- ключ Создателя: секрет под паролем ----------
const KDF_ITER = 310000;
function sealSeed(seed, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(password), salt, KDF_ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(seed)), c.final()]);
  const body = { v: 1, it: KDF_ITER, s: b64u(salt), i: b64u(iv), c: b64u(ct), t: b64u(c.getAuthTag()), pub: publicFromSeed(seed) };
  return CREATOR_PREFIX + '.' + b64u(Buffer.from(JSON.stringify(body), 'utf8'));
}
function parseCreator(str) {
  const s = String(str || '').replace(/\s+/g, '');
  const [pre, body] = s.split('.');
  if (pre !== CREATOR_PREFIX || !body) return null;
  try { const o = JSON.parse(fromB64u(body).toString('utf8')); return o && o.c && o.s ? Object.assign({ text: s }, o) : null; } catch (e) { return null; }
}
function openSeed(str, password) {
  const o = parseCreator(str);
  if (!o) throw new Error('Это не ключ Создателя');
  const key = crypto.pbkdf2Sync(String(password), fromB64u(o.s), o.it || KDF_ITER, 32, 'sha256');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(o.i));
    d.setAuthTag(fromB64u(o.t));
    const seed = Buffer.concat([d.update(fromB64u(o.c)), d.final()]);
    if (seed.length !== 32) throw new Error('size');
    return seed;
  } catch (e) { throw new Error('Неверный пароль'); }
}
function newSeed() { return crypto.randomBytes(32); }

module.exports = {
  KEY_PREFIX, CREATOR_PREFIX, WARN_DAYS, GRACE_DAYS, ANY, PRODUCTS, DAY,
  machineCode, codeFromGuid, normCode, isoDay, dayEnd, ruDate, addDays,
  parseKey, checkKey, signKey, publicFromSeed, newSeed, sealSeed, parseCreator, openSeed,
};
