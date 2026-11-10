// Icon rasterizer: assets/icon.svg → icon-256/48/32/16.png + multi-size icon.ico
// Runs inside Electron (uses its offscreen renderer + nativeImage). No new npm deps.
// usage: npx electron tools/render-icon.js   (from transcriber/app/)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "app", "assets");

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, "icon.svg"), "utf8");
  const html = `<html><body style="margin:0"></body></html>`;

  const win = new BrowserWindow({
    width: 280,
    height: 280,
    show: false,
    webPreferences: { offscreen: true },
  });
  const wc = win.webContents;

  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    // Rasterize the SVG on a canvas inside the page — deterministic, no race.
    const png256 = await wc.executeJavaScript(
      `(async () => {
        const svgStr = ${JSON.stringify(svg)};
        const img = new Image();
        img.decoding = "sync";
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 256; c.height = 256;
        c.getContext("2d").drawImage(img, 0, 0, 256, 256);
        return c.toDataURL("image/png");
      })()`
    );
    const freeOffscreenFirst = wc.capturePage; // noop ref kept for clarity
    saveSizes(png256.replace(/^data:image\/png;base64,/, ""));
  } catch (err) {
    console.error("rasterization failed:", err);
    app.exit(1);
    return;
  }
  app.quit();
});

function saveSizes(pngBase64) {
  const full = require("electron").nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  const sizes = [256, 48, 32, 16];
  const entries = sizes.map((s) => {
    const img = s === 256 ? full : full.resize({ width: s, height: s, quality: "best" });
    const png = img.toPNG();
    fs.writeFileSync(path.join(ASSETS, `icon-${s}.png`), png);
    return { size: s, png };
  });
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), packIco(entries));
  console.log("OK — wrote icon-256/48/32/16.png + icon.ico");
}

// Minimal ICO packer (PNG-compressed entries, valid for Windows Vista+)
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  const blobs = [];
  let offset = 6 + 16 * images.length;
  images.forEach((im, i) => {
    const b = 16 * i;
    const dim = im.size >= 256 ? 0 : im.size; // 0 encodes 256
    dir.writeUInt8(dim, b + 0);
    dir.writeUInt8(dim, b + 1);
    dir.writeUInt8(0, b + 2);  // palette
    dir.writeUInt8(0, b + 3);  // reserved
    dir.writeUInt16LE(1, b + 4);  // color planes
    dir.writeUInt16LE(32, b + 6); // bits per px
    dir.writeUInt32LE(im.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    blobs.push(im.png);
    offset += im.png.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}
