// Transcriber pane logic
const el = (id) => document.getElementById(id);
let currentFile = null;
let currentTranscript = null;
let engineRunning = false;

// --- first-run init: settings sync + welcome card ---
(async () => {
  const s = await window.api.readSettings();
  if (s.provider) el("engine-select").value = s.provider;
  if (s.aaiKey) el("aai-key").value = s.aaiKey;
  if (s.hfToken) el("hf-token").value = s.hfToken;
  if (s.maxSpeakers) el("max-speakers").value = s.maxSpeakers;
  el("disfluencies").checked = s.disfluencies !== false;
  if (!s.aaiKey && !s.welcomed) el("welcome").classList.remove("hidden");
})();

el("welcome-getkey").addEventListener("click", () => {
  window.api.openExternal("https://www.assemblyai.com/dashboard/api-keys");
});
el("welcome-save").addEventListener("click", async () => {
  const key = el("welcome-key").value.trim();
  const s = await window.api.readSettings();
  await window.api.saveSettings({
    ...s,
    aaiKey: key || s.aaiKey || "",
    provider: key ? "assemblyai" : s.provider,
    welcomed: true,
  });
  el("aai-key").value = key || s.aaiKey || "";
  el("welcome").classList.add("hidden");
});
el("welcome-skip").addEventListener("click", async (e) => {
  e.preventDefault();
  const s = await window.api.readSettings();
  await window.api.saveSettings({ ...s, welcomed: true });
  el("welcome").classList.add("hidden");
});

// --- settings UI ---
el("settings-btn").addEventListener("click", async () => {
  const panel = el("settings-panel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    const s = await window.api.readSettings();
    if (s.provider) el("engine-select").value = s.provider;
    if (s.aaiKey) el("aai-key").value = s.aaiKey;
    if (s.hfToken) el("hf-token").value = s.hfToken;
    if (s.maxSpeakers) el("max-speakers").value = s.maxSpeakers;
  }
});
const aaiLink = el("aai-link");
if (aaiLink) aaiLink.addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://www.assemblyai.com/dashboard/api-keys");
});
el("save-settings").addEventListener("click", async () => {
  await window.api.saveSettings({
    provider: el("engine-select").value,
    aaiKey: el("aai-key").value.trim(),
    hfToken: el("hf-token").value.trim(),
    maxSpeakers: el("max-speakers").value,
    disfluencies: el("disfluencies").checked,
    welcomed: true,
  });
  el("settings-panel").classList.add("hidden");
});

// --- update check (GitHub releases) ---
let currentUpdateVersion = null;

async function runUpdateCheck(auto) {
  const s = await window.api.readSettings();
  await window.api.saveSettings({ ...s, lastUpdateCheck: Date.now() });
  const r = await window.api.checkUpdates();
  if (!r.ok) {
    if (!auto) el("update-note").textContent = "Couldn't check for updates (" + r.error + ")";
    return;
  }
  if (!r.available) {
    if (!auto) el("update-note").textContent = "You're on the latest version.";
    return;
  }
  if (r.version === s.skippedVersion) return; // user already skipped this one
  showUpdateBanner(r);
}

function showUpdateBanner(r) {
  currentUpdateVersion = r.version;
  el("update-title").textContent = `🔔 Update available — v${r.version}`;
  const list = el("update-notes");
  list.innerHTML = "";
  for (const n of (r.notes || []).slice(0, 5)) {
    const li = document.createElement("li");
    li.textContent = n;
    list.appendChild(li);
  }
  el("update-hint").classList.add("hidden");
  el("update-banner").classList.remove("hidden");
}

el("update-btn").addEventListener("click", () => {
  if (!currentUpdateVersion) return;
  const r = { version: currentUpdateVersion };
  window.api.checkUpdates().then((res) => {
    const url = res.ok && res.url ? res.url : res.releaseUrl;
    if (url) window.api.openExternal(url);
  });
  el("update-hint").textContent =
    "Installer is downloading in your browser — close Transcribe, then run it to update.";
  el("update-hint").classList.remove("hidden");
});

el("update-skip").addEventListener("click", async () => {
  el("update-banner").classList.add("hidden");
  const s = await window.api.readSettings();
  await window.api.saveSettings({ ...s, skippedVersion: currentUpdateVersion });
});

el("check-updates-btn").addEventListener("click", () => {
  el("update-note").textContent = "Checking…";
  runUpdateCheck(false);
});

