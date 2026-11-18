#!/usr/bin/env node
// Node v24 offline renderer for pdoom-video (avoids Bun Windows Playwright pipe hang).
// Supports: stills, sheet, perf, video.
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'stills';
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const SCALE = Math.max(1, Math.round(+(opt('scale', '1') ?? '1')));
const OW = 1920 * SCALE;
const OH = 1080 * SCALE;
const SAMPLES =
  opt('samples', '1') === 'auto'
    ? {
        min: +opt('min-samples', '4'),
        max: +opt('max-samples', '324'),
        tol: +opt('tol', '3'),
        refine: opt('refine', 'tiles'),
      }
    : +opt('samples', '1');

const hist = (h) =>
  Object.entries(h)
    .sort((a, b) => +a[0] - +b[0])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  const url = opt('url', 'http://localhost:5173');
  if (await reachable(url)) return { url, stop: () => {} };
  const port = 5300 + Math.floor(Math.random() * 500);
  const viteBin = path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    env: { ...process.env, PDOOM_NO_HMR: '1' },
  });
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 120 && !(await reachable(u)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await reachable(u))) throw new Error(`Vite failed to start on ${u}`);
  return {
    url: u,
    stop: () => {
      try {
        proc.kill();
      } catch {}
    },
  };
}

async function openPage(url) {
  const browser = await chromium.launch({
    headless: !flag('headed'),
    args: [
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
      ...(process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : []),
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const only = opt('only');
  await page.goto(`${url}/?export=1${only ? `&only=${only}` : ''}${SCALE !== 1 ? `&scale=${SCALE}` : ''}`);
  await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__pdoom.error);
  if (err) throw new Error(`app failed to boot:\n${err}\n${logs.join('\n')}`);
  const size = await page.evaluate(() => [window.__pdoom.width ?? 1920, window.__pdoom.height ?? 1080]);
  if (size[0] !== OW || size[1] !== OH) {
    throw new Error(`app renders ${size[0]}x${size[1]}, expected ${OW}x${OH} (--scale ${SCALE})`);
  }
  const sceneErrors = await page.evaluate(() => window.__pdoom.errors);
  if (sceneErrors.length) console.error('SCENE ERRORS:\n' + sceneErrors.join('\n'));
  return { browser, page, logs };
}

/** Minimal RFC-6455 WebSocket server over node:http for raw rgb24 frames. */
function createWsServer(onFrame, onError) {
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end('ws only');
  });

  server.on('upgrade', (req, socket) => {
    const k = +(new URL(req.url, 'http://localhost').searchParams.get('w') ?? 0);
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const sendText = (str) => {
      if (socket.destroyed) return;
      const p = Buffer.from(str, 'utf8');
      const hdr =
        p.length < 126
          ? Buffer.from([0x81, p.length])
          : Buffer.from([0x81, 126, (p.length >> 8) & 0xff, p.length & 0xff]);
      socket.write(Buffer.concat([hdr, p]));
    };

    const wsProxy = {
      send: sendText,
      close: () => {
        try {
          socket.destroy();
        } catch {}
      },
    };

    let buf = Buffer.alloc(0);
    let fragChunks = [];
    let fragOp = 0;

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          const hi = buf.readUInt32BE(off);
          const lo = buf.readUInt32BE(off + 4);
          len = hi * 4294967296 + lo;
          off += 8;
        }
        if (masked && buf.length < off + 4) return;
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;

        const payload = Buffer.allocUnsafe(len);
        buf.copy(payload, 0, off, off + len);
        if (masked) {
          const m0 = buf[maskOff],
            m1 = buf[maskOff + 1],
            m2 = buf[maskOff + 2],
            m3 = buf[maskOff + 3];
          for (let i = 0; i < len; i++) {
            const m = i & 3;
            payload[i] ^= m === 0 ? m0 : m === 1 ? m1 : m === 2 ? m2 : m3;
          }
        }
        buf = buf.subarray(off + len);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          // ping -> pong
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          socket.write(pong);
          continue;
        }
        if (opcode !== 0) {
          fragOp = opcode;
          fragChunks = [payload];
        } else {
          fragChunks.push(payload);
        }
        if (fin) {
          const full = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks);
          fragChunks = [];
          if (fragOp === 0x2) {
            onFrame(k, full, wsProxy);
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (err?.code !== 'ECONNRESET') onError(err);
    });
  });

  return server;
}

