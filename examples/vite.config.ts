import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { parseGatewayBridgeTarget, sameOriginBridgeOrigin } from './entry';

const releaseTag = process.env.GITHUB_REF_NAME ?? '';
const chatReleaseVersion = process.env.GITHUB_REF_TYPE === 'tag' &&
  process.env.GITHUB_REF === `refs/tags/${releaseTag}` && /^v\d+\.\d+\.\d+$/.test(releaseTag)
  ? releaseTag : null;

// Development-only same-origin bridge. Never expose this server to a network.
function gatewayBridge(): Plugin {
  return {
    name: 'chat-gateway-bridge',
    configureServer(server) {
      function target(raw = '') {
        const route = parseGatewayBridgeTarget(raw);
        if (!route) return null;
        return { base: new URL(route.gateway), path: route.path };
      }
      const allowed = (req: http.IncomingMessage) => {
        const origin = req.headers.origin;
        const protocol = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
        const requestOrigin = req.headers.host ? `${protocol}://${req.headers.host}` : '';
        return !origin || sameOriginBridgeOrigin(origin, requestOrigin);
      };
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/gateway/')) return next();
        try {
          if (!allowed(req) || req.method !== 'GET') { res.writeHead(403).end(); return; }
          const route = target(req.url);
          if (!route) { res.writeHead(404).end(); return; }
          const upstream = (route.base.protocol === 'https:' ? https : http).request(route.base, {
            path: route.path, method: 'GET',
            headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
          }, (reply) => {
            res.writeHead(reply.statusCode ?? 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            reply.pipe(res);
          });
          upstream.setTimeout(15000, () => upstream.destroy(new Error('Gateway timeout')));
          upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Gateway unavailable'); });
          res.on('close', () => upstream.destroy());
          upstream.end();
        } catch { res.writeHead(400).end('Invalid gateway request'); }
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/gateway/')) return;
        try {
          if (!allowed(req)) { socket.destroy(); return; }
          const route = target(req.url);
          if (!route || !route.path.startsWith('/ws')) { socket.destroy(); return; }
          const upstream = (route.base.protocol === 'https:' ? https : http).request(route.base, {
            path: route.path,
            headers: { host: route.base.host, connection: 'Upgrade', upgrade: 'websocket',
              'sec-websocket-key': String(req.headers['sec-websocket-key']),
              'sec-websocket-version': '13' },
          });
          upstream.on('upgrade', (reply, remote, remoteHead) => {
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers)
              .map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            socket.pipe(remote).pipe(socket);
            socket.on('error', () => remote.destroy());
            remote.on('error', () => socket.destroy());
            socket.on('close', () => remote.destroy());
          });
          upstream.on('response', () => { socket.destroy(); upstream.destroy(); });
          upstream.on('error', () => socket.destroy());
          socket.on('close', () => upstream.destroy());
          upstream.end();
        } catch { socket.destroy(); }
      });
    },
  };
}

export default defineConfig({ root: resolve(import.meta.dirname), plugins: [react(), gatewayBridge()],
  define: { __CHAT_RELEASE_VERSION__: JSON.stringify(chatReleaseVersion) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { rollupOptions: { input: {
    main: resolve(import.meta.dirname, 'index.html'),
    hostComposer: resolve(import.meta.dirname, 'host-composer.html'),
  } } },
});