// auto-check at most once per 24h, silently
(async () => {
  const s = await window.api.readSettings();
  if (Date.now() - (s.lastUpdateCheck || 0) > 24 * 3600 * 1000) runUpdateCheck(true);
})();

// --- upload flow ---
el("upload-btn").addEventListener("click", async () => {
  const p = await window.api.pickAudio();
  if (!p) return;
  currentFile = p;
  el("file-name").textContent = p.split(/[\\/]/).pop();
  el("file-row").classList.remove("hidden");
  el("transcript").classList.add("hidden");
  setupPlayer();
  updateCostEstimate();
});

// --- cloud cost estimate ("~1.5 hours ≈ $0.35") ---
async function updateCostEstimate() {
  const note = el("engine-note");
  if (!currentFile) { note.classList.add("hidden"); return; }
  const s = await window.api.readSettings();
  if (s.provider === "local") { note.classList.add("hidden"); return; }
  note.textContent = "Reading audio length…";
  note.classList.remove("hidden");
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = "file:///" + encodeURI(currentFile.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/%3F/g, "?");
  audio.addEventListener("loadedmetadata", () => {
    const hrs = audio.duration / 3600;
    const cost = (hrs * 0.23).toFixed(2);
    const mins = Math.round(audio.duration / 60);
    note.textContent = `☁ Fast cloud mode: ${mins} min of audio · ≈ $${cost} · plan says ~185 h of credit first`;
  });
  audio.addEventListener("error", () => {
    note.textContent = "☁ Fast cloud mode · ≈ $0.23 per audio-hour";
  });
}

// --- Drive-style audio player (real Web Audio waveform, zero deps) ---
const SPD = window.devicePixelRatio || 1;
let audioEl = null;
let wavePeaks = null;
let waveMode = null; // "wave" | "bar"

function fileUrl(p) {
  return "file:///" + encodeURI(p.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/%3F/g, "?");
}

async function setupPlayer() {
  stopPlayback();
  el("player").classList.remove("hidden");
  el("play-btn").textContent = "▶";
  el("player-time").textContent = "0:00 / 0:00";
  wavePeaks = null;
  waveMode = null;
  el("wave-canvas").classList.remove("hidden");
  el("wave-canvas").classList.add("wave-loading");
  el("wave-fallback").classList.add("hidden");
  drawWave();

  audioEl = new Audio();
  audioEl.src = fileUrl(currentFile);
  audioEl.addEventListener("ended", () => { el("play-btn").textContent = "▶"; drawWave(); });
  audioEl.addEventListener("timeupdate", () => { updateTime(); highlightSegment(); if (audioEl.paused) drawWave(); });

  // Build the waveform from real decoded audio. Long files skip the waveform
  // and get the minimal progress bar instead (decode would eat RAM).
  try {
    const u8 = await window.api.readAudio(currentFile);
    const oc = new OfflineAudioContext(1, 1, 22050);
    const ab = await oc.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    const ch = ab.getChannelData(0);
    const BARS = 400, step = Math.floor(ch.length / BARS) || 1;
    wavePeaks = new Array(BARS);
    for (let i = 0; i < BARS; i++) {
      let m = 0;
      for (let j = i * step, e = Math.min(j + step, ch.length); j < e; j += 8) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
      wavePeaks[i] = m;
    }
    waveMode = "wave";
    el("wave-canvas").classList.remove("wave-loading");
    drawWave();
  } catch {
    waveMode = "bar";
    el("wave-canvas").classList.add("hidden");
    el("wave-fallback").classList.remove("hidden");
  }
  updateTime();
}

function togglePlay() {
  if (!audioEl) return;
  if (audioEl.paused) {
    audioEl.play();
    el("play-btn").textContent = "❚❚";
    tickWave();
  } else {
    audioEl.pause();
    el("play-btn").textContent = "▶";
  }
}
el("play-btn").addEventListener("click", togglePlay);

function tickWave() {
  if (!audioEl || audioEl.paused) return;
  drawWave();
  updateTime();
  requestAnimationFrame(tickWave);
}

