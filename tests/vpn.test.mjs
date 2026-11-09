import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureConfiguredVpn, ensureEduVpnConnected, isEduVpnConnected, isExternalVpnConnected, normalizeVpnMode, parseCommandArgs } from "../dist/services/eduvpn.js";

const names = ["VPN_MODE", "VPN_STATUS_EXECUTABLE", "VPN_STATUS_ARGS_JSON", "VPN_CONNECT_EXECUTABLE", "VPN_CONNECT_ARGS_JSON", "EDUVPN_SERVER_NAME", "EDUVPN_PROFILE_NAME", "EDUVPN_ADAPTER_NAME"];
async function withEnv(values, fn) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try { await fn(); } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
}
function ops(overrides = {}) {
  return { platform: "win32", isConnected: async () => false, findClient: () => "client", ensure: async () => {},
    isExternalConnected: async () => false, connectExternal: async () => {}, delay: async () => {}, ...overrides };
}

test("disabled mode does not check or connect", async () => withEnv({VPN_MODE:"none"}, async () => {
  const result = await ensureConfiguredVpn(ops({isConnected: async () => { throw new Error("must not check"); }}));
  assert.deepEqual(result, {mode:"none", status:"disabled"});
}));

test("automatic mode reuses an active eduVPN connection", async () => withEnv({}, async () => {
  let connects = 0;
  const result = await ensureConfiguredVpn(ops({isConnected: async () => true, ensure: async () => { connects++; }}));
  assert.equal(result.status, "connected");
  assert.equal(connects, 0);
}));

test("automatic mode remains nonblocking if client or profile unavailable", async () => withEnv({}, async () => {
  const missing = await ensureConfiguredVpn(ops({findClient: () => { throw new Error("missing"); }}));
  assert.equal(missing.status, "not_found");
  const failed = await ensureConfiguredVpn(ops({ensure: async () => { throw new Error("ambiguous"); }}));
  assert.equal(failed.status, "unavailable");
}));

test("strict mode and legacy provider aliases share generic semantics", async () => withEnv({VPN_MODE:"legacy-eduvpn"}, async () => {
  assert.equal(normalizeVpnMode("legacy-eduvpn"), "eduvpn");
  await assert.rejects(ensureConfiguredVpn(ops({ensure: async () => { throw new Error("not connected"); }})), /not connected/);
}));

test("named server or profile requires an explicit adapter mapping and never guesses", async () => {
  let attempts = 0;
  const deps = ops({isConnected: async () => {attempts++; return true;}, ensure: async () => {attempts++;}});
  await withEnv({EDUVPN_SERVER_NAME:"Example University"}, async () => {
    const result = await ensureConfiguredVpn(deps);
    assert.equal(result.status, "unavailable");
    assert.match(result.detail, /EDUVPN_ADAPTER_NAME/);
    await assert.rejects(isEduVpnConnected(), /EDUVPN_ADAPTER_NAME/);
  });
  await withEnv({VPN_MODE:"eduvpn",EDUVPN_PROFILE_NAME:"Profile"}, async () => {
    await assert.rejects(ensureConfiguredVpn(deps), /EDUVPN_ADAPTER_NAME/);
  });
  assert.equal(attempts, 0);
  await withEnv({EDUVPN_SERVER_NAME:"Example University", EDUVPN_ADAPTER_NAME:"eduVPN.example"}, async () => {
    assert.equal((await ensureConfiguredVpn(deps)).status, "connected");
    assert.equal(attempts, 1);
  });
});

test("a different active eduVPN tunnel is not switched", async () => {
  let started = 0;
  await assert.rejects(ensureEduVpnConnected({isConnected: async () => false, isAnyConnected: async () => true,
    isClientRunning: async () => false, startClient: async () => {started++;}, connectWithoutMouse: async () => {started++;}, delay: async () => {}}), /already active/);
  assert.equal(started, 0);
});

