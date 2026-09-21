// Framing tests for lib/ws.mjs, against two clients.
//
// Node 22's global WebSocket is the realistic one: it does the handshake, masks
// its frames, and negotiates a subprotocol the way the dashboard will. It also
// never fragments a message, never sends a ping, and never dies mid-frame, so a
// hand-rolled raw client (maskedFrame + parseFrames below) covers the paths the
// spec names in section 10 that a well-behaved client cannot produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

import { handleUpgrade, acceptKey } from '../lib/ws.mjs';

// --- harness ----------------------------------------------------------------

// An http server on a random port whose every upgrade becomes a ws connection.
// onConnection gets (conn, req); the echo default is what most tests want.
async function startServer(onConnection, opts = {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // The daemon will check the token here before approving the echo; the tests
    // only need the echo itself.
    const requested = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
    const conn = handleUpgrade(req, socket, head, { protocol: requested, ...opts });
    if (conn) onConnection(conn, req);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const nextEvent = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
const nextWsEvent = (ws, name) => new Promise((resolve) => ws.addEventListener(name, resolve, { once: true }));

// One masked client frame. `fin: false` plus opcode 0 is how a fragmented
// message is built.
function maskedFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

// Pull whole server frames (never masked) out of a buffer; returns the frames
// and whatever tail is left over.
function parseFrames(buf) {
  const frames = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const b0 = buf[at];
    let len = buf[at + 1] & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length < off + 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    if (buf.length < off + len) break;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: buf.subarray(off, off + len) });
    at = off + len;
  }
  return { frames, rest: buf.subarray(at) };
}

// A raw client: does the handshake by hand, then hands back write() plus a
// waitFor(opcode) over the parsed server frames.
async function rawClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  await nextEvent(socket, 'connect');
  const key = crypto.randomBytes(16).toString('base64');
  socket.write([
    'GET /term HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n'));

  let buf = Buffer.alloc(0);
  let handshake = null;
  const frames = [];
  let waiter = null;
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshake) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buf.subarray(0, end).toString('utf8');
      buf = buf.subarray(end + 4);
    }
    const parsed = parseFrames(buf);
    buf = parsed.rest;
    for (const f of parsed.frames) frames.push(f);
    if (waiter) {
      const hit = frames.findIndex((f) => f.opcode === waiter.opcode);
      if (hit >= 0) {
        const { resolve } = waiter;
        waiter = null;
        resolve(frames.splice(hit, 1)[0]);
      }
    }
  });
  // Wait for the 101 before any test writes a frame.
  while (!handshake) await new Promise((r) => setTimeout(r, 5));
  assert.match(handshake, /^HTTP\/1\.1 101 /, 'handshake did not switch protocols');
  assert.ok(handshake.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`), 'accept digest is wrong');

  return {
    socket,
    write: (b) => socket.write(b),
    waitFor(opcode) {
      const hit = frames.findIndex((f) => f.opcode === opcode);
      if (hit >= 0) return Promise.resolve(frames.splice(hit, 1)[0]);
      return new Promise((resolve) => { waiter = { opcode, resolve }; });
    },
  };
}

// --- handshake --------------------------------------------------------------

test('a non-websocket upgrade gets 400 and a closed socket', async () => {
  const server = await startServer(() => assert.fail('should not have reached a connection'));
  const socket = net.connect(server.port, '127.0.0.1');
  await nextEvent(socket, 'connect');
  socket.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n`);
  let text = '';
  socket.on('data', (c) => { text += c.toString('utf8'); });
  await nextEvent(socket, 'close');
  assert.match(text, /^HTTP\/1\.1 400 /);
  await server.stop();
});

test('a requested subprotocol is echoed back', async () => {
  const server = await startServer(() => {});
  const ws = new WebSocket(server.url, ['lazydev-token-abc']);
  await nextWsEvent(ws, 'open');
  assert.equal(ws.protocol, 'lazydev-token-abc');
  ws.close();
  await server.stop();
});

// --- round trips against Node's own client ----------------------------------

