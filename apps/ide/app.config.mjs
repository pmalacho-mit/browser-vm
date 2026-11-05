// The browser VM this repository deploys: VS Code at the site root and the
// lite page at /lite/, every playground that's built, the web gate, previews.
//
//   npm run build            → dist/ide/{site,gate,preview}/
//   npm start                → http://localhost:8080
/** @type {import("@browser-vm/tools/app").AppConfig} */
export default {
  title: "Code in a Browser VM",
  machine: "i686",
  image: "base",
  playgrounds: "all",
  surfaces: { "/": "vscode", "/lite/": "lite" },
  gate: "web",
  previews: true,
};
