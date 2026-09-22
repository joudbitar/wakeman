// Loopback-binding + fail-closed guard tests for the daemon.
//
// Proves the daemon (a) recognises loopback addresses, (b) when bound to
// 127.0.0.1 refuses connections on the machine's LAN IPv4, and (c) even if it
// somehow ends up bound to a routable interface, requests arriving there get a
// 403 instead of reaching the control plane. Pure node:test + node:assert, no
// real projects or fixed ports.

import './isolate-logs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { createDaemonServer, isLoopbackAddress } from '../xerb.mjs';

// First non-internal IPv4 on this machine, or null if the box has none.
function lanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

// Listen and resolve the OS-assigned port, or reject with the bind error.
function listen(server, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

// GET / over a fresh TCP connection to host:port; resolve { status, body }.
function httpGet(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path: '/' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// True if a raw TCP connect to host:port fails with ECONNREFUSED.
function connectRefused(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(2000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', (err) => {
      resolve(err.code === 'ECONNREFUSED');
    });
  });
}

test('isLoopbackAddress truth table', () => {
  for (const addr of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(addr), true, `${addr} should be loopback`);
  }
  for (const addr of ['192.168.1.10', '10.0.0.1', '::ffff:192.168.1.10', '', undefined]) {
    assert.equal(isLoopbackAddress(addr), false, `${JSON.stringify(addr)} should not be loopback`);
  }
});

test('bound to 127.0.0.1: loopback GET works, LAN IPv4 is refused', async (t) => {
  const server = createDaemonServer();
  t.after(() => server.close());

  const port = await listen(server, '127.0.0.1');

  // Loopback request passes the guard (not a 403).
  const res = await httpGet('127.0.0.1', port);
  assert.notEqual(res.status, 403, `loopback GET should not be forbidden (got ${res.status})`);

  // Off-loopback: the server never bound the LAN IPv4, so a connect there on the
  // same port is refused at the OS level. Skip if this box has no LAN IPv4.
  const lan = lanIPv4();
  if (!lan) {
    t.diagnostic('no non-internal IPv4 on this machine; skipping LAN-refused half');
    return;
  }
  const refused = await connectRefused(lan, port);
  assert.equal(refused, true, `connect to ${lan}:${port} should be ECONNREFUSED`);
});

test('bound to LAN IPv4: request on that address is 403 forbidden', async (t) => {
  const lan = lanIPv4();
  if (!lan) {
    t.diagnostic('no non-internal IPv4 on this machine; skipping non-loopback-bind test');
    return;
  }

  const server = createDaemonServer();
  t.after(() => server.close());

  let port;
  try {
    port = await listen(server, lan);
  } catch (err) {
    if (err && err.code === 'EADDRNOTAVAIL') {
      t.diagnostic(`cannot bind ${lan} (EADDRNOTAVAIL); skipping`);
      return;
    }
    throw err;
  }

  // The request arrives on a non-loopback localAddress, so the fail-closed guard
  // rejects it with 403 before it can reach the control plane.
  const res = await httpGet(lan, port);
  assert.equal(res.status, 403, `GET on ${lan} should be forbidden (got ${res.status})`);
  assert.ok(res.body.includes('forbidden'), `body should contain 'forbidden' (got ${JSON.stringify(res.body)})`);
});
