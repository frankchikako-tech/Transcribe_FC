// Diagnostic: which AssemblyAI config diarizes our 2-voice test file correctly?
// usage: node diag-speakers.js <audioFile> <apiKey>
const path = require("path");
const { aaiUpload, aaiCreateTranscript, AAI } = require("./cloud");

const [, , audioFile, apiKey] = process.argv;

// speakersExpected: undefined = let AAI auto-cluster; a number pins the count
async function run(name, speakersExpected) {
  const t0 = Date.now();
  const uploadUrl = await aaiUpload(path.resolve(audioFile), apiKey);
  const job = await aaiCreateTranscript(apiKey, uploadUrl, "en", speakersExpected);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const t = await (await fetch(`${AAI}/v2/transcript/${job.id}`, { headers: { authorization: apiKey } })).json();
    if (t.status === "completed" || t.status === "error") {
      const spk = [...new Set((t.utterances || []).map((u) => u.speaker))];
      console.log(`[${name}] ${t.status} · ${(Date.now() - t0) / 1000 | 0}s · model=${t.speech_model} · utterances=${(t.utterances || []).length} · speakers=${spk.join(",")} ${t.error || ""}`);
      return;
    }
  }
}

(async () => {
  await run("default");       // auto speaker count
  await run("expect-2", 2);   // pin to 2 speakers
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
