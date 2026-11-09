import { spawn } from "node:child_process";
import path from "node:path";
import { appConfig, projectRoot } from "../config.js";

export interface ZoteroArchiveInput {
  title?: string;
  url: string;
  pdfPath?: string;
  collectionKey?: string;
}

export type ZoteroArchiveResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  location?: string | null;
  raw?: string;
};

async function archiveLocally(input: ZoteroArchiveInput): Promise<ZoteroArchiveResult> {
  if (process.platform !== "win32") {
    return { ok: false, reason: "The shared Zotero local authorization helper currently requires Windows. Configure ZOTERO_API_MODE=web only if web access is desired." };
  }
  return new Promise((resolve) => {
    const child = spawn("python", [path.join(projectRoot, "scripts", "zotero_local_archive.py")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let output = "";
    let settled = false;
    const finish = (value: ZoteroArchiveResult) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(value); }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "Local Zotero archive timed out; check the library before retrying." });
    }, 45000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (output.length < 2_000_000) output += chunk; });
    // Avoid forwarding unexpected diagnostics that may contain user data.
    child.stderr.resume();
    child.on("error", () => finish({ ok: false, reason: "Could not start the Python Zotero local API helper." }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, reason: "The Zotero local API helper failed; check the library before retrying." });
      try {
        const result: unknown = JSON.parse(output);
        if (!result || typeof result !== "object" || typeof (result as ZoteroArchiveResult).ok !== "boolean") throw new Error("invalid result");
        finish(result as ZoteroArchiveResult);
      } catch {
        finish({ ok: false, reason: "The Zotero local API helper returned an invalid response; check the library before retrying." });
      }
    });
    child.stdin.on("error", () => { /* close/error handler reports helper failure */ });
    child.stdin.end(JSON.stringify(input));
  });
}

async function archiveOnWeb({ title, url, pdfPath, collectionKey }: ZoteroArchiveInput): Promise<ZoteroArchiveResult> {
  if (!appConfig.zoteroApiKey || !appConfig.zoteroUserId) {
    return { ok: false, skipped: true, reason: "Zotero Web API key or user ID is not configured." };
  }
  const item = {
    itemType: "journalArticle", title: title ?? url, url,
    ...(pdfPath ? { extra: `Local PDF: ${pdfPath}` } : {}),
    ...(collectionKey ? { collections: [collectionKey] } : {}),
  };
  const response = await fetch(`https://api.zotero.org/${appConfig.zoteroLibraryType}s/${appConfig.zoteroUserId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Zotero-API-Key": appConfig.zoteroApiKey },
    body: JSON.stringify([item]),
  });
  const raw = await response.text();
  if (!response.ok) return { ok: false, status: response.status, reason: "Zotero Web API rejected the request." };
  try {
    const result = JSON.parse(raw) as { failed?: Record<string, unknown>; success?: Record<string, string> };
    if (Object.keys(result.failed ?? {}).length || !result.success?.["0"]) {
      return { ok: false, status: response.status, reason: "Zotero did not confirm item creation; check the library before retrying." };
    }
  } catch {
    return { ok: false, status: response.status, reason: "Zotero returned an invalid response; check the library before retrying." };
  }
  return { ok: true, status: response.status, location: response.headers.get("Location"), raw };
}

export async function archiveToZotero(input: ZoteroArchiveInput): Promise<ZoteroArchiveResult> {
  if (input.collectionKey && !/^[A-Z0-9]{8}$/.test(input.collectionKey)) return { ok: false, reason: "Invalid Zotero collection key." };
  if (appConfig.zoteroApiMode === "local") return archiveLocally(input);
  if (appConfig.zoteroApiMode === "web") return archiveOnWeb(input);
  return { ok: false, reason: "ZOTERO_API_MODE must be local or web." };
}
