// Quick Open (Ctrl+P) and Find in Files for vmfs:. In the desktop app these are
// served by ripgrep on a Node server; in a pure web workbench, a custom file
// system must supply them through the (proposed) search provider APIs.
// Types: extension/types/vscode.proposed.*.d.ts (from Code-OSS 1.91.1).
import * as vscode from "vscode";
import type { VmFileSystemProvider } from "./fs-provider.ts";

const MAX_FILE = 2 * 1024 * 1024;

export function fileSearchProvider(fsp: VmFileSystemProvider): vscode.FileSearchProvider {
  return {
    async provideFileSearchResults(query, options, token) {
      await fsp.fsReady;
      const pattern = (query.pattern || "").toLowerCase().replace(/\s+/g, "");
      const max = options.maxResults || 1000;
      const out: vscode.Uri[] = [];
      for (const [path] of fsp.walk(options.folder.path)) {
        if (token.isCancellationRequested || out.length >= max) break;
        // cheap subsequence filter; the workbench does the real fuzzy scoring
        if (pattern && !isSubsequence(pattern, path.toLowerCase())) continue;
        out.push(options.folder.with({ path }));
      }
      return out;
    },
  };
}

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

export function textSearchProvider(fsp: VmFileSystemProvider): vscode.TextSearchProvider {
  return {
    async provideTextSearchResults(query, options, progress, token) {
      await fsp.fsReady;
      let source = query.isRegExp ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (query.isWordMatch) source = `\\b${source}\\b`;
      const re = new RegExp(source, query.isCaseSensitive ? "g" : "gi");
      const decoder = new TextDecoder();
      let count = 0;
      for (const [path, id, inode] of fsp.walk(options.folder.path)) {
        if (token.isCancellationRequested) break;
        if (inode.size > (options.maxFileSize || MAX_FILE)) continue;
        const bytes = await fsp.fs.Read(id, 0, inode.size);
        if (!bytes || bytes.includes(0)) continue; // skip binaries
        const lines = decoder.decode(bytes).split("\n");
        for (let ln = 0; ln < lines.length; ln++) {
          const text = lines[ln];
          re.lastIndex = 0;
          let m;
          const ranges: vscode.Range[] = [], previews: vscode.Range[] = [];
          while ((m = re.exec(text))) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            ranges.push(new vscode.Range(ln, m.index, ln, m.index + m[0].length));
            previews.push(new vscode.Range(0, m.index, 0, m.index + m[0].length));
          }
          if (ranges.length) {
            progress.report({ uri: options.folder.with({ path }), ranges, preview: { text, matches: previews } });
            if (++count >= options.maxResults) return { limitHit: true };
          }
        }
      }
      return { limitHit: false };
    },
  };
}
