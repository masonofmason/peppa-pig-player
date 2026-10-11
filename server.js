// 의존성 없는 정적 파일 서버.
// YouTube 임베드 플레이어는 file:// 에서 동작하지 않으므로 http://localhost 로 서빙한다.
// 사용법: node server.js [--open]   (--open: 서버가 뜨면 기본 브라우저로 앱을 연다)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 시청 기록(localStorage)은 origin(포트 포함)별로 저장되므로 가능한 한 같은 포트를 쓴다
const BASE_PORT = Number(process.env.PORT) || 5173;
const MAX_PORT_TRIES = 10;
const APP_TITLE = '<title>Peppa Pig Player</title>';
const ROOT = path.join(__dirname, 'public');
const OPEN_BROWSER = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));

  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd);
}

// 해당 포트에서 이미 이 앱이 돌고 있는지 확인
function isOurApp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body.includes(APP_TITLE)));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port, triesLeft) {
  const server = http.createServer(handler);
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isOurApp(port)) {
      const url = `http://localhost:${port}`;
      console.log(`Peppa Pig Player가 이미 실행 중입니다: ${url}`);
      if (OPEN_BROWSER) openBrowser(url);
      return;
    }
    if (triesLeft <= 1) {
      console.error(`사용 가능한 포트를 찾지 못했습니다 (${BASE_PORT}~${port}).`);
      process.exit(1);
    }
    listen(port + 1, triesLeft - 1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`Peppa Pig Player: ${url}`);
    console.log('이 창을 닫으면 앱이 종료됩니다.');
    if (OPEN_BROWSER) openBrowser(url);
  });
}

listen(BASE_PORT, MAX_PORT_TRIES);