async function stills(page, times, outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const t of times) {
    const k = await page.evaluate(([tVal, s, sh]) => window.__pdoom.still(tVal, s, sh), [
      t,
      SAMPLES,
      +opt('shutter', '0.5'),
    ]);
    const f = path.join(outDir, `f_${t.toFixed(2).padStart(7, '0')}.png`);
    if (typeof SAMPLES !== 'number') console.log(`t=${t}: ${k} sub-frames`);
    if (SCALE !== 1) {
      const b64 = await page.evaluate(() => window.__pdoom.png());
      writeFileSync(f, Buffer.from(b64, 'base64'));
    } else {
      await page.screenshot({ path: f, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    }
    files.push(f);
  }
  return files;
}

async function sheet(page, times, cols, out) {
  const dataUrl = await page.evaluate(
    async ({ times: ts, cols: cCount }) => {
      const P = window.__pdoom;
      const cw = 480,
        ch = 270,
        pad = 4,
        lab = 18;
      const rows = Math.ceil(ts.length / cCount);
      const cv = document.createElement('canvas');
      cv.width = cCount * (cw + pad) + pad;
      cv.height = rows * (ch + lab + pad) + pad;
      const c = cv.getContext('2d');
      c.fillStyle = '#222';
      c.fillRect(0, 0, cv.width, cv.height);
      const src = document.getElementById('c');
      ts.forEach((t, i) => {
        P.still(t);
        const x = pad + (i % cCount) * (cw + pad),
          y = pad + Math.floor(i / cCount) * (ch + lab + pad);
        c.drawImage(src, x, y + lab, cw, ch);
        c.fillStyle = '#ddd';
        c.font = '13px monospace';
        c.fillText(`${t.toFixed(2)}s`, x + 2, y + 13);
      });
      return cv.toDataURL('image/png');
    },
    { times, cols },
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function video(url, from, to, fps, out) {
  mkdirSync(path.dirname(out), { recursive: true });
  const crf = opt('crf', '19');
  const tune = opt('tune', '');
  const audio = path.join(ROOT, 'audio/pdoom.mp3');
  const ffArgs = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${OW}x${OH}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
  ];
  if (!flag('noaudio')) ffArgs.push('-ss', String(from), '-t', String(to - from), '-i', audio);
  ffArgs.push(
    '-vf',
    'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709',
    '-c:v',
    'libx264',
    '-preset',
    opt('preset', 'slow'),
    '-crf',
    crf,
    '-pix_fmt',
    'yuv420p',
    '-x264-params',
    opt('x264', 'aq-mode=3'),
  );
  if (tune) ffArgs.push('-tune', tune);
  if (!flag('noaudio')) ffArgs.push('-c:a', 'aac', '-b:a', '320k', '-shortest');
  ffArgs.push('-movflags', '+faststart', out);

  const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  const f0 = Math.round(from * fps),
    f1 = Math.round(to * fps),
    total = f1 - f0;
  const chunk = Math.max(1, +opt('chunk', '8'));
  const workers = Math.max(1, Math.min(+opt('workers', '2'), Math.ceil(total / chunk)));
  const frameBytes = OW * OH * 3;
  const cap = Math.max(4, Math.floor((+opt('mem-gb', '1') * 1e9) / frameBytes));
  const spoolCap = Math.floor((+opt('spool-gb', '20') * 1e9) / frameBytes);
  const spoolDir = path.join(tmpdir(), `pdoom-spool-${process.pid}`);
  mkdirSync(spoolDir, { recursive: true });

  const spooled = new Set();
  let spoolPeak = 0;
  const spoolFile = (n) => path.join(spoolDir, `${n}.rgb`);
  const toSpool = (n, buf) => {
    writeFileSync(spoolFile(n), buf);
    spooled.add(n);
    spoolPeak = Math.max(spoolPeak, spooled.size);
  };
  const waiting = new Map();
  const owed = new Map();
  const queue = Array.from({ length: workers }, () => []);
  const sockets = [];
  const ackCount = new Array(workers).fill(0);
  const ack = (k) => {
    ackCount[k]++;
    sockets[k]?.send(String(ackCount[k]));
  };
  let next = f0,
    written = 0,
    cursor = f0,
    ending = false;

  let failure = null,
    rejectFailed,
    resolveWritten;
  const failed = new Promise((_, rej) => {
    rejectFailed = rej;
  });
  failed.catch(() => {});
  const allWritten = new Promise((res) => {
    resolveWritten = res;
  });
  const fail = (e) => {
    if (failure) return;
    failure = e instanceof Error ? e : new Error(String(e));
    for (const ws of sockets) ws?.close();
    rejectFailed(failure);
  };
  ff.on('exit', (code) => {
    if (!ending) fail(new Error(`ffmpeg exited early (code ${code})`));
  });
  ff.stdin.on('error', (err) => {
    if (!ending) fail(err);
  });

  const t0 = performance.now();
  let draining = false;
  const writeToFfmpeg = (buf) =>
    new Promise((resolve) => {
      if (ff.stdin.write(buf)) resolve();
      else ff.stdin.once('drain', resolve);
    });

  const drain = async () => {
    if (draining || failure) return;
    draining = true;
    try {
      while (!failure && (waiting.has(next) || spooled.has(next))) {
        let buf = waiting.get(next);
        if (buf) waiting.delete(next);
        else {
          buf = readFileSync(spoolFile(next));
          spooled.delete(next);
          rmSync(spoolFile(next));
        }
        await writeToFfmpeg(buf);
        const k = owed.get(next);
        if (k !== undefined) {
          owed.delete(next);
          ack(k);
        }
        next++;
        written++;
        for (const [m, kk] of owed) {
          if (waiting.size > cap) {
            if (spooled.size >= spoolCap) break;
            toSpool(m, waiting.get(m));
            waiting.delete(m);
          }
          owed.delete(m);
          ack(kk);
        }
        if (written % 60 === 0 || written === total) {
          const el = (performance.now() - t0) / 1000;
          const rate = written / Math.max(0.01, el);
          console.log(`${written}/${total} frames  ${rate.toFixed(1)} fps  eta ${((total - written) / rate).toFixed(0)}s`);
        }
        if (written === total) resolveWritten();
      }
    } catch (e) {
      fail(e);
    } finally {
      draining = false;
    }
  };

  const server = createWsServer(
    (k, buf, wsProxy) => {
      if (failure) return;
      sockets[k] = wsProxy;
      try {
        const n = queue[k].shift();
        if (n === undefined) throw new Error(`worker ${k} sent a frame it was not given`);
        if (buf.length !== frameBytes) throw new Error(`worker ${k} sent ${buf.length} bytes for frame ${n}`);
        if (waiting.size < cap || n === next) {
          waiting.set(n, buf);
          ack(k);
        } else if (spooled.size < spoolCap) {
          toSpool(n, buf);
          ack(k);
        } else {
          waiting.set(n, buf);
          owed.set(n, k);
        }
        void drain();
      } catch (e) {
        fail(e);
      }
    },
    (err) => fail(err),
  );

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const wsPort = server.address().port;

  const take = () => {
    if (cursor >= f1) return null;
    const a = cursor;
    cursor = Math.min(f1, a + chunk);
    return [a, cursor];
  };

  const pages = [];
  const used = {};
  const closePages = async () => {
    for (const p of pages.splice(0)) {
      if (p.logs.length) console.error('BROWSER LOG:\n' + p.logs.slice(0, 40).join('\n'));
      await p.browser.close().catch(() => {});
    }
  };

  let ok = false;
  try {
    const opened = await Promise.allSettled(Array.from({ length: workers }, () => openPage(url)));
    for (const o of opened) if (o.status === 'fulfilled') pages.push(o.value);
    for (const o of opened) if (o.status === 'rejected') throw o.reason;

    const rendering = Promise.all(
      pages.map(async ({ page }, k) => {
        for (let r = take(); r && !failure; r = take()) {
          for (let n = r[0]; n < r[1]; n++) queue[k].push(n);
          const h = await page.evaluate((o) => window.__pdoom.stream(o), {
            from: r[0] / fps,
            to: r[1] / fps,
            fps,
            ws: `ws://127.0.0.1:${wsPort}/?w=${k}`,
            samples: SAMPLES,
            shutter: +opt('shutter', '0.5'),
            inflight: 4,
          });
          for (const [c, m] of Object.entries(h)) used[c] = (used[c] ?? 0) + m;
        }
      }),
    );
    rendering.catch(() => {});
    await Promise.race([rendering, failed]).catch((e) => {
      fail(e);
      throw failure;
    });
    await Promise.race([allWritten, failed]);
    await closePages();
    ending = true;
    ff.stdin.end();
    const code = await new Promise((res) => ff.on('exit', res));
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    ok = true;
  } finally {
    ending = true;
    if (!ok) {
      try {
        ff.kill('SIGKILL');
      } catch {}
    }
    await closePages();
    server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
  console.log(`\nwrote ${out} (${written} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${workers} workers${spoolPeak ? `, up to ${spoolPeak} frames spooled` : ''})`);
  console.log(`sub-frames per frame (count:frames): ${hist(used)}`);
}

const { url, stop } = await ensureServer();
try {
  if (mode === 'video') {
    const { browser, page } = await openPage(url);
    const dur = await page.evaluate(() => window.__pdoom.duration);
    await browser.close();
    await video(url, +opt('from', '0'), +opt('to', String(dur)), +opt('fps', '60'), path.resolve(opt('out', path.join(ROOT, 'out/pdoom.mp4'))));
  } else {
    const { browser, page, logs } = await openPage(url);
    try {
      if (mode === 'stills') {
        const times = (opt('t') ?? '0').split(',').map(Number);
        const files = await stills(page, times, opt('out', path.join(ROOT, 'out/stills')));
        console.log(files.join('\n'));
      } else if (mode === 'sheet') {
        const from = +opt('from', '0'),
          to = +opt('to', '10'),
          n = +opt('n', '12');
        let times = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
        if (opt('times')) times = opt('times').split(',').map(Number);
        const out = opt('out', path.join(ROOT, `out/sheets/sheet_${from}-${to}.png`));
        await sheet(page, times, +opt('cols', '4'), out);
        console.log(out);
      } else if (mode === 'perf') {
        const from = +opt('from', '0'),
          to = +opt('to', '5');
        const r = await page.evaluate(
          async ({ from: f0, to: f1, samples, shutter }) => {
            const P = window.__pdoom;
            const ms = [];
            const buf = new Uint8Array(P.width * P.height * 4);
            P.still(f0);
            const used = {};
            for (let t = f0; t < f1; t += 1 / 60) {
              const a = performance.now();
              const k = P.engine.render(t, 1 / 60, false, samples, shutter);
              used[k] = (used[k] ?? 0) + 1;
              await P.engine.readPixelsAsync(buf);
              ms.push(performance.now() - a);
            }
            ms.sort((a, b) => a - b);
            return {
              n: ms.length,
              avg: ms.reduce((a, b) => a + b, 0) / ms.length,
              p50: ms[ms.length >> 1],
              p95: ms[Math.floor(ms.length * 0.95)],
              max: ms[ms.length - 1],
              used,
            };
          },
          { from, to, samples: SAMPLES, shutter: +opt('shutter', '0.5') },
        );
        console.log(`frames ${r.n}  avg ${r.avg.toFixed(1)}ms  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  max ${r.max.toFixed(1)}  sub-frames ${hist(r.used)}`);
      }
      if (logs.length) console.error('BROWSER LOG:\n' + logs.slice(0, 40).join('\n'));
    } finally {
      await browser.close();
    }
  }
} finally {
  stop();
}
