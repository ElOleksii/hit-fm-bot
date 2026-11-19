// Offline self-test: validates config, checks voice dependencies and decodes a few
// seconds of every configured station through ffmpeg. No Discord token needed.
import { spawn } from 'node:child_process';
import { generateDependencyReport } from '@discordjs/voice';
import ffmpegStatic from 'ffmpeg-static';
import { loadConfig } from './config.js';
import { openIcyStream } from './icy.js';

const SECONDS = 4;
const config = loadConfig();
console.log(generateDependencyReport());
console.log(`Config OK - ${Object.keys(config.stations).length} station(s), default "${config.defaultStation}"\n`);

function testStation(station) {
  return new Promise(async (resolve) => {
    let title = null;
    let icy;
    try {
      icy = await openIcyStream(station.url, {
        userAgent: config.stream.userAgent,
        timeoutMs: config.stream.timeoutSeconds * 1000,
        metadataEncoding: config.stream.metadataEncoding,
        onMetadata: (t) => (title = t || title),
      });
    } catch (err) {
      resolve({ station, ok: false, error: err.message });
      return;
    }
    const ff = spawn(config.stream.ffmpegPath || ffmpegStatic || 'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { windowsHide: true });
    let pcm = 0;
    let stderr = '';
    ff.stdout.on('data', (d) => (pcm += d.length));
    ff.stderr.on('data', (d) => (stderr += d));
    ff.stdin.on('error', () => {});
    ff.on('error', (err) => resolve({ station, ok: false, error: `ffmpeg: ${err.message}` }));
    icy.stream.pipe(ff.stdin);
    setTimeout(() => {
      icy.close();
      ff.kill();
      // 48 kHz * 2 ch * 2 bytes = 192000 bytes per second of audio
      const seconds = pcm / 192_000;
      resolve({ station, ok: seconds > 1, seconds, title, bitrate: icy.headers['icy-br'], error: stderr.trim() || undefined });
    }, SECONDS * 1000);
  });
}

const results = await Promise.all(Object.values(config.stations).map(testStation));
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`OK   ${r.station.name.padEnd(24)} ${r.bitrate ?? '?'} kbps, decoded ${r.seconds.toFixed(1)}s  ${r.title ? `"${r.title}"` : '(no title right now)'}`);
  } else {
    failed++;
    console.log(`FAIL ${r.station.name.padEnd(24)} ${r.error ?? 'no audio decoded'}`);
  }
}
process.exit(failed ? 1 : 0);
