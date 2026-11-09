import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("local archive bridge handles collection, partial failure and authorization", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("python", ["-B", "tests/zotero_local_archive_test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("local Zotero API is the default", () => {
  const env = { ...process.env };
  delete env.ZOTERO_API_MODE;
  const code = `import {appConfig} from './dist/config.js'; process.stdout.write(appConfig.zoteroApiMode);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "local");
});

test("explicit web mode checks individual item failures", async () => {
  const env = { ...process.env, ZOTERO_API_MODE: "web", ZOTERO_USER_ID: "123", ZOTERO_API_KEY: "dummy" };
  const code = `
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({success:{},failed:{0:{message:'bad'}}}), headers: new Headers() });
    const {archiveToZotero} = await import('./dist/services/zotero.js');
    const result = await archiveToZotero({url:'https://example.org/paper'});
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).ok, false);
});
