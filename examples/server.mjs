import http from 'node:http';
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(request.url === '/ready' ? 'ready\n' : 'Hello from previewd.\n');
});
server.listen(Number(process.env.PORT), process.env.HOST, () => {
  console.log(`Serving ${process.env.PREVIEW_URL}`);
});
