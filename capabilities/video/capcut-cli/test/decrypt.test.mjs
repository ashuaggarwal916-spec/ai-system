import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut decrypt", () => {
  describe("on a plain JSON draft", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("reports not encrypted", () => {
      const r = spawnCli(["decrypt", fix.path]);
      assert.equal(r.status, 0);
      assert.equal(r.json.encrypted, false);
      assert.match(r.json.reason, /not encrypted/);
    });
  });

  describe("on a binary blob", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-decrypt-"));
    const binPath = join(dir, "draft_content.json");
    // Random bytes that don't start with { — emulates JianYing 6.0+ encrypted payload
    writeFileSync(binPath, Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37, 0xab]));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("reports encrypted and exits 2", () => {
      const r = spawnCli(["decrypt", binPath]);
      assert.equal(r.status, 2);
      assert.equal(r.json.encrypted, true);
      assert.match(r.json.fix, /Pin JianYing to 5.9/);
    });
  });
});
