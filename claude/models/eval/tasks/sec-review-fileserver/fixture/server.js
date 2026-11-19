'use strict';
// Small static file server with a link-preview proxy.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, 'public');
const PREVIEW_HOSTS = ['imgcdn.net', 'static-assets.io'];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function sendFile(res, urlPath) {
  const name = decodeURIComponent(urlPath);
  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(`<p>No such file: ${name}</p>`);
    }
    res.writeHead(200);
    res.end(data);
  });
}

async function preview(res, target) {
  const u = new URL(target);
  if (!PREVIEW_HOSTS.some(h => u.hostname.endsWith(h))) {
    res.writeHead(400);
    return res.end('host not allowed');
  }
  const r = await fetch(u);
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

function greet(res, name) {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<h1>Hello, ${escapeHtml(name)}</h1>`);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/preview') return preview(res, url.searchParams.get('url'));
  if (url.pathname === '/hello') return greet(res, url.searchParams.get('name') || 'guest');
  return sendFile(res, url.pathname);
}).listen(8080);
