// AssemblyAI cloud transcription provider.
// Flow mirrors Microsoft Word's Transcribe status: Uploading → Transcribing → Fetching.
//
// Exported for main.js (Electron IPC) AND a CLI test harness at the bottom.
//
// Events emitted via onEvent(type, payload):
//   { type: "stage",  stage: "upload" | "transcribing" | "fetching" }
//   { type: "upload-progress", pct: 0..100 }
//   { type: "status",  status: "queued" | "processing" | ... }
//   { type: "log",     text }
const https = require("https");
const fs = require("fs");
const path = require("path");

const AAI = "https://api.assemblyai.com";
const UPLOADED_CHUNK = 1 << 20; // 1 MiB
const POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// 1. Streaming upload with real byte progress (fetch can't report upload %)
// ---------------------------------------------------------------------------
function aaiUpload(filePath, apiKey, onFraction) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const req = https.request(
      {
        hostname: "api.assemblyai.com",
        path: "/v2/upload",
        method: "POST",
        headers: {
          authorization: apiKey,
          "content-type": "application/octet-stream",
          "content-length": stat.size,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data).upload_url);
            } catch {
              reject(new Error("Unexpected upload response: " + data));
            }
          } else if (res.statusCode === 401) {
            reject(new Error("API key rejected (401) — check the AssemblyAI key in settings."));
          } else {
            reject(new Error(`Upload failed (HTTP ${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    let sent = 0;
    fs.createReadStream(filePath, { highWaterMark: UPLOADED_CHUNK })
      .on("data", (chunk) => {
        sent += chunk.length;
        if (typeof onFraction === "function") onFraction(sent / stat.size);
      })
      .pipe(req);
  });
}

// ---------------------------------------------------------------------------
// 2. Create + poll the job
// ---------------------------------------------------------------------------
async function aaiCreateTranscript(apiKey, uploadUrl, languageCode, speakersExpected) {
  const body = {
    audio_url: uploadUrl,
    speaker_labels: true, // diarization — maps to our Word-style segments
    language_code: languageCode || "en",
    speech_models: ["universal-3-5-pro"], // flagship; explicit (API param is plural array)
  };
  // Only pass a speaker count when the user set one explicitly (Word asks the
  // same question); "auto" lets AssemblyAI cluster freely.
  const n = parseInt(speakersExpected, 10);
  if (!isNaN(n) && n >= 1) body.speakers_expected = n;
  const res = await fetch(`${AAI}/v2/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Cloud request failed: ${data.error || `HTTP ${res.status}`}`);
  }
  return data; // { id, status: "queued", ... }
}

async function aaiPollTranscript(apiKey, id, onStatus, isCancelled) {
  for (;;) {
    if (isCancelled && isCancelled()) throw new CANCELLED();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (isCancelled && isCancelled()) throw new CANCELLED();
    const res = await fetch(`${AAI}/v2/transcript/${id}`, {
      headers: { authorization: apiKey },
    });
    const t = await res.json();
    if (t.error) throw new Error(`Cloud transcription error: ${t.error}`);
    if (typeof onStatus === "function") onStatus(t.status);
    if (t.status === "completed") return t;
    if (t.status === "error") {
      throw new Error(`Cloud transcription failed: ${t.error || "unknown error"}`);
    }
  }
}

function CANCELLED() {
  this.message = "cancelled";
}
CANCELLED.prototype = Object.create(Error.prototype);

// ---------------------------------------------------------------------------
// 3. Map AssemblyAI result → our Word-format contract
// ---------------------------------------------------------------------------
// AssemblyAI: { speaker: "A", start: ms, end: ms, text }  (utterances[])
// Ours:       { speaker: "Speaker N", start: s, end: s, text }
function mapAssemblyAI(t, fileName) {
  const utterances = t.utterances || [];
  const order = [...new Set(utterances.map((u) => u.speaker))].sort();
  const segments = utterances.map((u) => ({
    speaker: `Speaker ${order.indexOf(u.speaker) + 1}`,
    start: u.start / 1000,
    end: u.end / 1000,
    text: (u.text || "").trim(),
  }));
  return {
    file: fileName,
    duration_s: Math.round((t.audio_duration || 0) * 10) / 10,
    speakers: order.length,
    segments,
  };
}

// ---------------------------------------------------------------------------
// 4. Write the same three output files the local engine produces
// ---------------------------------------------------------------------------
const pad = (n, w) => String(n).padStart(w, "0");
function mmss(s) {
  const m = Math.floor(s / 60), x = Math.round(s % 60);
  return `${pad(m, 2)}:${pad(x, 2)}`;
}
function srtTime(s) {
  const ms = Math.round(s * 1000);
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor((ms % 3600000) / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)},${pad(ms % 1000, 3)}`;
}

function writeOutputs(audioPath, t) {
  const base = audioPath.replace(/\.[^.]+$/, "");
  const lines = [
    `# Transcript: ${path.basename(audioPath)}`,
    `# Length: ${mmss(t.duration_s)} | Speakers: ${t.speakers}`,
    "",
  ];
  let prev = null;
  for (const seg of t.segments) {
    lines.push(prev === seg.speaker ? callerLine(seg) : headerLine(seg));
    prev = seg.speaker;
  }
  fs.writeFileSync(base + ".transcript.txt", lines.join("\n"), "utf8");

  let srt = "";
  t.segments.forEach((seg, i) => {
    srt += `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.speaker}: ${seg.text}\n\n`;
  });
  fs.writeFileSync(base + ".srt", srt, "utf8");

  fs.writeFileSync(
    base + ".transcript.json",
    JSON.stringify({ file: t.file, duration_s: t.duration_s, speakers: t.speakers, segments: t.segments }, null, 2),
    "utf8"
  );
  return [base + ".transcript.txt", base + ".srt", base + ".transcript.json"];
}
const headerLine = (seg) => `${seg.speaker} [${mmss(seg.start)}]: ${seg.text}`;
const callerLine = (seg) => `[${mmss(seg.start)}] ${seg.text}`;

// ---------------------------------------------------------------------------
// 5. Orchestration (upload → transcribe → fetch)
// ---------------------------------------------------------------------------
// opts: { audioPath, apiKey, maxSpeakers?, languageCode?, onEvent?, isCancelled?, writeFiles? }
async function assemblyAITranscribe(opts) {
  const onEvent = opts.onEvent || (() => {});
  const isCancelled = opts.isCancelled || (() => false);
  const emitStage = (stage) => onEvent({ type: "stage", stage });

  try {
    // Upload
    emitStage("upload");
    onEvent({ type: "log", text: "Uploading audio to AssemblyAI...\n" });
    const uploadUrl = await aaiUpload(opts.audioPath, opts.apiKey, (frac) =>
      onEvent({ type: "upload-progress", pct: frac * 100 })
    );
    onEvent({ type: "log", text: "Upload complete.\n" });
    if (isCancelled()) return { ok: false, error: "cancelled" };

    // Transcribe
    emitStage("transcribing");
    const job = await aaiCreateTranscript(opts.apiKey, uploadUrl, opts.languageCode, opts.maxSpeakers);
    onEvent({ type: "log", text: `Job ${job.id} (${job.status}).\n` });
    onEvent({ type: "status", status: job.status });
    const final = await aaiPollTranscript(
      opts.apiKey,
      job.id,
      (s) => onEvent({ type: "status", status: s }),
      isCancelled
    );

    // Fetching
    emitStage("fetching");
    onEvent({ type: "log", text: "Fetching transcript...\n" });
    const transcript = mapAssemblyAI(final, path.basename(opts.audioPath));

    const files = opts.writeFiles === false ? [] : writeOutputs(opts.audioPath, transcript);
    onEvent({ type: "log", text: `Done: ${transcript.segments.length} segments, ${transcript.speakers} speaker(s).\n` });
    return { ok: true, transcript, files };
  } catch (err) {
    if (err instanceof CANCELLED) return { ok: false, error: "cancelled" };
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { assemblyAITranscribe, mapAssemblyAI, mmss, srtTime, writeOutputs, aaiUpload, aaiCreateTranscript, AAI };

// ---------------------------------------------------------------------------
// CLI test harness: node cloud.js <audioFile> <apiKey>
// ---------------------------------------------------------------------------
if (require.main === module) {
  const [, , audioFile, apiKey] = process.argv;
  if (!audioFile || !apiKey) {
    console.error("usage: node cloud.js <audioFile> <apiKey>");
    process.exit(1);
  }
  assemblyAITranscribe({
    audioPath: path.resolve(audioFile),
    apiKey,
    languageCode: "en",
    onEvent: (ev) => {
      if (ev.type === "stage") console.log(`[stage] ${ev.stage}`);
      if (ev.type === "upload-progress") console.log(`  upload ${ev.pct.toFixed(1)}%`);
      if (ev.type === "status") console.log(`  job ${ev.status}`);
      if (ev.type === "log") process.stdout.write(`  ${ev.text}`);
    },
  }).then((r) => {
    if (r.ok) {
      console.log("\n--- Preview ---");
      for (const seg of r.transcript.segments.slice(0, 6)) console.log(`${seg.speaker} [${mmss(seg.start)}]: ${seg.text}`);
      process.exit(0);
    }
    console.error("FAILED: " + r.error);
    process.exit(1);
  });
}
