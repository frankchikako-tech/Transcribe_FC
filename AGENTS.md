# Transcriber — Project Context

> Audio transcription app for Windows, modeled after Microsoft Word's "Transcribe" pane
> (upload/record audio → diarized, timestamped, speaker-labeled transcript → exports).
>
> **Engine: 100% free & local** — no accounts, no cloud calls, audio never leaves this machine.
> Azure fast transcription is planned later only as an optional quality/speed toggle for long files.

---

## 1. Goal & story

- Build a desktop app like Word's Transcribe: language picker (en-US first), "Upload audio",
  "Start recording", progress, per-speaker transcript segments with timestamps.
- We previously reverse-engineered the local Word install (Phase 0) and extracted its exact
  architecture & data model (see `C:\Users\LENOVO THINKPAD L490\AppData\Local\Temp\opencode\phase0\PHASE0-FINDINGS.md`).
- Owner decision: **local-first engine** (faster-whisper + pyannote), Azure optional later.
- English-first, model size "small" as default (CPU-friendly), long files (1–3h) expected.
- Hardware reality: i3-8130U (2c/4t), 8GB RAM → transcription ~0.8–0.85x real-time;
  diarization heavier on CPU (~1–2x audio duration). Progress + cancel/resume matters later.

## 2. Repository / folder layout

```
C:\Users\LENOVO THINKPAD L490\transcriber\
├── AGENTS.md               ← this file
├── transcriber.py          ← Phase 1 engine: CLI transcriber (the core pipeline)
├── make_sample.py          ← test-audio generator: merges tmp/turn*.mp3 into sample_meeting.wav
├── sample_meeting.wav      ← 94s mock meeting (2 speakers: male Brian/Andrew + female Ava via edge-tts)
├── tmp\turn01–08.mp3       ← per-turn TTS sources used to build the test WAV
├── phase1_run*.log         ← logs of each pipeline attempt (documented fixes below)
├── cloud_test_run1.log / diag_speakers.log / control_speakers.log  ← AssemblyAI test evidence
├── tools\render-icon.js    ← icon rasterizer: assets SVG → PNGs + multi-size .ico (run: npx electron tools/render-icon.js from app\)
├── app\assets\             ← app icon source (icon.svg) + rendered icon-16/32/48/256.png + icon.ico
└── venv\                   ← isolated Python 3.12 venv with the whole engine stack (~4GB)
```

