import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// What Windows PowerShell's Set-Content prepends to every text file it writes.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// First video / first text segment of the canonical fixture (test/draft_content.json).
const VIDEO_SEG = "aaaaaa01";
const TEXT_SEG = "cccccc01";

/** Prepend a UTF-8 BOM to an existing file, in place. */
function addBom(path) {
  writeFileSync(path, Buffer.concat([BOM, readFileSync(path)]));
}

function hasBom(path) {
  return readFileSync(path).subarray(0, 3).equals(BOM);
}

const SRT_SAMPLE = `1
00:00:01,000 --> 00:00:04,500
Hello BOM

2
00:00:05,000 --> 00:00:08,000
Second cue
`;

describe("UTF-8 BOM tolerance (PowerShell Set-Content)", () => {
  it("info on a BOM'd draft_content.json matches the clean output exactly", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const clean = spawnCli(["info", fix.path]);
    assert.equal(clean.status, 0, `stderr: ${clean.stderr}`);
    addBom(fix.path);
    const bommed = spawnCli(["info", fix.path]);
    assert.equal(bommed.status, 0, `stderr: ${bommed.stderr}`);
    assert.equal(bommed.stdout, clean.stdout);
  });

  it("lint on a BOM'd draft_content.json matches the clean output exactly", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const clean = spawnCli(["lint", fix.path, "--no-check-paths"]);
    addBom(fix.path);
    const bommed = spawnCli(["lint", fix.path, "--no-check-paths"]);
    assert.equal(bommed.status, clean.status, `stderr: ${bommed.stderr}`);
    assert.equal(bommed.stdout, clean.stdout);
  });

  it("a write to a BOM'd draft succeeds and drops the BOM (never emitted)", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    addBom(fix.path);
    const r = spawnCli(["keyframe", fix.path, VIDEO_SEG, "alpha", "0s", "0.5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(hasBom(fix.path), false);
    // The saved file parses without any leniency.
    JSON.parse(readFileSync(fix.path, "utf-8"));
  });

  it("import-srt reads a BOM'd .srt file", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "bom-srt-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const srtPath = join(dir, "bom.srt");
    writeFileSync(srtPath, Buffer.concat([BOM, Buffer.from(SRT_SAMPLE)]));
    const r = spawnCli(["import-srt", fix.path, srtPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cues, 2);
    assert.equal(r.json.first.start_us, 1_000_000);
  });

  it("import-srt reads BOM'd SRT from stdin", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const r = spawnCli(["import-srt", fix.path, "-"], {
      input: Buffer.concat([BOM, Buffer.from(SRT_SAMPLE)]),
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.cues, 2);
  });

  it("keyframe --batch accepts BOM'd JSONL on stdin", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const lines = [
      JSON.stringify({ property: "alpha", time: 0, value: "1.0" }),
      JSON.stringify({ property: "alpha", time: 1000000, value: "0.5" }),
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, VIDEO_SEG, "--batch"], {
      input: Buffer.concat([BOM, Buffer.from(lines)]),
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.added, 2);
  });

  it("batch accepts BOM'd JSONL on stdin", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const line = JSON.stringify({ cmd: "set-text", id: TEXT_SEG, text: "bom survived" });
    const r = spawnCli(["batch", fix.path], { input: Buffer.concat([BOM, Buffer.from(line)]) });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(readFileSync(fix.path, "utf-8"), /bom survived/);
  });

  it("--preset loads a BOM'd preset file", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "bom-preset-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const presetPath = join(dir, "style.json");
    const made = spawnCli(["make-preset", fix.path, TEXT_SEG, "--out", presetPath]);
    assert.equal(made.status, 0, `stderr: ${made.stderr}`);
    addBom(presetPath);
    const r = spawnCli(["text-style", fix.path, TEXT_SEG, "--preset", presetPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
  });

  it("reads a BOM'd .capcutrc instead of silently ignoring it", () => {
    const dir = mkdtempSync(join(tmpdir(), "bom-rc-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".capcutrc"), Buffer.concat([BOM, Buffer.from(JSON.stringify({ cols: 99 }))]));
    const r = spawnCli(["config"], { cwd: dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.config.cols, 99);
  });
});
