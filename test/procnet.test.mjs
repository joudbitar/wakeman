// lib/procnet.mjs: the listener lookup Linux answers from /proc. Driven with
// fixture text so it runs on any OS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListenInodes, listenerPid, processCwd, processName } from '../lib/procnet.mjs';

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
// :3000 listening on loopback, :3000 as an ESTABLISHED client, :80 on the wildcard.
const TCP = [
  HEAD,
  '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1',
  '   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 17 1 0000000000000000 100 0 0 10 0',
].join('\n');
const TCP6 = [
  HEAD,
  '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55001 1 0000000000000000 100 0 0 10 0',
].join('\n');

test('parseListenInodes keeps LISTEN rows on the port and nothing else', () => {
  assert.deepEqual([...parseListenInodes(TCP, 3000)], ['41234'], 'the ESTABLISHED row on :3000 is not a listener');
  assert.deepEqual([...parseListenInodes(TCP, 80)], ['17']);
  assert.deepEqual([...parseListenInodes(TCP6, 8080)], ['55001']);
  assert.equal(parseListenInodes(TCP, 4000).size, 0);
  assert.equal(parseListenInodes('', 3000).size, 0);
});

// A fake /proc: pid 500 is someone else's (fd dir unreadable), pid 612 holds
// the :3000 listener, pid 700 holds the v6 :8080 one.
function fakeProc() {
  const files = {
    '/proc/net/tcp': TCP,
    '/proc/net/tcp6': TCP6,
    '/proc/612/comm': 'node\n',
  };
  const dirs = {
    '/proc': ['1', '500', '612', '700', 'net', 'self'],
    '/proc/1/fd': ['0'],
    '/proc/612/fd': ['0', '1', '2', '21'],
    '/proc/700/fd': ['9'],
  };
  const links = {
    '/proc/1/fd/0': '/dev/null',
    '/proc/612/fd/0': '/dev/null',
    '/proc/612/fd/1': 'pipe:[900]',
    '/proc/612/fd/2': 'pipe:[901]',
    '/proc/612/fd/21': 'socket:[41234]',
    '/proc/700/fd/9': 'socket:[55001]',
    '/proc/612/cwd': '/home/a/code/site',
  };
  const miss = (p) => Object.assign(new Error(`EACCES ${p}`), { code: 'EACCES' });
  return {
    readFile: (p) => { if (p in files) return files[p]; throw miss(p); },
    readdir: (p) => { if (p in dirs) return dirs[p]; throw miss(p); },
    readlink: (p) => { if (p in links) return links[p]; throw miss(p); },
  };
}

test('listenerPid finds the process holding the socket, v4 or v6', () => {
  const io = fakeProc();
  assert.equal(listenerPid(3000, { io }), 612);
  assert.equal(listenerPid(8080, { io }), 700);
});

test('listenerPid is null for a free port or a listener it cannot see', () => {
  const io = fakeProc();
  assert.equal(listenerPid(4000, { io }), null, 'nothing listens');
  assert.equal(listenerPid(80, { io }), null, "root's socket, no fd link we can read");
});

test('listenerPid never throws without a /proc', () => {
  const io = { readFile() { throw new Error('ENOENT'); }, readdir() { throw new Error('ENOENT'); }, readlink() { throw new Error('ENOENT'); } };
  assert.equal(listenerPid(3000, { io }), null);
});

test('processCwd and processName read the pid, null when it is gone', () => {
  const io = fakeProc();
  assert.equal(processCwd(612, { io }), '/home/a/code/site');
  assert.equal(processName(612, { io }), 'node');
  assert.equal(processCwd(999, { io }), null);
  assert.equal(processName(999, { io }), null);
});
