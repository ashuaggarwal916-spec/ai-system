import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// The canonical timeline register derives id/name/duration from. register
// treats it as read-only: it must be byte-identical after every run.
function contentDraft() {
  return {
    id: "guid-existing-draft",
    name: "edited-by-cli",
    duration: 2_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [{ id: "T1", type: "text", name: "text", attribute: 0, segments: [] }],
    materials: {
      videos: [],
      audios: [],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

// An unrelated draft's entry already in the store index. Carries a
// version-specific field (draft_enterprise_info) the repair must clone into
// new entries and must never drop from existing ones.
function otherEntry(root) {
  return {
    draft_cover: "draft_cover.jpg",
    draft_enterprise_info: { draft_enterprise_extra: "" },
    draft_fold_path: join(root, "Other Draft"),
    draft_id: "guid-other-draft",
    draft_json_file: join(root, "Other Draft", "draft_content.json"),
    draft_name: "Other Draft",
    draft_root_path: root,
    tm_draft_create: 1_700_000_000_000_000,
    tm_draft_modified: 1_700_000_000_000_000,
    tm_draft_removed: 0,
    tm_duration: 5_000_000,
  };
}

// A draft store: root dir holding root_meta_info.json plus one draft folder
// ("My Draft") that exists on disk but — per options — lacks its
// draft_meta_info.json sidecar and/or its entry in the index.
function storeFixture({ withMeta = false, entry = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capcut-register-store-"));
  const dir = join(root, "My Draft");
  mkdirSync(dir);
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(contentDraft(), null, 2));
  if (withMeta) {
    writeFileSync(
      join(dir, "draft_meta_info.json"),
      JSON.stringify({
        draft_cover: "draft_cover.jpg",
        draft_fold_path: dir,
        draft_id: "guid-existing-draft",
        draft_json_file: join(dir, "draft_content.json"),
        draft_name: "My Draft",
        draft_root_path: root,
        tm_draft_create: 1_700_000_000_000_000,
        tm_draft_modified: 1_700_000_000_000_000,
        tm_draft_removed: 0,
        tm_duration: 2_000_000,
      }),
    );
  }
  const entries = [otherEntry(root)];
  if (entry) entries.push(entry);
  writeFileSync(join(root, "root_meta_info.json"), JSON.stringify({ all_draft_store: entries }));
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("register", () => {
  it("plan (default) reports a missing sidecar + missing index entry without writing", () => {
    const f = storeFixture();
    after(f.cleanup);
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["register", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, false);
    assert.equal(r.json.needs_repair, true);
    assert.equal(r.json.store_root, f.root);
    assert.equal(r.json.draft_id, "guid-existing-draft");
    assert.deepEqual(r.json.repairs.sort(), ["draft_meta_info.json", "root_meta_info.json"]);
    const meta = r.json.targets.find((t) => t.file === "draft_meta_info.json");
    assert.equal(meta.state, "missing");
    assert.equal(meta.action, "create");
    const index = r.json.targets.find((t) => t.file === "root_meta_info.json");
    assert.equal(index.state, "unregistered");
    assert.equal(index.action, "update");
    assert.match(r.stderr, /--apply/);
    assert.ok(!existsSync(join(f.dir, "draft_meta_info.json")), "plan must not write the sidecar");
    assert.equal(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"), indexBefore, "plan must not write");
  });

  it("--apply repairs both targets, never touches draft_content.json, and re-runs no-op", () => {
    const f = storeFixture();
    after(f.cleanup);
    const contentBefore = readFileSync(join(f.dir, "draft_content.json"), "utf-8");
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["register", f.dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.applied.sort(), ["draft_meta_info.json", "root_meta_info.json"]);
    assert.deepEqual(r.json.backups, ["root_meta_info.json.bak"], "only pre-existing files get a .bak");
    assert.equal(r.json.needs_repair, false, "the post-write verify must report the repaired state");

    // The recreated sidecar carries the identity derived from draft_content.json.
    const meta = JSON.parse(readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8"));
    assert.equal(meta.draft_id, "guid-existing-draft");
    assert.equal(meta.draft_fold_path, f.dir);
    assert.equal(meta.draft_json_file, join(f.dir, "draft_content.json"));
    assert.equal(meta.draft_root_path, f.root);
    assert.equal(meta.draft_name, "edited-by-cli");
    assert.equal(meta.tm_duration, 2_000_000, "duration must derive from draft_content.json");

    // The index gained an entry cloned from the existing entry's shape; the
    // unrelated entry is preserved untouched.
    const index = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    assert.equal(index.all_draft_store.length, 2);
    const other = index.all_draft_store.find((e) => e.draft_id === "guid-other-draft");
    assert.deepEqual(other, otherEntry(f.root), "existing entries must survive byte-for-byte");
    const mine = index.all_draft_store.find((e) => e.draft_fold_path === f.dir);
    assert.equal(mine.draft_id, "guid-existing-draft");
    assert.equal(mine.tm_duration, 2_000_000);
    assert.ok("draft_enterprise_info" in mine, "the new entry must clone the installed version's entry shape");
    assert.equal(readFileSync(join(f.root, "root_meta_info.json.bak"), "utf-8"), indexBefore);

    // draft_content.json is a read-only source: byte-identical, no .bak.
    assert.equal(readFileSync(join(f.dir, "draft_content.json"), "utf-8"), contentBefore);
    assert.ok(!existsSync(join(f.dir, "draft_content.json.bak")), "register must never back up draft_content.json");

    // Idempotent: the re-run finds nothing to write and exits 0.
    const again = spawnCli(["register", f.dir, "--apply"]);
    assert.equal(again.status, 0, `stderr: ${again.stderr}`);
    assert.deepEqual(again.json.applied, []);
    assert.deepEqual(again.json.backups, []);
    assert.equal(again.json.needs_repair, false);
    assert.match(again.json.message, /already registered/);
  });

  it("unregistered draft with a valid sidecar gets only the index entry", () => {
    const f = storeFixture({ withMeta: true });
    after(f.cleanup);
    const metaBefore = readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8");

    const plan = spawnCli(["register", f.dir]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.targets.find((t) => t.file === "draft_meta_info.json").state, "ok");
    assert.deepEqual(plan.json.repairs, ["root_meta_info.json"]);

    const r = spawnCli(["register", f.dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.applied, ["root_meta_info.json"]);
    assert.equal(
      readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8"),
      metaBefore,
      "a valid sidecar stays untouched",
    );
    const index = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    assert.ok(index.all_draft_store.some((e) => e.draft_fold_path === f.dir));
  });

  it("repairs a stale index entry in place, preserving unknown fields and the display name", () => {
    const staleRoot = mkdtempSync(join(tmpdir(), "capcut-register-oldstore-"));
    after(() => rmSync(staleRoot, { recursive: true, force: true }));
    const f = storeFixture({ withMeta: true });
    after(f.cleanup);
    // The entry exists but was written for the draft's pre-move location and
    // an older content file (wrong id/json path/root/duration). Its non-empty
    // draft_name is CapCut's display name — user data that must survive.
    const stale = {
      ...otherEntry(staleRoot),
      draft_fold_path: f.dir,
      draft_id: "guid-before-content-was-replaced",
      draft_json_file: join(staleRoot, "My Draft", "draft_content.json"),
      draft_name: "Renamed In App",
      draft_root_path: staleRoot,
      tm_duration: 1,
    };
    const index = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    index.all_draft_store.push(stale);
    writeFileSync(join(f.root, "root_meta_info.json"), JSON.stringify(index));

    const plan = spawnCli(["register", f.dir]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    const target = plan.json.targets.find((t) => t.file === "root_meta_info.json");
    assert.equal(target.state, "stale");
    assert.deepEqual(
      target.stale_fields.sort(),
      ["draft_id", "draft_json_file", "draft_root_path", "tm_duration"],
      "the report must name exactly the fields draft_content.json disagrees on",
    );

    const r = spawnCli(["register", f.dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.applied, ["root_meta_info.json"]);
    const repaired = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    assert.equal(repaired.all_draft_store.length, 2, "the stale entry is updated in place, not duplicated");
    const mine = repaired.all_draft_store.find((e) => e.draft_fold_path === f.dir);
    assert.equal(mine.draft_id, "guid-existing-draft");
    assert.equal(mine.draft_json_file, join(f.dir, "draft_content.json"));
    assert.equal(mine.draft_root_path, f.root);
    assert.equal(mine.tm_duration, 2_000_000);
    assert.equal(mine.draft_name, "Renamed In App", "a non-empty display name is user data and must win");
    assert.ok("draft_enterprise_info" in mine, "unknown entry fields must be preserved");
  });

  it("reports a draft outside any known store root explicitly; --apply writes nothing and exits 2", () => {
    const loose = mkdtempSync(join(tmpdir(), "capcut-register-loose-"));
    after(() => rmSync(loose, { recursive: true, force: true }));
    const dir = join(loose, "Orphan Draft");
    mkdirSync(dir);
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(contentDraft(), null, 2));

    const plan = spawnCli(["register", dir]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.ok, false);
    assert.equal(plan.json.store_root, null);
    assert.equal(plan.json.needs_repair, false, "nothing is writable without a store root");
    assert.deepEqual(plan.json.blocked.sort(), ["draft_meta_info.json", "root_meta_info.json"]);
    const index = plan.json.targets.find((t) => t.file === "root_meta_info.json");
    assert.equal(index.state, "unknown-store-root");
    assert.match(index.detail, /--drafts/, "the report must say how to point register at the store");
    assert.match(plan.stderr, /WARNING root_meta_info\.json/);

    const r = spawnCli(["register", dir, "--apply"]);
    assert.equal(r.status, 2, "a blocked repair must exit 2, not pretend success");
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.applied, []);
    assert.ok(!existsSync(join(dir, "draft_meta_info.json")), "no sidecar may be invented outside a store");
    assert.ok(!existsSync(join(loose, "root_meta_info.json")), "no index may be invented outside a store");

    // --drafts names the store root explicitly: register then creates the
    // missing index there, exactly like init on a fresh custom store.
    const forced = spawnCli(["register", dir, "--apply", "--drafts", loose]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.deepEqual(forced.json.applied.sort(), ["draft_meta_info.json", "root_meta_info.json"]);
    const created = JSON.parse(readFileSync(join(loose, "root_meta_info.json"), "utf-8"));
    assert.equal(created.all_draft_store[0].draft_fold_path, dir);
  });

  it("--apply --dry-run previews without writing and does not claim a repair", () => {
    const f = storeFixture();
    after(f.cleanup);
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["register", f.dir, "--apply", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.deepEqual(r.json.applied, []);
    assert.deepEqual(r.json.backups, []);
    assert.deepEqual(r.json.would_apply.sort(), ["draft_meta_info.json", "root_meta_info.json"]);
    assert.doesNotMatch(r.stderr, /Registered/, "dry-run stderr must not assert a repair happened");
    assert.ok(!existsSync(join(f.dir, "draft_meta_info.json")), "dry-run must not write");
    assert.equal(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"), indexBefore, "dry-run must not write");
    assert.ok(!existsSync(join(f.root, "root_meta_info.json.bak")), "dry-run must not create backups");
  });

  it("refuses to rewrite an unreadable root_meta_info.json but still repairs the sidecar (exit 2)", () => {
    const f = storeFixture();
    after(f.cleanup);
    writeFileSync(join(f.root, "root_meta_info.json"), "\x00\x01not-json\x02");

    const r = spawnCli(["register", f.dir, "--apply"]);
    assert.equal(r.status, 2, "a blocked index must exit 2, not pretend full success");
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.applied, ["draft_meta_info.json"], "only the repairable target is written");
    assert.deepEqual(r.json.blocked, ["root_meta_info.json"]);
    assert.match(r.stderr, /WARNING root_meta_info\.json/);
    assert.equal(
      readFileSync(join(f.root, "root_meta_info.json"), "utf-8"),
      "\x00\x01not-json\x02",
      "the index that lists every draft must never be clobbered",
    );
  });

  it("rejects an explicitly named non-canonical file, symmetrically for plan and --apply", () => {
    const f = storeFixture({ withMeta: true });
    after(f.cleanup);

    const plan = spawnCli(["register", join(f.dir, "draft_meta_info.json")]);
    assert.equal(plan.status, 1);
    assert.match(plan.stderr, /cannot target draft_meta_info\.json/);

    const apply = spawnCli(["register", join(f.dir, "draft_meta_info.json"), "--apply"]);
    assert.equal(apply.status, 1, "apply must reject the same inputs the plan rejects");

    // The canonical file itself is an accepted alias for the directory form.
    const accepted = spawnCli(["register", join(f.dir, "draft_content.json")]);
    assert.equal(accepted.status, 0, `stderr: ${accepted.stderr}`);
    assert.equal(accepted.json.project_dir, f.dir);
  });

  it("diagnose recommends the register plan form when draft_meta_info.json is missing", () => {
    const f = storeFixture();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const advice = r.json.next_actions.join(" ");
    assert.match(advice, /`capcut register <project>`/, "missing-meta advice must recommend the plan form");
    assert.ok(!advice.includes("register <project> --apply"), "diagnose must not recommend a destructive one-liner");
  });
});

describe("register — BOM-tolerant reads", () => {
  it("reads BOM'd draft/store files instead of reporting them unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "capcut-register-bom-"));
    try {
      writeFileSync(join(root, "root_meta_info.json"), `\uFEFF${JSON.stringify({ all_draft_store: [] })}`);
      const dir = join(root, "BOM Draft");
      mkdirSync(dir);
      writeFileSync(join(dir, "draft_content.json"), `\uFEFF${JSON.stringify(contentDraft())}`);
      const r = spawnCli(["register", dir]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.needs_repair, true);
      assert.ok(!JSON.stringify(r.json).includes("unreadable"), "BOM'd files must not be classified unreadable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
