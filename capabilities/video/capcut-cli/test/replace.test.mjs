import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function videoSegmentId(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return draft.tracks.find((t) => t.type === "video").segments[0].id;
}

function materialPath(path, materialId) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    const m = arr.find((x) => x && x.id === materialId);
    if (m) return m.path;
  }
  return null;
}

describe("capcut replace-media", () => {
  it("swaps a segment's source into the draft's assets, preserving its material id", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "final-render-bytes");

    const r = spawnCli(["replace-media", fix.path, segId, newFile]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.segment_id, segId);
    assert.match(r.json.new_path, /assets[/\\]video[/\\]final\.mp4$/);

    // The material the segment points at now references the copied file.
    assert.equal(materialPath(fix.path, r.json.material_id), r.json.new_path);
    assert.ok(existsSync(join(fix.dir, "assets", "video", "final.mp4")), "new file copied into assets");
  });

  it("honors --dry-run: no write, no asset copy, dryRun marker", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const before = readFileSync(fix.path, "utf-8");
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "x");

    const r = spawnCli(["replace-media", fix.path, segId, newFile, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "draft must be byte-identical under --dry-run");
    assert.equal(existsSync(join(fix.dir, "assets", "video", "final.mp4")), false, "must not copy media in dry-run");
  });

  it("fails clearly on an unknown segment id", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "x");

    const r = spawnCli(["replace-media", fix.path, "does-not-exist", newFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Segment not found/);
  });

  it("requires the new-file argument", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const r = spawnCli(["replace-media", fix.path, segId]);
    assert.notEqual(r.status, 0);
  });
});
