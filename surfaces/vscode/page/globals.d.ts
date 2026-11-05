// Globals of the VS Code workbench page (boot.ts, amd-config.ts).
export {};

declare global {
  interface Window {
    /** Workbench construction options (IWorkbenchConstructionOptions), set by boot.ts. */
    product: Record<string, unknown>;
    /** URL of the page's vscode/ folder, without a trailing slash (set by boot.ts, read by amd-config.ts). */
    __vscodeBase: string;
    /** Trusted Types, where the browser supports it. */
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown };
  }

  /** Module name → path, defined by vscode/out/vs/webPackagePaths.js. */
  var webPackagePaths: Record<string, string>;

  /** Code-OSS's AMD loader (vscode/out/vs/loader.js). */
  var require: { config(options: Record<string, unknown>): void };
}
