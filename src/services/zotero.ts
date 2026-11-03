import { appConfig } from "../config.js";

export interface ZoteroArchiveInput {
  title?: string;
  url: string;
  pdfPath?: string;
}

export async function archiveToZotero({ title, url, pdfPath }: ZoteroArchiveInput): Promise<{ ok: boolean; skipped?: boolean; reason?: string; status?: number; location?: string | null; raw?: string }> {
  if (!appConfig.zoteroApiKey || !appConfig.zoteroUserId) {
    return {
      ok: false,
      skipped: true,
      reason: "Zotero API key or user ID is not configured.",
    };
  }

  // The Zotero Web API expects an array of items. PDF file upload is not implemented yet; the local path is
  // recorded in "extra" so the file can be found.
  const payload = [
    {
      itemType: "journalArticle",
      title: title ?? url,
      url,
      ...(pdfPath ? { extra: `Local PDF: ${pdfPath}` } : {}),
    },
  ];

  const response = await fetch(`https://api.zotero.org/${appConfig.zoteroLibraryType}s/${appConfig.zoteroUserId}/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Zotero-API-Key": appConfig.zoteroApiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: rawText,
    };
  }

  return {
    ok: true,
    status: response.status,
    location: response.headers.get("Location"),
    raw: rawText,
  };
}
