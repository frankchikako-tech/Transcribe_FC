// In-app update checker.
// Compares the running version against the latest GitHub release; if newer is
// available, returns the version, human-readable notes, and installer URL.
// No auth (public repo), no dependencies — plain fetch.
const REPO = "frankchikako-tech/Transcribe_FC";

// "1.2.10" vs "1.2.9" → numeric part-by-part compare (no semver dep needed)
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Release body (markdown) → clean bullet list for the update banner.
// Keeps lines starting with "- " or "* ", strips markdown emphasis.
function parseNotes(body) {
  return String(body || "")
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) =>
      l
        .replace(/^\s*[-*]\s+/, "")
        .replace(/[*_`]/g, "")
        .trim()
    )
    .filter(Boolean);
}

async function checkForUpdate(currentVersion) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Transcribe-App" },
  });
  if (!res.ok) {
    const err = new Error(`Update check failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  const rel = await res.json();
  if (rel.draft || rel.prerelease) return { available: false };

  const latest = String(rel.tag_name || "").replace(/^v/, "");
  const available = compareVersions(latest, currentVersion) > 0;
  if (!available) return { available: false, version: latest };

  // Prefer the installer asset; fall back to the release page.
  const asset = (rel.assets || []).find((a) => /setup.*\.exe$/i.test(a.name)) ||
    (rel.assets || [])[0];
  return {
    available: true,
    version: latest,
    notes: parseNotes(rel.body),
    url: asset ? asset.browser_download_url : rel.html_url,
    releaseUrl: rel.html_url,
  };
}

module.exports = { checkForUpdate, compareVersions, parseNotes, REPO };
