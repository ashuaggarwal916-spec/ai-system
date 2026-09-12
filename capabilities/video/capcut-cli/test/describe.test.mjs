import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// `describe` emits a machine-readable tool spec for agent callers.
describe("describe", () => {
  it("emits valid JSON with name, version, global_flags, and commands", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.equal(r.json.name, "capcut-cli");
    assert.match(r.json.version, /^\d+\.\d+\.\d+/);
    assert.ok(Array.isArray(r.json.global_flags) && r.json.global_flags.length > 0);
    assert.ok(Array.isArray(r.json.commands) && r.json.commands.length > 0);
  });

  it("describes every command with a non-empty summary (no undescribed commands)", () => {
    const r = spawnCli(["describe"]);
    const undescribed = r.json.commands.filter((c) => !c.name || !c.summary || c.summary.length === 0);
    assert.deepEqual(undescribed, [], `commands missing a summary: ${undescribed.map((c) => c.name).join(", ")}`);
  });

  it("provides a complete machine-callable contract for every command", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.json.schema_version, 2);
    for (const command of r.json.commands) {
      assert.match(command.usage, new RegExp(`^capcut ${command.name}(?: |$)`));
      assert.ok(Array.isArray(command.positionals), `${command.name}: positionals`);
      assert.ok(Array.isArray(command.options), `${command.name}: options`);
      assert.equal(typeof command.mutates, "boolean", `${command.name}: mutates`);
      assert.ok(command.output?.type, `${command.name}: output`);
      assert.ok(command.exit_codes?.["0"], `${command.name}: exit codes`);
      for (const option of command.options) {
        assert.ok(Array.isArray(option.flags) && option.flags.length > 0, `${command.name}: option flags`);
        assert.ok(option.type, `${command.name}: option type`);
      }
    }
  });

  it("includes the new commands", () => {
    const r = spawnCli(["describe"]);
    const names = r.json.commands.map((c) => c.name);
    for (const expected of [
      "prune",
      "relink",
      "timeline",
      "projects",
      "describe",
      "restore",
      "diagnose",
      "templates",
    ]) {
      assert.ok(names.includes(expected), `expected command "${expected}" in describe output`);
    }
  });
});
