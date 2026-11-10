# Transcribe

A simple Windows desktop app that turns an audio file into a **speaker-labeled, timestamped transcript** — modeled after Microsoft Word's "Transcribe" pane.

## Download & install

1. Go to the [**Releases**](../../releases) page.
2. Download **`Transcribe Setup 1.0.0.exe`**.
3. Double-click it. It installs and puts a **Transcribe** icon on your desktop.
4. Open the app, click **⚙ settings**, paste a free **AssemblyAI API key**
   (get one at [assemblyai.com](https://www.assemblyai.com/dashboard/api-keys)), and **Save**.
5. Click **Upload audio**, pick a file, then **Transcribe file**.

Supported audio: `wav, mp3, m4a, mp4, flac, ogg`.

## How it works

This edition uses **AssemblyAI cloud** transcription (fast, GPU-powered, automatic speaker
labels, ~$0.23 per audio-hour). Audio is uploaded to AssemblyAI for processing and the
transcript comes back into the app, where you can view, copy, and export it.

A fully local/offline engine (faster-whisper + pyannote, no cloud, no account) also exists
in this repo and is planned as a future "offline edition".

## Build from source

```powershell
cd app
npm install
npm run dist        # produces app/dist/Transcribe Setup <version>.exe
npm start           # run in dev mode
```
