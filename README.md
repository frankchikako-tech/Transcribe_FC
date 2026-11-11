<h1 align="center">Transcribe</h1>

<p align="center">
  Turn any audio file into a <b>speaker-labeled, timestamped transcript</b> —<br/>
  a simple Windows desktop app, modeled after Microsoft Word's "Transcribe" pane.
</p>

<p align="center">
  <a href="https://github.com/frankchikako-tech/Transcribe_FC/releases/latest/download/Transcribe-Setup-1.0.4.exe">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download%20for%20Windows-1.0.4-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"/>
  </a>
</p>

<p align="center">
  <sub>Windows 10 / 11 · 84 MB · free app (cloud transcription billed by AssemblyAI, ~$0.23/hr)</sub>
</p>

---

## Install in 4 steps

1. Click **⬇ Download for Windows** above and run **`Transcribe-Setup-1.0.4.exe`**.
   *(Windows may say "unknown publisher" — click **More info → Run anyway**. That's normal for a new, unsigned app.)*
2. It installs and drops a **Transcribe** icon on your desktop.
3. Open it → click **⚙ settings** → paste a free **AssemblyAI API key**
   ([get one here](https://www.assemblyai.com/dashboard/api-keys)) → **Save**.
4. Click **Upload audio**, pick a file, then **Transcribe file**. Done.

Supported audio: `wav`, `mp3`, `m4a`, `mp4`, `flac`, `ogg`.

## What it does

- 🎙️ **Speaker labels** — automatically tells who said what (Speaker 1, Speaker 2…)
- ⏱️ **Timestamps** on every segment
- 💬 **Filler words kept** — "um", "uh" and friends stay in the transcript (toggle in settings)
- ☁️ **Fast cloud engine** (AssemblyAI, GPU-powered) with a live cost estimate before you run
- 📄 **Export** your transcript to text / Markdown / subtitles
- 🔔 **In-app updates** — the app checks for new releases and shows what's new (once a day, quietly)
- 🎛️ **Built-in audio player** — a Drive-style waveform player with click-to-seek; click any transcript line to jump to that moment

> Your audio is uploaded to AssemblyAI for transcription, then the result comes back into the
> app. Your API key is stored only in this app's local data on your PC.

A fully **local / offline** engine (faster-whisper + pyannote — no cloud, no account) also
lives in this repo and is planned as a future "offline edition".

## Build from source

```powershell
cd app
npm install
npm run dist     # builds app/dist/Transcribe-Setup-<version>.exe
npm start        # run in dev mode
```
