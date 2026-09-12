import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-quickstart-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("capcut quickstart", () => {
  it("creates a lint-clean editable draft from a single video input", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "not-a-real-video");
    const drafts = join(dir, "drafts");

    const r = spawnCli(["quickstart", "demo", "--video", video, "--drafts", drafts]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be JSON");
    assert.equal(r.json.ok, true);
    assert.equal(r.json.name, "demo");
    assert.equal(r.json.added.video, true);
    assert.equal(r.json.lint.errors, 0);
    assert.ok(Array.isArray(r.json.open_hint) && r.json.open_hint.length > 0, "should print an open hint");
    assert.ok(
      r.json.steps.some((s) => s.step === "create" && s.ok),
      "should record a create step",
    );
  });

  it("adds a caption segment per SRT cue", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const srt = join(dir, "subs.srt");
    writeFileSync(srt, "1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:03,500 --> 00:00:05,000\nWorld\n");
    const drafts = join(dir, "drafts");

    const r = spawnCli(["quickstart", "subs", "--srt", srt, "--drafts", drafts]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.added.captions, 2);
  });

  it("the created draft passes the standalone lint command", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const drafts = join(dir, "drafts");

    const create = spawnCli(["quickstart", "p", "--video", video, "--drafts", drafts]);
    assert.equal(create.status, 0, `stderr: ${create.stderr}`);
    const lint = spawnCli(["lint", create.json.draft_path]);
    assert.equal(lint.status, 0, `lint stderr: ${lint.stderr}`);
  });

  it("fails clearly when no input is given", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const r = spawnCli(["quickstart", "empty", "--drafts", join(dir, "drafts")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at least one input/);
  });
});
