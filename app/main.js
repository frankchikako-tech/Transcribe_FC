// Transcriber App — main process (Electron)
// Spawns the Phase 1 python engine and pipes progress to the renderer.
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { assemblyAITranscribe } = require("./cloud");
const { checkForUpdate } = require("./update");

const PROJECT_ROOT = path.join(__dirname, "..");
const PYTHON = path.join(PROJECT_ROOT, "venv", "Scripts", "python.exe");
const ENGINE = path.join(PROJECT_ROOT, "transcriber.py");

let engineProc = null;
let cloudJob = null; // { apiKey, id?, cancelled } while an AssemblyAI run is active
let mainWindow = null;

// Safe log to the renderer — a hung/closed window must never crash a running job.
function sendLog(text) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("engine-log", text);
    }
  } catch {}
}

// Single-instance lock: a second launch focuses the existing window instead of
// stacking a fresh (and possibly blank/hung) Electron process tree on top.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  // First open: a comfortable default. After that: remember the user's
  // own size & position (saved on close), like a proper desktop app.
  const defaults = { width: 1180, height: 760, x: undefined, y: undefined };
  let win = { ...defaults };
  try {
    const saved = readSettings().windowState;
    if (saved && saved.width && saved.height) win = saved;
  } catch {}
  // never smaller than usable; never bigger than the actual screen
  const { screen } = require("electron");
  const disp = screen.getPrimaryDisplay().workAreaSize;
  win.width = Math.min(Math.max(win.width, 720), disp.width - 40);
  win.height = Math.min(Math.max(win.height, 560), disp.height - 40);

  mainWindow = new BrowserWindow({
    width: win.width,
    height: win.height,
    x: win.x,
    y: win.y,
    minWidth: 560,
    minHeight: 480,
    icon: path.join(__dirname, "assets", "icon.ico"), // title bar, taskbar, Alt-Tab
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);

  // Harden navigation: this app only ever shows its own local UI. Block any
  // attempt to navigate the window elsewhere or open new windows in-app;
  // external links go out through the vetted "open-external" IPC (https only).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());

  mainWindow.on("closed", () => { mainWindow = null; });

  // persist size & position when the window is being closed
  const saveState = () => {
    try {
      if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
        const b = mainWindow.getBounds();
        const s = readSettings();
        s.windowState = { width: b.width, height: b.height, x: b.x, y: b.y };
        writeSettings(s);
      }
    } catch {}
  };
  mainWindow.on("close", saveState);
}

// Only the primary instance opens a window; a second launch quit above.
if (gotLock) app.whenReady().then(() => {
  // proper taskbar identity (groups under our icon instead of default electron.exe)
  app.setAppUserModelId("com.frank.transcriber");
  createWindow();
});
app.on("window-all-closed", () => {
  if (engineProc) engineProc.kill();
  app.quit();
});

// ---- IPC ----

ipcMain.handle("pick-audio", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose an audio file",
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "mp4", "flac", "ogg"] }],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("cancel", () => {
  if (engineProc) {
    engineProc.kill();
    engineProc = null;
  }
  if (cloudJob) {
    cloudJob.cancelled = true;
    if (cloudJob.id) {
      // best-effort: also delete the remote job so credits aren't charged
      fetch(`https://api.assemblyai.com/v2/transcript/${cloudJob.id}`, {
        method: "DELETE",
        headers: { authorization: cloudJob.apiKey },
      }).catch(() => {});
    }
  }
  return true;
});

// Provider dispatcher: settings["provider"] = "local" (default) | "assemblyai"
ipcMain.handle("transcribe", async (e, audioPath) => {
  if (!fs.existsSync(audioPath)) return { ok: false, error: "File not found: " + audioPath };

  const settings = readSettings();
  // Only offer the local engine if this machine actually has it (dev checkout).
  // Installed cloud-only builds have no bundled Python → fall back to cloud.
  const hasLocalEngine = fs.existsSync(PYTHON);
  if (settings.provider === "local" && hasLocalEngine) {
    return localTranscribe(audioPath, settings);
  }
  if (!hasLocalEngine && settings.provider === "local") {
    // settings came from a dev checkout sharing this userData — auto-heal + inform
    sendLog("Local engine isn't included in this install — using fast cloud mode.\n");
  }
  if (!settings.aaiKey) {
    return { ok: false, error: "No API key yet. Open ⚙ settings and paste your AssemblyAI key." };
  }
  return cloudTranscribe(audioPath, settings);
});

