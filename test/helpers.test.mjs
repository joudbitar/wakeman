// Pure-helper tests for the daemon: host-key resolution, install-command
// inference, and port probing. All values are asserted against the current
// documented behavior; the bracket-form cases in particular LOCK IN the current
// passthrough (a ']' in the host suppresses :port stripping) — assert as-is, do
// not "fix" it here. Pure node:test + node:assert, no real projects, no network,
// only ephemeral ports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { resolveHostKey, inferInstallCmd, probePort } from '../xerb.mjs';

test('resolveHostKey documented cases', () => {
  // Project subdomain, tenant subdomain, bare localhost.
  assert.equal(resolveHostKey('webapp.localhost'), 'webapp');
  assert.equal(resolveHostKey('tenant.webapp.localhost'), 'webapp');
  assert.equal(resolveHostKey('localhost'), null);
  // Port suffixes.
  assert.equal(resolveHostKey('webapp.localhost:4000'), 'webapp');
  assert.equal(resolveHostKey('name:4000'), 'name');
  // Empty input.
  assert.equal(resolveHostKey(''), null);
  // IP literals name no project: they resolve to null so the daemon serves the
  // dashboard instead of a 502 keyed on "1" or "[::1]:4000".
  assert.equal(resolveHostKey('127.0.0.1'), null);
  assert.equal(resolveHostKey('127.0.0.1:4000'), null);
  assert.equal(resolveHostKey('[::1]:4000'), null);
  assert.equal(resolveHostKey('[::1]'), null);
  // Reserved host passes through; lowercasing applies.
  assert.equal(resolveHostKey('xerb.localhost'), 'xerb');
  assert.equal(resolveHostKey('XERB.LOCALHOST'), 'xerb');
});

test('inferInstallCmd for each package manager + fallbacks', () => {
  assert.equal(inferInstallCmd('pnpm dev'), 'pnpm install');
  assert.equal(inferInstallCmd('yarn dev'), 'yarn install');
  assert.equal(inferInstallCmd('bun run dev'), 'bun install');
  assert.equal(inferInstallCmd('npm run dev'), 'npm install');
  // Empty and unknown both fall back to npm install.
  assert.equal(inferInstallCmd(''), 'npm install');
  assert.equal(inferInstallCmd('deno task dev'), 'npm install');
  assert.equal(inferInstallCmd(undefined), 'npm install');
});

test('probePort reports the loopback family that accepts, null when nothing listens', async (t) => {
  // Throwaway listener on an OS-assigned port on 127.0.0.1.
  const server = net.createServer(() => {});
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });

  // A listener on 127.0.0.1 -> probePort reports the IPv4 loopback family.
  assert.equal(await probePort(port, 300), '127.0.0.1');

  // Close it and probe the same port again -> nothing listens -> null.
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probePort(port, 300), null);
});
