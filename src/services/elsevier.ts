import { appConfig } from "../config.js";
import type { CitationMeta } from "../browser/persistentBrowser.js";

const API_BASE = "https://api.elsevier.com/content/article";

export type ElsevierResult =
  | { ok: true; bytes: Buffer; citation: CitationMeta }
  | { ok: false; reason: string };

/** Extract the PII from a ScienceDirect article URL, e.g. /science/article/abs/pii/S0021999118307125. */
export function extractSciencedirectPii(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.endsWith("sciencedirect.com")) {
      return null;
    }
    return pathname.match(/\/pii\/([0-9A-Z]+)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-ELS-APIKey": appConfig.elsevierApiKey };
  if (appConfig.elsevierInstToken) {
    headers["X-ELS-Insttoken"] = appConfig.elsevierInstToken;
  }
  return headers;
}

async function fetchMeta(pii: string): Promise<CitationMeta> {
  try {
    const response = await fetch(`${API_BASE}/pii/${pii}?view=META`, {
      headers: { ...authHeaders(), Accept: "application/json" },
    });
    if (!response.ok) {
      return { authors: [] };
    }
    const core = (await response.json())?.["full-text-retrieval-response"]?.coredata ?? {};
    const creators = Array.isArray(core["dc:creator"]) ? core["dc:creator"] : core["dc:creator"] ? [core["dc:creator"]] : [];
    return {
      title: core["dc:title"],
      doi: core["prism:doi"],
      journal: core["prism:publicationName"],
      publicationDate: core["prism:coverDate"],
      authors: creators.map((c: { $?: string } | string) => (typeof c === "string" ? c : c.$ ?? "")).filter(Boolean),
    };
  } catch {
    return { authors: [] };
  }
}

/**
 * Download a full-text PDF through the official Elsevier Article Retrieval API (TDM).
 * Requires ELSEVIER_API_KEY plus entitlement via institutional IP or ELSEVIER_INSTTOKEN.
 */
export async function fetchElsevierPdf(pii: string): Promise<ElsevierResult> {
  if (!appConfig.elsevierApiKey) {
    return { ok: false, reason: "ELSEVIER_API_KEY not configured" };
  }

  const response = await fetch(`${API_BASE}/pii/${pii}`, {
    headers: { ...authHeaders(), Accept: "application/pdf" },
  });
  const bytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const status = bytes.toString("utf8").match(/<statusText>([^<]+)<\/statusText>|"statusText":"([^"]+)"/);
    return { ok: false, reason: `Elsevier API ${response.status}: ${status?.[1] ?? status?.[2] ?? "request failed"}` };
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, reason: "Elsevier API did not return a PDF" };
  }

  return { ok: true, bytes, citation: await fetchMeta(pii) };
}
