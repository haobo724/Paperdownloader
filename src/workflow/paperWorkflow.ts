import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { appConfig } from "../config.js";
import { PersistentEdgeBrowser, type CitationMeta } from "../browser/persistentBrowser.js";
import { extractSciencedirectPii, fetchElsevierPdf } from "../services/elsevier.js";
import { archiveToZotero, type ZoteroArchiveInput } from "../services/zotero.js";
import { ensureConfiguredVpn, type VpnStatus } from "../services/eduvpn.js";

export type PaperInfo = {
  pageUrl: string;
  title: string;
  citation: CitationMeta;
  /** Direct PDF URL if the page exposes one (usually means full-text access). */
  pdfUrl: string | null;
};

export class PaperWorkflow {
  constructor(private readonly browser = new PersistentEdgeBrowser(appConfig.userDataDir)) {}

  /** Open the article page and return metadata plus the detected PDF link, without downloading. */
  async inspectPaper(url: string): Promise<PaperInfo> {
    const page = await this.browser.openPage(url);
    try {
      const citation = await this.browser.readCitationMeta(page);
      return {
        pageUrl: page.url(),
        title: citation.title ?? (await page.title()).split(" | ")[0].trim(),
        citation,
        pdfUrl: await this.browser.waitForPdfUrl(page),
      };
    } finally {
      await page.close();
    }
  }

  /** Return the visible text of the article page, truncated to maxChars. */
  async readPaper(
    url: string,
    maxChars = 20_000,
  ): Promise<{ pageUrl: string; title: string; citation: CitationMeta; text: string; truncated: boolean }> {
    const page = await this.browser.openPage(url);
    try {
      const citation = await this.browser.readCitationMeta(page);
      const snapshot = await this.browser.snapshotPage(page);
      return {
        pageUrl: snapshot.url,
        title: citation.title ?? snapshot.title.split(" | ")[0].trim(),
        citation,
        text: snapshot.text.slice(0, maxChars),
        truncated: snapshot.text.length > maxChars,
      };
    } finally {
      await page.close();
    }
  }

  async downloadPaperPdf(
    url: string,
    fileName?: string,
  ): Promise<{
    url: string;
    pdfUrl: string;
    pdfPath: string;
    title: string;
    citation: CitationMeta;
    source: "elsevier-api" | "browser";
    apiFallbackReason?: string;
    vpn: VpnStatus;
  }> {
    const vpn = await ensureConfiguredVpn();
    try {
      // Prefer the official Elsevier API for ScienceDirect: no browser, no captcha.
      let apiFallbackReason: string | undefined;
      // Keep caller-supplied names inside downloadDir (no path separators / traversal).
      fileName = fileName?.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "").replace(/\.pdf$/i, "").trim() || undefined;
      const pii = extractSciencedirectPii(url);
      if (pii && appConfig.elsevierApiKey) {
        const api = await fetchElsevierPdf(pii);
        if (api.ok) {
          const title = api.citation.title ?? pii;
          const pdfPath = path.join(appConfig.downloadDir, `${fileName ?? this.buildSafeFileName(url, title)}.pdf`);
          await mkdir(path.dirname(pdfPath), { recursive: true });
          await writeFile(pdfPath, api.bytes);
          return { url, pdfUrl: `https://api.elsevier.com/content/article/pii/${pii}`, pdfPath, title, citation: api.citation, source: "elsevier-api", vpn };
        }
        apiFallbackReason = api.reason;
      }

      const page = await this.browser.openPage(url);

      try {
        const citation = await this.browser.readCitationMeta(page);
        const title = citation.title ?? (await page.title()).split(" | ")[0].trim();
        const pdfUrl = await this.browser.waitForPdfUrl(page);

        if (!pdfUrl) {
          const bodyText = await page.locator("body").innerText();
          const noAccess = /purchase pdf|get access|access through/i.test(bodyText);
          throw new Error(
            noAccess
              ? `No full-text access for ${url}. ${loginHint(url)}`
              : `No PDF link found on ${url}.`,
          );
        }

        const safeName = fileName ?? this.buildSafeFileName(url, title);
        const outputPath = path.join(appConfig.downloadDir, `${safeName}.pdf`);
        const pdfPath = await this.browser.fetchPdf(pdfUrl, outputPath, page).catch((error: Error) => {
          throw new Error(`${error.message}. If you lack full-text access: ${loginHint(url)}`);
        });

        return {
          url,
          pdfUrl,
          pdfPath,
          title,
          citation: { ...citation, pdfUrl },
          source: "browser",
          apiFallbackReason,
          vpn,
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      if (vpn.status === "not_found" || vpn.status === "unavailable") {
        throw new Error((error instanceof Error ? error.message : String(error)) + " [VPN: " + vpn.status + "; " + (vpn.detail ?? "unknown") + "]", { cause: error });
      }
      throw error;
    }
  }

  /** Open a tab and leave it open for the human user to log in; the session is persisted automatically. */
  async openForLogin(url: string): Promise<{ pageUrl: string; message: string }> {
    const page = await this.browser.openPage(url);
    await page.bringToFront().catch(() => undefined);
    return {
      pageUrl: page.url(),
      message:
        "Browser tab opened for human institutional sign-in or verification. " +
        "The session uses the persistent browser profile.",
    };
  }

  async archivePaper(input: ZoteroArchiveInput): Promise<{ ok: boolean; skipped?: boolean; reason?: string; status?: number; location?: string | null; raw?: string }> {
    return archiveToZotero(input);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private buildSafeFileName(url: string, title: string): string {
    const fromUrl = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "paper";
      }
    })();

    const sanitizedTitle = (title || fromUrl)
      .replace(/[^a-zA-Z0-9\-_ ]+/g, " ")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "paper";

    return `${sanitizedTitle}_${Date.now()}`;
  }
}

export const paperWorkflow = new PaperWorkflow();

function loginHint(url: string): string {
  return `Institutional sign-in or human verification may be required for ${url}.`;
}