Outputs produced by `transcriber.py` per input file (written next to the input):
`<name>.transcript.txt` (speaker + [mm:ss] lines), `.srt` (timed subtitles), .transcript.json
(`{speaker, start, end, text}` — same segment model Word's Transcribe uses).

## 3. How to run (Phase 1, CLI)

```powershell
Set-Location "C:\Users\LENOVO THINKPAD L490\transcriber"
.\venv\Scripts\python.exe transcriber.py <audio_file> [--model small] [--min-speakers 2] [--max-speakers 2]
```

Env vars needed (already handled when launched like above):

```powershell
$env:HF_TOKEN = "<YOUR_HF_TOKEN>"   # HF account token (user-provided, rotate later if leaked)
$env:HUGGING_FACE_HUB_TOKEN = $env:HF_TOKEN
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
```

Models auto-download on first run to `%USERPROFILE%\.cache\huggingface\` (all one-time, then offline).
The user must keep HF access acknowledged for:
`pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` (done).

## 4. Engine stack (versions matter — see §5)

| Package | Pinned to | Why |
|---|---|---|
| faster-whisper | latest (works fine) | Whisper STT, CTranslate2 int8 on CPU; uses PyAV internally |
| pyannote.audio | **3.1.1** | diarization pipeline (SpeakerDiarization), needs `torch` |
| av (PyAV) | **12.3.0** | 19.x removed `metadata_errors` kwarg faster-whisper needs |
| huggingface_hub | **0.24.7** | 2.x removed `use_auth_token` kwarg pyannote 3.1.1 passes down |
| torch / torchaudio | 2.15.0+cpu | stable CPU build |
| edge-tts | latest | free TTS used *only* to build test audio |

Python: 3.12.3 (`python` and `py` both resolve to it).

## 5. Compatibility shims (already inside transcriber.py, keep them)

pyannote 3.1.1 predates torch 2.15 / numpy 2.0 in this venv, so before
`from pyannote.audio import Pipeline` we patch:

```python
import numpy as np
if not hasattr(np, "NaN"):
    np.NaN = np.nan                      # numpy>=2 removed np.NaN

import torchaudio
if not hasattr(torchaudio, "set_audio_backend"):
    torchaudio.set_audio_backend = lambda *a, **k: None        # removed in torch>=2.9
if not hasattr(torchaudio, "get_audio_backend"):
    torchaudio.get_audio_backend = lambda *a, **k: "soundfile" # removed in torch>=2.9
```

And the auth kwarg is version-adaptive:

```python
params = inspect.signature(Pipeline.from_pretrained).parameters
pipeline_kwargs["use_auth_token" if "use_auth_token" in params else "token"] = HF_TOKEN
```

## 6. Run history (what failed and was fixed)

| Run | Blocker | Fix |
|---|---|---|
| 1 | PyAV 19 dropped `metadata_errors` | pin av 12.3.0 |
| 2 | pyannote 4.x: `use_auth_token` → `token` | adaptive kwarg |
| 3 | pyannote 4.x default → manually-approved `speaker-diarization-community-1` (403) | pin pyannote.audio 3.1.1 |
| 4 | torch 2.15 removed `set_audio_backend` | shim |
| 5 | NumPy 2.0 removed `np.NaN` | shim |
| 7 | pyannote 3.1.1 passes `use_auth_token` into hf_hub 2.x | pin huggingface_hub 0.24.7 |
| 8 | torch 2.15 removed `get_audio_backend` | second shim |
| 9 | pyannote tasks: `torchaudio.backend.common` missing | downgrade torch/torchaudio to **2.7.1** (era-matched) + pin pytorch-metric-learning 2.6.0 / pandas 2.2.3 / numpy 1.26.4 |
| 10 | torch>=2.6 `torch.load` defaults `weights_only=True` | trusted-loader shim (force `weights_only=False` for pyannote HF checkpoints) |
| 11 | lightning passes `weights_only=True` explicitly | force-overriding shim (must overwrite, not setdefault) |
| 12 | none — **local pipeline success** | transcription 01:33 + diarization 05:19, 2 speakers detected correctly, all outputs written |
| C1 | — | **AssemblyAI cloud pipeline success**: 94s WAV → 47s end-to-end (upload→transcribe→fetch), $0.23/hr tier. Uses `speech_models: ["universal-3-5-pro"]` (param is plural array), `speaker_labels: true`, utterances→segments mapping `Speaker A/B → Speaker 1/2` |

## 6b. Cloud provider (AssemblyAI) — Phase 4 fast mode

- `app/cloud.js` — standalone provider module + CLI test harness (`node cloud.js <file> <key>`)
- Streaming upload with real byte progress via `https.request` (fetch can't report upload %)
- Poll every 3s; cancel = flag + best-effort `DELETE /v2/transcript/{id}`
- `main.js` dispatches on `settings.provider`: `"local"` (python engine) | `"assemblyai"` (`cloudTranscribe`)
- Events over the existing `engine-log` channel: `CLOUD stage upload|transcribing|fetching`,
  `CLOUD upload <pct>` (0–100), `CLOUD status queued|processing` — renderer maps to
  Word's Uploading → Transcribing → Fetching progress flow
- Cost estimate shown on file pick (duration read via `Audio` metadata, $0.23/hr)
- Key stored in `%APPDATA%\transcriber-app\settings.json` as `aaiKey`; default provider `local`
- Control test (AssemblyAI's own multi-speaker sample, 201s): **4 speakers split correctly**
  (9 utterances, alternating A/B/C/D) via `universal-3-5-pro` → mapping/pipe verified sound
- Known quirk: on our synthetic TTS test file, AAI diarization merges 1 speaker while local
  pyannote splits 2 — confirmed to be the artificial file (two near-identical male TTS voices),
  not a code issue

Transcription stage: **10 segments, 01:34 audio in ~01:10–01:33** on CPU (slower past runs were bezel-competitor processes sharing cores).

## 7. Phase plan (agreed with owner)

| Phase | Scope | Status |
|---|---|---|
| 0 | Reverse-engineer Word Transcribe locally | ✅ done (findings file above) |
| 1 | Local engine proof: audio → diarized transcript (.txt/.srt/.json) | 🔄 in progress (diarization stage) |
| 2 | Desktop app shell (Word-pane UX): upload/record/progress/cancel; engine as background worker | pending |
| 3 | Word-parity transcript UI: speaker rename, 4 "Add to document" modes, exports (.docx/.txt/.srt), playback | pending |
| 4 | Long files: chunked processing, resume, sleep-prevention + optional AssemblyAI fast-transcription provider | 🔄 fast mode built & wired (cloud.js + provider dropdown) — TTS-file diarization quirk under control-test |

## 8. Notes & cautions

- The HF token is pasted in chat and written into run commands; **rotate it** at
  https://huggingface.co/settings/tokens when the app ships (never hardcode in the final app;
  store in app config with same perms).
- 8GB RAM: run whisper and pyannote sequentially (current design already does).
- Don't upgrade `av`, `huggingface_hub`, or `pyannote.audio` casually — see §4 pins.
- Word reference behavior for the UI (from Phase 0):
  status flow "Uploading → Transcribing → Fetching", insert modes
  Just text / With speakers / With timestamps / Speakers+timestamps, quota messaging.
  Word persists transcripts as docx custom XML part (ns `http://schemas.microsoft.com/office/transcription/2022`).
