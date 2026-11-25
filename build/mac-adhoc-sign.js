// Mac без сертификата Apple: подписываем программу «ad-hoc» — иначе на Mac с процессором M1–M4 она не запустится вовсе.
// (С сертификатом разработчика Apple этот шаг не нужен — electron-builder подпишет сам.)
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  console.log('[mac] ad-hoc подпись: ' + app);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