function drawWave() {
  const c = el("wave-canvas");
  const wrap = c.parentElement;
  const w = Math.max(60, Math.floor(wrap.clientWidth * SPD));
  if (c.width !== w) c.width = w;
  c.height = Math.floor(56 * SPD);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!wavePeaks) { // loading state: thin placeholder line
    ctx.fillStyle = "#5f6368";
    ctx.fillRect(0, c.height / 2 - SPD, c.width, 2 * SPD);
    return;
  }
  const dur = audioEl ? (audioEl.duration || 0) : 0;
  const prog = dur ? audioEl.currentTime / dur : 0;
  const bw = 3 * SPD, gap = 2 * SPD;
  const n = Math.floor((c.width + gap) / (bw + gap));
  const mid = c.height / 2;
  for (let i = 0; i < n; i++) {
    const p = wavePeaks[Math.floor((i / n) * wavePeaks.length)] || 0;
    const bh = Math.max(2 * SPD, p * (c.height * 0.92));
    ctx.fillStyle = (i / n) <= prog ? "#8ab4f8" : "#5f6368";
    ctx.fillRect(i * (bw + gap), mid - bh / 2, bw, bh);
  }
  // playback cursor
  ctx.fillStyle = "#4a9fe8";
  ctx.fillRect(Math.min(c.width - 2 * SPD, prog * c.width), 0, 2 * SPD, c.height);
}

el("wave-canvas").addEventListener("click", (e) => {
  if (!audioEl || !isFinite(audioEl.duration)) return;
  const r = e.currentTarget.getBoundingClientRect();
  seekTo(((e.clientX - r.left) / r.width) * (audioEl.duration || 0));
});

window.addEventListener("resize", () => drawWave());

function seekTo(sec) {
  if (!audioEl || !isFinite(audioEl.duration)) return;
  audioEl.currentTime = Math.max(0, Math.min(sec, audioEl.duration - 0.05));
  updateTime();
  highlightSegment();
  drawWave();
}

function stopPlayback() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
  wavePeaks = null;
}

function updateTime() {
  if (!audioEl) return;
  const d = audioEl.duration || 0, t = audioEl.currentTime || 0;
  el("player-time").textContent = `${mmssFmt(t)} / ${mmssFmt(d)}`;
  if (waveMode === "bar") el("wave-bar").style.width = (d ? (t / d) * 100 : 0) + "%";
}

const mmssFmt = (s) => {
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};

function highlightSegment() {
  if (!audioEl || !currentTranscript) return;
  const t = audioEl.currentTime || 0;
  let active = -1;
  (currentTranscript.segments || []).forEach((seg, i) => {
    if (t >= seg.start && t < seg.end) active = i;
  });
  const segs = el("segments").children;
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle("playing", i === active);
}

// --- transcribe flow ---
el("start-btn").addEventListener("click", async () => {
  if (!currentFile || engineRunning) return;
  beginRun("Uploading & preparing audio…");
  const res = await window.api.transcribe(currentFile);
  if (res.ok) {
    currentTranscript = res.transcript;
    renderTranscript(res.transcript);
  } else {
    fail(res.error || "Unknown error");
  }
});

el("cancel-btn").addEventListener("click", async () => {
  await window.api.cancel();
  endRun();
  el("status-text").textContent = "Cancelled.";
});

// stream engine logs
window.api.onEngineLog((text) => {
  const log = el("log");
  log.classList.add("shown");
  log.style.display = "block";
  log.textContent += text;
  log.scrollTop = log.scrollHeight;

  for (const line of text.split(/\r?\n/)) {
    // cloud engine events (AssemblyAI fast mode)
    if (line.startsWith("CLOUD ")) { handleCloudLine(line.slice(6)); continue; }
    // engine reports real transcription progress as "PROGRESS <pct>"
    if (line.startsWith("PROGRESS ")) {
      const pct = parseFloat(line.slice(9));
      if (!isNaN(pct)) setDeterminate(10 + Math.min(50, pct / 1.8)); // stage 2 maps 0-100% → bar 10-60
      continue;
    }
    if (line.includes("[1/3]")) { setStatus("Loading engine…"); setIndeterminate(); }
    if (line.includes("[2/3]")) { setStatus("Transcribing audio…"); }
    if (line.includes("[3/3]")) { setStatus("Identifying speakers…"); setIndeterminate(); }
  }
});

// --- progress helpers (Fluent-style) ---
// indeterminate = the Word-like moving sweep line; determinate = real % fill
const progressWrap = () => el("progress-wrap");

function setIndeterminate() {
  progressWrap().classList.add("indeterminate");
  progressWrap().classList.remove("invisible");
}

function setDeterminate(pct) {
  progressWrap().classList.remove("indeterminate");
  progressWrap().classList.remove("invisible");
  barPct = pct;
  el("bar").style.width = Math.min(100, Math.max(0, pct)) + "%";
}

// Diarization has no internal progress signal → show the sweeping line
// (replaces the previous creeping-percentage approach: matches Word's pane)
function startCrawl(from, to) { setIndeterminate(); }

