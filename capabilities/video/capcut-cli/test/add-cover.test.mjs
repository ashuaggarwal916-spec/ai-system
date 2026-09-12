import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut add-cover", () => {
  const fix = tmpDraft();
  let imgPath;
  let tmpdirPath;

  before(() => {
    tmpdirPath = mkdtempSync(join(tmpdir(), "cover-"));
    imgPath = join(tmpdirPath, "cover.png");
    // 1x1 PNG (smallest valid)
    writeFileSync(
      imgPath,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
          "0d0a2db40000000049454e44ae426082",
        "hex",
      ),
    );
  });
  after(() => {
    fix.cleanup();
    rmSync(tmpdirPath, { recursive: true, force: true });
  });

  it("sets draft.cover to a populated object", () => {
    const r = spawnCli(["add-cover", fix.path, imgPath, "--time", "1500"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cover_path, imgPath);
    assert.equal(r.json.time_ms, 1500);

    const draft = loadDraft(fix.path);
    assert.ok(draft.cover, "cover is populated");
    assert.equal(draft.cover.path, imgPath);
    assert.equal(draft.cover.time_ms, 1500);
    assert.equal(draft.cover.type, "image");
    assert.equal(typeof draft.cover.custom_cover_id, "string");
  });

  it("defaults --time to 0", () => {
    const r = spawnCli(["add-cover", fix.path, imgPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.time_ms, 0);
  });

  it("rejects when the image path doesn't exist", () => {
    const r = spawnCli(["add-cover", fix.path, "/tmp/does-not-exist.png"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found|ENOENT|exist/i);
  });
});
