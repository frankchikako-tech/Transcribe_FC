// Diagnostic: which AssemblyAI config diarizes our 2-voice test file correctly?
// usage: node diag-speakers.js <audioFile> <apiKey>
const path = require("path");
const { aaiUpload, aaiCreateTranscript, AAI } = require("./cloud");

const [, , audioFile, apiKey] = process.argv;

async function run(name, extra) {
  const t0 = Date.now();
  const uploadUrl = await aaiUpload(path.resolve(audioFile), apiKey);
  const job = await aaiCreateTranscript(apiKey, uploadUrl, "en");
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
  await run("default", {});
  await run("expect-2", { speakers_expected: 2 });
  await run("universal", { speech_model: "universal" });
  await run("universal-2", { speech_model: "universal-2" });
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
