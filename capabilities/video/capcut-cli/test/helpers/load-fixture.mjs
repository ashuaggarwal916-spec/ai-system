import { readFileSync } from "node:fs";

/**
 * Read a draft JSON file from disk. Throws on missing or invalid JSON.
 */
export function loadDraft(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Count segments across all tracks. Useful for asserting add-* commands.
 */
export function segmentCount(draft) {
  return draft.tracks.reduce((n, t) => n + t.segments.length, 0);
}

/**
 * Find the first segment with a given id-prefix. Returns null if missing.
 */
export function findSegmentByPrefix(draft, prefix) {
  for (const t of draft.tracks) {
    for (const s of t.segments) {
      if (s.id.startsWith(prefix)) return s;
    }
  }
  return null;
}
