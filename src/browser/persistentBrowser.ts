import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { chromium, type BrowserContext, type Page } from "playwright";

const HUMAN_VERIFICATION_TIMEOUT_MS = Number(process.env.HUMAN_VERIFICATION_TIMEOUT_MS ?? 300_000);
/** How long to wait for PDF bytes when no human-verification challenge is shown. */
const PDF_RESPONSE_TIMEOUT_MS = 30_000;
const IN_PAGE_FETCH_TIMEOUT_MS = 20_000;
const IN_PAGE_RETRY_DELAYS_MS = [1_000, 2_000];
const CHALLENGE_TITLE = /just a moment|nur einen moment|un instant|un momento|are you a robot|attention required/i;

/** Remove query strings and fragments that may contain access tokens. */
function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

export type CitationMeta = {
  title?: string;
  doi?: string;
  journal?: string;
  publicationDate?: string;
  authors: string[];
  pdfUrl?: string;
};

export class PersistentEdgeBrowser {
  private context: BrowserContext | null = null;
  private cookieTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userDataDir: string = appConfig.userDataDir,
    private readonly channel: string = appConfig.browserChannel,
  ) {}

  private get sessionCookieFile(): string {
    return path.join(this.userDataDir, "session-cookies.json");
  }

  /**
   * Chromium drops session cookies (no expiry) on exit, which loses e.g. institutional access on
   * ScienceDirect. Snapshot them so the next launch can restore them.
   */
  private async saveSessionCookies(): Promise<void> {
    if (!this.context) {
      return;
    }
    try {
      const sessionCookies = (await this.context.cookies()).filter((c) => c.expires === -1);
      await writeFile(this.sessionCookieFile, JSON.stringify(sessionCookies), "utf8");
    } catch {
      // Context may be closing; the last snapshot is kept.
    }
  }

  private async restoreSessionCookies(context: BrowserContext): Promise<void> {
    try {
      const cookies = JSON.parse(await readFile(this.sessionCookieFile, "utf8"));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
      }
    } catch {
      // No snapshot yet.
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    await mkdir(this.userDataDir, { recursive: true });

    const isHeadless = process.env.PLAYWRIGHT_HEADLESS === "true" || process.env.CI === "true";

    try {
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        channel: this.channel || undefined,
        headless: isHeadless,
        viewport: { width: 1440, height: 1100 },
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("remote debugging is disallowed")) {
        throw new Error(
          `Browser channel "${this.channel}" refused automation: an enterprise policy (RemoteDebuggingAllowed=0) ` +
            "blocks Playwright. Unset BROWSER_CHANNEL to use Playwright's bundled Chromium.",
          { cause: error },
        );
      }
      throw new Error(`Failed to launch browser (channel: ${this.channel || "bundled chromium"}): ${message}`, {
        cause: error,
      });
    }

    await this.restoreSessionCookies(this.context);
    this.cookieTimer = setInterval(() => void this.saveSessionCookies(), 5_000);
    this.cookieTimer.unref();
    this.context.on("close", () => {
      if (this.cookieTimer) {
        clearInterval(this.cookieTimer);
        this.cookieTimer = null;
      }
      this.context = null;
    });

    return this.context;
  }

  async openPage(url: string): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    // Silent SSO hops (e.g. id.elsevier.com) redirect back to the requested host.
    const targetHost = new URL(url).hostname;
    await page.waitForURL((u) => u.hostname === targetHost, { timeout: 30_000 }).catch(() => undefined);
    await this.waitForHumanVerification(page);

    return page;
  }

  /**
   * If the page shows a bot challenge (e.g. Cloudflare Turnstile), bring the window to the front and
   * wait for the user to solve it manually. The challenge is never clicked automatically.
   */
  async waitForHumanVerification(page: Page): Promise<void> {
    const deadline = Date.now() + HUMAN_VERIFICATION_TIMEOUT_MS;
    let prompted = false;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error("Page was closed while waiting for human verification.");
      }
      if (!(await this.isChallengePage(page))) {
        if (prompted) {
          console.error("[browser] Verification passed.");
        }
        await page.waitForLoadState("load").catch(() => undefined);
        return;
      }
      if (!prompted) {
        prompted = true;
        await page.bringToFront().catch(() => undefined);
        console.error(`[browser] Human verification required on ${safeUrl(page.url())} - please complete it in the browser window.`);
      }
      await page.waitForTimeout(1_000);
    }

    throw new Error(`Human verification was not completed within ${HUMAN_VERIFICATION_TIMEOUT_MS / 1000}s.`);
  }

  private async inspectChallengePage(page: Page): Promise<boolean | null> {
    try {
      const title = await page.title();
      if (CHALLENGE_TITLE.test(title)) return true;
      return (await page.locator("iframe[src*='challenges.cloudflare.com']").count()) > 0;
    } catch {
      // A navigation can briefly destroy the page context; this is not evidence of a challenge.
      return null;
    }
  }

  private async isChallengePage(page: Page): Promise<boolean> {
    // During navigation, keep waiting rather than assuming verification has cleared.
    return (await this.inspectChallengePage(page)) ?? true;
  }

  // Note: callbacks passed to page.evaluate must not declare named inner functions, because tsx/esbuild
  // injects a `__name` helper into them that does not exist in the browser.
  async readCitationMeta(page: Page): Promise<CitationMeta> {
    let meta: string[][] | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        meta = await page.evaluate(() =>
          Array.from(document.querySelectorAll("meta[name^='citation_']")).map((m) => [
            m.getAttribute("name") ?? "",
            m.getAttribute("content")?.trim() ?? "",
          ]),
        );
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/execution context was destroyed|cannot find context/i.test(error.message) || attempt === 4) throw error;
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(500);
      }
    }
    if (!meta) throw new Error("Could not read citation metadata after navigation.");
    const get = (name: string) => meta.find(([n, v]) => n === name && v)?.[1] || undefined;

    return {
      title: get("citation_title"),
      doi: get("citation_doi"),
      journal: get("citation_journal_title"),
      publicationDate: get("citation_publication_date") ?? get("citation_date"),
      authors: meta.filter(([n, v]) => n === "citation_author" && v).map(([, v]) => v),
      pdfUrl: get("citation_pdf_url"),
    };
  }

  /** Locate the full-text PDF link: citation_pdf_url, ScienceDirect pdfft, "View/Download PDF", or a direct .pdf link. */
  async findPdfUrl(page: Page): Promise<string | null> {
    const pageUrl = page.url();
    // IEEE Xplore renders the PDF button without an href; the raw PDF endpoint is derived from the arnumber.
    const ieee = /^https:\/\/ieeexplore\.ieee\.org\/(?:abstract\/)?document\/(\d+)/.exec(pageUrl);
    if (ieee) {
      return `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${ieee[1]}`;
    }

    // Springer Nature accepted manuscripts can expose a stale citation_pdf_url
    // that redirects to HTML, while the article's own download link is a PDF.
    const article = new URL(pageUrl);
    if (article.hostname === "www.nature.com" && /^\/articles\/[^/]+$/.test(article.pathname)) {
      const expectedPath = `${article.pathname}_reference.pdf`;
      const referencePdf = await page.locator("a[href]").evaluateAll((links, expected) =>
        links.map((link) => (link as HTMLAnchorElement).href).find((href) => {
          const url = new URL(href);
          return url.hostname === "www.nature.com" && url.pathname === expected;
        }) ?? null, expectedPath);
      if (referencePdf) return referencePdf;
    }
    // Sage's PDF/EPUB reader is an HTML page; navigate to its direct PDF route.
    const sage = /^https:\/\/journals\.sagepub\.com\/doi\/(?:full\/|abs\/)?(10\.\d{4,9}\/.+?)(?:[?#].*)?$/.exec(pageUrl);
    if (sage) return `https://journals.sagepub.com/doi/pdf/${sage[1]}`;

    const metaPdf = (await this.readCitationMeta(page)).pdfUrl;
    if (metaPdf) {
      return new URL(metaPdf, pageUrl).href;
    }

    const anchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => ({
        href: a.href,
        label: (a.innerText || a.getAttribute("aria-label") || "").trim(),
      })),
    );
    const match =
      anchors.find((a) => /\/pdfft(\?|$)/.test(a.href)) ??
      anchors.find((a) => /^(view|download)\s+pdf/i.test(a.label)) ??
      anchors.find((a) => /\.pdf(\?|$)/i.test(a.href));
    return match?.href ?? null;
  }

  /** Poll for a PDF link while the article page and access controls finish loading. */
  async waitForPdfUrl(page: Page, timeoutMs = 20_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pdfUrl = await this.findPdfUrl(page).catch(() => null);
      if (pdfUrl) {
        return pdfUrl;
      }
      await page.waitForTimeout(1_000);
    }
    return null;
  }

  /**
   * Download the PDF with the logged-in session. First tries fetch() inside the article page (same-origin,
   * uses the browser's cookies and trusted certificates), then falls back to navigating to the PDF URL.
   */
  async fetchPdf(pdfUrl: string, outputPath: string, sourcePage?: Page): Promise<string> {
    let inPage: { bytes: Buffer | null; diagnostic: string; retryable: boolean; challenge: boolean } | null = null;
    if (sourcePage) {
      for (let attempt = 0; attempt <= IN_PAGE_RETRY_DELAYS_MS.length; attempt++) {
        inPage = await this.fetchPdfInPage(sourcePage, pdfUrl);
        if (inPage.bytes) {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, inPage.bytes);
          return outputPath;
        }
        // Never repeatedly request a recognized challenge or a persistent authorization failure.
        if (inPage.challenge || !inPage.retryable || attempt === IN_PAGE_RETRY_DELAYS_MS.length) break;
        await sourcePage.waitForTimeout(IN_PAGE_RETRY_DELAYS_MS[attempt]);
      }
    }
    try {
      return await this.fetchPdfByNavigation(pdfUrl, outputPath);
    } catch (error) {
      const detail = inPage?.diagnostic ? `; in-page request: ${inPage.diagnostic}` : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error });
    }
  }

  private async fetchPdfInPage(page: Page, pdfUrl: string): Promise<{ bytes: Buffer | null; diagnostic: string; retryable: boolean; challenge: boolean }> {
    try {
      const result = await page.evaluate(async ({ url, timeoutMs }) => {
        try {
          const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
          const type = (response.headers.get("content-type") ?? "unknown").split(";")[0];
          const blob = await response.blob();
          const signature = await blob.slice(0, 5).text();
          if (response.ok && signature === "%PDF-") {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            return { dataUrl, diagnostic: `HTTP ${response.status}, PDF`, retryable: false, challenge: false };
          }
          const html = type.includes("html") || /^\s*</.test(signature);
          const sample = html ? await blob.slice(0, 65_536).text() : "";
          const challenge = /<title[^>]*>\s*(?:just a moment|attention required|are you a robot)|challenges\.cloudflare\.com|cf-turnstile|g-recaptcha|h-captcha|verify (?:that )?you are human|are you a robot/i.test(sample);
          const temporary = response.status === 429 || response.status >= 500 || /temporarily unavailable|service unavailable|try again later/i.test(sample);
          const classification = challenge ? "human verification detected" : temporary ? "temporary error indicated" : html ? "HTML response; cause unknown" : "non-PDF response";
          const retryable = !challenge && response.status !== 401 && response.status !== 403 && (html || temporary);
          return { dataUrl: null, diagnostic: `HTTP ${response.status}, ${type}, ${classification}`, retryable, challenge };
        } catch (error) {
          return { dataUrl: null, diagnostic: error instanceof Error ? error.name : "request failed", retryable: true, challenge: false };
        }
      }, { url: pdfUrl, timeoutMs: IN_PAGE_FETCH_TIMEOUT_MS });
      return { bytes: result.dataUrl ? Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(",") + 1), "base64") : null, diagnostic: result.diagnostic, retryable: result.retryable, challenge: result.challenge };
    } catch {
      return { bytes: null, diagnostic: "page navigation or request error", retryable: false, challenge: false };
    }
  }

  /** Navigate to the PDF URL and capture the PDF bytes from the network or a download. */
  private async fetchPdfByNavigation(pdfUrl: string, outputPath: string): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();

    try {
      const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";
      let lastNavigation = "no navigation response";
      let retryableNavigationHtml = false;
      let navigationResponseAt = 0;
      let navigationAttempts = 1;
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          const type = (response.headers()["content-type"] ?? "unknown").split(";")[0];
          lastNavigation = `HTTP ${response.status()}, ${type}`;
          retryableNavigationHtml = type.includes("html") && response.status() !== 401 && response.status() !== 403;
          navigationResponseAt = Date.now();
        }
      });
      const captured = new Promise<Buffer>((resolve) => {
        // In headed Chromium the built-in PDF viewer first serves an HTML shell under the PDF URL and then
        // streams the real bytes via chrome-extension://, so only accept bodies with the %PDF- magic.
        page.on("response", async (response) => {
          if ((response.headers()["content-type"] ?? "").includes("application/pdf")) {
            try {
              const body = await response.body();
              if (isPdf(body)) {
                resolve(body);
              }
            } catch {
              // Body unavailable (e.g. redirect) - wait for the next response.
            }
          }
        });
        page.on("download", async (download) => {
          try {
            const body = await readFile(await download.path());
            if (isPdf(body)) resolve(body);
          } catch {
            // A cancelled or failed browser download is not a valid PDF.
          }
        });
      });

      // goto rejects with "Download is starting" when the PDF is served as an attachment; that is expected.
      void page.goto(pdfUrl, { timeout: 90_000 }).catch(() => undefined);

      // Detect a challenge after navigation starts; never reload it automatically.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        const started = Date.now();
        let challengeStarted: number | undefined;
        let challengeEnded: number | undefined;
        let checking = false;
        timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const challenge = page.url() !== "about:blank" ? await this.inspectChallengePage(page) : null;
            if (challenge === true && (!challengeStarted || challengeEnded)) {
              challengeStarted = Date.now();
              challengeEnded = undefined;
              await page.bringToFront().catch(() => undefined);
              console.error(`[browser] Human verification required on ${safeUrl(page.url())} - please complete it in the browser window.`);
            } else if (challenge === false && challengeStarted && !challengeEnded) {
              challengeEnded = Date.now();
              console.error("[browser] Verification page closed or cleared; waiting for PDF.");
            }
            // Only retry plain HTML when no challenge was detected in this navigation.
            if (challenge === false && !challengeStarted && retryableNavigationHtml && navigationAttempts < 3 && Date.now() - navigationResponseAt >= 1_500) {
              navigationAttempts++;
              retryableNavigationHtml = false;
              void page.goto(pdfUrl, { timeout: 90_000 }).catch(() => undefined);
            }
            const elapsed = Date.now() - (challengeEnded ?? challengeStarted ?? started);
            const limit = challengeStarted && !challengeEnded ? HUMAN_VERIFICATION_TIMEOUT_MS : PDF_RESPONSE_TIMEOUT_MS;
            if (elapsed > limit) {
              reject(new Error(`Timed out waiting for PDF from ${safeUrl(pdfUrl)} (landed on ${safeUrl(page.url())}; ${lastNavigation}; human verification ${challengeStarted ? "detected" : "not detected"})`));
            }
          } finally {
            checking = false;
          }
        }, 1_000);
      });
      const bytes = await Promise.race([captured, timeout]).finally(() => clearInterval(timer));

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      return outputPath;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async snapshotPage(page: Page): Promise<{ title: string; url: string; text: string }> {
    const title = await page.title();

    return {
      title,
      url: page.url(),
      text: await page.locator("body").innerText(),
    };
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.saveSessionCookies();
      await this.context.close();
      this.context = null;
    }
  }
}
