import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function firstText(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const track = draft.tracks.find((item) => item.type === "text");
  return track.segments[0].id;
}

describe("transactional batch", () => {
  it("writes nothing when any operation fails", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const before = readFileSync(fix.path, "utf-8");
    const input = [
      JSON.stringify({ cmd: "set-text", id: firstText(fix.path), text: "changed" }),
      JSON.stringify({ cmd: "shift", id: "missing-segment", offset: "+1s" }),
    ].join("\n");
    const result = spawnCli(["batch", fix.path], { input });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no changes written/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
    assert.equal(existsSync(`${fix.path}.bak`), false);
  });

  it("commits only successful operations with --continue-on-error", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const input = [
      JSON.stringify({ cmd: "set-text", id: firstText(fix.path), text: "changed" }),
      JSON.stringify({ cmd: "shift", id: "missing-segment", offset: "+1s" }),
    ].join("\n");
    const result = spawnCli(["batch", fix.path, "--continue-on-error"], { input });
    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.succeeded, 1);
    assert.equal(result.json.failed, 1);
    assert.match(readFileSync(fix.path, "utf-8"), /changed/);
  });
});
