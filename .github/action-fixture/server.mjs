import { createServer } from 'node:http';

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Heimdall QA Action Fixture</title>
  <style>
    body { margin: 0; font: 16px/1.5 sans-serif; color: #18212d; background: #f4f7fb; }
    main { max-width: 760px; margin: 48px auto; padding: 32px; background: white; border: 1px solid #cbd5e1; }
    h1 { margin-top: 0; }
  </style>
</head>
<body>
  <main>
    <h1>Heimdall QA Action Fixture</h1>
    <p>This local page exists only to verify the composite action end to end.</p>
  </main>
</body>
</html>`;

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 5090);
createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`QA action fixture: http://127.0.0.1:${port}/`);
});
