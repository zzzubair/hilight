// Shared by the real-browser tests: find Chrome, bundle a test/fixtures/<name>.browser.jsx page
// with real Excalidraw, and serve it on an ephemeral loopback port.
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

/**
 * Bundles the fixture and serves it. `route(url, response)` may answer a request first.
 * @param {string} fixtureName
 * @param {(url: URL, response: http.ServerResponse) => boolean} [route]
 */
export async function serveFixture(fixtureName, route = () => false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-excalidraw-render-"));
  let server;
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, `test/fixtures/${fixtureName}.browser.jsx`)],
      outdir: root,
      entryNames: "fixture",
      assetNames: "assets/[name]-[hash]",
      bundle: true,
      format: "iife",
      platform: "browser",
      conditions: ["production"],
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.IS_PREACT": '"false"',
      },
    });
    await cp(
      path.join(projectRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
      path.join(root, "whiteboard-assets/fonts"),
      { recursive: true },
    );
    await writeFile(
      path.join(root, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><script src="/fixture.js"></script></body></html>',
    );
    server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (route(url, response)) return;
        const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
        const file = path.resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("outside fixture root");
        const body = await readFile(file);
        response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const live = server;
    return {
      root,
      url: `http://127.0.0.1:${address.port}/`,
      async close() {
        live.closeAllConnections();
        await new Promise((resolve) => live.close(resolve));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
