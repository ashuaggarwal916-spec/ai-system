# CapCut / JianYing draft-schema reference

A practical, field-level reference for the project files that CapCut and JianYing save to disk. Use this to write your own tooling against the format, debug "why does CapCut ignore my edit?" questions, or extend `capcut-cli` itself.

## Why this exists

The CapCut JSON format is undocumented. ByteDance ships no schema and no API. The only public sources are reverse-engineering work (this repo, [`pyJianYingDraft`](https://github.com/GuanYixuan/pyJianYingDraft), and a few blog posts) and hands-on experimentation with real drafts. These notes are derived from real project files plus the upstream Python implementation, then verified against `capcut-cli`'s code and its end-to-end tests against fixture drafts.

## Reading order

1. **[`00-overview.md`](./00-overview.md)** — top-level shape (`id`, `name`, `duration`, `fps`, `canvas_config`, `tracks`, `materials`, `platform`). The 30-second mental model: a draft is a flat list of tracks + a flat dictionary of materials; tracks contain segments that reference materials by id.
2. **[`01-tracks-and-segments.md`](./01-tracks-and-segments.md)** — track types (video, audio, text, image, sticker, effect, subtitle, filter), the `Segment` shape (`material_id`, `target_timerange`, `source_timerange`, `clip`, `render_index`, `extra_material_refs`), and how segment ids map to material ids.
3. **[`02-materials.md`](./02-materials.md)** — material categories (`videos`, `audios`, `texts`, `stickers`, `video_effects`, `material_animations`, `transitions`, `masks`, `canvases`), the text material's escaped-JSON `content` field, the companion-materials pattern (canvas / speed / placeholder / scm / vocal).
4. **[`03-keyframes-and-animations.md`](./03-keyframes-and-animations.md)** — `common_keyframes` per segment for motion properties (alpha, position, scale, rotation, etc.), the `material_animations` container for video effect-style animations, the `sticker_animation` container for text and sticker intro/outro/combo, and which animation properties actually render vs. which CapCut silently ignores.
5. **[`04-effects-filters-stickers.md`](./04-effects-filters-stickers.md)** — `video_effects` track-scoped vs segment-scoped (the `apply_target_type` field), `common_mask` shape and slugs, `canvas_blur` background blur, transitions between segments, and text bubble effects / 花字.
6. **[`05-version-differences.md`](./05-version-differences.md)** — CapCut (overseas) vs JianYing (国内) differences: `platform.app_source` flag, enum-id divergence, filename (`draft_content.json` vs `draft_info.json`), the role of `--jianying` in CLI namespace selection.

## Conventions

- **Time units**: microseconds (`start_us`, `duration_us`, `time_offset`). Convert at the boundary; the format never stores seconds.
- **Coordinate system**: normalized `-1 … 1` for `position_x`/`position_y` (centre = `0,0`, upper-left = `-1,-1`). Scale is unitless multiplier (`1.0` = source size). Rotation is degrees clockwise.
- **Ids**: UUIDs. Within `capcut-cli` you can identify any segment / material by the first 6+ characters as a prefix.
- **Encoding**: UTF-8 JSON, but text material `content` is **double-encoded** — a JSON string containing escaped JSON (see [`02-materials.md`](./02-materials.md)).

## What this reference does NOT cover

- **Render pipeline**: how CapCut composites a draft to MP4 is closed-source and out of scope.
- **GPU shaders / filter math**: filter `effect_id` slugs are opaque; we treat them as catalogue lookups via [`src/enums.json`](../../src/enums.json).
- **Network sync / cloud drafts**: this reference is local-file-only.
