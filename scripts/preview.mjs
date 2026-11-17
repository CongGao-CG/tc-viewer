import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    // The preview serves only site assets, including when a local data file is in this folder.
    if (!file.startsWith(root + sep) || pathname.split('/').some(part => part.startsWith('.')) || !types[extname(file)]) {
      response.writeHead(403).end('Not a public site asset.');
      return;
    }
    if (!(await stat(file)).isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end('Not found');
  }
});
server.on('error', error => { console.error(`Could not start preview: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`TC Viewer: http://localhost:${port}\nPress Ctrl+C to stop.`));
