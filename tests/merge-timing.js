const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

test('merged export keeps a continuous 29.97 fps timeline across muted slow and normal clips', () => {
  const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
  const run = (args) => execFileSync(ffmpeg, ['-loglevel', 'error', '-y', ...args], { timeout: 60000 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xvision-merge-test-'));
  return verify().finally(() => fs.rmSync(temp, { recursive: true, force: true }));

  async function verify() {
    const source = path.join(temp, 'source.mp4');
    const output = path.join(temp, 'merged.mp4');
    run(['-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=29.97:d=10', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=48000:duration=10', '-c:v', 'libx264', '-c:a', 'aac',
      '-video_track_timescale', '90000', source]);
    let exportClips;
    const encoder = { id: 'libx264', args: ['-c:v', 'libx264', '-crf', '22'] };
    const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    vm.runInNewContext(main.slice(main.indexOf("ipcMain.handle('export-clips'")), {
      ipcMain: { handle: (_, fn) => { exportClips = fn; } }, BrowserWindow: { fromWebContents: () => null },
      fs, path, os, freezeLib: require('../freeze'), licOk: () => true, detectEncoder: async () => encoder,
      SOFT_ENCODER: encoder, probeVideoInfo: async () => ({ fps: 29.97 }), hasAudioTrack: async () => true,
      fmtTs: (t) => t.toFixed(3), sanitizeFileName: (s) => s, uniquePath: () => output, runFfmpeg: run,
    });
    const clips = Array.from({ length: 10 }, (_, i) => ({
      name: String(i), start: i, end: i + 1, fps: 29.97, mute: true,
      slows: i % 5 === 0 ? [] : [{ a: 0.2, b: 0.7, speed: 0.5 }],
    }));
    const result = await exportClips({ sender: {} }, { sourcePath: source, outputDir: temp, clips, mode: 'merged', fastMode: true });
    assert.ok(result.ok, result.error);
    const metadata = path.join(temp, 'frames.txt');
    execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-vf',
      'signalstats,metadata=print:file=frames.txt', '-fps_mode', 'passthrough', '-f', 'null', '-'], { cwd: temp, timeout: 60000 });
    const frames = Array.from(fs.readFileSync(metadata, 'utf8').matchAll(/pts_time:([\d.e+-]+)/g), m => Number(m[1]));
    assert.equal(frames.length, 420);
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i] - frames[i - 1];
      assert.ok(gap > 0 && gap < 0.035, 'unexpected frame gap ' + gap);
    }
  }
});