test("a detected third-party VPN adapter prevents an eduVPN connection attempt", async () => {
  let started = 0;
  await assert.rejects(ensureEduVpnConnected({isConnected: async () => false, isAnyConnected: async () => false, isOtherVpnConnected: async () => true,
    isClientRunning: async () => false, startClient: async () => {started++;}, connectWithoutMouse: async () => {started++;}, delay: async () => {}}), /Another VPN/);
  assert.equal(started, 0);
});

test("external mode never connects without a status check or on unknown status", async () => {
  let connects = 0;
  const deps = ops({connectExternal: async () => {connects++;}, isExternalConnected: async () => {throw new Error("unknown");}});
  await withEnv({VPN_MODE:"external",VPN_CONNECT_EXECUTABLE:"example"}, async () => {
    assert.equal((await ensureConfiguredVpn(deps)).status, "unavailable");
  });
  await withEnv({VPN_MODE:"external",VPN_STATUS_EXECUTABLE:"example",VPN_CONNECT_EXECUTABLE:"example"}, async () => {
    assert.equal((await ensureConfiguredVpn(deps)).status, "unavailable");
  });
  assert.equal(connects, 0);
});

test("external mode reuses an active connection and verifies after a single connect", async () => withEnv({VPN_MODE:"external",VPN_STATUS_EXECUTABLE:"status",VPN_CONNECT_EXECUTABLE:"connect"}, async () => {
  let calls = 0, connects = 0;
  const deps = ops({isExternalConnected: async () => ++calls > 1, connectExternal: async () => {connects++;}});
  assert.equal((await ensureConfiguredVpn(deps)).status, "connected");
  assert.equal(connects, 1);
  assert.equal((await ensureConfiguredVpn(ops({isExternalConnected: async () => true, connectExternal: async () => {connects++;}}))).status, "connected");
  assert.equal(connects, 1);
}));

test("external status process uses exit codes and arguments without a shell", async () => {
  await withEnv({VPN_STATUS_EXECUTABLE:process.execPath,VPN_STATUS_ARGS_JSON:JSON.stringify(["-e", "process.exit(0)"])}, async () => assert.equal(await isExternalVpnConnected(), true));
  await withEnv({VPN_STATUS_EXECUTABLE:process.execPath,VPN_STATUS_ARGS_JSON:JSON.stringify(["-e", "process.exit(1)"])}, async () => assert.equal(await isExternalVpnConnected(), false));
  await withEnv({VPN_STATUS_EXECUTABLE:process.execPath,VPN_STATUS_ARGS_JSON:JSON.stringify(["-e", "process.exit(2)"])}, async () => assert.rejects(isExternalVpnConnected(), /unknown status/));
  assert.deepEqual(parseCommandArgs('["a; do not run", "$(not a shell)"]'), ["a; do not run", "$(not a shell)"]);
  assert.throws(() => parseCommandArgs('{"not":"array"}'), /array of strings/);
});

test("external executable flow connects only when status says disconnected", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paper-vpn-test-"));
  const marker = path.join(dir, "connected");
  const status = `const f=require('node:fs'); process.exit(f.existsSync(process.argv[1]) ? 0 : 1);`;
  const connect = `const f=require('node:fs'); f.writeFileSync(process.argv[1], String((f.existsSync(process.argv[1]) ? Number(f.readFileSync(process.argv[1])) : 0)+1));`;
  try {
    await withEnv({VPN_MODE:"external",VPN_STATUS_EXECUTABLE:process.execPath,VPN_STATUS_ARGS_JSON:JSON.stringify(["-e",status,marker]),
      VPN_CONNECT_EXECUTABLE:process.execPath,VPN_CONNECT_ARGS_JSON:JSON.stringify(["-e",connect,marker])}, async () => {
      assert.equal((await ensureConfiguredVpn()).status, "connected");
      assert.equal((await ensureConfiguredVpn()).status, "connected");
      assert.equal(readFileSync(marker, "utf8"), "1");
    });
  } finally {
    try { unlinkSync(marker); } catch (error) { if (error.code !== "ENOENT") throw error; }
    rmdirSync(dir);
  }
});
