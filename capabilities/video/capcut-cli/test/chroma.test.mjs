import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut chroma", () => {
  describe("on a video segment", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("applies chroma key and stores material + ref", () => {
      // Find a video segment ID from the fixture.
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const videoTrack = draft.tracks.find((t) => t.type === "video");
      assert.ok(videoTrack, "fixture must contain a video track");
      const segId = videoTrack.segments[0].id;

      const r = spawnCli(["chroma", fix.path, segId, "--color", "#00FF00", "--intensity", "0.7"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.json.ok);
      assert.equal(r.json.color, "#00FF00");
      assert.equal(r.json.intensity, 0.7);

      const after = JSON.parse(readFileSync(fix.path, "utf-8"));
      assert.ok(Array.isArray(after.materials.chromas));
      assert.equal(after.materials.chromas.length, 1);
      const afterSeg = after.tracks.find((t) => t.type === "video").segments.find((s) => s.id === segId);
      assert.ok(afterSeg.extra_material_refs.includes(after.materials.chromas[0].id));
    });

    it("--off removes chroma material + ref", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const videoTrack = draft.tracks.find((t) => t.type === "video");
      const segId = videoTrack.segments[0].id;

      const r = spawnCli(["chroma", fix.path, segId, "--off"]);
      assert.equal(r.status, 0);
      assert.ok(r.json.ok);

      const after = JSON.parse(readFileSync(fix.path, "utf-8"));
      assert.equal((after.materials.chromas ?? []).length, 0);
    });
  });

  describe("error paths", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("rejects invalid hex color", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const segId = draft.tracks.find((t) => t.type === "video").segments[0].id;
      const r = spawnCli(["chroma", fix.path, segId, "--color", "not-a-color"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Invalid color/);
    });

    it("rejects chroma on non-video segments", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack || textTrack.segments.length === 0) return; // skip if fixture changes
      const segId = textTrack.segments[0].id;
      const r = spawnCli(["chroma", fix.path, segId, "--color", "#00FF00"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Chroma key can only be applied to video segments/);
    });
  });
});
