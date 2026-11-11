// Transcriber App — main process (Electron)
// Spawns the Phase 1 python engine and pipes progress to the renderer.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
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

  // persist size & position when the window is being closed
  const saveState = () => {
    try {
      if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
        const b = mainWindow.getBounds();
        const s = readSettings();
        s.windowState = { width: b.width, height: b.height, x: b.x, y: b.y };
        fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
      }
    } catch {}
  };
  mainWindow.on("close", saveState);
}

app.whenReady().then(() => {
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
    mainWindow.webContents.send(
      "engine-log",
      "Local engine isn't included in this install — using fast cloud mode.\n"
    );
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
        mainWindow.webContents.send("engine-log", `CLOUD upload ${ev.pct.toFixed(1)}\n`);
      } else if (ev.type === "stage") {
        mainWindow.webContents.send("engine-log", `CLOUD stage ${ev.stage}\n`);
      } else if (ev.type === "status") {
        mainWindow.webContents.send("engine-log", `CLOUD status ${ev.status}\n`);
      } else if (ev.type === "log") {
        mainWindow.webContents.send("engine-log", ev.text);
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

  engineProc.stdout.on("data", (d) => {
    mainWindow.webContents.send("engine-log", d.toString());
  });
  engineProc.stderr.on("data", (d) => {
    // python warnings arrive on stderr; surface them as log lines too
    mainWindow.webContents.send("engine-log", d.toString());
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
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return true;
});

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
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
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
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
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
    return { ok: true, list: s.history };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("export-transcript", async (e, { markdown, defaultName }) => {
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
  fs.writeFileSync(res.filePath, markdown, "utf8");
  return res.filePath;
});
