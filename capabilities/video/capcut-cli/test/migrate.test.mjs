import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut migrate", () => {
  describe("mask -> common_masks across 9.6 boundary", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("moves entries from masks[] to common_masks[]", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      draft.materials.masks = [{ id: "mask-1", type: "mask", name: "circle" }];
      draft.materials.common_masks = [];
      writeFileSync(fix.path, JSON.stringify(draft));

      const r = spawnCli(["migrate", fix.path, "--from", "5.9", "--to", "9.6"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.json.ok);
      assert.ok(r.json.applied.some((a) => /mask->common_masks/.test(a)));

      const after = JSON.parse(readFileSync(fix.path, "utf-8"));
      assert.equal(after.materials.masks.length, 0);
      assert.equal(after.materials.common_masks.length, 1);
      assert.equal(after.materials.common_masks[0].id, "mask-1");
    });
  });

  describe("common_masks -> mask in reverse direction", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("moves entries the other way for 9.6 -> 5.9", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      draft.materials.masks = [];
      draft.materials.common_masks = [{ id: "cmask-1", type: "common_mask" }];
      writeFileSync(fix.path, JSON.stringify(draft));

      const r = spawnCli(["migrate", fix.path, "--from", "9.6", "--to", "5.9"]);
      assert.equal(r.status, 0);
      assert.ok(r.json.applied.some((a) => /common_masks->mask/.test(a)));
    });
  });

  describe("no-op on same-version", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("returns warning when no migration registered", () => {
      const r = spawnCli(["migrate", fix.path, "--from", "6.0", "--to", "6.5"]);
      assert.equal(r.status, 0);
      assert.ok(r.json.ok);
      assert.ok(Array.isArray(r.json.warnings));
    });
  });
});
