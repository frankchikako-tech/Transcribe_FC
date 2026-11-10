"""Merge per-turn mp3 files (edge-tts) into one wav with silence gaps."""
import glob

import av
import numpy as np

SAMPLE_RATE = 16000
GAP_S = 0.7  # silence between speaker turns

turns = sorted(glob.glob("tmp/turn*.mp3"))
all_pcm = []
for path in turns:
    container = av.open(path)
    frames = []
    for frame in container.decode(audio=0):
        arr = frame.to_ndarray()
        # average across channels, take first channel dim
        if arr.ndim == 2:
            arr = arr[0] if arr.shape[0] < arr.shape[1] else arr[:, 0]
        frames.append(arr.astype(np.float32) / 32768.0)
    container.close()
    if frames:
        all_pcm.append(np.concatenate(frames))

gap = np.zeros(int(GAP_S * SAMPLE_RATE), dtype=np.float32)
audio = []
for i, seg in enumerate(all_pcm):
    if i:
        audio.append(gap)
    audio.append(seg)
    audio.append(gap)

final = np.concatenate(audio)
# normalize
peak = np.abs(final).max()
if peak > 0:
    final = final / peak * 0.8

pcm16 = (final * 32767).astype(np.int16)
container = av.open("sample_meeting.wav", "w")
stream = container.add_stream("pcm_s16le", rate=SAMPLE_RATE)
stream.layout = "mono"
frame = av.AudioFrame.from_ndarray(pcm16.reshape(1, -1), format="s16", layout="mono")
frame.rate = SAMPLE_RATE
for chunk in np.array_split(pcm16.reshape(1, -1), max(1, pcm16.size // (SAMPLE_RATE * 5))) if pcm16.size else []:
    if chunk.size < 1024:
        continue
    f = av.AudioFrame.from_ndarray(chunk.astype(np.int16), format="s16", layout="mono")
    f.rate = SAMPLE_RATE
    f.pts = None
    for packet in stream.encode(f):
        container.mux(packet)
for packet in stream.encode(None):
    container.mux(packet)
container.close()
print(f"sample_meeting.wav written: {final.size/SAMPLE_RATE:.1f}s audio")
