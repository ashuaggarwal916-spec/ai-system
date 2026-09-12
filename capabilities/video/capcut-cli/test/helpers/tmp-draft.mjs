import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "..", "test", "draft_content.json");

/**
 * Copy the canonical fixture to a fresh temp dir. Returns { path, dir, cleanup }.
 * Caller must invoke cleanup() (or pair with a `t.after` hook).
 */
export function tmpDraft() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-cli-test-"));
  const path = join(dir, "draft_content.json");
  copyFileSync(FIXTURE, path);
  return {
    path,
    dir,
    cleanup() {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * For commands that need a project DIRECTORY (e.g. `init` outputs there).
 * Returns a fresh empty dir with cleanup.
 */
export function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-cli-test-"));
  return {
    dir,
    cleanup() {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