// ---- AssemblyAI cloud engine (fast mode) ----
async function cloudTranscribe(audioPath, settings) {
  cloudJob = { apiKey: settings.aaiKey, id: null, cancelled: false };
  const result = await assemblyAITranscribe({
    audioPath,
    apiKey: settings.aaiKey,
    languageCode: settings.language || "en",
    maxSpeakers: parseInt(settings.maxSpeakers, 10),
    disfluencies: settings.disfluencies !== false, // default ON
    onEvent: (ev) => {
      if (ev.type === "upload-progress") {
        sendLog(`CLOUD upload ${ev.pct.toFixed(1)}\n`);
      } else if (ev.type === "stage") {
        sendLog(`CLOUD stage ${ev.stage}\n`);
      } else if (ev.type === "status") {
        sendLog(`CLOUD status ${ev.status}\n`);
      } else if (ev.type === "log") {
        sendLog(ev.text);
      }
    },
    isCancelled: () => !cloudJob || cloudJob.cancelled,
  });
  cloudJob = null;
  return result;
}

// ---- Local engine (free, offline) ----
async function localTranscribe(audioPath, settings) {
  const env = { ...process.env };
  if (settings.hfToken) {
    env.HF_TOKEN = settings.hfToken;
    env.HUGGING_FACE_HUB_TOKEN = settings.hfToken;
  }
  env.HF_HUB_DISABLE_SYMLINKS_WARNING = "1";

  // stream engine output as events
  const ts = Date.now();
  const args = [ENGINE, audioPath];
  const maxSpk = parseInt(settings.maxSpeakers, 10);
  if (!isNaN(maxSpk) && maxSpk >= 1) args.push("--max-speakers", String(maxSpk));
  engineProc = spawn(PYTHON, args, {
    cwd: PROJECT_ROOT,
    env,
  });

  engineProc.stdout.on("data", (d) => sendLog(d.toString()));
  engineProc.stderr.on("data", (d) => {
    // python warnings arrive on stderr; surface them as log lines too
    sendLog(d.toString());
  });

  const result = await new Promise((resolve) => {
    engineProc.on("close", async (code) => {
      engineProc = null;
      const base = audioPath.replace(/\.[^.]+$/, "");
      const jsonPath = base + ".transcript.json";
      if (code === 0 && fs.existsSync(jsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
          resolve({ ok: true, transcript: data });
        } catch (err) {
          resolve({ ok: false, error: "Could not parse transcript: " + err });
        }
      } else {
        resolve({ ok: false, error: `Engine exited with code ${code}` });
      }
    });
    engineProc.on("error", (err) => resolve({ ok: false, error: String(err) }));
  });

  return { ...result, ts };
}

ipcMain.handle("read-settings", () => readSettings());
ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("read-audio", async (e, audioPath) => {
  if (!fs.existsSync(audioPath)) throw new Error("File not found");
  const stat = fs.statSync(audioPath);
  if (stat.size > 150 * 1024 * 1024) {
    throw new Error("TOO_LARGE"); // renderer falls back to the minimal player
  }
  return fs.promises.readFile(audioPath);
});

