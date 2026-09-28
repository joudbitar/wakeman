// Viewables: throwaway static pages get tagged, shelved apart from projects,
// archived after N days unopened, and deleted only by hand (to the Trash).
//
// The pure half (lib/viewables.mjs, the registry edits, the merge) is tested
// directly; the daemon half against a real daemon on an OS-assigned port with
// a throwaway state dir, the same way dashboard-routes.test.mjs does it.
// WAKEMAN_CONFIG and WAKEMAN_VIEWABLES_DIR are read at module load, so both are set
// before the dynamic import of ../wakeman.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isUnder,
  tagViewables,
  dueForArchive,
  archiveDays,
  trashFolder,
  DEFAULT_ARCHIVE_DAYS,
} from '../lib/viewables.mjs';
import { archiveEntry, restoreEntry } from '../lib/registry-cli.mjs';
import { mergeRegistry } from '../lib/registry.mjs';

const DAY = 86_400_000;

// --- pure ---------------------------------------------------------------------

test('isUnder is strict: the root itself and siblings with a shared prefix are out', () => {
  assert.equal(isUnder('/h/viewables/a', '/h/viewables'), true);
  assert.equal(isUnder('/h/viewables/a/b', '/h/viewables'), true);
  assert.equal(isUnder('/h/viewables', '/h/viewables'), false);
  assert.equal(isUnder('/h/viewables-old/a', '/h/viewables'), false);
  assert.equal(isUnder('/h/viewables/../x', '/h/viewables'), false);
});

test('tagViewables tags only untagged entries under the root, and is idempotent', () => {
  const reg = {
    projects: [
      { host: 'a', dir: '/h/viewables/a' },
      { host: 'b', dir: '/h/work/b' },
      { host: 'c', dir: '/h/viewables/c', kind: 'something-else' },
    ],
  };
  assert.equal(tagViewables(reg, '/h/viewables'), 1);
  assert.equal(reg.projects[0].kind, 'viewable');
  assert.equal(reg.projects[1].kind, undefined);
  assert.equal(reg.projects[2].kind, 'something-else');
  assert.equal(tagViewables(reg, '/h/viewables'), 0);
});

test('dueForArchive: the newest of opened and file time decides, and only live viewables count', () => {
  const now = 100 * DAY;
  const projects = [
    { host: 'stale', dir: '/v/stale', kind: 'viewable' },
    { host: 'opened', dir: '/v/opened', kind: 'viewable' },
    { host: 'edited', dir: '/v/edited', kind: 'viewable' },
    { host: 'gone', dir: '/v/gone', kind: 'viewable' },
    { host: 'already', dir: '/v/already', kind: 'viewable', archived: 1 },
    { host: 'project', dir: '/w/project' },
  ];
  const files = { '/v/stale': now - 20 * DAY, '/v/opened': now - 20 * DAY, '/v/edited': now - 2 * DAY, '/v/already': 1, '/w/project': 1 };
  const due = dueForArchive(projects, {
    opened: { opened: now - 13 * DAY },
    now,
    days: 14,
    touched: (d) => files[d] || 0,
  });
  assert.deepEqual(due, ['stale']);
});

test('archiveDays falls back to the default on junk', () => {
  assert.equal(archiveDays({}), DEFAULT_ARCHIVE_DAYS);
  assert.equal(archiveDays({ viewableArchiveDays: -3 }), DEFAULT_ARCHIVE_DAYS);
  assert.equal(archiveDays({ viewableArchiveDays: 3 }), 3);
});

test('archive parks the entry; restore brings it back enabled', () => {
  const reg = { projects: [{ host: 'a', dir: '/v/a', enabled: true, kind: 'viewable' }] };
  archiveEntry(reg, 'a', 42);
  assert.equal(reg.projects[0].archived, 42);
  assert.equal(reg.projects[0].enabled, false);
  restoreEntry(reg, 'a');
  assert.equal(reg.projects[0].archived, undefined);
  assert.equal(reg.projects[0].enabled, true);
});

test('a rescan keeps kind and archived on entries it rediscovers', () => {
  const projects = mergeRegistry({
    existing: { projects: [{ host: 'site', dir: '/v/site', port: 3010, startCmd: '$WAKEMAN_STATIC', framework: 'static', enabled: false, kind: 'viewable', archived: 7 }] },
    candidates: [{ dir: '/v/site', name: 'site', framework: 'static' }],
    startCmdFor: () => '$WAKEMAN_STATIC',
    sanitizeHost: (n) => n,
    dirExists: () => true,
  });
  assert.equal(projects[0].kind, 'viewable');
  assert.equal(projects[0].archived, 7);
});

test('trashFolder refuses anything outside the root, including via a symlink', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-trash-'));
  const root = path.join(tmp, 'viewables');
  const outside = path.join(tmp, 'precious');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => trashFolder(outside, root, { home: tmp }), /not inside/);
  assert.throws(() => trashFolder(root, root, { home: tmp }), /not inside/);
  assert.throws(() => trashFolder(path.join(root, 'link'), root, { home: tmp }), /resolves outside/);
  assert.ok(fs.existsSync(outside));
});