test('text, binary and a 70 KB frame round trip with the global WebSocket', async () => {
  const server = await startServer((conn) => conn.on('message', (data) => conn.send(data)));
  const ws = new WebSocket(server.url);
  ws.binaryType = 'arraybuffer';
  await nextWsEvent(ws, 'open');

  ws.send('hello');
  assert.equal((await nextWsEvent(ws, 'message')).data, 'hello');

  // 70 KB is past the 16-bit length form in both directions: the client writes a
  // 64-bit header and so does our encoder on the way back.
  const big = 'z'.repeat(70 * 1024);
  ws.send(big);
  const echoed = (await nextWsEvent(ws, 'message')).data;
  assert.equal(echoed.length, big.length);
  assert.equal(echoed, big);

  const bytes = crypto.randomBytes(70 * 1024);
  ws.send(bytes);
  const backAsBinary = (await nextWsEvent(ws, 'message')).data;
  assert.ok(backAsBinary instanceof ArrayBuffer, 'a Buffer from the server must arrive as binary');
  assert.ok(Buffer.from(backAsBinary).equals(bytes));

  ws.close();
  await server.stop();
});

test('a masked close frame from the client ends the handshake with its code and reason', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; });
  const ws = new WebSocket(server.url);
  await nextWsEvent(ws, 'open');
  const closedOnServer = nextEvent(conn, 'close');
  ws.close(4001, 'bye');
  const [code, reason] = await closedOnServer;
  assert.equal(code, 4001);
  assert.equal(reason, 'bye');
  const ev = await nextWsEvent(ws, 'close');
  assert.equal(ev.code, 4001, 'the server must echo the code back so the client closes cleanly');
  assert.equal(ev.wasClean, true);
  await server.stop();
});

test('close() from the server reaches the client', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; });
  const ws = new WebSocket(server.url);
  await nextWsEvent(ws, 'open');
  conn.close(4002, 'sleeping');
  const ev = await nextWsEvent(ws, 'close');
  assert.equal(ev.code, 4002);
  assert.equal(ev.reason, 'sleeping');
  await server.stop();
});

// --- paths the global client cannot produce ---------------------------------

test('a fragmented message is reassembled into one message', async () => {
  const seen = [];
  const server = await startServer((conn) => conn.on('message', (data, binary) => {
    seen.push([data, binary]);
    conn.send(`got:${data}`);
  }));
  const client = await rawClient(server.port);
  client.write(maskedFrame(0x1, 'he', false));
  client.write(maskedFrame(0x0, 'll', false));
  client.write(maskedFrame(0x0, 'o', true));
  const reply = await client.waitFor(0x1);
  assert.equal(reply.payload.toString('utf8'), 'got:hello');
  assert.deepEqual(seen, [['hello', false]], 'three frames must arrive as exactly one text message');
  client.socket.destroy();
  await server.stop();
});

test('a binary message split across frames stays binary', async () => {
  let got = null;
  const server = await startServer((conn) => conn.on('message', (data, binary) => { got = { data, binary }; conn.send('ok'); }));
  const client = await rawClient(server.port);
  client.write(maskedFrame(0x2, Buffer.from([1, 2]), false));
  client.write(maskedFrame(0x0, Buffer.from([3, 4]), true));
  await client.waitFor(0x1);
  assert.equal(got.binary, true);
  assert.ok(Buffer.isBuffer(got.data));
  assert.deepEqual([...got.data], [1, 2, 3, 4]);
  client.socket.destroy();
  await server.stop();
});

test('a ping is answered with a pong carrying the same payload', async () => {
  const server = await startServer(() => {});
  const client = await rawClient(server.port);
  client.write(maskedFrame(0x9, 'keepalive'));
  const pong = await client.waitFor(0xa);
  assert.equal(pong.payload.toString('utf8'), 'keepalive');
  assert.equal(pong.fin, true);
  client.socket.destroy();
  await server.stop();
});

test('a pong from the client is surfaced, not treated as a message', async () => {
  let conn;
  const messages = [];
  const server = await startServer((c) => { conn = c; c.on('message', (m) => messages.push(m)); });
  const client = await rawClient(server.port);
  const pong = nextEvent(conn, 'pong');
  client.write(maskedFrame(0xa, 'pp'));
  assert.equal((await pong)[0].toString('utf8'), 'pp');
  assert.deepEqual(messages, []);
  client.socket.destroy();
  await server.stop();
});

test('ping() from the server is answered by the global client', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; });
  const ws = new WebSocket(server.url);
  await nextWsEvent(ws, 'open');
  const pong = nextEvent(conn, 'pong');
  conn.ping('are you there');
  assert.equal((await pong)[0].toString('utf8'), 'are you there');
  ws.close();
  await server.stop();
});

