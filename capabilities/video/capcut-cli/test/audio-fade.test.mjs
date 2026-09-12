import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut audio-fade", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("writes audio_fades material with seconds -> microseconds", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "audio"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["audio-fade", fix.path, seg.id.slice(0, 8), "--in", "0.5", "--fade-out", "1.0"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.fade_in_us, 500000);
    assert.equal(r.json.fade_out_us, 1000000);

    const draft = loadDraft(fix.path);
    const fade = (draft.materials.audio_fades ?? []).find((f) => f.id === r.json.fade_id);
    assert.ok(fade, "audio_fades entry exists");
    assert.equal(fade.fade_in_duration, 500000);
    assert.equal(fade.fade_out_duration, 1000000);
    assert.equal(fade.type, "audio_fade");
  });

  it("requires at least one of --in or --fade-out", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "audio"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["audio-fade", fix.path, seg.id.slice(0, 8)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at least one/i);
  });

  it("rejects on a non-audio segment", () => {
    const videoSegs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = videoSegs[0];
    if (!seg) return;
    const r = spawnCli(["audio-fade", fix.path, seg.id.slice(0, 8), "--in", "0.5"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /audio/i);
  });
});
