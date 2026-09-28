// wakeman's WebSocket server half: RFC 6455, built-ins only.
//
// The terminal panel needs a bidirectional byte pipe between the browser and a
// dev server's pty, and `wakeman attach` needs the same pipe from a shell. Node
// 22 ships a WebSocket *client* (global WebSocket) but no server, and the whole
// point of this package is that it installs with no runtime dependencies, so the
// server side is here: a handshake, a frame reader, a frame writer, and a close
// handshake. Nothing else. No permessage-deflate, no extensions, no subprotocol
// negotiation beyond echoing back the one value the caller approves. That value
// is how the term socket carries its control token, since a browser cannot set
// headers on a WebSocket (spec section 6).
//
// Frames arriving from a client are always masked (RFC 6455 5.1); frames we send
// never are. Payload lengths come in three forms (7-bit, 16-bit, 64-bit) and all
// three are read here, because a pty ring buffer replay is routinely past 64 KB.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// The magic string from RFC 6455 1.3, concatenated with the client's key to
// prove we actually parsed the handshake.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Frames bigger than this are refused instead of buffered. A pty replay is
// 256 KB and terminal input frames are tiny, so 1 MiB is slack; without a cap a
// client that lies about a 64-bit length makes the daemon allocate until it dies.
export const MAX_PAYLOAD = 1024 * 1024;

const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

// The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key.
export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

// Whether an http 'upgrade' request is a WebSocket one we can answer. The caller
// checks this before deciding auth, so a non-websocket upgrade on the same path
// does not look like a failed token.
export function isWebSocketUpgrade(req) {
  const headers = req?.headers || {};
  return String(headers.upgrade || '').toLowerCase() === 'websocket'
    && typeof headers['sec-websocket-key'] === 'string'
    && String(headers['sec-websocket-version']) === '13';
}

// Complete the handshake on an http 'upgrade' socket and return the connection.
//
//   req, socket, head   the three arguments of http's 'upgrade' event; `head` is
//                       any bytes the client already sent after the request, and
//                       they are the first thing fed to the frame reader
//   protocol            the single Sec-WebSocket-Protocol value to echo back, or
//                       '' for none. The caller decides this AFTER checking the
//                       token, so we never echo something unvetted
//   maxPayload          per-frame and per-message cap
//
// Returns a connection (send / ping / close, 'message' / 'close' / 'error'
// events), or null when the request is not a WebSocket 13 upgrade, in which case
// the socket has already been answered 400 and destroyed.
export function handleUpgrade(req, socket, head, { protocol = '', maxPayload = MAX_PAYLOAD } = {}) {
  if (!isWebSocketUpgrade(req)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
  ];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  return new WebSocketConnection(socket, head, maxPayload);
}

