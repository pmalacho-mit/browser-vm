// Updates vendor/v86_64/ (the 64-bit emulator) from the v86_64 fork's own CI
// release, verified before anything is written:
//
//   1. the release must be published by GitHub Actions (github-actions[bot]),
//   2. its tag must point at the commit you name (V86_64_COMMIT), or at the
//      fork's current one if you don't name one; it is printed either way,
//   3. every downloaded file must match the SHA-256 GitHub records for it,
//   4. LICENSE and LICENSE.MIT come from that exact commit.
//
//   npm run v86_64                                   # the fork's current CI release
//   V86_64_COMMIT=<sha> npm run v86_64               # only if `latest` is that commit
//   V86_64_REPO=<owner>/v86_64 npm run v86_64        # another fork (its GitHub Actions must be enabled)
//
// Then update vendor/v86_64/PROVENANCE.md with the printed commit and checksums,
// and run both `npm run test:boot` and `npm run test:boot:x86_64`.
// The fork publishes only a moving `latest` release, so a past commit's build
// can't be downloaded later: the vendored copy is the record.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REPO = process.env.V86_64_REPO || "portlandhodl/v86_64";
const FILES = ["libv86.mjs", "v86.wasm", "v86-fallback.wasm"];
const out = path.resolve(import.meta.dirname, "../vendor/v86_64");

/** @param {string} url */
const getJSON = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};
/** @param {string} url */
const getBytes = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};
const sha256 = (/** @type {Uint8Array} */ b) => crypto.createHash("sha256").update(b).digest("hex");

const release = await getJSON(`https://api.github.com/repos/${REPO}/releases/tags/latest`);
const tag = await getJSON(`https://api.github.com/repos/${REPO}/git/refs/tags/latest`);
const commit = tag.object.sha;
const wanted = process.env.V86_64_COMMIT;
if (wanted && wanted !== commit) throw new Error(`the fork's latest release is ${commit}, not ${wanted}; build ${wanted} from source with scripts/build-v86_64.sh`);
if (release.author?.login !== "github-actions[bot]") throw new Error(`release published by ${release.author?.login}, not GitHub Actions; refusing`);

/** @type {Record<string, Uint8Array>} */
const files = {};
for (const name of FILES) {
  const asset = release.assets.find((/** @type {{ name: string }} */ a) => a.name === name);
  if (!asset) throw new Error(`release has no ${name}`);
  if (asset.uploader?.login !== "github-actions[bot]") throw new Error(`${name} uploaded by ${asset.uploader?.login}; refusing`);
  const bytes = await getBytes(asset.browser_download_url);
  const expected = String(asset.digest || "").replace(/^sha256:/, "");
  if (!expected || sha256(bytes) !== expected) throw new Error(`${name}: checksum ${sha256(bytes)} doesn't match GitHub's ${asset.digest}`);
  files[name] = bytes;
}
for (const name of ["LICENSE", "LICENSE.MIT"]) {
  files[name] = await getBytes(`https://raw.githubusercontent.com/${REPO}/${commit}/${name}`);
}

fs.mkdirSync(out, { recursive: true });
for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(out, name), bytes);
console.log(`vendor/v86_64 updated from ${REPO} CI release of commit ${commit} (published ${release.published_at})`);
for (const name of FILES) console.log(`  ${sha256(files[name])}  ${name}`);
console.log("Now update vendor/v86_64/PROVENANCE.md and run npm run test:boot and npm run test:boot:x86_64.");
