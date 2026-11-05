// Quick Open (Ctrl+P) and Find in Files for vmfs:. In the desktop app these are
// served by ripgrep on a Node server; in a pure web workbench, a custom file
// system must supply them through the (proposed) search provider APIs. The
// searching itself happens in the VM runtime (runtime/src/vmfs.ts).
// Types: extension/types/vscode.proposed.*.d.ts (from Code-OSS 1.91.1).
import * as vscode from "vscode";
import type { Client } from "../../runtime/src/rpc.ts";
import type { Runtime } from "../../runtime/src/runtime.ts";

export function fileSearchProvider(rt: Client<Runtime>): vscode.FileSearchProvider {
  return {
    async provideFileSearchResults(query, options) {
      // search.exclude and files.exclude arrive as options.excludes: excluded folders aren't even read.
      const paths = await rt.api.searchFiles(options.folder.path, query.pattern || "", options.maxResults || 1000, { includes: options.includes, excludes: options.excludes });
      return paths.map((path) => options.folder.with({ path }));
    },
  };
}

export function textSearchProvider(rt: Client<Runtime>): vscode.TextSearchProvider {
  return {
    async provideTextSearchResults(query, options, progress, token) {
      const { matches, limitHit } = await rt.api.searchText(options.folder.path, query, {
        maxResults: options.maxResults, maxFileSize: options.maxFileSize, includes: options.includes, excludes: options.excludes,
      });
      for (const m of matches) {
        if (token.isCancellationRequested) break;
        progress.report({
          uri: options.folder.with({ path: m.path }),
          ranges: m.ranges.map(([a, b]) => new vscode.Range(m.line, a, m.line, b)),
          preview: { text: m.text, matches: m.ranges.map(([a, b]) => new vscode.Range(0, a, 0, b)) },
        });
      }
      return { limitHit };
    },
  };
}
