# 04 — Effects, filters, stickers, masks, transitions

The "decoration" layer of a CapCut draft. All of these are materials referenced by segments through `material_id` (primary) or `extra_material_refs` (companion).

## Scene effects via `materials.video_effects[]`

Scene effects (VHS, shake, vignette, light leak, …) are stored as `video_effects` materials and referenced by *effect-track segments* (not by the video segments they visually affect).

```jsonc
{
  "id": "effect-mat-uuid",
  "type": "video_effect",          // or "filter" for colour-grade filters
  "name": "VHS",
  "effect_id": "10001",            // from enums.json — CapCut-internal id
  "resource_id": "",
  "category_id": "", "category_name": "",
  "source_platform": 1,
  "value": 1.0,                    // master intensity, 0..1
  "adjust_params": [
    { "name": "intensity", "default_value": 0.7, "value": 0.7 }
  ],
  "apply_target_type": 2,          // see below
  "apply_target_track_type": 0,
  "platform": "cc"
}
```

### `apply_target_type` — scope semantics

This single field decides what the effect modifies:

| Value | Meaning |
|---|---|
| `0` | Apply to ONE specific segment. The effect-track segment's `target_timerange` overlaps that segment. |
| `1` | Apply to all segments on a track type. `apply_target_track_type` chooses which (0=video, 1=audio, 2=text). |
| `2` | Apply to the global composite (the whole frame). This is the most common for VFX. |

`capcut-cli add-effect` writes `apply_target_type: 2` by default — global scope. Use `--params '[…]'` to override the per-knob `adjust_params` values.

### Adjust params catalogue

Each effect has a fixed `adjust_params` list specific to its `effect_id`. The catalogue is opaque (these are CapCut's internal effect shader parameters); the slug catalogue in `src/enums.json` gives names but not value semantics. **Trial-and-error** is the realistic workflow — set `value: 0.0`, open in CapCut, observe behaviour.

## Filters via `materials.video_effects[]` with `type: "filter"`

Same shape as scene effects but `type: "filter"`. Filters live in a different effect-track category in the CapCut UI but on disk they share the `video_effects` material array. The `category_name` distinguishes them at the human level.

## Masks via `materials.masks[]`

A mask carves the visible region of a video/image segment. Each segment can have AT MOST ONE mask.

```jsonc
{
  "id": "mask-mat-uuid",
  "type": "mask",
  "resource_type": "circle",      // linear | mirror | circle | rectangle | heart | star
  "config": {
    "rotation": 0,                // degrees
    "centerX": 0, "centerY": 0,   // -1..1 normalized
    "feather": 0,                 // 0..1 edge softness
    "width": 0.5,                 // rectangle width 0..1 (other shapes ignore)
    "height": 0.5,                // height 0..1
    "invert": false,
    "roundCorner": 0              // rectangle only, 0..100
  },
  "name": "Circle",
  "resource_id": "",
  "platform": "cc"
}
```

`capcut-cli mask <project> <id> <slug>` writes the material AND attaches its uuid to the segment's `extra_material_refs`. `capcut-cli mask <project> <id> --off` removes every mask uuid from the segment's `extra_material_refs` (the orphaned mask material stays in the materials pool until the next draft save — CapCut prunes).

### Mask geometry by shape

- **Linear** — straight line; `rotation` + `centerX/Y` + `feather` are meaningful. `width` ignored.
- **Mirror** — two-sided linear; same fields.
- **Circle** — `centerX/Y` + `height` (= radius) + `feather`. `width`, `rotation`, `roundCorner` ignored.
- **Rectangle** — `centerX/Y` + `width` + `height` + `rotation` + `feather` + `roundCorner`.
- **Heart**, **Star** — `centerX/Y` + `height` (= scale) + `rotation` + `feather`.

`invert: true` flips the masked-in / masked-out regions.

## Background blur / colour via `materials.canvases[]`

What's behind a video segment when it doesn't fill the frame (portrait video on a landscape canvas, scaled-down clip, etc.):

```jsonc
{
  "id": "canvas-mat-uuid",
  "type": "canvas_blur",          // or "canvas_color" or "canvas_image"
  "blur": 0.375,                  // 0.0625=level 1, 0.375=2, 0.75=3, 1.0=4
  "color": "",
  "image": "",
  "image_id": ""
}
```

`capcut-cli bg-blur <project> <id> <1|2|3|4>` writes/updates the canvas. `--off` clears the canvas ref.

A canvas material lives in `extra_material_refs` of the video/image segment. It is NOT shared across segments — each segment gets its own canvas material entry (CapCut's choice, not ours).

## Transitions via `materials.transitions[]`

A transition joins two adjacent segments on the same track. It's attached to the **first** segment of the pair:

```jsonc
{
  "id": "trans-mat-uuid",
  "type": "transition",
  "name": "Dissolve",
  "effect_id": "10000",
  "resource_id": "",
  "duration": 600000,             // microseconds
  "is_overlap": false,            // true = transition consumes time from BOTH segments
  "category_id": "", "category_name": "",
  "platform": "cc"
}
```

The transition material's uuid goes into `segment.extra_material_refs` of the FIRST segment, not the second. CapCut figures out the second segment from track order.

`capcut-cli transition <project> <id> <slug> [--duration <s>]` finds the right slug from the catalogue and writes both the material and the segment reference. No CLI shortcut for `is_overlap` today — defaults to false.

### Common transitions (CapCut namespace)

`dissolve` · `rgb-glitch` · `radial-blur` · `horizontal-blur` · `vertical-blur-ii` · `twinkle-zoom` · `urban-glitch` · `shake-3`

Full live catalogue: `capcut enums --transitions -H`.

## Stickers via `materials.stickers[]`

Stickers are visual assets from CapCut's built-in library (emoji-style overlays, decorative shapes, brand-style elements).

```jsonc
{
  "id": "sticker-mat-uuid",
  "type": "sticker",
  "name": "",
  "resource_id": "...",           // CapCut sticker library uuid — get from CapCut's sticker browser
  "sticker_id": "",
  "source_platform": 1,
  "platform": "cc",
  "category_id": "", "category_name": ""
}
```

You get `resource_id` values by browsing CapCut's sticker library inside the app (it's not exposed via API). `capcut-cli add-sticker <project> <resource-id> <start> <duration>` then writes a sticker segment and the matching material entry.

Transforms (`--x/-y/-scale/-rotation`) live on the sticker segment's `clip` field like a video segment.

## Text bubble effects / 花字 — deferred

CapCut's text "bubble" (speech bubble background shapes) and 花字 (decorative text styles) require additional material types not yet exposed by `capcut-cli`:

- `materials.text_bubbles[]` — bubble shape resources
- `materials.text_effects[]` — 花字 style resources
- Segment `extra_material_refs` includes both

Phase 4 left these out because the resource-id catalogue is wide and CapCut-version-specific. If you need them, set the fields by hand on the text material:

```jsonc
"materials.texts[i]": {
  "bubble_effect_id": "...",
  "bubble_resource_id": "...",
  "effect_id": "...",
  "effect_resource_id": "..."
}
```

Get the resource ids from a draft you created in CapCut with the desired effect applied.

## Filters chain — out of scope here

CapCut supports a multi-step filter chain (colour-grade nodes). `capcut-cli` doesn't yet expose a `capcut filter` command. The schema:

- `materials.video_effects[]` with `type: "filter"`
- Effect-track segment that chains them via `render_index` ordering

Use `capcut add-effect` with filter slugs from `capcut enums --filters` if you need this today; the API is the same as scene effects.
