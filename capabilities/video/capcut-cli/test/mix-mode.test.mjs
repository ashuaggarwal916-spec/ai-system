import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut mix-mode", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("sets a blend mode on a video segment's material", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["mix-mode", fix.path, seg.id.slice(0, 8), "multiply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mix_mode, "Multiply");

    const draft = loadDraft(fix.path);
    const mat = draft.materials.videos.find((v) => v.id === r.json.material_id);
    assert.ok(mat, "material exists");
    assert.equal(mat.mix_mode, "Multiply");
  });

  it("rejects invalid modes", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["mix-mode", fix.path, seg.id.slice(0, 8), "neon-glow"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown blend mode|Valid/i);
  });

  it("rejects on non-video segment (text)", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli(["mix-mode", fix.path, texts[0].id.slice(0, 8), "screen"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /video|photo/i);
  });
});