// --- clients behaving badly -------------------------------------------------

test('a client that dies mid-frame closes with 1006 and delivers nothing', async () => {
  let conn;
  const messages = [];
  const server = await startServer((c) => { conn = c; c.on('message', (m) => messages.push(m)); });
  const client = await rawClient(server.port);
  const closed = nextEvent(conn, 'close');
  // A header promising 1000 bytes, then 10 of them, then the socket is gone.
  const half = maskedFrame(0x1, 'x'.repeat(1000)).subarray(0, 2 + 4 + 10);
  client.write(half);
  await new Promise((r) => setTimeout(r, 20));
  client.socket.destroy();
  const [code] = await closed;
  assert.equal(code, 1006);
  assert.deepEqual(messages, [], 'a half-written frame must never be delivered');
  await server.stop();
});

test('a frame over the cap is refused with 1009 instead of buffered', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; }, { maxPayload: 4096 });
  const client = await rawClient(server.port);
  const errored = nextEvent(conn, 'error');
  const closed = nextEvent(conn, 'close');
  // A 64-bit length claiming 8 GB, with no payload behind it at all.
  const head = Buffer.alloc(14);
  head[0] = 0x81;
  head[1] = 0x80 | 127;
  head.writeBigUInt64BE(8n * 1024n * 1024n * 1024n, 2);
  client.write(head);
  const close = await client.waitFor(0x8);
  assert.equal(close.payload.readUInt16BE(0), 1009);
  assert.match((await errored)[0].message, /too large/);
  assert.equal((await closed)[0], 1009);
  client.socket.destroy();
  await server.stop();
});

test('an unmasked client frame is a protocol error', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; });
  const client = await rawClient(server.port);
  const closed = nextEvent(conn, 'close');
  client.write(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi', 'utf8')]));
  const close = await client.waitFor(0x8);
  assert.equal(close.payload.readUInt16BE(0), 1002);
  assert.equal((await closed)[0], 1002);
  client.socket.destroy();
  await server.stop();
});

// A peer that keeps its read half open after we end() ours goes on delivering
// 'data' forever. Nothing reads it once the connection is closed (#read returns
// on the closed flag), so every byte used to pile up in this.rx: 64 MB written
// was 64 MB held, and the socket itself was never destroyed, because only
// close() ever armed the destroy timer.
test('a peer that keeps writing after a protocol error is dropped, not buffered', async () => {
  let conn;
  const server = await startServer((c) => { conn = c; });
  // allowHalfOpen: our FIN does not make this client FIN back, which is the
  // whole point — a well-behaved client goes away on its own.
  const socket = net.connect({ port: server.port, host: '127.0.0.1', allowHalfOpen: true });
  await nextEvent(socket, 'connect');
  socket.resume();
  socket.write([
    'GET /term HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n'));
  await new Promise((r) => setTimeout(r, 100));

  try {
    const closed = nextEvent(conn, 'close');
    socket.write(Buffer.from([0x81, 0x01, 0x41])); // unmasked -> 1002
    assert.equal((await closed)[0], 1002);

    for (let i = 0; i < 4; i++) socket.write(Buffer.alloc(256 * 1024, 0x41));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(conn.rx.length, 0, 'a closed connection buffers nothing');

    let destroyed = false;
    for (let i = 0; i < 40 && !destroyed; i++) {
      destroyed = conn.socket.destroyed;
      if (!destroyed) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(destroyed, 'the socket is destroyed, not left open for the peer to write into');
  } finally {
    socket.destroy();
    await server.stop();
  }
});

test('fragments that together exceed the cap are refused', async () => {
  let conn;
  const messages = [];
  const server = await startServer((c) => { conn = c; c.on('message', (m) => messages.push(m)); }, { maxPayload: 4096 });
  const client = await rawClient(server.port);
  const closed = nextEvent(conn, 'close');
  client.write(maskedFrame(0x2, Buffer.alloc(3000), false));
  client.write(maskedFrame(0x0, Buffer.alloc(3000), true));
  const close = await client.waitFor(0x8);
  assert.equal(close.payload.readUInt16BE(0), 1009);
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(messages, []);
  client.socket.destroy();
  await server.stop();
});
