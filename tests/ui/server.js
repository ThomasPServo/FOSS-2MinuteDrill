// Static file server for the UI tests: serves web/ the way `python3 -m http.server` or
// GitHub Pages would. Run directly (`node tests/ui/server.js`, PORT=8000) to play locally.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

/** True when the engine and the built data are in place under web/. */
export function gameAvailable() {
  return existsSync(join(WEB, 'js/engine/index.js')) && existsSync(join(WEB, 'data/spots/index.json'));
}

async function fileFor(urlPath) {
  const path = normalize(join(WEB, decodeURIComponent(urlPath)));
  if (!path.startsWith(WEB)) return null;
  try {
    const st = await stat(path);
    return st.isDirectory() ? fileFor(join(urlPath, 'index.html')) : path;
  } catch {
    return null;
  }
}

/** Start the server on `port` (0 = any free port). Resolves to { url, close }. */
export function serve({ port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const file = await fileFor(new URL(req.url, 'http://x').pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serve({ port: Number(process.env.PORT || 8000) }).then(({ url }) => console.log(`serving web/ at ${url}`));
}
