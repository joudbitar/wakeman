// Rename control endpoint tests: POST /__wakeman/rename/<host> { to } must
// rewrite the registry file (the single source of truth — see the handler
// comment) and refuse everything else: bad names, the reserved dashboard
// host, collisions, unknown hosts, and callers without the capability token.
// Real daemon server, temp registry, no fixed ports.

import './isolate-logs.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WAKEMAN_CONFIG is read at module load, so the temp registry must exist and
// the env var must point at it BEFORE importing wakeman.mjs.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-rename-'));
const CONFIG_PATH = path.join(TMP_ROOT, 'projects.json');
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-renamedir-'));

function writeRegistry() {
  const registry = {
    port: 0,
    projects: [
      { host: 'proj', dir: PROJECT_DIR, port: 4101, startCmd: 'true', enabled: true, framework: 'node' },
      { host: 'other', dir: PROJECT_DIR, port: 4102, startCmd: 'true', enabled: true, framework: 'node' },
    ],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(registry));
}

writeRegistry();
process.env.WAKEMAN_CONFIG = CONFIG_PATH;
process.env.WAKEMAN_CONTROL_TOKEN_PATH = path.join(TMP_ROOT, 'control-token');

const { createDaemonServer, loadConfig, ensureControlToken } = await import('../wakeman.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function postJson(port, reqPath, { token, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = { host: 'wakeman.localhost', 'content-type': 'application/json' };
  if (token) headers['x-wakeman-token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: reqPath, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        // Not every answer is JSON: the crash path renders an HTML 500 page.
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* HTML, not JSON */ }
          resolve({ status: res.statusCode, json, body: text });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

let daemon;
let daemonPort;
let token;

before(async () => {
  writeRegistry();
  loadConfig('test:rename');
  token = ensureControlToken();
  daemon = createDaemonServer();
  daemonPort = await listen(daemon);
});

after(() => {
  daemon.close();
});

test('rejects a rename without the capability token', async () => {
  const res = await postJson(daemonPort, '/__wakeman/rename/proj', { body: { to: 'stolen' } });
  assert.equal(res.status, 403);
});

test('rejects an unknown host, a bad name, the dashboard host, and a taken name', async () => {
  const cases = [
    ['/__wakeman/rename/ghost', { to: 'anything' }, 404],
    ['/__wakeman/rename/proj', { to: 'Has Spaces' }, 400],
    ['/__wakeman/rename/proj', { to: '-leading-hyphen' }, 400],
    ['/__wakeman/rename/proj', { to: 'wakeman' }, 400],
    ['/__wakeman/rename/proj', { to: 'other' }, 409],
    ['/__wakeman/rename/proj', undefined, 400],
  ];
  for (const [reqPath, body, expected] of cases) {
    const res = await postJson(daemonPort, reqPath, { token, body });
    assert.equal(res.status, expected, `${reqPath} ${JSON.stringify(body)} -> ${res.status}`);
    assert.equal(res.json.ok, false);
  }
  // None of the rejections may have touched the registry file.
  const reg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.deepEqual(reg.projects.map((p) => p.host).sort(), ['other', 'proj']);
});

test('renames in the registry file and the live config', async () => {
  const res = await postJson(daemonPort, '/__wakeman/rename/proj', { token, body: { to: 'renamed' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, host: 'renamed' });

  // The file is the source of truth: the entry keeps everything but its host.
  const reg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const entry = reg.projects.find((p) => p.host === 'renamed');
  assert.ok(entry, 'renamed entry exists in the registry file');
  assert.equal(entry.port, 4101);
  assert.equal(reg.projects.some((p) => p.host === 'proj'), false);

  // The daemon reloaded: the old host is gone from live status, the new is in.
  const status = await new Promise((resolve, reject) => {
    http.get(
      { host: '127.0.0.1', port: daemonPort, path: '/__wakeman/status', headers: { host: 'wakeman.localhost' } },
      (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (text += c));
        r.on('end', () => resolve(JSON.parse(text)));
      }
    ).on('error', reject);
  });
  const hosts = status.projects.map((p) => p.host);
  assert.ok(hosts.includes('renamed'));
  assert.equal(hosts.includes('proj'), false);
});

// A registry write that fails for a reason no RegistryError covers (a read-only
// state dir, a full disk, a synced folder mid-sync) is a 500 by the handler's
// own comment. It used to be nothing at all: handleRequest is async, so a throw
// after its first await arrives as a rejection, and createDaemonServer's plain
// try/catch could not see it — the client got no response and the socket stayed
// open until the browser gave up.
test('a control route that throws after an await answers 500 instead of hanging', async (t) => {
  const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
  fs.chmodSync(CONFIG_PATH, 0o444);
  t.after(() => fs.chmodSync(CONFIG_PATH, mode));

  const res = await postJson(daemonPort, '/__wakeman/rename/other', { token, body: { to: 'newname' } });
  assert.equal(res.status, 500, 'the request is answered, not abandoned');
  assert.match(res.body, /Internal error/, 'and it says what happened');
});
