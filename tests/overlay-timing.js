const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('  async function generateOverlayForClip(');
const end = html.indexOf('  // ---------- export ----------', start);
assert.ok(start >= 0 && end > start);

async function overlayForPause(fps, startTime) {
  let arrow;
  const context = { clearRect() { arrow = false; } };
  // Record the canvas state in place of the PNG payload.
  const canvas = { getContext: () => context, toDataURL: () => 'data:image/png;base64,' + (arrow ? 'arrow' : 'clear') };
  const env = {
    videoFps: fps, video: { videoWidth: 64, videoHeight: 64 }, document: { createElement: () => canvas },
    strokesByKey: { clip: [{ type: 'arrow', atTime: startTime, erasedAt: startTime, erasedP: 5 }] },
    graphicsByKey: { clip: [{ type: 'text', from: startTime, to: startTime, toP: 5 }] },
    pausesByKey: {}, highlightsByKey: {}, freezesFor: () => [{ t: startTime, dur: 5 }],
    clipSlows: () => [], ensureMedia() {}, posLoadAll() {}, baseLineWidth: () => 1,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), ED_FADE: 0.2,
    drawSpotDim: () => false, drawShape() { arrow = true; }, drawGraphic() {}, gfxAlpha: () => 1, setTimeout,
  };
  const generate = vm.runInNewContext(html.slice(start, end) + '\ngenerateOverlayForClip', env);
  return (await generate({ id: 'clip', start: 0, end: 9 })).segments;
}

if (require.main === module) {
  for (const fps of [25, 30, 50, 60]) {
    test('export preserves both drawing boundaries at ' + fps + ' fps', async () => {
      for (const startTime of [1.999, 2, 2.001, 2.015]) {
        let time = 0;
        for (const { duration, png } of await overlayForPause(fps, startTime)) {
          assert.ok(duration > 0);
          for (const sample of [time + duration / 4, time + 3 * duration / 4]) {
            assert.equal(png, sample >= startTime && sample < startTime + 5 ? 'arrow' : 'clear');
          }
          for (const edge of [startTime, startTime + 5]) {
            assert.ok(edge <= time + 1e-6 || edge >= time + duration - 1e-6, 'segment straddles boundary');
          }
          time += duration;
        }
        assert.ok(Math.abs(time - 14) < 1e-6);
      }
    });
  }
}
module.exports = { overlayForPause };
