"""
Phase 1 pipeline proof: local transcription with speaker diarization.
faster-whisper (small, int8) + pyannote speaker-diarization-3.1, all local/free.

Usage:
  python transcriber.py <audio_file> [--model small] [--min-speakers N] [--max-speakers N]

Outputs (next to input file):
  <name>.transcript.txt  — "Speaker X:" lines with timestamps
  <name>.srt             — timed subtitles with speaker labels
  <name>.transcript.json — full segment data {speaker, start, end, text}
"""
import argparse
import json
import os
import sys
from pathlib import Path

HF_TOKEN = os.environ.get("HF_TOKEN", "")


def mmss(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m:02d}:{s:02d}"


def srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="path to audio file")
    ap.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium"])
    ap.add_argument("--beam", type=int, default=1, help="beam size; 1 = greedy (fast), 5 = best quality")
    ap.add_argument("--min-speakers", type=int, default=None)
    ap.add_argument("--max-speakers", type=int, default=None)
    args = ap.parse_args()

    src = Path(args.audio)
    if not src.exists():
        sys.exit(f"Audio file not found: {src}")

    import time

    # --- 1. Transcribe with faster-whisper -------------------------------
    from faster_whisper import WhisperModel

    print(f"[1/3] Loading faster-whisper '{args.model}' (int8, cpu)...")
    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    print(f"      loaded in {time.time()-t0:.1f}s")

    print("[2/3] Transcribing audio...")
    t0 = time.time()
    segments_iter, info = model.transcribe(
        str(src),
        language="en",
        vad_filter=True,
        beam_size=args.beam,
    )
    audio_duration = info.duration
    segments = []
    for seg in segments_iter:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        # machine-readable progress line for the UI (streamed via stdout)
        print(f"PROGRESS {seg.end / audio_duration * 100:.1f}", flush=True)
    t_transcribe = time.time() - t0
    print(f"      {len(segments)} segments | audio {mmss(audio_duration)} | took {mmss(t_transcribe)}")

    if not segments:
        sys.exit("No speech detected in audio.")

    # --- 2. Diarize with pyannote -----------------------------------------
    # Heavy on CPU: runs roughly 1x-2x the audio duration on this laptop.
    import numpy as np
    if not hasattr(np, "NaN"):          # NumPy >= 2.0 renamed it
        np.NaN = np.nan

    # pyannote 3.1.x calls torchaudio.set_audio_backend(), removed in torch >= 2.9.
    # It's a deprecated no-op, so shim it instead of downgrading torch.
    import torchaudio
    if not hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend = lambda *a, **k: None
    if not hasattr(torchaudio, "get_audio_backend"):
        torchaudio.get_audio_backend = lambda *a, **k: "soundfile"

    # torch>=2.6 changed torch.load default to weights_only=True; old pyannote
    # checkpoints (trusted, from pyannote's own HF hub) need the classic loader.
    import torch as _torch
    _orig_torch_load = _torch.load
    def _trusted_load(*args, **kwargs):
        kwargs["weights_only"] = False   # force — lightning passes True explicitly on torch>=2.6
        return _orig_torch_load(*args, **kwargs)
    _torch.load = _trusted_load

    from pyannote.audio import Pipeline
    from huggingface_hub import whoami

    if HF_TOKEN:
        # make token visible to the pyannote model downloader
        Path.home().joinpath(".huggingface").mkdir(exist_ok=True)
        Path.home().joinpath(".cache", "huggingface").mkdir(parents=True, exist_ok=True)
        hf_cli_token = Path.home().joinpath(".cache", "huggingface", "token")
        hf_cli_token.write_text(HF_TOKEN)
        hf_cache_token = Path.home().joinpath(".huggingface", "token")
        hf_cache_token.write_text(HF_TOKEN)

    print("[3/3] Diarizing speakers with pyannote (first run downloads ~80MB from HF)...")
    t0 = time.time()
    try:
        whoami(token=HF_TOKEN)
    except Exception:
        pass  # token errors here will surface in the pipeline call

    pipeline_kwargs = {}
    if HF_TOKEN:
        # kwarg name differs across pyannote versions: 3.1.x = use_auth_token, 4.x = token
        import inspect as _inspect
        from pyannote.audio import Pipeline as _P
        _params = _inspect.signature(_P.from_pretrained).parameters
        pipeline_kwargs["use_auth_token" if "use_auth_token" in _params else "token"] = HF_TOKEN
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        **pipeline_kwargs,
    )
    kwargs = {}
    if args.min_speakers:
        kwargs["min_speakers"] = args.min_speakers
    if args.max_speakers:
        kwargs["max_speakers"] = args.max_speakers
    diarization = pipeline(str(src), **kwargs)
    t_diarize = time.time() - t0
    print(f"      diarization took {mmss(t_diarize)}")

    turns = [(turn.start, turn.end, speaker)
             for turn, _, speaker in diarization.itertracks(yield_label=True)]
    speakers = sorted({s for _, _, s in turns})
    print(f"      detected speakers: {len(speakers)}")

    # --- 3. Assign speaker to each whisper segment via max overlap --------
    def overlap_speaker(seg: dict) -> str:
        seg_start, seg_end = seg["start"], seg["end"]
        best, best_len = speakers[0] if speakers else "SPK_00", -1.0
        for t_start, t_end, speaker in turns:
            o = min(seg_end, t_end) - max(seg_start, t_start)
            if o > best_len:
                best_len, best = o, speaker
        return best.replace("SPEAKER_", "Speaker ")

    merged = []
    for seg in segments:
        merged.append({
            "speaker": overlap_speaker(seg),
            "start": round(seg["start"], 3),
            "end": round(seg["end"], 3),
            "text": seg["text"],
        })

    # --- outputs ----------------------------------------------------------
    base = src.with_suffix("")
    txt_path = base.with_suffix(".transcript.txt")
    srt_path = base.with_suffix(".srt")
    json_path = base.with_suffix(".transcript.json")

    lines = [f"# Transcript: {src.name}", f"# Length: {mmss(audio_duration)} | Speakers: {len(speakers)}", ""]
    prev = None
    for seg in merged:
        header = f"\n[{mmss(seg['start'])}] {seg['speaker']}:"  # new line when speaker changes
        if prev == seg["speaker"]:
            lines.append(f"[{mmss(seg['start'])}] {seg['text']}")
        else:
            lines.append(header + f" {seg['text']}" if False else f"{seg['speaker']} [{mmss(seg['start'])}]: {seg['text']}")
        prev = seg["speaker"]
    txt_path.write_text("\n".join(lines), encoding="utf-8")

    with open(srt_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(merged, 1):
            f.write(f"{i}\n{srt_time(seg['start'])} --> {srt_time(seg['end'])}\n{seg['speaker']}: {seg['text']}\n\n")

    json_path.write_text(json.dumps({
        "file": src.name, "duration_s": round(audio_duration, 1),
        "speakers": len(speakers), "segments": merged,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nDone. Wrote:\n  {txt_path}\n  {srt_path}\n  {json_path}")
    print("\n--- Preview ---")
    for line in lines[4:14]:
        print(line)


if __name__ == "__main__":
    main()
