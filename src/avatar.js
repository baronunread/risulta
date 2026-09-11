// Generated avatars via the vendored blobatar bundle (BSD/MIT, same
// library as the Bun app). The dist file is self-contained: no node:
// imports, no DOM, no framework code. The seed is the display name
// itself (blobatar hashes internally), so this stays synchronous; the
// Bun app pre-hashes with SHA-256, hence avatars differ across the two
// deployments for the same name. Results are cached per process.
import { blobatar } from "../node_modules/blobatar/dist/blob.js";

const cache = new Map();

export function avatarFor(name) {
  // The runtime has no String.prototype.normalize, which blobatar calls
  // unless asked not to; trim + lowercase here replicate its seed prep
  // (NFC composition itself is skipped, so names with combining marks
  // render differently than on the Bun app).
  const key = String(name || "Risulta").trim().toLowerCase().slice(0, 80);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let svg = "";
  try {
    svg = blobatar(key || "risulta", { background: "squircle", normalize: false });
  } catch {
    svg = "";
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, svg);
  return svg;
}
