import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildSceneSegments,
  detectScenes,
  limitCuts,
  mergeCloseCuts,
  parseFfmpegDuration,
  parseSceneCuts,
  timecode,
} from "../dist/scenes.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const US = 1_000_000;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" }).status === 0;
const isWindows = process.platform === "win32"; // fake-ffmpeg tests use /bin/sh scripts

// Three 1s solid-color scenes -> hard cuts at t=1 and t=2. Solid-color swaps
// score exactly 0.4 on this ffmpeg, so tests pass an explicit --threshold 0.3
// (the default 0.4 is a strict greater-than).
function makeSceneClip(dir) {
  const clip = join(dir, "scenes.mp4");
  const src = (color) => ["-f", "lavfi", "-i", `color=c=${color}:size=160x120:rate=15:duration=1`];
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      ...src("red"),
      ...src("blue"),
      ...src("green"),
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      clip,
    ],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return clip;
}

const METADATA_STDERR = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'scenes.mp4':",
  "  Duration: 00:00:03.00, start: 0.000000, bitrate: 7 kb/s",
  "[Parsed_metadata_1 @ 0x1] frame:0    pts:15360   pts_time:1",
  "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.400000",
  "[Parsed_metadata_1 @ 0x1] frame:1    pts:30720   pts_time:2.5",
  "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.750000",
].join("\n");

describe("detect-scenes — parsing + cut math (pure)", () => {
  it("pairs pts_time with the following scene_score", () => {
    const cuts = parseSceneCuts(METADATA_STDERR);
    assert.deepEqual(cuts, [
      { time: 1, score: 0.4 },
      { time: 2.5, score: 0.75 },
    ]);
  });

  it("drops cuts at t<=0 and returns [] on unrelated stderr", () => {
    const zero = "[Parsed_metadata_1 @ 0x1] frame:0 pts:0 pts_time:0\n[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.9";
    assert.deepEqual(parseSceneCuts(zero), []);
    assert.deepEqual(parseSceneCuts("Duration: 00:00:03.00\nnothing else"), []);
  });

  it("reads the input duration from the ffmpeg header", () => {
    assert.equal(parseFfmpegDuration(METADATA_STDERR), 3);
    assert.equal(parseFfmpegDuration("  Duration: 00:01:02.50, start: 0"), 62.5);
    assert.equal(parseFfmpegDuration("no header here"), null);
  });

  it("mergeCloseCuts keeps the strongest cut of a close cluster", () => {
    const cuts = [
      { time: 1, score: 0.5 },
      { time: 1.5, score: 0.8 },
      { time: 4, score: 0.6 },
    ];
    assert.deepEqual(mergeCloseCuts(cuts, 2), [
      { time: 1.5, score: 0.8 },
      { time: 4, score: 0.6 },
    ]);
    // minGap 0 disables merging
    assert.deepEqual(mergeCloseCuts(cuts, 0), cuts);
    // ties keep the earliest cut
    assert.deepEqual(
      mergeCloseCuts(
        [
          { time: 1, score: 0.4 },
          { time: 2, score: 0.4 },
        ],
        2,
      ),
      [{ time: 1, score: 0.4 }],
    );
  });

  it("limitCuts keeps the N strongest, back in time order", () => {
    const cuts = [
      { time: 1, score: 0.5 },
      { time: 5, score: 0.9 },
      { time: 9, score: 0.7 },
    ];
    assert.deepEqual(limitCuts(cuts, 2), [
      { time: 5, score: 0.9 },
      { time: 9, score: 0.7 },
    ]);
    assert.deepEqual(limitCuts(cuts, undefined), cuts);
  });

  it("buildSceneSegments spans 0..duration and carries microseconds", () => {
    const segments = buildSceneSegments(
      [
        { time: 1, score: 0.4 },
        { time: 2.5, score: 0.75 },
      ],
      4,
    );
    assert.deepEqual(segments, [
      { start: 0, end: 1, duration: 1, start_us: 0, end_us: US, duration_us: US },
      { start: 1, end: 2.5, duration: 1.5, start_us: US, end_us: 2.5 * US, duration_us: 1.5 * US },
      { start: 2.5, end: 4, duration: 1.5, start_us: 2.5 * US, end_us: 4 * US, duration_us: 1.5 * US },
    ]);
    // cuts at/after the known duration are dropped
    assert.equal(buildSceneSegments([{ time: 5, score: 0.9 }], 4).length, 1);
  });

  it("buildSceneSegments leaves the tail open when duration is unknown", () => {
    const segments = buildSceneSegments([{ time: 2, score: 0.5 }], null);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[1], {
      start: 2,
      end: null,
      duration: null,
      start_us: 2 * US,
      end_us: null,
      duration_us: null,
    });
  });

  it("timecode formats hh:mm:ss.mmm", () => {
    assert.equal(timecode(0), "00:00:00.000");
    assert.equal(timecode(1.5), "00:00:01.500");
    assert.equal(timecode(3723.042), "01:02:03.042");
  });

  it("timecode carries millisecond round-up across minute/hour boundaries", () => {
    // MPEG-TS 1/90000 timebase yields pts_time like 59.9996 — rounding the
    // seconds field alone printed the out-of-range "00:00:60.000".
    assert.equal(timecode(59.9996), "00:01:00.000");
    assert.equal(timecode(3599.9999), "01:00:00.000");
    assert.equal(timecode(59.9994), "00:00:59.999"); // rounds down: no carry
  });
});