// AssemblyAI cloud stages — mirrors Word's "Uploading → Transcribing → Fetching"
function handleCloudLine(rest) {
  const sp = rest.indexOf(" ");
  const kind = sp < 0 ? rest : rest.slice(0, sp);
  const arg = sp < 0 ? "" : rest.slice(sp + 1);
  if (kind === "stage") {
    if (arg === "upload") { setStatus("Uploading audio…"); setDeterminate(2); }
    if (arg === "transcribing") { setStatus("Transcribing audio…"); setIndeterminate(); }
    if (arg === "fetching") { setStatus("Fetching transcript…"); setIndeterminate(); }
  } else if (kind === "upload") {
    const pct = parseFloat(arg);
    if (!isNaN(pct)) setDeterminate(2 + Math.min(100, pct) / 100 * 38); // upload 0-100% → bar 2-40
  } else if (kind === "status") {
    if (arg === "queued") setStatus("Queued at AssemblyAI…");
    if (arg === "processing") setStatus("Transcribing audio…");
  }
}

function stopCrawl() {
  /* kept for compatibility with earlier call sites */
}

function getStatusText() { return el("status-text").textContent; }

function beginRun(message) {
  engineRunning = true;
  el("log").textContent = "";
  el("log").style.display = "none";
  el("status").classList.remove("hidden");
  el("status-text").textContent = message;
  setIndeterminate();          // Word-style sweep starts immediately
  el("cancel-btn").classList.remove("hidden");
  el("start-btn").disabled = true;
  el("upload-btn").disabled = true;
}

function endRun() {
  engineRunning = false;
  el("cancel-btn").classList.add("hidden");
  el("start-btn").disabled = false;
  el("upload-btn").disabled = false;
}

function fail(msg) {
  endRun();
  el("status-text").textContent = "Failed: " + msg;
}

// --- transcript rendering (Word-style speakers + timestamps) ---
function renderTranscript(t) {
  endRun();
  setDeterminate(100);               // flash completion
  setTimeout(() => setDeterminate(0), 1200); // then reset for next run
  el("status").classList.add("hidden");
  const box = el("transcript");
  box.classList.remove("hidden");
  const mmss = (s) => {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  el("meta").textContent =
    `${t.file || el("file-name").textContent} · ${mmss(t.duration_s || 0)} · ${t.speakers} speaker(s)`;
  const segs = el("segments");
  segs.innerHTML = "";
  const palette = ["#0f6cbd", "#8767d3", "#0e7a4d", "#c25e00", "#c23b3b", "#5b6bd3"];
  for (const seg of t.segments || []) {
    const div = document.createElement("div");
    div.className = "segment";
    const num = String((seg.speaker.match(/\d+/) || ["1"])[0]);
    const color = palette[(parseInt(num, 10) - 1 + palette.length) % palette.length];
    div.innerHTML =
      `<span class="seg-chip" style="background:${color}">${num}</span>` +
      `<span class="seg-speaker" style="color:${color}">${seg.speaker}</span>` +
      `<span class="seg-time">${mmss(seg.start)}</span>` +
      `<span class="seg-text"></span>` +
      `<span class="seg-actions"><button title="Copy text">＋</button></span>`;
    div.querySelector(".seg-text").textContent = seg.text;
    // click anywhere on the segment → seek the player there (Word-like)
    div.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") return;
      seekTo(seg.start);
    });
    div.querySelector("button").addEventListener("click", () => {
      navigator.clipboard.writeText(seg.text);
      div.querySelector("button").textContent = "✔";
      setTimeout(() => (div.querySelector("button").textContent = "＋"), 1200);
    });
    segs.appendChild(div);
  }
}

// --- export flow ---
el("export-btn").addEventListener("click", async () => {
  if (!currentTranscript) return;
  const t = currentTranscript;
  const lines = [
    `# Transcript: ${t.file}`,
    `# Duration: ${Math.round(t.duration_s)}s · Speakers: ${t.speakers}`,
    "",
  ];
  let last = null;
  const mmss = (s) => {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  for (const seg of t.segments) {
    if (seg.speaker !== last) lines.push("");
    lines.push(`${seg.speaker} [${mmss(seg.start)}]: ${seg.text}`);
    last = seg.speaker;
  }
  const out = await window.api.export({
    markdown: lines.join("\n"),
    defaultName: t.file.replace(/\.[^.]+$/, "") + ".transcript.md",
  });
  if (out) alert("Saved to " + out);
});
