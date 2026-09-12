import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function videoSegId(path) {
  const segs = spawnCli(["segments", path, "--track", "video"]).json ?? [];
  return segs[0]?.id ?? null;
}

describe("capcut crop (read-only)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("prints the material crop + dims and writes nothing", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const before = readFileSync(fix.path, "utf-8");
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8)]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.segmentId, segId);
    assert.equal(r.json.width, 1920);
    assert.equal(r.json.height, 1080);
    // The fixture material carries no crop struct yet — read reports what's there.
    assert.equal(r.json.crop, null);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "read-only mode must not write");
  });

  it("rejects a non-video segment (text)", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli(["crop", fix.path, texts[0].id.slice(0, 8)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /video\/photo/);
  });

  it("rejects an unknown segment", () => {
    const r = spawnCli(["crop", fix.path, "no-such-segment"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Segment not found/);
  });
});

describe("capcut crop --ratio", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("writes the centered maximal 9:16 crop for a 1920x1080 source", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "9:16"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    // 9:16 against 16:9 source: w = (9/16)/(16/9) = 81/256, x = (1 - 81/256)/2.
    assert.equal(r.json.rect.w, 0.31640625);
    assert.equal(r.json.rect.x, 0.341796875);
    assert.equal(r.json.rect.h, 1);
    assert.equal(r.json.rect.y, 0);
    assert.deepEqual(r.json.crop, {
      lower_left_x: 0.341796875,
      lower_left_y: 1,
      lower_right_x: 0.658203125,
      lower_right_y: 1,
      upper_left_x: 0.341796875,
      upper_left_y: 0,
      upper_right_x: 0.658203125,
      upper_right_y: 0,
    });
    const draft = loadDraft(fix.path);
    const mat = draft.materials.videos.find((v) => v.id === r.json.material_id);
    assert.ok(mat, "material exists");
    assert.deepEqual(mat.crop, r.json.crop);
  });

  it("writes the centered maximal 1:1 crop for a 1920x1080 source", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "1:1"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.rect, { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  });

  it("16:9 on a 16:9 source is the full frame", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "16:9"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.rect, { x: 0, y: 0, w: 1, h: 1 });
  });

  it("rejects an unknown ratio", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "2:1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown ratio/);
  });

  it("exits 1 pointing at --rect when the material has no stored dims", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const draft = loadDraft(fix.path);
    for (const v of draft.materials.videos) {
      delete v.width;
      delete v.height;
    }
    writeFileSync(fix.path, JSON.stringify(draft), "utf-8");
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "1:1"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--rect/);
  });
});

describe("capcut crop --rect / --reset", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("writes an explicit normalized rect", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0.25,0,0.5,1"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.crop.upper_left_x, 0.25);
    assert.equal(r.json.crop.lower_right_x, 0.75);
    assert.equal(r.json.crop.upper_left_y, 0);
    assert.equal(r.json.crop.lower_right_y, 1);
    const readBack = spawnCli(["crop", fix.path, segId.slice(0, 8)]);
    assert.deepEqual(readBack.json.crop, r.json.crop);
  });

  it("--rect overrides --ratio when both are given", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--ratio", "1:1", "--rect", "0,0,0.5,0.5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.rect, { x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it("rejects a rect that leaves the frame (x+w > 1)", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0.6,0,0.5,1"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x\+w <= 1/);
  });

  it("rejects non-positive width/height", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0.1,0.1,0,0.5"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /w\/h must be > 0/);
  });

  it("rejects negative origin", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "-0.1,0,0.5,1"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x\/y must be >= 0/);
  });

  it("rejects a malformed rect", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0.1,0.2,0.3"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /four comma-separated numbers/);
  });

  it("--reset restores the full frame", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const set = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0.25,0.25,0.5,0.5"]);
    assert.equal(set.status, 0, `stderr: ${set.stderr}`);
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--reset"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.crop, {
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
    });
    const draft = loadDraft(fix.path);
    const mat = draft.materials.videos.find((v) => v.id === r.json.material_id);
    assert.deepEqual(mat.crop, r.json.crop);
  });

  it("--dry-run previews without writing", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const before = readFileSync(fix.path, "utf-8");
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0,0,0.5,0.5", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "--dry-run must not write");
  });

  it("stamps crop_ratio to free when the material carries the field", () => {
    const segId = videoSegId(fix.path);
    if (!segId) return;
    const draft = loadDraft(fix.path);
    for (const v of draft.materials.videos) v.crop_ratio = "16:9";
    writeFileSync(fix.path, JSON.stringify(draft), "utf-8");
    const r = spawnCli(["crop", fix.path, segId.slice(0, 8), "--rect", "0,0,1,1"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.crop_ratio, "free");
    const after_ = loadDraft(fix.path);
    const mat = after_.materials.videos.find((v) => v.id === r.json.material_id);
    assert.equal(mat.crop_ratio, "free");
  });
});
