// Rasterize build/icon.svg into a macOS .iconset using Electron (already a
// project dependency) - no third-party SVG tooling required.
//
//   npx electron build/make-icon.js
//   iconutil -c icns build/icon.iconset -o build/icon.icns
//
// A hidden, node-enabled renderer loads the SVG as a vector <img> and redraws
// it to a canvas at each required pixel size (vector source => crisp at every
// size), writing the Apple-named PNGs directly into build/icon.iconset/.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const buildDir = __dirname;
const svgPath = path.join(buildDir, 'icon.svg');
const iconsetDir = path.join(buildDir, 'icon.iconset');

// size (px) -> Apple iconset filename
const MAP = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png']
];

function fail(msg) { console.error('[make-icon] ' + msg); app.exit(1); }

app.whenReady().then(() => {
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const svg = fs.readFileSync(svgPath, 'utf8');
  const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>
const fs = require('fs');
const MAP = ${JSON.stringify(MAP)};
const OUT = ${JSON.stringify(iconsetDir)};
const img = new Image();
img.onload = () => {
  try {
    for (const [size, name] of MAP) {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      const b64 = c.toDataURL('image/png').split(',')[1];
      fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64'));
    }
    document.title = 'DONE';
  } catch (e) {
    document.title = 'ERR:' + e.message;
  }
};
img.onerror = () => { document.title = 'ERR:image-load-failed'; };
img.src = ${JSON.stringify(svgDataUrl)};
</script>
</body></html>`;

  const win = new BrowserWindow({
    width: 1100, height: 1100, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: false }
  });

  const finish = (title) => {
    if (title === 'DONE') {
      const written = MAP.every(([, n]) => fs.existsSync(path.join(iconsetDir, n)));
      console.log('[make-icon] wrote ' + MAP.length + ' PNGs; all present: ' + written);
      app.exit(written ? 0 : 1);
    } else if (title && title.startsWith('ERR:')) {
      fail(title);
    }
  };

  win.webContents.on('page-title-updated', (_e, title) => finish(title));
  win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));

  setTimeout(() => fail('timed out waiting for render'), 20000);
});
