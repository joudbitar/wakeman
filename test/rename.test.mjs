// Rename control endpoint tests: POST /__lazydev/rename/<host> { to } must
// rewrite the registry file (the single source of truth — see the handler
// comment) and refuse everything else: bad names, the reserved dashboard
// host, collisions, unknown hosts, and callers without the capability token.
// Real daemon server, temp registry, no fixed ports.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LAZYDEV_CONFIG is read at module load, so the temp registry must exist and
// the env var must point at it BEFORE importing lazydev.mjs.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-rename-'));
const CONFIG_PATH = path.join(TMP_ROOT, 'projects.json');
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-renamedir-'));

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
process.env.LAZYDEV_CONFIG = CONFIG_PATH;
process.env.LAZYDEV_CONTROL_TOKEN_PATH = path.join(TMP_ROOT, 'control-token');

const { createDaemonServer, loadConfig, ensureControlToken } = await import('../lazydev.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function postJson(port, reqPath, { token, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = { host: 'lazydev.localhost', 'content-type': 'application/json' };
  if (token) headers['x-lazydev-token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: reqPath, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
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
  const res = await postJson(daemonPort, '/__lazydev/rename/proj', { body: { to: 'stolen' } });
  assert.equal(res.status, 403);
});

test('rejects an unknown host, a bad name, the dashboard host, and a taken name', async () => {
  const cases = [
    ['/__lazydev/rename/ghost', { to: 'anything' }, 404],
    ['/__lazydev/rename/proj', { to: 'Has Spaces' }, 400],
    ['/__lazydev/rename/proj', { to: '-leading-hyphen' }, 400],
    ['/__lazydev/rename/proj', { to: 'lazydev' }, 400],
    ['/__lazydev/rename/proj', { to: 'other' }, 409],
    ['/__lazydev/rename/proj', undefined, 400],
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
  const res = await postJson(daemonPort, '/__lazydev/rename/proj', { token, body: { to: 'renamed' } });
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
      { host: '127.0.0.1', port: daemonPort, path: '/__lazydev/status', headers: { host: 'lazydev.localhost' } },
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
