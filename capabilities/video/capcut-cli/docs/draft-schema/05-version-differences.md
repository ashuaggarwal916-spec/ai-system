# 05 — CapCut vs JianYing — what's different

CapCut and JianYing are the international and Chinese-market builds of the same ByteDance product. They share ~95% of the draft format, but the differences matter when writing tooling.

## Filename and path

| | CapCut | JianYing (剪映) |
|---|---|---|
| Project filename | `draft_content.json` (Windows) or `draft_info.json` (macOS) | `draft_info.json` |
| Project dir | `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<id>/` (mac) | `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/<id>/` (mac) |
| | `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<id>\` (win) | similar under `JianyingPro\` |

`capcut-cli` auto-detects either filename when you pass the project directory.

## `platform.app_source`

The single field that tells you which app saved the draft:

```jsonc
"platform": {
  "app_source": "cc",     // CapCut
  // OR
  "app_source": "lv",     // JianYing (LV = lv_editor / 剪映)
  "app_version": "5.0.0",
  "os": "mac"
}
```

`capcut-cli` reads this to pick the right enum namespace by default when listing transitions / masks / effects. The `--jianying` flag forces the JianYing namespace regardless of `app_source`.

## Enum-id divergence — the big one

Most decorative resources (transitions, masks, image animations, text animations, scene effects) have **different `effect_id` / `resource_id` values** between CapCut and JianYing, even when the visual effect is the same.

Example: `Fade In` text animation.

- **CapCut**: `effect_id: "9094"` (or whatever the current CapCut id is)
- **JianYing**: `effect_id: "...different..."`

If you write a CapCut transition id into a JianYing draft (or vice versa), the host app will load the draft but render that transition as a no-op.

`capcut-cli` solves this by:

1. Extracting both namespaces' full catalogues into `src/enums.json` at build time from `pyJianYingDraft`'s Python enums.
2. Keying every enum lookup on `(slug, namespace)` where namespace is `capcut` (default) or `jianying`.
3. Slugs are human-readable (`fade-in`, `dissolve`, `circle`, …) and **shared** across namespaces where the same visual effect exists.

### How to switch namespaces

Two equivalent ways:

```bash
# Per-command via flag:
capcut transition ./draft <segment-id> dissolve --jianying

# Per-draft via the saved draft's platform.app_source:
# (capcut-cli reads it automatically; the --jianying flag overrides)
```

The `--jianying` flag is threaded through every decorator command: `transition`, `mask`, `text-anim`, `image-anim`, `add-effect`, and `enums`.

### JianYing slug quirks

A handful of JianYing transitions / masks have no English slug — their original Python identifiers are Chinese-language. `capcut-cli enums --transitions --jianying` lists them with an empty `slug` and a `member` field containing the Python name:

```jsonc
[ { "slug": "", "member": "_3D空间", "name": "3D Space" }, ... ]
```

You can still attach them by passing the member name as the slug argument:

```bash
capcut transition ./draft <id> "_3D空间" --jianying
```

## Sticker resources

Sticker `resource_id`s also differ between CapCut and JianYing's library catalogues. The numbers are not transferable. If you build a sticker workflow on CapCut and want to port it to JianYing (or vice versa), you'll need to re-browse the library and capture new resource ids.

## Fonts

JianYing ships a different default font catalogue (Chinese-language fonts dominant). Font fallbacks: if a CapCut draft references a font id JianYing doesn't recognise, JianYing falls back to its system default. The text renders but the design changes. Worth keeping in mind for cross-platform delivery.

## Audio effects / music

Music library (`music_id`) and audio effects also have CapCut-vs-JianYing catalogue divergence. User-imported audio (`type: "extract_music"`) is portable; library audio (`type: "music"` with a `music_id`) typically isn't.

## What's the SAME

- Top-level draft shape (id, name, duration, fps, canvas, tracks, materials)
- Track and segment shapes
- Time units (microseconds everywhere)
- Coordinate system (-1..1 normalized for position; unitless multipliers for scale; degrees for rotation)
- Material category names (`videos`, `audios`, `texts`, `stickers`, `video_effects`, `material_animations`, `transitions`, `masks`, `canvases`, etc.)
- The text `content` field's JSON-in-JSON shape (`{text, styles, layer_weight, effect}`)
- Keyframe property types (`KFTypePositionX`, `KFTypeAlpha`, etc.)
- Animation system shape (`sticker_animation` with intro / outro / combo slots)
- The `apply_target_type` semantics for scene effects

`capcut-cli` is built to be **schema-portable** — the actual JSON manipulation is namespace-agnostic; only the enum lookup table changes via `--jianying`.

## Version-within-app differences

CapCut major versions (3.x, 4.x, 5.x) have introduced minor schema additions over time:

- New material categories (`smart_crops`, `manual_deformations`, `vocal_separations`)
- New `extra_info` keys
- Per-segment colour-grade fields (`enable_color_curves`, `enable_color_wheels`, etc.) added gradually

`capcut-cli` does not version-gate. It writes the most current shape; older CapCut versions either ignore unknown fields or silently downgrade them on save. We test against CapCut 5.x and JianYing 4.x as the reference targets.

## Cross-platform editing

You **can** open a CapCut-saved draft in JianYing and vice versa — the file format is shared. What breaks:

1. Decorative resources (transitions, masks, animations, stickers, filters) render as no-ops on the wrong-namespace host.
2. Font references may fall back to system default.
3. Library audio (`music_id`) loses its source.
4. Cloud-sync features differ — CapCut Cloud and JianYing Cloud are separate accounts.

User-imported video / audio / image / text, motion keyframes, segment timing, multi-style text ranges — **all portable**.
