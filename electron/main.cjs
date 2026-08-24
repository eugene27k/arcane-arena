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
      stream: true,      // <audio> wants a streamable, range-able body
      codeCache: true,
      bypassCSP: false,
    },
  },
]);

// WebGL wants the discrete/high-power GPU where there is a choice, and the
// render loop must keep its cadence when the window is not frontmost — the
// default backgrounding throttle turns a paused-looking game into a stuttering
// one on the way back.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes' };

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
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

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
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'togglefullscreen', visible: false },
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
