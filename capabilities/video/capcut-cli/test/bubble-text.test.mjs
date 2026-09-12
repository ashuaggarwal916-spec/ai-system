import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut bubble-text", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("applies a bubble by slug to a text segment", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli(["bubble-text", fix.path, texts[0].id.slice(0, 8), "--bubble", "cloud"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.bubble_id, "string");
    assert.equal(r.json.effect_id, "7137269184932778510");

    const draft = loadDraft(fix.path);
    const filter = (draft.materials.filters ?? []).find((f) => f.id === r.json.bubble_id);
    assert.ok(filter, "filters[] entry exists");
    assert.equal(filter.type, "text_shape");
    assert.equal(filter.effect_id, "7137269184932778510");
  });

  it("accepts --effect-id + --resource-id directly", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli([
      "bubble-text",
      fix.path,
      texts[0].id.slice(0, 8),
      "--effect-id",
      "1111111111111111111",
      "--resource-id",
      "2222222222222222222",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.effect_id, "1111111111111111111");
    assert.equal(r.json.resource_id, "2222222222222222222");
  });

  it("rejects on a non-text segment", () => {
    const videoSegs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    if (videoSegs.length === 0) return;
    const r = spawnCli(["bubble-text", fix.path, videoSegs[0].id.slice(0, 8), "--bubble", "cloud"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /text/i);
  });

  it("requires either slug or both ids", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli(["bubble-text", fix.path, texts[0].id.slice(0, 8)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--bubble|--effect-id/i);
  });
});

describe("capcut enums --bubbles", () => {
  it("returns the bubble starter catalogue", () => {
    const r = spawnCli(["enums", "--bubbles"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    const slugs = r.json.map((e) => e.slug);
    for (const expected of ["rectangle", "rounded", "cloud", "oval", "star", "heart", "burst"]) {
      assert.ok(slugs.includes(expected), `missing ${expected}`);
    }
  });
});
