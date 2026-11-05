import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // npm run build makes a Node server in build/ (npm start runs it on port 3000).
    adapter: adapter(),
  },
};
