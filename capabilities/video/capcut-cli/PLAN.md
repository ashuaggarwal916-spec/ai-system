# capcut-cli feature plan — port high-value additions from VectCutAPI/CapCutAPI

> Historical implementation plan through v0.3. v0.11 additionally ships optional ffprobe metadata/duration detection, a local FFmpeg proxy renderer, compile v2, and reliability features documented in the changelog. “Out of scope” below now means no mandatory runtime/server or cloud final renderer.

Source of reference features: [`sun-guannan/VectCutAPI`](https://github.com/sun-guannan/VectCutAPI) (formerly `CapCutAPI`), Python HTTP/MCP server wrapping `pyJianYingDraft`. Local clone for reference lives at `../CapCutAPI/` (fork: `ashreo/CapCutAPI`).

**Guiding principles**
- capcut-cli stays zero-dep, local-only, JSON-by-default, pipeable.
- Ports are pure JSON writes — no new runtime, no network, no Python.
- Each phase is a self-contained PR. Fixtures under `test/` per new command.
- CapCut vs JianYing enum namespaces handled via a `--jianying` flag (default: CapCut).

**Legend**
- `[ ]` not started · `[~]` in progress · `[x]` done

---

## Phase 0 — Expand the `capcut-edit` skill to a references/ layout

Current skill is a single `SKILL.md` (119 lines). Adopt sun-guannan's `vectcut-skill` directory structure (not its server-coupled content) so each phase's additions land in a predictable place and future Claudes don't miss capabilities.

**Meta-rule — pattern-first, one layer at a time.** Determinism is the top priority across all videos and all tools. Nail one pattern completely (script + tested + used on a real video) before starting the next. Viewers fall in love with patterns unconsciously; inconsistency breaks that. No parallel half-finished wrappers. See memory: `feedback_pattern_first_production.md`.

**Core principle — deterministic scripts over Claude-chained commands.**
Every recipe that involves more than one CLI call, any arithmetic, or any branching gets a parameterised shell script. Claude invokes the script with inputs; the script runs a fixed sequence of `capcut` commands. No intermediate reasoning. If a recipe can be written as a script, it **must** be a script — not a "first run X, then run Y" narrative in `workflows.md`. `workflows.md` documents *which script to call and why*, not how to reconstruct it.

Target layout:
```
capcut-cli/skills/capcut-edit/
├── SKILL.md                     # orientation + pointers only; short
├── references/
│   ├── api-reference.md         # every command, every flag, every value format
│   ├── workflows.md             # recipes = "call scripts/X.sh with these args"
│   ├── pitfalls.md              # close-project-first, .bak, clip=null on audio, etc.
│   └── enums.md                 # (populated when Phase 3 ships)
├── scripts/                     # deterministic shell wrappers — the "client library"
│   ├── fade-in.sh               # <project> <id> <duration> — writes alpha 0→1
│   ├── fade-out.sh              # <project> <id> <duration> — writes alpha 1→0
│   ├── ken-burns.sh             # <project> <id> <start-scale> <end-scale> <tx-start> <tx-end> <ty-start> <ty-end> <duration>
│   ├── long-to-short.sh         # <project> <start> <end> <out> <title> <cta> — cut + titles
│   ├── stamp-cta.sh             # <project> <template.json> <start> <duration> <text>
│   └── apply-subtitle-srt.sh    # <project> <srt-path> [--style-ref <id>] — once Phase 3 ships
└── assets/examples/             # raw data snippets only — no logic
    ├── fade-in.jsonl            # keyframe batch (for users who want to hand-edit)
    └── subscribe-cta.json       # reusable text template
```

Rule: `scripts/*.sh` are the **only** moving parts. If Claude needs to do math or a loop, that math/loop lives in the script, not the skill prose.

- [x] **Restructure skill directory** — create `references/`, `scripts/`, `assets/examples/`.
- [x] **`SKILL.md` trim** — keep frontmatter, project locations, progressive-disclosure pattern, `-H`/`-q`/`--batch` conventions, the deterministic-scripts principle, and pointers into `references/` + `scripts/`. Drop exhaustive flag lists.
- [x] **`references/api-reference.md`** — one section per command; every flag with type, default, example; time-format table; ID-prefix rule; `.bak` invariant.
- [x] **`references/workflows.md`** — recipes named by `scripts/X.sh`: when to reach for fade-in vs fade-out, Ken Burns param guidance, long→short guidance. Each recipe starts with "Run `scripts/<name>.sh <args>`" — not a multi-step narrative. Covers `anim.sh` (9-slug table), `ken-burns.sh`, `long-to-short.sh`, `stamp-cta.sh`.
- [x] **`references/pitfalls.md`** — close-project-first, `.bak` files, `clip=null` on audio segments, `source_timerange` math when using `speed`, Windows vs macOS filename differences.
- [x] **`scripts/fade-in.sh`** — thin wrapper around `scripts/anim.sh fade-in`. Logic consolidated in `anim.sh` + `assets/animations.json` catalogue of 9 animation slugs (fade-in, fade-out, flash-in, pulsing-zooms, scroll-up, stripe-merge, zoom-out, blur-out, smoke — all discovered in use on knossos-recon except Fade Out which came from CapCutAPI metadata). `anim.sh` writes a `materials.material_animations` entry matching CapCut's native shape, attaches its id to the segment's `extra_material_refs`, and guards against double-applying an intro or outro. Verified end-to-end on knossos-recon segment `c1ce4d65` (lightwell-shaft, 0:16–0:19) and fixture. **NOT alpha-keyframe-based** — that approach was tried first and CapCut ignored the keyframes on both video and text segments. Follow-up: promote `anim.sh`'s JSON mutation into a proper `capcut anim` CLI command in Phase 1.
- [x] **`scripts/fade-out.sh`** — thin wrapper around `scripts/anim.sh fade-out`. `anim.sh` auto-anchors outros at `start = target_duration - duration` so the fade finishes at the cut. Uses CapCut video "Fade Out" effect (`effect_id 6798320902548230669`, from CapCutAPI metadata — not yet visually verified in CapCut because knossos-recon hasn't used Fade Out; the effect will be fetched on first open).
- [x] **`scripts/ken-burns.sh`** — `<project> <id> <start-scale> <end-scale> <tx-start> <tx-end> <ty-start> <ty-end> <duration>` → batch `capcut keyframe --batch` with uniform_scale + position_x + position_y. Six keyframes; covered in `_test.sh`.
- [x] **`scripts/long-to-short.sh`** — `<project> <start> <end> <out> <title> <cta>` → `capcut cut` → `capcut add-text` intro → `capcut add-text` CTA. Covered in `_test.sh`.
- [x] **`scripts/stamp-cta.sh`** — `<project> <template.json> <start> <duration> <text>` → `capcut apply-template` with text override. Covered in `_test.sh`.
- [x] **`assets/examples/ken-burns.jsonl` + `subscribe-cta.json`** — raw snippets for users who want to hand-edit; not the primary path. (Replaced `fade-in.jsonl` with `ken-burns.jsonl` because fade-in no longer uses keyframes — see pitfalls.md. `subscribe-cta.json` produced by running `capcut save-template` on a CLI-generated CTA text segment.)
- [x] **Add keyframe coverage to `SKILL.md`** — already shipped in Phase 1; skill must name the command + point at `scripts/fade-in.sh` and `scripts/ken-burns.sh`. SKILL.md scripts block lists `ken-burns.sh` with the note that motion-property keyframes render in CapCut (alpha doesn't — see pitfalls.md).
- [x] **Test all scripts** — each `scripts/*.sh` must run end-to-end against `test/draft_content.json` without error; add a `scripts/_test.sh` runner that exercises every wrapper. Runner ships at `scripts/_test.sh`; 7/7 tests pass covering fade-in, fade-out, anim (flash-in + smoke), ken-burns, stamp-cta, long-to-short.
- [x] **Acceptance rule** (documented in this file): every subsequent phase PR must (a) update `references/api-reference.md`, (b) if the phase enables a recipe, add a `scripts/*.sh` wrapper (not a workflow narrative), and (c) add the script to `scripts/_test.sh`.

---

## Phase 1 — Decorators on existing segments

Reference: `../CapCutAPI/add_video_keyframe_impl.py`, `add_video_track.py`, `add_text_impl.py`.

- [x] **`capcut keyframe`** — add keyframe(s) to a segment
  - Single: `capcut keyframe <project> <id> <property> <time> <value>`
  - Batch: `capcut keyframe <project> <id> --batch` (JSONL on stdin: `{"property","time","value"}` per line)
  - Properties: `position_x`, `position_y`, `rotation`, `scale_x`, `scale_y`, `uniform_scale`, `alpha`, `saturation`, `contrast`, `brightness`, `volume`.
  - Value parsing rules copied from `add_video_keyframe_impl.py:131` (`"50%"`, `"+0.5"`, `"45deg"`, etc.).
  - Writes to `common_keyframes` on the segment. Appends to existing per-property list on re-invocation; sorted by `time_offset`.
  - Implementation: `src/decorators.ts`; dispatched from `src/index.ts`.

- [x] **`capcut transition`** — attach transition to a video/image segment
  - `capcut transition <project> <id> <slug> [--duration <s>]`
  - Default duration comes from the per-slug metadata. Starter catalogue of 8 slugs in `src/decorators.ts` (dissolve / rgb-glitch / radial-blur / horizontal-blur / vertical-blur-ii / twinkle-zoom / urban-glitch / shake-3). Covered in `_test.sh`. Phase 3 will replace the inline catalogue with a generated `enums.json`.

- [x] **`capcut mask`** — attach mask to video/image segment
  - `capcut mask <project> <id> <slug>` where slug ∈ `linear|mirror|circle|rectangle|heart|star`
  - Flags: `--center-x`, `--center-y`, `--size`, `--rotation`, `--feather`, `--invert`, `--rect-width` (rect only), `--round-corner` (rect only, 0–100).
  - `capcut mask <project> <id> --off` removes all masks.
  - Writes to `materials.common_mask`. Refuses stacking. Covered in `_test.sh`.

- [x] **`capcut bg-blur`** — background blur level
  - `capcut bg-blur <project> <id> <1|2|3|4>` (light → maximum).
  - `capcut bg-blur <project> <id> --off`.
  - Writes `materials.canvases[].type = canvas_blur` with values `0.0625 / 0.375 / 0.75 / 1.0`. Replaces any existing canvas reference on the segment. Covered in `_test.sh`.

- [x] **`capcut text-style`** — rich text styling on an existing text segment
  - Flags shipped: `--alpha`, `--vertical`, `--fixed-width`, `--fixed-height`, `--shadow/--no-shadow` (+ `--shadow-alpha/--shadow-angle/--shadow-color/--shadow-distance/--shadow-smoothing`), `--border-width/--border-color/--border-alpha`, `--bg-color/--bg-alpha/--bg-style/--bg-round-radius/--bg-width/--bg-height/--bg-h-offset/--bg-v-offset`. Covered in `_test.sh`.
  - **Deferred to Phase 4:** `--bubble-effect-id/--bubble-resource-id` and `--effect-id` (花字) require extra text-material types that aren't in the starter catalogue.

- [x] **`capcut text-anim`** — text intro/outro animations
  - `capcut text-anim <project> <id> [--intro <slug>] [--outro <slug>] [--intro-duration <s>] [--outro-duration <s>]`
  - Validated against starter catalogue in `src/decorators.ts` (fade-in / fade-out / typewriter / pop-up / throw-out / blur-text-in / zoom-in-text). Extends the segment's `sticker_animation` container with `material_type: "text"` animations. Covered in `_test.sh`.

- [x] **Implementation scaffolding**
  - `src/decorators.ts` — added `addTransition`, `addMask`, `setBgBlur`, `setTextStyle`, `addTextAnim`, plus `transitionSlugs/maskSlugs/textAnimSlugs`.
  - New flag parsing in `src/index.ts`: 35 Phase 1 flags (mask geometry, shadow, border, bg box, anim slugs/durations).
  - 5 new subcommand handlers + dispatch cases in `src/index.ts`; HELP text updated.
  - Smoke tests in `scripts/_test.sh` — 5 new tests pass. Per the Phase 0 acceptance rule (PLAN:61), every new command has an `api-reference.md` section and a `_test.sh` entry. No dedicated `scripts/*.sh` wrappers shipped yet — reconsider per command during real use; wrap only when a recipe emerges that needs locking (e.g. default transition slugs per video series).

---

## Phase 2 — New track types

Reference: `../CapCutAPI/add_sticker_impl.py`, `add_effect_impl.py`, `add_image_impl.py`.

- [x] **`capcut add-sticker`** — sticker segment + sticker track
  - `capcut add-sticker <project> <resource-id> <start> <duration> [--x/--y/--scale/--rotation/--track-name]`
  - Creates sticker track on demand; sticker material at `materials.stickers`; transforms applied via `seg.clip`. Covered in `_test.sh`.
  - **Deferred intro/outro flags:** use `capcut image-anim` (or Phase 4's sticker-anim if slug catalogue adds sticker-specific intros) — the generic `image-anim` already supports sticker segments since the animation shape is the same.

- [x] **`capcut add-effect`** — scene / character effect track segment
  - `capcut add-effect <project> <slug> <start> <duration> [--params <json-array>] [--track-name <name>]`
  - Starter slug catalogue of 7 scene effects (shake / vhs / cinematic / light-leak / film-grain / chromatic / vignette) in `src/factory.ts`. `apply_target_type=2` (global track scope). Creates effect track on demand. Material at `materials.video_effects`. Covered in `_test.sh`.
  - **Deferred `--jianying` flag** → Phase 4 (requires the JianYing enum namespace split).

- [x] **`capcut image-anim`** — image intro/outro/combo animations
  - `capcut image-anim <project> <id> [--intro <slug>] [--outro <slug>] [--combo <slug>] [--intro-duration/--outro-duration/--combo-duration]`
  - Shares the `sticker_animation` container shape with `text-anim` but writes `material_type: "video"`. Starter slug catalogue in `src/decorators.ts` matches `skills/capcut-edit/assets/animations.json` (fade-in / flash-in / pulsing-zooms / scroll-up / stripe-merge / zoom-out / fade-out / blur-out / smoke). Combo slugs not yet in catalogue (deferred to Phase 3 extraction). Covered in `_test.sh`.

- [x] **Companion-materials update**
  - `createCompanionMaterials` in `src/factory.ts` now accepts `"sticker"` (shares the video companion set: speeds/placeholder/scm/vocal + canvas + material_color) and `"effect"` (returns empty — effect segments don't use companions). Sticker + effect round-trips covered in `_test.sh` (track + material + segment created, verified via JSON asserts).

---

## Phase 3 — Import + enum discovery

Reference: `../CapCutAPI/add_subtitle_impl.py` and the `/get_*_types` endpoints in `capcut_server.py`.

- [x] **`capcut import-srt`** — parse SRT → per-cue text segments
  - `capcut import-srt <project> <srt-path-or-->` (supports `-` for stdin; file path; **not** URL — keep local-only).
  - Flags: `--track-name` (default `subtitle`), `--style-ref <segment-id>` (copy styling from existing text segment — copies full material style fields + `content.styles[0]` fill), or explicit text-style flags (`--font-size/--color/--align/--x/--y/--alpha/--vertical/--shadow/--border-*/--bg-*`) matching `capcut text-style`.
  - Flag: `--time-offset <s>` to shift all cues; fails fast if shift drops cue 1 below 0us.
  - Zero-dep SRT parser in `src/srt.ts`. Accepts `.` or `,` as ms separator; index lines optional.
  - Single `saveDraft` for the whole file (fast on hundreds of cues).

- [x] **`capcut enums`** — list valid enum values for agents
  - Subcommand flags wired: `--transitions`, `--masks`, `--text-intros`, `--text-outros`, `--text-loop-anims`, `--image-intros`, `--image-outros`, `--image-combos`, `--scene-effects`, `--character-effects`, `--fonts`, `--audio-effects`.
  - Respects `--jianying` flag (separate enum set). Namespace `capcut` is default.
  - Output: JSON array by default (`slug`, `member`, `name`/`title`, effect/resource ids, md5, durations), `-H` table (slug / name / member).
  - No project argument — pure lookup against the committed JSON.

- [x] **Enum extraction build step**
  - `scripts/extract-enums.py` — one-shot script: imports `pyJianYingDraft` from `../CapCutAPI`, dumps 13 enum categories × 2 namespaces to `src/enums.json` (committed; ~790KB).
  - `npm run build` does `tsc && cp src/enums.json dist/enums.json` so the runtime reads the dist copy via `import.meta.url`.
  - `npm run extract-enums` convenience script.
  - Inline `TRANSITIONS` / `MASKS` / `TEXT_ANIMS` starter maps removed (values matched upstream exactly); **`IMAGE_ANIMS` and `VIDEO_EFFECTS` kept inline** because their empirically-harvested knossos-recon `effect_id`s differ from the upstream metadata. Those two categories: inline wins, enums.json is fallback for any unknown slug.

---

## Phase 4 — Multi-style text + polish

- [x] **`capcut text-ranges`** — multi-style text (different styling per char range)
  - `capcut text-ranges <project> <id> --styles @styles.json` (also accepts inline JSON).
  - `styles.json`: `[{"start":0,"end":5,"font_color":"#FFD700","font_size":18,"font_alpha":1.0,"bold":true},…]`.
  - `start`/`end` are JS string code-unit indices; translated to UTF-16LE byte offsets to match existing `content.styles[i].range` format.
  - Writer sorts + validates non-overlap, then emits one style per range plus baseline-style fillers for any gaps so CapCut renders the whole text.
  - Unlocks word-level-highlight captions (big win for funshorts VO).

- [x] **`--jianying` global flag**
  - Threaded through `transition`, `mask`, `text-anim`, `image-anim`, `add-effect`, and `enums`. Each decorator function takes an optional `namespace` param (default `capcut`).
  - JianYing transitions / masks mostly carry Chinese Python identifiers → slug is `""`. CLI looks up by `member` too, so `capcut transition <project> <id> "_3D空间" --jianying` works.
  - `addEffect` skips its inline knossos catalogue when `--jianying` is set, since those effect_ids are CapCut-specific.

- [x] **Skill + docs update**
  - `SKILL.md` — replaced the "once Phase 3 ships" placeholder with an Enum-discovery bullet listing every `--<category>` flag.
  - `references/api-reference.md` — added `text-ranges` section, documented `--jianying` in Global flags, noted namespace aliases inside each decorator section.
  - Top-level `README.md` — added Decorators / Enum discovery / Import SRT sections with copyable examples.

---

## Phase 5 — Wikimedia Commons network input

- [x] **`add-video` / `add-audio` accept Wikimedia URLs** — `src/wikimedia.ts` resolves `commons.wikimedia.org`, any `*.wikipedia.org`, and `upload.wikimedia.org` inputs (page URLs, direct CDN URLs, and `api.php?prop=pageimages&piprop=original` queries) to a canonical `File:` title via the Commons imageinfo API.
- [x] **License classifier + refusal gate** — extracts `LicenseShortName` from extmetadata and classifies as `permissive` (CC*/PD*/CC0/Public domain/No restrictions), `fair-use`, `restrictive` (CC BY-NC/ND, ©), or `unknown`. Restrictive/unknown require `--force-license`. Fair-use downloads with a warning. Zero-dep (Node 18+ global `fetch`).
- [x] **Output surfaces attribution** — `wikimedia` block in the JSON carries `artist`, `credit`, `description_url`, license raw + class, dimensions, mime. Attribution required by CC-BY goes straight into a YouTube description.
- [x] **Single on-disk copy** — download lands directly in `<draft>/assets/<kind>/` so addVideo/addAudio's copyFileSync becomes a no-op. No temp-dir churn.
- [x] **Test coverage** — 37 URL-parse/classifier unit tests + 12 gate-logic tests + 3 CLI smoke tests in `_test.sh` (refusal of non-Wikimedia, local-path regression, classifier round-trip). Live fetch verified against `en.wikipedia.org/w/api.php?...titles=Barcelona...piprop=original` — returned `CC BY 2.0`, 16.6 MB JPEG, artist "dronepicr".

## Explicitly out of scope

Keep capcut-cli lean. These stay in the upstream Python project:

- HTTP server (port 9001) — upstream covers it.
- MCP server — capcut-cli plugin already provides skill-level integration; a thin MCP shim is only justified if usage demands it.
- Non-Wikimedia remote URL downloading — conflicts with zero-dep ethos and license-check guarantees; user downloads separately.
- Mandatory ffprobe dependency — metadata/duration probing is now optional and gracefully falls back to explicit arguments.
- Letterboxing to 1920×1080 — ffmpeg runtime dep; wrap outside the CLI if needed.
- Cloud/final CapCut rendering — out of scope. The local FFmpeg proxy renderer is intentionally approximate.

---

## Execution order

Phase 1 → Phase 2 → Phase 3 → Phase 4. Each phase ships as its own PR with fixtures + README update. Phase 3's enum extraction is the only step that touches Python, and only at build time — the committed `enums.json` is the runtime artifact.
