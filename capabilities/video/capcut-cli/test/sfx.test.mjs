import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut add-sfx", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("adds an SFX segment + material with valid slug", () => {
    const r = spawnCli(["add-sfx", fix.path, "big-house", "1s", "2s"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(r.json.name, "Big House");
    assert.equal(r.json.start_us, 1_000_000);
    assert.equal(r.json.duration_us, 2_000_000);

    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    assert.ok(Array.isArray(draft.materials.audio_effects));
    assert.ok(draft.materials.audio_effects.length > 0);
    const sfxTrack = draft.tracks.find((t) => t.type === "audio" && t.name === "sfx");
    assert.ok(sfxTrack, "expected an audio track named 'sfx'");
  });

  it("rejects unknown slug with a clear error", () => {
    const r = spawnCli(["add-sfx", fix.path, "not-a-real-slug", "0s", "1s"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown SFX slug/);
  });
});
