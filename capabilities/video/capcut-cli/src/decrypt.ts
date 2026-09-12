import { existsSync, readFileSync } from "node:fs";

export interface EncryptionReport {
  encrypted: boolean;
  filePath: string;
  size: number;
  reason: string;
  fix: string;
}

/**
 * Detect whether a draft_content.json is encrypted (JianYing 6.0+).
 *
 * JianYing introduced AES-based encryption in 6.0+. The encrypted payload is
 * not valid JSON — it's binary. This function reports the situation clearly
 * and points to the documented workarounds rather than attempting to decrypt:
 * shipping a decryption routine has legal posture implications and the
 * community-known algorithms are in flux. See:
 *   - https://github.com/GuanYixuan/pyJianYingDraft/issues/142
 *   - https://github.com/GuanYixuan/pyJianYingDraft/issues/169
 *   - https://github.com/GuanYixuan/pyJianYingDraft/issues/174
 *   - https://github.com/duoec/duo-video (reference implementation)
 */
export function detectEncryption(filePath: string): EncryptionReport {
  if (!existsSync(filePath)) {
    return {
      encrypted: false,
      filePath,
      size: 0,
      reason: "File does not exist",
      fix: "Check the path and that JianYing/CapCut has saved the project at least once",
    };
  }
  const buf = readFileSync(filePath);
  const size = buf.length;
  const head = buf.subarray(0, Math.min(256, buf.length)).toString("utf-8").trimStart();
  const startsJsonObject = head.startsWith("{");
  if (startsJsonObject) {
    try {
      JSON.parse(buf.toString("utf-8"));
      return {
        encrypted: false,
        filePath,
        size,
        reason: "Parses cleanly as JSON — not encrypted",
        fix: "",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        encrypted: false,
        filePath,
        size,
        reason: `Starts with '{' but JSON.parse failed: ${msg}. Likely a corrupted draft, not encryption.`,
        fix: "Try opening + saving in CapCut/JianYing to repair, or restore from .bak",
      };
    }
  }
  return {
    encrypted: true,
    filePath,
    size,
    reason: "File does not start with '{' and is not parseable as JSON — likely JianYing 6.0+ AES-encrypted payload",
    fix: [
      "JianYing 6.0+ encrypts draft_content.json. capcut-cli detects but does not decrypt it by design — see docs/jianying-encryption.md for the decision and the tripwires to revisit.",
      "",
      "Workarounds (in order of preference):",
      "  1. Pin JianYing to 5.9.x and block auto-update (Windows: delete update.exe + VEDetector.exe). See docs/version-support.md.",
      "  2. Use CapCut International — it is NOT encrypted, only JianYing is.",
      "  3. For an existing encrypted draft, see community references:",
      "     - https://github.com/GuanYixuan/pyJianYingDraft/issues/142 (decryption discussion)",
      "     - https://github.com/duoec/duo-video (working reference implementation)",
    ].join("\n"),
  };
}
