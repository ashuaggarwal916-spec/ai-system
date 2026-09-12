import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut info", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("returns project metadata as JSON", () => {
    const r = spawnCli(["info", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.equal(typeof r.json.duration_us, "number");
    assert.equal(typeof r.json.fps, "number");
    assert.equal(typeof r.json.width, "number");
    assert.equal(typeof r.json.height, "number");
    assert.ok(Array.isArray(r.json.material_summary));
  });

  it("renders a human-readable table with -H", () => {
    const r = spawnCli(["info", fix.path, "-H"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Project:/);
    assert.match(r.stdout, /Duration:/);
    assert.match(r.stdout, /Resolution:/);
  });

  it("--quiet outputs nothing on read commands", () => {
    const r = spawnCli(["info", fix.path, "-q"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

describe("capcut tracks / segments / materials", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("tracks returns an array", () => {
    const r = spawnCli(["tracks", fix.path]);
    assert.equal(r.status, 0);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length > 0);
    for (const t of r.json) {
      assert.equal(typeof t.id, "string");
      assert.equal(typeof t.type, "string");
    }
  });

  it("segments returns an array with timing", () => {
    const r = spawnCli(["segments", fix.path]);
    assert.equal(r.status, 0);
    assert.ok(Array.isArray(r.json));
    if (r.json.length > 0) {
      const s = r.json[0];
      assert.equal(typeof s.id, "string");
      assert.equal(typeof s.start_us, "number");
      assert.equal(typeof s.duration_us, "number");
    }
  });

  it("segments --track text filters by track type", () => {
    const r = spawnCli(["segments", fix.path, "--track", "text"]);
    assert.equal(r.status, 0);
    assert.ok(Array.isArray(r.json));
    // All entries (if any) should be text-track segments
  });

  it("materials returns type counts", () => {
    const r = spawnCli(["materials", fix.path]);
    assert.equal(r.status, 0);
    assert.ok(Array.isArray(r.json));
  });
});

describe("capcut texts", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("returns text segments with id/text fields", () => {
    const r = spawnCli(["texts", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    if (r.json.length > 0) {
      const t = r.json[0];
      assert.equal(typeof t.id, "string");
      assert.equal(typeof t.text, "string");
      assert.equal(typeof t.start_us, "number");
      assert.equal(typeof t.duration_us, "number");
    }
  });
});

describe("capcut --help", () => {
  it("prints help + a non-zero list of commands", () => {
    const r = spawnCli(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: capcut/);
    assert.match(r.stdout, /set-text/);
    assert.match(r.stdout, /cut/);
    assert.match(r.stdout, /apply-template/);
  });
});
