import { chmod, copyFile, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });
// Chunk names carry a content hash, so clear old ones before writing new ones.
for (const name of await readdir("dist")) {
  if (/^cli-.+\.mjs$/.test(name)) await rm(`dist/${name}`);
}

await esbuild.build({
  // Split, so `hilight --version` loads only the small entry chunk (bin/hilight.js imports the CLI
  // lazily); the rest of the CLI and its dependencies load for every other command. Chunks sit
  // next to cli.mjs because the CLI resolves server.mjs and its assets from import.meta.url.
  entryPoints: { cli: "bin/hilight.js" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  splitting: true,
  chunkNames: "cli-[name]-[hash]",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.HILIGHT_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.HILIGHT_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);

await esbuild.build({
  entryPoints: ["bin/hilight-server.js"],
  outfile: "dist/server.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "external-cli",
      setup(build) {
        build.onResolve({ filter: /^\.\/hilight\.js$/ }, () => ({
          path: "./cli.mjs",
          external: true,
        }));
      },
    },
  ],
});
await chmod("dist/server.mjs", 0o755);

await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// Whiteboard frame: a self-contained browser bundle (Excalidraw + the Mermaid
// converter + its exactly-pinned mermaid + React) served from
// /whiteboard-assets/ by an embedded frame for every rendered Mermaid diagram
// in a `.mermaid` container.
// Everything is vendored so the eagerly loaded whiteboards work fully offline.
await mkdir("dist/whiteboard", { recursive: true });
await esbuild.build({
  entryPoints: { whiteboard: "src/whiteboard-frame.js" },
  outdir: "dist/whiteboard",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.IS_PREACT": '"false"',
  },
});

// Excalidraw lazily fetches canvas fonts from `EXCALIDRAW_ASSET_PATH/fonts/`.
// Vendor every family except Xiaolai (12 MB of CJK glyphs; those fall back to
// Excalidraw's CDN fallback or the system font when missing locally).
const fontFamilies = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
await mkdir("dist/whiteboard/fonts", { recursive: true });
for (const family of fontFamilies) {
  await cp(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, `dist/whiteboard/fonts/${family}`, {
    recursive: true,
  });
}
