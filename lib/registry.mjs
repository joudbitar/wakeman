// xerb registry merge — the pure half of the scanner.
//
// scan.mjs does the fs walk (find project roots, build candidate rows) and the
// write; the actual merge with the existing registry lives here so it can be
// exercised in isolation with no filesystem or network. Zero import-time work:
// no top-level fs, no side effects. The one fs dependency (does a carried-over
// directory still exist?) is INJECTED as `dirExists` so the function stays pure
// and tests can pass a fake predicate.

// Merge freshly-scanned candidates with the existing registry, preserving
// everything the registry already knows (hand-edited port/startCmd/enabled) and
// assigning fresh pool ports only to genuinely new hosts. Returns the merged
// projects array (nothing else — scan.mjs wraps it with port/timeouts/etc).
//
//   existing      parsed registry object (or null) — { projects: [...] }
//   candidates    scanned rows: [{ dir, name, framework, pm?, enabled?, ... }]
//                 (enabled: false marks a candidate the scanner registers
//                 parked, e.g. static folders; extra fields like a django
//                 interpreter ride along for startCmdFor; fixedPort carries a
//                 port the project's own dev script hardcodes — see below)
//   reservedHost  host the daemon owns; never emitted (default 'xerb')
//   poolStart     first port in the auto-assign pool (default 3010)
//   poolStep      pool stride (default 10)
//   startCmdFor   (candidate, port) -> startCmd string       [injected]
//   sanitizeHost  (name) -> host slug                        [injected]
//   dirExists     (dir) -> bool; used only for carry-over    [injected, required]
export function mergeRegistry({
  existing,
  candidates,
  reservedHost = 'xerb',
  poolStart = 3010,
  poolStep = 10,
  startCmdFor,
  sanitizeHost,
  dirExists,
}) {
  // Index the existing registry by host.
  const existingByHost = new Map();
  if (existing && Array.isArray(existing.projects)) {
    for (const p of existing.projects) {
      if (p && typeof p.host === 'string') existingByHost.set(p.host, p);
    }
  }

  // ------------------------------------------------------------------------
  // Assign unique hosts (sanitized name, collision -> -2, -3, ...).
  // Never emit reservedHost. Sort by dir for deterministic collision suffixing.
  // ------------------------------------------------------------------------
  const rows = [...candidates];
  const used = new Set([reservedHost]);
  rows.sort((a, b) => a.dir.localeCompare(b.dir));
  for (const c of rows) {
    let base = sanitizeHost(c.name) || 'project';
    if (base === reservedHost) base = `${base}-2`;
    let host = base;
    let n = 1;
    while (used.has(host)) {
      n += 1;
      host = `${base}-${n}`;
    }
    used.add(host);
    c.host = host;
  }

  // ------------------------------------------------------------------------
  // Port assignment: preserve known hosts' ports; fresh pool ports for new
  // hosts. Ports already taken by anything the registry knows about are off
  // limits.
  // ------------------------------------------------------------------------
  const takenPorts = new Set();
  for (const p of existingByHost.values()) {
    if (Number.isFinite(p.port)) takenPorts.add(p.port);
  }

  function nextFreePort() {
    let p = poolStart;
    while (takenPorts.has(p)) p += poolStep;
    takenPorts.add(p);
    return p;
  }

  // Deterministic port assignment for new hosts: sort by host.
  const sortedByHost = [...rows].sort((a, b) => a.host.localeCompare(b.host));
  // Claim every script-pinned port up front: assignment walks hosts in
  // alphabetical order, and without the pre-claim a host early in the order
  // could draw a pool port that a later host's dev script has hardcoded.
  for (const c of sortedByHost) {
    if (Number.isFinite(c.fixedPort)) takenPorts.add(c.fixedPort);
  }
  const portByHost = new Map();
  for (const c of sortedByHost) {
    const prev = existingByHost.get(c.host);
    // fixedPort is ground truth, not a preference: the project's own dev
    // script hardcodes it (`next dev -p 3000`), so the app binds that port no
    // matter what the registry says or what PORT the daemon injects. Register
    // anything else and every start is a guaranteed timeout — the app up and
    // healthy on its port, the daemon waiting on another. The one override
    // that still wins is a hand-set startCmd: a user who replaced the command
    // owns the port choice that goes with it.
    const handSetCmd = prev && typeof prev.startCmd === 'string'
      && prev.startCmd !== startCmdFor(c, Number.isFinite(prev.port) ? prev.port : c.fixedPort);
    if (Number.isFinite(c.fixedPort) && !handSetCmd) {
      portByHost.set(c.host, c.fixedPort);
      takenPorts.add(c.fixedPort); // pool assignments must steer around it
    } else if (prev && Number.isFinite(prev.port)) {
      portByHost.set(c.host, prev.port); // preserve existing
    } else {
      portByHost.set(c.host, nextFreePort());
    }
  }

  // ------------------------------------------------------------------------
  // Build final project objects (back in dir-sorted order).
  // ------------------------------------------------------------------------
  const projects = rows.map((c) => {
    const port = portByHost.get(c.host);
    const prev = existingByHost.get(c.host);
    const startCmd = prev && typeof prev.startCmd === 'string'
      ? prev.startCmd
      : startCmdFor(c, port);
    // A hand-set enabled flag always wins over whatever the scanner thinks;
    // otherwise the candidate's own default applies (static folders arrive
    // with enabled: false, everything else true).
    const enabled = prev && typeof prev.enabled === 'boolean'
      ? prev.enabled
      : (typeof c.enabled === 'boolean' ? c.enabled : true);
    const out = {
      host: c.host,
      dir: c.dir,
      port,
      startCmd,
      framework: c.framework,
      enabled,
    };
    // Tags a rescan knows nothing about still belong to the entry.
    if (prev && prev.kind) out.kind = prev.kind;
    if (prev && prev.archived) out.archived = prev.archived;
    return out;
  });

  // Carry over registry entries the walk didn't rediscover (hand-added static
  // servers, projects outside HOME) as long as their directory still exists.
  const discovered = new Set(projects.map((p) => p.host));
  for (const [host, prev] of existingByHost) {
    if (discovered.has(host)) continue;
    if (!prev.dir || !dirExists(prev.dir)) continue;
    projects.push(prev);
  }

  return projects;
}
