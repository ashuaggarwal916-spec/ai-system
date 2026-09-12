import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "test", "draft_content.json");

describe("capcut export --batch", () => {
  describe("empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-export-empty-"));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("returns warning when no drafts found", () => {
      const r = spawnCli(["export", dir, "--batch", "--dry-run"]);
      assert.ok(r.json);
      assert.equal(r.json.ok, false);
      assert.match(r.json.warning, /No draft directories found/);
    });
  });

  describe("directory with drafts in --dry-run", () => {
    const parent = mkdtempSync(join(tmpdir(), "capcut-export-"));
    const projectA = join(parent, "projectA");
    mkdirSync(projectA);
    copyFileSync(FIXTURE, join(projectA, "draft_content.json"));
    after(() => rmSync(parent, { recursive: true, force: true }));

    it("enumerates drafts and skips with --dry-run", () => {
      const r = spawnCli(["export", parent, "--batch", "--dry-run"]);
      assert.ok(r.json);
      assert.equal(r.json.drafts.length, 1);
      assert.equal(r.json.results.length, 1);
      assert.equal(r.json.results[0].status, "skipped");
      assert.match(r.json.warning, /EXPERIMENTAL/);
    });
  });
});
