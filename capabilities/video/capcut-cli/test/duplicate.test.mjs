import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

/** Every id that must stay unique draft-wide: tracks, segments, materials, keyframes. */
function collectIds(draft) {
  const ids = [];
  for (const track of draft.tracks) {
    ids.push(track.id);
    for (const seg of track.segments) {
      ids.push(seg.id);
      for (const list of seg.common_keyframes ?? []) {
        ids.push(list.id);
        for (const kf of list.keyframe_list ?? []) ids.push(kf.id);
      }
    }
  }
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) if (mat?.id) ids.push(mat.id);
  }
  return ids;
}

describe("capcut duplicate (new track above the source)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  const before = loadDraft(fix.path);
  const sourceTrack = before.tracks.find((t) => t.type === "video");
  const source = sourceTrack.segments[0];

  it("duplicates onto a fresh same-type track that renders above the source", () => {
    const r = spawnCli(["duplicate", fix.path, source.id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.new_track, true);
    assert.equal(r.json.track_name, `${sourceTrack.name}-copy`);
    assert.notEqual(r.json.new_segment_id, source.id);

    const draft = loadDraft(fix.path);
    // Track order after sortTracks: the copy track sits directly after (=
    // above, later same-type renders on top) the source video track.
    const names = draft.tracks.map((t) => t.name);
    assert.equal(names[names.indexOf(sourceTrack.name) + 1], `${sourceTrack.name}-copy`);
    assert.deepEqual(
      draft.tracks.map((t) => t.type),
      ["video", "video", "audio", "text"],
      "canonical layer order stays stable",
    );

    const copyTrack = draft.tracks.find((t) => t.name === `${sourceTrack.name}-copy`);
    assert.equal(copyTrack.type, "video");
    assert.equal(copyTrack.segments.length, 1);
    const copy = copyTrack.segments[0];
    assert.equal(copy.id, r.json.new_segment_id);
    assert.equal(copy.raw_segment_id, copyTrack.id);
    // Same timeline position/duration; project duration unchanged.
    assert.deepEqual(copy.target_timerange, source.target_timerange);
    assert.deepEqual(copy.source_timerange, source.source_timerange);
    assert.equal(draft.duration, before.duration);
  });

  it("clones the source video material entry (same file, fresh id) and every extra_material_refs companion", () => {
    const draft = loadDraft(fix.path);
    const copy = draft.tracks.find((t) => t.name === `${sourceTrack.name}-copy`).segments[0];

    // The media FILE stays shared, but the material entry is per-segment
    // state: a fresh id so crop/mix-mode on the copy never leak to the source.
    assert.notEqual(copy.material_id, source.material_id);
    assert.equal(draft.materials.videos.length, before.materials.videos.length + 1);
    const copyMat = draft.materials.videos.find((m) => m.id === copy.material_id);
    const srcMat = draft.materials.videos.find((m) => m.id === source.material_id);
    assert.ok(copyMat, "cloned video material is registered in materials.videos");
    assert.equal(copyMat.path, srcMat.path, "clone points at the same media file");

    // Companions are per-segment instances: same count, fresh ids.
    assert.equal(copy.extra_material_refs.length, source.extra_material_refs.length);
    for (const [i, ref] of copy.extra_material_refs.entries()) {
      assert.notEqual(ref, source.extra_material_refs[i], "aux material must not be shared");
    }
    assert.equal(draft.materials.speeds.length, before.materials.speeds.length + 1);
    const clonedSpeed = draft.materials.speeds.find((m) => copy.extra_material_refs.includes(m.id));
    assert.ok(clonedSpeed, "cloned speed companion is registered in materials.speeds");

    // The source keeps its own refs untouched.
    const src = draft.tracks.find((t) => t.name === sourceTrack.name).segments[0];
    assert.deepEqual(src.extra_material_refs, source.extra_material_refs);
  });

  it("crop on the copy never touches the source segment's material", () => {
    const fresh = tmpDraft();
    try {
      const dup = spawnCli(["duplicate", fresh.path, source.id]);
      assert.equal(dup.status, 0, `stderr: ${dup.stderr}`);
      const cropBefore = loadDraft(fresh.path).materials.videos.find((m) => m.id === source.material_id).crop;

      const r = spawnCli(["crop", fresh.path, dup.json.new_segment_id, "--rect", "0.25,0.25,0.5,0.5"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const draft = loadDraft(fresh.path);
      const srcMat = draft.materials.videos.find((m) => m.id === source.material_id);
      const copyMat = draft.materials.videos.find((m) => m.id === dup.json.material_id);
      assert.equal(copyMat.crop.upper_left_x, 0.25, "copy's material got the crop");
      assert.deepEqual(srcMat.crop, cropBefore, "source material's crop is untouched");
    } finally {
      fresh.cleanup();
    }
  });

  it("reports the cloned companions in cloned_materials", () => {
    const fresh = tmpDraft();
    try {
      const r = spawnCli(["duplicate", fresh.path, source.id]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.deepEqual(
        r.json.cloned_materials.map((m) => ({ type: m.type, source_id: m.source_id })),
        [
          { type: "videos", source_id: source.material_id },
          ...source.extra_material_refs.map((ref) => ({ type: "speeds", source_id: ref })),
        ],
      );
      for (const m of r.json.cloned_materials) assert.notEqual(m.id, m.source_id);
    } finally {
      fresh.cleanup();
    }
  });

  it("keeps every id in the draft unique and lints clean", () => {
    const ids = collectIds(loadDraft(fix.path));
    assert.equal(new Set(ids).size, ids.length, "duplicate ids found in draft");

    // --no-check-paths: the fixture's media paths do not exist on disk, which
    // is the fixture's pre-existing (and only) lint complaint.
    const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
    assert.equal(r.status, 0, `lint issues: ${r.stdout}`);
    assert.equal(r.json.summary.total, 0);
  });

  it("re-mints embedded keyframe ids on the copy", () => {
    const fresh = tmpDraft();
    try {
      const kf = spawnCli(["keyframe", fresh.path, source.id, "alpha", "1s", "50%"]);
      assert.equal(kf.status, 0, `stderr: ${kf.stderr}`);
      const r = spawnCli(["duplicate", fresh.path, source.id]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const draft = loadDraft(fresh.path);
      const src = draft.tracks.find((t) => t.name === sourceTrack.name).segments[0];
      const copy = draft.tracks.find((t) => t.name === `${sourceTrack.name}-copy`).segments[0];
      assert.equal(copy.common_keyframes.length, src.common_keyframes.length);
      assert.notEqual(copy.common_keyframes[0].id, src.common_keyframes[0].id);
      assert.notEqual(copy.common_keyframes[0].keyframe_list[0].id, src.common_keyframes[0].keyframe_list[0].id);
      assert.deepEqual(
        copy.common_keyframes[0].keyframe_list[0].values,
        src.common_keyframes[0].keyframe_list[0].values,
      );
    } finally {
      fresh.cleanup();
    }
  });

  it("names a second copy track uniquely", () => {
    const r = spawnCli(["duplicate", fix.path, source.id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.track_name, `${sourceTrack.name}-copy-2`);
  });
});

describe("capcut duplicate --track (existing track placement)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  const before = loadDraft(fix.path);
  const videoTrack = before.tracks.find((t) => t.type === "video");
  const [first, second] = videoTrack.segments;

  it("errors with exit 1 when the target range is occupied", () => {
    const r = spawnCli(["duplicate", fix.path, first.id, "--track", videoTrack.name]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /occupied/);
    // Nothing written.
    assert.deepEqual(loadDraft(fix.path), before);
  });

  it("places onto an existing same-type track when the range is free", () => {
    const mk = spawnCli(["duplicate", fix.path, first.id]); // creates "<name>-copy" holding [0s,5s)
    assert.equal(mk.status, 0, `stderr: ${mk.stderr}`);
    const r = spawnCli(["duplicate", fix.path, second.id, "--track", mk.json.track_name]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.new_track, false);
    assert.equal(r.json.track_name, mk.json.track_name);

    const draft = loadDraft(fix.path);
    assert.equal(draft.tracks.length, before.tracks.length + 1, "no extra track created");
    const target = draft.tracks.find((t) => t.name === mk.json.track_name);
    assert.equal(target.segments.length, 2);
  });

  it("errors on a missing track", () => {
    const r = spawnCli(["duplicate", fix.path, first.id, "--track", "no-such-track"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Track not found/);
  });

  it("errors on a track-type mismatch", () => {
    const textTrack = before.tracks.find((t) => t.type === "text");
    const r = spawnCli(["duplicate", fix.path, first.id, "--track", textTrack.name]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /text track.*video track/);
  });

  it("rejects --track combined with --new-track", () => {
    const r = spawnCli(["duplicate", fix.path, first.id, "--track", videoTrack.name, "--new-track"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
  });
});

describe("capcut duplicate (non-media primaries and safety)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  const before = loadDraft(fix.path);
  const textSeg = before.tracks.find((t) => t.type === "text").segments[0];

  it("clones a text segment's primary material (per-segment instance, never shared)", () => {
    const r = spawnCli(["duplicate", fix.path, textSeg.id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.notEqual(r.json.material_id, textSeg.material_id);
    assert.ok(
      r.json.cloned_materials.some((m) => m.type === "texts" && m.source_id === textSeg.material_id),
      "text primary listed in cloned_materials",
    );
    const draft = loadDraft(fix.path);
    assert.equal(draft.materials.texts.length, before.materials.texts.length + 1);
  });

  it("errors on an unknown segment id", () => {
    const r = spawnCli(["duplicate", fix.path, "ffffffff"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Segment not found/);
  });

  it("--dry-run previews without writing", () => {
    const raw = readFileSync(fix.path, "utf-8");
    const r = spawnCli(["duplicate", fix.path, textSeg.id, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), raw, "draft file must be untouched");
  });
});
