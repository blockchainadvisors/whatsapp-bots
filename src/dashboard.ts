import * as http from 'node:http';
import * as crypto from 'node:crypto';
import QRCode from 'qrcode';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type DashboardState = {
    qr?: string;
    connection?: string;
    statusCode?: number;
    error?: string;
    loggedInAs?: string;
    loggedInLid?: string;
    lastUpdatedMs: number;
};

type DashboardOpts = {
    getState: () => DashboardState;
    resetAuth: () => Promise<void> | void;
};

function getEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

function okNoCache(res: http.ServerResponse, contentType: string) {
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
}

function send(res: http.ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8') {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
}

function safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function checkBasicAuth(req: http.IncomingMessage, password: string): boolean {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    return safeEqual(pass, password);
}

function unauthorized(res: http.ServerResponse) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Bot Dashboard"');
    res.end('Unauthorized');
}

let server: http.Server | undefined;
let currentOpts: DashboardOpts | undefined;
let lastListenKey: string | undefined;

function renderIndexHtml(state: DashboardState) {
    const safe = (v: unknown) => String(v ?? '');
    const initial = {
        connection: state.connection ?? 'unknown',
        loggedInAs: state.loggedInAs ?? 'unknown',
        loggedInLid: state.loggedInLid ?? 'n/a',
        statusCode: typeof state.statusCode === 'number' ? state.statusCode : null,
        error: state.error ?? '',
        lastUpdatedMs: state.lastUpdatedMs,
        hasQr: Boolean(state.qr)
    };

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp Bot Dashboard</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 24px; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; max-width: 640px; }
      .row { margin: 8px 0; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
      .muted { color: #6b7280; }
      .error { color: #b91c1c; }
      .btn { padding: 10px 12px; border-radius: 10px; border: 1px solid #111827; background: #111827; color: white; cursor: pointer; }
      .btn:disabled { opacity: 0.6; cursor: default; }
      .danger { background: #b91c1c; border-color: #b91c1c; }
      .qr { width: 300px; height: 300px; border: 1px solid #e5e7eb; border-radius: 12px; display: grid; place-items: center; overflow: hidden; background: #fff; }
      .qr img { width: 300px; height: 300px; display: block; }
      hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
    </style>
  </head>
  <body>
    <h2>WhatsApp Bot Dashboard</h2>
    <div class="card">
      <div class="row">Connection: <code id="conn">${safe(initial.connection)}</code></div>
      <div class="row">Logged in as: <code id="me">${safe(initial.loggedInAs)}</code></div>
      <div class="row">LID: <code id="lid">${safe(initial.loggedInLid)}</code></div>
      <div class="row">Last update: <code id="updated">${new Date(initial.lastUpdatedMs).toISOString()}</code></div>
      <div class="row muted" id="statusLine"></div>
      <div class="row error" id="errLine"></div>
      <div class="row" id="codeLine"></div>

      <hr />

      <h3>QR Code</h3>
      <div class="qr">
        <img id="qrImg" alt="QR code" style="display:none;" />
        <div id="qrEmpty" class="muted">No QR available</div>
      </div>
      <div class="row muted">The QR appears only when relogin is required.</div>

      <hr />

      <button id="resetBtn" class="btn danger" type="button">Reset auth + restart</button>
    </div>

    <script>
      const state = ${JSON.stringify(initial)};
      const els = {
        conn: document.getElementById('conn'),
        me: document.getElementById('me'),
        lid: document.getElementById('lid'),
        updated: document.getElementById('updated'),
        statusLine: document.getElementById('statusLine'),
        errLine: document.getElementById('errLine'),
        codeLine: document.getElementById('codeLine'),
        qrImg: document.getElementById('qrImg'),
        qrEmpty: document.getElementById('qrEmpty'),
        resetBtn: document.getElementById('resetBtn')
      };

      let resetting = false;
      function setQrVisible(hasQr) {
        if (hasQr) {
          els.qrImg.style.display = 'block';
          els.qrEmpty.style.display = 'none';
          els.qrImg.src = '/qr.png?ts=' + Date.now();
        } else {
          els.qrImg.style.display = 'none';
          els.qrEmpty.style.display = 'block';
          els.qrImg.removeAttribute('src');
        }
      }

      function applyStatus(s) {
        els.conn.textContent = s.connection || 'unknown';
        els.me.textContent = s.loggedInAs || 'unknown';
        els.lid.textContent = s.loggedInLid || 'n/a';
        els.updated.textContent = new Date(s.lastUpdatedMs || Date.now()).toISOString();
        els.errLine.textContent = s.error ? ('Error: ' + s.error) : '';
        els.codeLine.textContent = (typeof s.statusCode === 'number') ? ('Status code: ' + s.statusCode) : '';
        setQrVisible(Boolean(s.qr));

        if (resetting) {
          if (s.connection === 'open') {
            resetting = false;
            els.statusLine.textContent = 'Restart complete.';
            els.resetBtn.disabled = false;
          } else {
            els.statusLine.textContent = 'Restarting… waiting for connection.';
          }
        } else {
          els.statusLine.textContent = s.qr ? 'Scan the QR in WhatsApp → Linked devices.' : 'Standing by.';
        }
      }

      async function poll() {
        try {
          const res = await fetch('/status.json', { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const s = await res.json();
          applyStatus(s);
        } catch (e) {
          els.statusLine.textContent = resetting ? 'Restarting… waiting for server.' : 'Waiting for server…';
        } finally {
          setTimeout(poll, 2000);
        }
      }

      els.resetBtn.addEventListener('click', async () => {
        if (!confirm('Delete auth credentials and restart bot?')) return;
        resetting = true;
        els.resetBtn.disabled = true;
        els.statusLine.textContent = 'Restarting…';
        try {
          await fetch('/reset-auth', { method: 'POST' });
        } catch (e) {
          // ignore; server may exit quickly
        }
      });

      applyStatus(state);
      poll();
    </script>
  </body>
</html>`;
}

export function startDashboard(opts: DashboardOpts) {
    const password = process.env.WEB_PASSWORD;
    if (!password) {
        console.log('🌐 Dashboard disabled (WEB_PASSWORD not set)');
        return;
    }

    currentOpts = opts;

    const host = process.env.WEB_HOST || '127.0.0.1';
    const port = getEnvInt('WEB_PORT', 3000);
    const listenKey = `${host}:${port}`;
    if (server) {
        if (lastListenKey !== listenKey) {
            console.warn(`🌐 Dashboard already running on ${lastListenKey}; ignoring new bind ${listenKey}`);
        }
        return;
    }
    lastListenKey = listenKey;

    server = http.createServer(async (req, res) => {
        try {
            if (!checkBasicAuth(req, password)) {
                unauthorized(res);
                return;
            }

            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const state = currentOpts?.getState();
            if (!state) {
                send(res, 503, 'Dashboard not ready');
                return;
            }

            if (req.method === 'GET' && url.pathname === '/') {
                okNoCache(res, 'text/html; charset=utf-8');
                res.end(renderIndexHtml(state));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/status.json') {
                okNoCache(res, 'application/json; charset=utf-8');
                res.end(JSON.stringify(state, null, 2));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/qr.png') {
                if (!state.qr) {
                    send(res, 404, 'No QR available');
                    return;
                }
                const png = await QRCode.toBuffer(state.qr, { type: 'png', width: 300, margin: 1 });
                okNoCache(res, 'image/png');
                res.end(png);
                return;
            }

            if (req.method === 'POST' && url.pathname === '/reset-auth') {
                await currentOpts?.resetAuth();
                send(res, 200, 'OK');
                // Give the HTTP response a chance to flush before exiting.
                setTimeout(() => process.exit(0), 1000);
                return;
            }

            send(res, 404, 'Not found');
        } catch (err) {
            console.error('❌ Dashboard error:', err);
            send(res, 500, 'Internal error');
        }
    });

    server.listen(port, host, () => {
        console.log(`🌐 Dashboard: http://${host}:${port} (basic auth password from WEB_PASSWORD)`);
    });

    // If PM2 sends SIGINT/SIGTERM, close cleanly.
    const shutdown = () => server?.close();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

export function clearAuthDir(authDir = './auth') {
    const resolved = path.resolve(authDir);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}
