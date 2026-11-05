// AMD loader configuration for the Code-OSS workbench, adapted from Code-OSS's
// own workbench.html. Built to dist/amd-config.js and loaded by index.html after
// vscode/out/vs/loader.js and webPackagePaths.js (which define `require` and
// `webPackagePaths`) and before the workbench itself.
export {}; // a module for type checking; esbuild emits a self-contained classic script

const base = window.__vscodeBase;

for (const key of Object.keys(self.webPackagePaths)) {
  self.webPackagePaths[key] = `${base}/node_modules/${key}/${self.webPackagePaths[key]}`;
}

require.config({
  baseUrl: `${base}/out`,
  recordStats: true,
  trustedTypesPolicy: window.trustedTypes?.createPolicy("amdLoader", {
    createScriptURL(value: string) {
      if (value.startsWith(window.location.origin)) return value;
      throw new Error(`Invalid script url: ${value}`);
    },
  }),
  paths: self.webPackagePaths,
});

performance.mark("code/willLoadWorkbenchMain");
