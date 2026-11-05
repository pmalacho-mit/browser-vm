// A small browser VM: the lite surface alone, opening in the Python
// playground, with the web gate (pip can reach PyPI) and no previews.
// A fraction of the ide app's download: no VS Code, one playground.
//
//   npm run playgrounds -- python-3.12     (once)
//   npm run build -- python                → dist/python/{site,gate}/
//   node tools/serve.mjs dist/python       → http://localhost:8080
/** @type {import("@browser-vm/tools/app").AppConfig} */
export default {
  title: "Python in a Browser VM",
  machine: "i686",
  image: "base",
  playgrounds: ["python-3.12"],
  start: "python-3.12",
  surfaces: { "/": "lite" },
  gate: "web",
  previews: false,
};