// One frame, server side: never masked, always final. Header length follows the
// payload: 2 bytes under 126, 4 up to 64 KB, 10 beyond.
function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload], head.length + len);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head, maxPayload = MAX_PAYLOAD) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.rx = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frags = [];        // pieces of a fragmented message, in order
    this.fragOp = 0;        // opcode the fragmented message started with, 0 when idle
    this.fragLen = 0;
    this.sentClose = false;
    this.closed = false;
    this.closeTimer = null;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => {
      // Nothing reads this buffer once the connection is closed (#read returns
      // on the flag), so appending to it would be a leak with no reader: a peer
      // that keeps its read half open and keeps writing would grow it until the
      // daemon died. Drop the bytes instead; #done arms the socket's teardown.
      if (this.closed) return;
      this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
      this.#read();
    });
    // A client that dies mid-frame lands here: no close frame, so 1006 (abnormal)
    // is the code, same as every other WebSocket implementation reports.
    socket.on('error', (err) => {
      if (this.listenerCount('error')) this.emit('error', err);
      this.#done(1006, '');
    });
    socket.on('close', () => this.#done(1006, ''));
    // An upgraded socket can sit half-open: a peer that vanishes gives us 'end'
    // and, with our writable side still up, no 'close' at all. So the peer's FIN
    // is the end of the connection here, and we let go of our half too.
    socket.on('end', () => {
      this.#done(1006, '');
      socket.end();
    });
    // Bytes that arrived with the handshake are real frames, but the caller only
    // attaches its listeners after we return, so read them a microtask later.
    if (this.rx.length) queueMicrotask(() => this.#read());
  }

  // Send a message: a string goes as text, a Buffer as binary.
  send(data) {
    if (this.closed || this.sentClose) return false;
    if (Buffer.isBuffer(data)) return this.#write(OP.binary, data);
    if (ArrayBuffer.isView(data)) return this.#write(OP.binary, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return this.#write(OP.text, Buffer.from(String(data), 'utf8'));
  }

  ping(payload = Buffer.alloc(0)) {
    return this.#write(OP.ping, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  }

  // Start the close handshake. The peer answers with its own close frame and the
  // socket dies then; the timer is the backstop for a peer that never answers.
  close(code = 1000, reason = '') {
    if (this.closed || this.sentClose) return;
    this.sentClose = true;
    const text = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.#write(OP.close, payload);
    this.socket.end();
    this.closeTimer = setTimeout(() => this.socket.destroy(), 5000);
    this.closeTimer.unref();
  }

  #write(opcode, payload) {
    if (this.closed || !this.socket.writable) return false;
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }

  // Pull every complete frame out of the receive buffer. Returns as soon as the
  // next frame is only partly here; the bytes stay in this.rx for the next chunk.
  #read() {
    while (!this.closed) {
      const buf = this.rx;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      if (b0 & 0x70) return this.#fail(1002, 'reserved bits set');
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        // Checked as a BigInt: a 64-bit length does not survive Number() intact,
        // and this is exactly the frame we must refuse rather than allocate for.
        if (big > BigInt(this.maxPayload)) return this.#fail(1009, 'frame too large');
        len = Number(big);
        off = 10;
      }
      // RFC 6455 5.1: every frame from a client is masked. An unmasked one is a
      // broken client or something rewriting the stream; either way, stop.
      if (!masked) return this.#fail(1002, 'client frame not masked');
      if (len > this.maxPayload) return this.#fail(1009, 'frame too large');
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.rx = buf.subarray(off + 4 + len);
      this.#frame(fin, opcode, payload);
    }
  }

  #frame(fin, opcode, payload) {
    // Control frames (5.5): never fragmented, never over 125 bytes.
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this.#fail(1002, 'bad control frame');
      if (opcode === OP.ping) return void this.#write(OP.pong, payload);
      if (opcode === OP.pong) return void this.emit('pong', payload);
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      // Echo the peer's code back unless we opened the handshake ourselves.
      if (!this.sentClose) {
        this.sentClose = true;
        this.#write(OP.close, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      }
      this.socket.end();
      return this.#done(code, reason);
    }
    if (opcode === OP.cont) {
      if (!this.fragOp) return this.#fail(1002, 'continuation with nothing to continue');
    } else if (this.fragOp) {
      return this.#fail(1002, 'new data frame inside a fragmented message');
    }
    const messageOp = opcode || this.fragOp;
    this.fragLen += payload.length;
    // The cap is per message as well as per frame: a thousand small fragments
    // must not do what one huge frame cannot.
    if (this.fragLen > this.maxPayload) return this.#fail(1009, 'message too large');
    this.frags.push(payload);
    this.fragOp = messageOp;
    if (!fin) return;
    const data = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags, this.fragLen);
    this.frags = [];
    this.fragOp = 0;
    this.fragLen = 0;
    // Text arrives as a string (the term socket's `i:` and `r:` lines), binary as
    // a Buffer (raw pty bytes).
    this.emit('message', messageOp === OP.text ? data.toString('utf8') : data, messageOp === OP.binary);
  }

  // A protocol violation: say why in a close frame, then stop reading. end()
  // rather than destroy() so the close frame actually reaches the peer.
  #fail(code, reason) {
    if (this.closed) return;
    if (this.listenerCount('error')) this.emit('error', new Error(reason));
    if (!this.sentClose) {
      this.sentClose = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.#write(OP.close, payload);
    }
    this.socket.end();
    this.#done(code, reason);
  }

  #done(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.rx = Buffer.alloc(0);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    // The paths that get here on purpose (#fail, a close frame from the peer)
    // have end()ed our writable half, and end() only half-closes: a peer that
    // never FINs back leaves the socket open, and us reading bytes nothing
    // consumes. So the connection gets one second to flush the close frame we
    // just wrote, then goes away. (close()'s own 5 s timer waits for the peer's
    // REPLY; this one waits for nothing but the kernel, hence shorter.)
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
    this.closeTimer.unref?.();
    this.emit('close', code, reason);
  }
}