ipcMain.handle("check-updates", async () => {
  try {
    return { ok: true, ...(await checkForUpdate(app.getVersion())) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("open-external", (e, url) => {
  // only allow https links out of the pane
  if (typeof url === "string" && url.startsWith("https://")) {
    require("electron").shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.handle("save-settings", (e, obj) => {
  writeSettings(obj);
  return true;
});

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

// The AssemblyAI key is encrypted at rest with the OS keystore (DPAPI on
// Windows) via Electron safeStorage, tagged so we can tell it apart from a
// legacy plaintext key. Everything degrades gracefully: if encryption isn't
// available, or a blob can't be decrypted, we fall back to plaintext rather
// than ever locking the user out of their own key.
const ENC_PREFIX = "enc:v1:";
function encryptKey(plain) {
  try {
    if (plain && safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(String(plain)).toString("base64");
    }
  } catch {}
  return plain || "";
}
function decryptKey(stored) {
  if (typeof stored !== "string" || !stored.startsWith(ENC_PREFIX)) return stored || "";
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return ""; // unreadable (e.g. restored on a different machine) — treat as unset
  }
}

// Read settings with the key decrypted for in-process use and the renderer.
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    if (s && typeof s.aaiKey === "string") s.aaiKey = decryptKey(s.aaiKey);
    return s || {};
  } catch {
    return {};
  }
}

// Single write path — always re-encrypts the key so no caller can accidentally
// persist it in plaintext (window-state saves, history updates, etc.).
function writeSettings(obj) {
  const out = { ...obj };
  if (typeof out.aaiKey === "string") out.aaiKey = encryptKey(out.aaiKey);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
}

// ---- transcript history: one JSON file per transcript + an index in settings ----
const HISTORY_CAP = 50;

function historyDir() {
  return path.join(app.getPath("userData"), "transcripts");
}

ipcMain.handle("save-history", (e, item) => {
  try {
    const dir = historyDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, item.id + ".json"), JSON.stringify(item, null, 2), "utf8");
    const s = readSettings();
    const list = (s.history || []).filter((h) => h.id !== item.id);
    list.unshift({
      id: item.id,
      name: item.name,
      date: item.date,
      duration: item.duration,
      speakers: item.speakers,
      audioPath: item.audioPath,
      hasAudio: !!item.audioPath && fs.existsSync(item.audioPath),
    });
    // drop dead audio references so sidebar badges stay honest
    for (const h of list) h.hasAudio = fs.existsSync(h.audioPath || "");
    s.history = list.slice(0, HISTORY_CAP);
    writeSettings(s);
    return { ok: true, list: s.history };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("load-history", (e, id) => {
  try {
    const p = path.join(historyDir(), path.basename(String(id)) + ".json");
    if (!fs.existsSync(p)) return { ok: false, error: "Not found" };
    return { ok: true, item: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("delete-history", (e, id) => {
  try {
    fs.rmSync(path.join(historyDir(), path.basename(String(id)) + ".json"), { force: true });
    const s = readSettings();
    s.history = (s.history || []).filter((h) => h.id !== id);
    writeSettings(s);
    return { ok: true, list: s.history };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// --- transcript export formatters (the saved file must match its extension) ---
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (s) => `${pad2(Math.floor(s / 60))}:${pad2(Math.round(s % 60))}`;
const srtClock = (s) => {
  const ms = Math.round(s * 1000);
  return `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor((ms % 3600000) / 60000))}:${pad2(Math.floor((ms % 60000) / 1000))},${String(ms % 1000).padStart(3, "0")}`;
};
function buildMarkdown(title, duration, speakers, segments) {
  const lines = [`# Transcript: ${title}`, `# Duration: ${clock(duration || 0)} · Speakers: ${speakers || 0}`, ""];
  let last = null;
  for (const seg of segments) {
    if (seg.speaker !== last) lines.push("");
    lines.push(`${seg.speaker} [${clock(seg.start)}]: ${seg.text}`);
    last = seg.speaker;
  }
  return lines.join("\n");
}
function buildText(title, duration, speakers, segments) {
  // same body as markdown but without the "#"/Markdown flavouring
  const lines = [`Transcript: ${title}`, `Duration: ${clock(duration || 0)} · Speakers: ${speakers || 0}`, ""];
  let last = null;
  for (const seg of segments) {
    if (seg.speaker !== last) lines.push("");
    lines.push(`${seg.speaker} [${clock(seg.start)}]: ${seg.text}`);
    last = seg.speaker;
  }
  return lines.join("\n");
}
function buildSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${srtClock(seg.start)} --> ${srtClock(seg.end)}\n${seg.speaker}: ${seg.text}\n`)
    .join("\n");
}

ipcMain.handle("export-transcript", async (e, { segments, title, duration, speakers, markdown, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Save transcript",
    defaultPath: defaultName || "transcript.md",
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Text", extensions: ["txt"] },
      { name: "Subtitles", extensions: ["srt"] },
    ],
  });
  if (res.canceled || !res.filePath) return null;
  const segs = Array.isArray(segments) ? segments : null;
  const ext = path.extname(res.filePath).toLowerCase();
  let content;
  if (segs && ext === ".srt") content = buildSrt(segs);
  else if (segs && ext === ".txt") content = buildText(title, duration, speakers, segs);
  else if (segs) content = buildMarkdown(title, duration, speakers, segs);
  else content = markdown || ""; // fallback: pre-built string (older callers)
  fs.writeFileSync(res.filePath, content, "utf8");
  return res.filePath;
});

// Word document export — Word Transcribe-style plain lines:
// "0:00 0:22 speaker001 They moved to New York."
const mmss = (s) => {
  const m = Math.floor(s / 60), x = Math.round(s % 60);
  return `${m}:${String(x).padStart(2, "0")}`;
};

ipcMain.handle("export-transcript-docx", async (e, { title, subtitle, segments, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Save transcript as Word document",
    defaultPath: defaultName || "transcript.docx",
    filters: [{ name: "Word document", extensions: ["docx"] }],
  });
  if (res.canceled || !res.filePath) return null;
  try {
    const { Document, Packer, Paragraph, TextRun } = require("docx");
    const mono = (text, extra = {}) =>
      new TextRun({ text, font: "Consolas", size: 20, ...extra }); // 10pt Consolas, example-format look
    const children = [
      new Paragraph({ children: [mono(title || "Transcript", { bold: true, size: 24 })], spacing: { after: 80 } }),
      new Paragraph({ children: [mono(subtitle || "", { color: "666666" })], spacing: { after: 200 } }),
    ];
    for (const seg of segments || []) {
      const num = String((seg.speaker.match(/\d+/) || ["1"])[0]).padStart(3, "0");
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [
            mono(`${mmss(seg.start)} ${mmss(seg.end)} speaker${num} `),
            mono(seg.text),
          ],
        })
      );
    }
    const doc = new Document({ sections: [{ children }] });
    fs.writeFileSync(res.filePath, await Packer.toBuffer(doc));
    return res.filePath;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});