describe("detect-scenes — CLI", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-detect-scenes-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("detects both hard cuts and returns draft-ready segments", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSceneClip(s.dir);
    const r = spawnCli(["detect-scenes", clip, "--threshold", "0.3", "--min-gap", "0.5"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.cuts.length, 2, JSON.stringify(r.json.cuts));
    assert.ok(Math.abs(r.json.cuts[0].time - 1) < 0.2, `cut 1 at ${r.json.cuts[0].time}`);
    assert.ok(Math.abs(r.json.cuts[1].time - 2) < 0.2, `cut 2 at ${r.json.cuts[1].time}`);
    assert.match(r.json.cuts[0].timecode, /^00:00:0\d\.\d{3}$/);
    assert.ok(Math.abs(r.json.duration - 3) < 0.2);
    assert.equal(r.json.segments.length, 3);
    assert.equal(r.json.segments[0].start, 0);
    for (const seg of r.json.segments) {
      assert.equal(seg.start_us, Math.round(seg.start * US));
      assert.equal(seg.end_us, Math.round(seg.end * US));
      assert.equal(seg.duration_us, seg.end_us - seg.start_us);
    }
    // segments tile the clip: each start = previous end
    assert.equal(r.json.segments[1].start, r.json.segments[0].end);
    assert.equal(r.json.segments[2].start, r.json.segments[1].end);
  });

  it("--min-gap merges cuts closer than the gap (default 2s)", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSceneClip(s.dir);
    const r = spawnCli(["detect-scenes", clip, "--threshold", "0.3"]);
    assert.equal(r.status, 0, r.stderr);
    // cuts at ~1s and ~2s are 1s apart -> merged into one under the 2s default
    assert.equal(r.json.cuts.length, 1);
    assert.equal(r.json.segments.length, 2);
  });

  it("--limit keeps only the N strongest cuts", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSceneClip(s.dir);
    const r = spawnCli(["detect-scenes", clip, "--threshold", "0.3", "--min-gap", "0.5", "--limit", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.cuts.length, 1);
    assert.equal(r.json.segments.length, 2);
  });

  it("-H prints a human summary; --json overrides it", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSceneClip(s.dir);
    const human = spawnCli(["detect-scenes", clip, "--threshold", "0.3", "-H"]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.json, null, "human output must not be JSON");
    assert.match(human.stdout, /Cuts:\s+1/);
    assert.match(human.stdout, /00:00:0\d\.\d{3}/);
    const json = spawnCli(["detect-scenes", clip, "--threshold", "0.3", "-H", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.ok(json.json && Array.isArray(json.json.cuts), "--json must force JSON output");
  });

  // Reviewer repro: 6s video track muxed with an 8s audio track. The container
  // header reports 8s (longest stream), so the final segment used to be
  // {start:4, end:8} — 2s past the last video frame.
  it("ends the final segment at the video stream, not the longer audio track", {
    skip: !hasFfmpeg || !hasFfprobe,
  }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = join(s.dir, "longaudio.mp4");
    const src = (color) => ["-f", "lavfi", "-i", `color=c=${color}:size=160x120:rate=15:duration=2`];
    const r = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        ...src("red"),
        ...src("blue"),
        ...src("green"),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=8000:cl=mono:d=8",
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
        "-map",
        "[v]",
        "-map",
        "3:a",
        "-c:a",
        "aac",
        clip,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const cli = spawnCli(["detect-scenes", clip, "--threshold", "0.3", "--min-gap", "0.5"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.json.duration_source, "video-stream");
    assert.ok(
      Math.abs(cli.json.duration - 6) < 0.2,
      `duration ${cli.json.duration} must be ~6s (video), not 8s (container)`,
    );
    const last = cli.json.segments[cli.json.segments.length - 1];
    assert.ok(Math.abs(last.end - 6) < 0.2, `final segment ends at ${last.end} — past the last video frame`);
    assert.ok(last.end_us <= 6.2 * US, `final segment end_us ${last.end_us} overruns the video track`);
  });

  it("falls back to the container header when ffprobe is unavailable, and says so", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "clip.mp4");
    writeFileSync(placeholder, "");
    // Fake ffmpeg emits a real-looking header + scene metadata; ffprobe is
    // pointed at a nonexistent path to force the container fallback.
    const fakeFfmpeg = join(s.dir, "fake-ffmpeg");
    writeFileSync(fakeFfmpeg, `#!/bin/sh\ncat >&2 <<'EOF'\n${METADATA_STDERR}\nEOF\nexit 0\n`);
    chmodSync(fakeFfmpeg, 0o755);
    const r = spawnCli([
      "detect-scenes",
      placeholder,
      "--min-gap",
      "0.5",
      "--ffmpeg-cmd",
      fakeFfmpeg,
      "--ffprobe-cmd",
      "/nonexistent/ffprobe",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.duration, 3);
    assert.equal(r.json.duration_source, "container");
    assert.equal(r.json.segments[r.json.segments.length - 1].end, 3);
  });

  // Reviewer repro: spawnSync reports a tripped timeout as r.error (code
  // ETIMEDOUT, status null) — it used to be misreported as "install ffmpeg".
  it("reports a timeout as a timeout, not as ffmpeg being unavailable", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "clip.mp4");
    writeFileSync(placeholder, "");
    const slowFfmpeg = join(s.dir, "slow-ffmpeg");
    writeFileSync(slowFfmpeg, "#!/bin/sh\nsleep 3\n");
    chmodSync(slowFfmpeg, 0o755);
    let err = null;
    try {
      detectScenes(placeholder, { ffmpegCmd: slowFfmpeg, timeoutMs: 250 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected detectScenes to throw on timeout");
    assert.match(err.message, /timed out after 0\.25s/);
    assert.doesNotMatch(err.message, /install ffmpeg|unavailable/i);
  });

  it("reports a maxBuffer overflow as such, not as ffmpeg being unavailable", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "clip.mp4");
    writeFileSync(placeholder, "");
    const noisyFfmpeg = join(s.dir, "noisy-ffmpeg");
    writeFileSync(noisyFfmpeg, "#!/bin/sh\nhead -c 200000 /dev/zero\n");
    chmodSync(noisyFfmpeg, 0o755);
    let err = null;
    try {
      detectScenes(placeholder, { ffmpegCmd: noisyFfmpeg, maxBufferBytes: 1024 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected detectScenes to throw on buffer overflow");
    assert.match(err.message, /output exceeded/);
    assert.doesNotMatch(err.message, /install ffmpeg|unavailable/i);
  });

  it("fails with a clear error when the video is missing", () => {
    const r = spawnCli(["detect-scenes", "/nonexistent/video.mp4"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /video not found/);
  });

  it("fails actionably when ffmpeg is unavailable", () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "clip.mp4");
    writeFileSync(placeholder, "");
    const r = spawnCli(["detect-scenes", placeholder, "--ffmpeg-cmd", "/nonexistent/ffmpeg"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ffmpeg is unavailable/);
    assert.match(r.stderr, /--ffmpeg-cmd/);
  });

  it("rejects an out-of-range threshold", () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "clip.mp4");
    writeFileSync(placeholder, "");
    const r = spawnCli(["detect-scenes", placeholder, "--threshold", "1.5"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--threshold must be in/);
  });
});