test('trashFolder moves into ~/.Trash when there is one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-trash-'));
  const root = path.join(tmp, 'viewables');
  fs.mkdirSync(path.join(root, 'page'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.Trash'));
  const out = trashFolder(path.join(root, 'page'), root, { home: tmp });
  assert.equal(out.trashed, path.join(tmp, '.Trash', 'page'));
  assert.ok(fs.existsSync(out.trashed));
  assert.ok(!fs.existsSync(path.join(root, 'page')));
});

// --- daemon -------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-view-'));
const CONFIG_PATH = path.join(TMP, 'projects.json');
const VROOT = path.join(TMP, 'viewables');
const page = (name, ageDays) => {
  const dir = path.join(VROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<h1>${name}</h1>`);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(path.join(dir, 'index.html'), t, t);
  fs.utimesSync(dir, t, t);
  return dir;
};
const PROJECT_DIR = path.join(TMP, 'proj');
fs.mkdirSync(PROJECT_DIR);

fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  port: 0,
  projects: [
    { host: 'proj', dir: PROJECT_DIR, port: 39101, startCmd: 'true', framework: 'node', enabled: true },
    { host: 'fresh', dir: page('fresh', 1), port: 39102, startCmd: '$WAKEMAN_STATIC', framework: 'node', enabled: true },
    { host: 'old', dir: page('old', 20), port: 39103, startCmd: '$WAKEMAN_STATIC', framework: 'node', enabled: true },
  ],
}, null, 2));

process.env.WAKEMAN_CONFIG = CONFIG_PATH;
process.env.WAKEMAN_CONTROL_TOKEN_PATH = path.join(TMP, 'control-token');
process.env.WAKEMAN_LOGS_DIR = path.join(TMP, 'logs');
process.env.WAKEMAN_VIEWABLES_DIR = VROOT;

const { createDaemonServer, loadConfig, ensureControlToken, sweepViewables, dashboardHtml, upstreamAgent } = await import('../wakeman.mjs');

let daemon;
let daemonPort;
let token;
const readReg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const entryFor = (host) => readReg().projects.find((p) => p.host === host) || null;

function req(pathname, { method = 'POST', host = 'wakeman.localhost', auth = true } = {}) {
  const headers = { host };
  if (auth) headers['x-wakeman-token'] = token;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: daemonPort, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, json, body: text });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  loadConfig('test:viewables');
  token = ensureControlToken();
  daemon = createDaemonServer();
  daemonPort = await new Promise((resolve) => daemon.listen(0, '127.0.0.1', () => resolve(daemon.address().port)));
});

after(() => {
  daemon.close();
  upstreamAgent.destroy();
});

test('loading the registry tags the entries under the viewables root', () => {
  assert.equal(entryFor('fresh').kind, 'viewable');
  assert.equal(entryFor('old').kind, 'viewable');
  assert.equal(entryFor('proj').kind, undefined);
});

test('the sweep archives only the stale viewable, and its URL answers 410', async () => {
  const due = await sweepViewables();
  assert.deepEqual(due, ['old']);
  assert.ok(entryFor('old').archived);
  assert.equal(entryFor('old').enabled, false);
  assert.equal(entryFor('fresh').archived, undefined);
  assert.ok(fs.existsSync(path.join(VROOT, 'old')), 'archiving never touches the folder');
  const res = await req('/', { method: 'GET', host: 'old.localhost', auth: false });
  assert.equal(res.status, 410);
});

test('the dashboard shelves viewables and archived entries apart from projects', () => {
  const html = dashboardHtml();
  const [main, rest] = html.split('id="shelf-viewables"');
  assert.match(main, /data-host="proj"/);
  assert.doesNotMatch(main, /data-host="fresh"/);
  assert.match(rest, /data-host="fresh"/);
  assert.match(rest.split('id="shelf-archived"')[1], /data-archived="old"/);
});

test('delete refuses a live viewable and a project', async () => {
  assert.equal((await req('/__wakeman/delete/fresh')).status, 409);
  assert.equal((await req('/__wakeman/delete/proj')).status, 409);
  assert.equal((await req('/__wakeman/delete/old', { auth: false })).status, 403);
});

test('restore brings it back and resets its clock so the next sweep leaves it', async () => {
  const res = await req('/__wakeman/restore/old');
  assert.equal(res.status, 200);
  assert.equal(entryFor('old').archived, undefined);
  assert.equal(entryFor('old').enabled, true);
  assert.deepEqual(await sweepViewables(), []);
  const opened = JSON.parse(fs.readFileSync(path.join(TMP, 'opened.json'), 'utf8'));
  assert.ok(opened.old > Date.now() - 60_000);
});

test('archive by hand, then delete moves the folder out and drops the entry', async () => {
  assert.equal((await req('/__wakeman/archive/old')).status, 200);
  const res = await req('/__wakeman/delete/old');
  assert.equal(res.status, 200, res.body);
  assert.equal(entryFor('old'), null);
  assert.ok(!fs.existsSync(path.join(VROOT, 'old')));
  // A test run must not litter the real Trash.
  if (res.json.trashed) fs.rmSync(res.json.trashed, { recursive: true, force: true });
});
