#!/usr/bin/env python3
"""
One-shot build step: dump every *_type / *_intro / *_outro / *_anim enum from
pyJianYingDraft (both CapCut and JianYing namespaces) into capcut-cli/src/enums.json.

Runtime does NOT call this — the JSON is committed and the CLI reads it directly.
Rerun this whenever upstream pyJianYingDraft adds new enum members.

Usage:
    python3 scripts/extract-enums.py
    # Assumes ../CapCutAPI/pyJianYingDraft is importable.
"""
from __future__ import annotations
import json
import re
import sys
from enum import Enum
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI_ROOT = HERE.parent
CAPCUTAPI = (CLI_ROOT / ".." / "CapCutAPI").resolve()
OUT_PATH = CLI_ROOT / "src" / "enums.json"

sys.path.insert(0, str(CAPCUTAPI))

import pyJianYingDraft as draft  # noqa: E402


# (category, JianYing enum attr, CapCut enum attr). Missing attrs are skipped.
ENUM_MAP = [
    ("transitions",        "Transition_type",             "CapCut_Transition_type"),
    ("masks",              "Mask_type",                   "CapCut_Mask_type"),
    ("image_intros",       "Intro_type",                  "CapCut_Intro_type"),
    ("image_outros",       "Outro_type",                  "CapCut_Outro_type"),
    ("image_combos",       "Group_animation_type",        "CapCut_Group_animation_type"),
    ("text_intros",        "Text_intro",                  "CapCut_Text_intro"),
    ("text_outros",        "Text_outro",                  "CapCut_Text_outro"),
    ("text_loop_anims",    "Text_loop_anim",              "CapCut_Text_loop_anim"),
    ("scene_effects",      "Video_scene_effect_type",     "CapCut_Video_scene_effect_type"),
    ("character_effects",  "Video_character_effect_type", "CapCut_Video_character_effect_type"),
    ("audio_effects",      "Audio_scene_effect_type",     "CapCut_Voice_filters_effect_type"),
    ("fonts",              "Font_type",                   None),
    ("filters",            "Filter_type",                 None),
]


def is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def to_slug(member_name: str) -> str | None:
    """`Dissolve_II` -> `dissolve-ii`. Returns None for non-ASCII identifiers."""
    if not is_ascii(member_name):
        return None
    s = member_name.lstrip("_")
    # Collapse CamelCase boundaries so `ZoomIn` -> `zoom-in`; also splits on underscore.
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", s)
    s = s.replace("_", "-").lower()
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def extract_meta(meta_obj) -> dict:
    """Pull public scalar attrs off a meta object."""
    fields: dict = {}
    for attr in dir(meta_obj):
        if attr.startswith("_"):
            continue
        value = getattr(meta_obj, attr, None)
        if callable(value):
            continue
        # Keep JSON-safe primitives; skip params lists (per-effect, heterogenous).
        if isinstance(value, (str, int, float, bool)) or value is None:
            fields[attr] = value
    return fields


def dump_enum(enum_cls: type[Enum]) -> list[dict]:
    out: list[dict] = []
    seen_slugs: set[str] = set()
    for name, member in enum_cls.__members__.items():
        slug = to_slug(name)
        if slug is None:
            # Non-ASCII (JianYing Chinese). Keep the entry but no slug.
            slug = ""
        elif slug in seen_slugs:
            # Disambiguate duplicates (e.g. `Mix` and `Mix_1`).
            i = 1
            while f"{slug}-{i}" in seen_slugs:
                i += 1
            slug = f"{slug}-{i}"
        if slug:
            seen_slugs.add(slug)
        entry = {"member": name, "slug": slug, **extract_meta(member.value)}
        out.append(entry)
    return out


def main() -> None:
    data = {"capcut": {}, "jianying": {}}
    for category, jy_attr, cc_attr in ENUM_MAP:
        jy_cls = getattr(draft, jy_attr, None)
        if jy_cls is not None:
            data["jianying"][category] = dump_enum(jy_cls)
        if cc_attr is not None:
            cc_cls = getattr(draft, cc_attr, None)
            if cc_cls is not None:
                data["capcut"][category] = dump_enum(cc_cls)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, indent=0, sort_keys=False, ensure_ascii=False), encoding="utf-8")
    totals = {f"{ns}.{k}": len(v) for ns, cats in data.items() for k, v in cats.items()}
    print(f"Wrote {OUT_PATH}")
    for k, v in sorted(totals.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
