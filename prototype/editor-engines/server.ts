import index from "./index.html";

const port = Number(Bun.env.PORT ?? 4177);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  routes: {
    "/": index,
    "/editor-engines": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Editor engine prototype running at http://127.0.0.1:${server.port}`);
