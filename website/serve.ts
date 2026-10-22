const root = `${import.meta.dir}/public`;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 4173,
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path.split('/').includes('..')) return new Response('Not found', {status:404});
    const file = Bun.file(`${root}${path === '/' ? '/index.html' : path}`);
    return await file.exists() ? new Response(file) : new Response('Not found', {status:404});
  }
});
console.log(`Local: ${server.url}`);
