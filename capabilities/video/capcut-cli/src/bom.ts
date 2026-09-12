/**
 * Lenient text reads: strip a leading UTF-8 BOM (U+FEFF). Windows PowerShell's
 * `Set-Content` (and some editors) prepend one to text files; `JSON.parse`
 * rejects it and the SRT/ASS/JSONL parsers would misread the first token.
 * Applied at every user-supplied text/JSON read path (draft files, presets,
 * @file arguments, stdin, subtitle files, compile specs, config). Writes never
 * emit a BOM, so saving a BOM'd file through the CLI drops it.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
