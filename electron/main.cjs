// Electron shell around the built game in dist/.
//
// The game itself is untouched browser code — no node, no IPC, no preload
// bridge. Everything here is window and protocol plumbing, so that the desktop
// build and the `npm run dev` build stay the same game.
const { app, BrowserWindow, Menu, protocol, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'arena';
const ORIGIN = `${SCHEME}://game`;

// A privileged custom scheme rather than file://. Vite emits the bundle as
// `<script type="module">`, and modules are blocked on file:// because it is an
// opaque origin; localStorage on an opaque origin is either unavailable or
// shared with every other file:// page on the machine, so the settings the
// player saves would be neither private nor reliably theirs. A standard, secure
// scheme gives the game one real origin it keeps for the life of the install.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true, // Vite stamps `crossorigin` on both the script and the stylesheet
      stream: true,      // <audio> wants a streamable, range-able body
      codeCache: true,
      bypassCSP: false,
    },
  },
]);

// WebGL wants the high-power GPU where there is a choice. `ignore-gpu-blocklist`
// matters most on Windows: a blocklisted driver drops Chromium to SwiftShader,
// and a fill-rate-bound postfx stack under software rendering is a slideshow
// with no error message to explain it.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// Deliberately NOT disabling background throttling. Alt-tabbing away drops
// pointer lock, which auto-pauses the game, so there is no cadence to protect —
// defeating the throttle would just keep the GPU rendering a paused scene and
// draining the battery. The game already clamps its own delta on resume.

// The bundle contains no eval, no Function constructor, no workers and no wasm,
// so everything can be locked to 'self'. Two exceptions are load-bearing:
// src/ui/menus.js writes inline `style=""` attributes on the death screen, and
// player-uploaded tracks play from blob: URLs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Serve one file out of dist/, honouring Range so <audio> can seek inside the
// multi-megabyte soundtrack instead of refusing to scrub.
function serve(filePath, rangeHeader) {
  const stat = fs.statSync(filePath);
  // statSync happily succeeds on a directory, and the read stream would then
  // fail asynchronously — after a 200 had already gone out.
  if (!stat.isFile()) return new Response('Not found', { status: 404 });
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'content-security-policy': CSP };

  const m = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : stat.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    start = Math.max(0, Math.min(start, stat.size - 1));
    end = Math.max(start, Math.min(end, stat.size - 1));
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': String(end - start + 1),
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { ...headers, 'content-length': String(stat.size) },
  });
}

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // path.join collapses `..` before the prefix check, so a crafted URL cannot
    // walk out of dist/ into the rest of the filesystem.
    const filePath = path.join(DIST, pathname);
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      return serve(filePath, request.headers.get('range'));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        return new Response('Not found', { status: 404 });
      }
      return new Response(String(err), { status: 500 });
    }
  });
}

let win = null;

function createWindow() {
  // Big enough to read the HUD, but never larger than the display it opens on.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1600, work.width);
  const height = Math.min(900, work.height);

  win = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#05040a',   // the game's own void, so there is no white flash
    show: false,
    autoHideMenuBar: true,        // Windows/Linux: no menu strip over the arena
    title: 'Arcane Arena',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,              // the game needs nothing from node
      preload: path.join(__dirname, 'preload.cjs'),
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Pinch-to-zoom on a trackpad is the other half of the Ctrl+wheel problem the
  // preload handles.
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Cmd+R / Ctrl+R / F5 would throw away a run in progress with no confirmation
  // and no save — in a browser tab that is the player's own doing, in a shipped
  // app it reads as a crash. before-input-event pre-empts menu accelerators,
  // which fire even with the menu bar hidden.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const key = (input.key || '').toLowerCase();
    if (input.key === 'F5' || input.key === 'F12') event.preventDefault();
    if (mod && ['r', '=', '+', '-', '_', '0'].includes(key)) event.preventDefault();
    if (mod && input.shift && key === 'i') event.preventDefault();
  });

  // A dead renderer should come back as a game, not stay a black rectangle.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[arcane] renderer gone:', details.reason);
    if (!win.isDestroyed()) win.reload();
  });

  // PostFX bakes its pixel budget from devicePixelRatio and only recomputes on
  // a resize event. Dragging the window from a Retina panel to a 1x monitor
  // changes the ratio without changing innerWidth/innerHeight, so nothing fires
  // and the render targets stay sized for the wrong display.
  const nudgeResize = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
    }
  };
  win.on('moved', nudgeResize);
  screen.on('display-metrics-changed', nudgeResize);

  // Pointer lock is the whole control scheme; grant it (and fullscreen) without
  // a prompt, and refuse everything else the page could think to ask for.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'pointerLock' || permission === 'fullscreen');
  });
  if (win.webContents.session.setPermissionCheckHandler) {
    win.webContents.session.setPermissionCheckHandler(
      (_wc, permission) => permission === 'pointerLock' || permission === 'fullscreen'
    );
  }

  // Nothing in the game opens a window; if anything ever does, it belongs in
  // the player's real browser, not in a chrome-less child of the game.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });

  win.loadURL(`${ORIGIN}/index.html`);
}

function buildMenu() {
  const view = {
    label: 'View',
    submenu: [
      {
        label: 'Toggle Full Screen',
        // Esc is the game's pause key and macOS also uses it to leave
        // fullscreen, so fullscreen gets its own explicit accelerator and the
        // window opens windowed.
        accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
        click: () => win && win.setFullScreen(!win.isFullScreen()),
      },
      // No reload and no DevTools role: both carry default accelerators that
      // fire through a hidden menu bar, and both are hostile in front of a
      // player mid-run. Zoom is pinned at 1x, so there is nothing to reset.
    ],
  };

  // macOS always shows a menu bar, so it needs a real app menu for Cmd+Q and
  // the standard Hide/Services items. Windows and Linux hide theirs entirely.
  const template = process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        view,
        { role: 'windowMenu' },
      ]
    : [view];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// userData — and therefore localStorage, where settings and the best wave live
// — is derived from the app name. Pinning it here means the unpackaged
// `npm run electron` and the installed app share one store, and no later change
// to packaging config can silently orphan a player's saves.
app.setName('Arcane Arena');

// One window, one game. A second launch focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerProtocol();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // A game is not a document app: closing the arena means quitting, on every
    // platform including macOS.
    app.quit();
  });
}
