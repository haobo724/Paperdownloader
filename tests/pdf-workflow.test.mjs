import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PersistentEdgeBrowser } from "../dist/browser/persistentBrowser.js";

// These tests use isolated browser profiles and local or intercepted pages.
test("article links distinguish actual PDFs, readers, and supplementary files", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "www.nature.com") {
        await route.fulfill({ contentType: "text/html", body: `<meta name="citation_pdf_url" content="https://www.nature.com/articles/s-test.pdf"><a href="https://static-content.springer.com/supplement.pdf">Supplementary PDF</a><a href="/articles/s-test_reference.pdf">Download PDF</a>` });
      } else if (url.hostname === "journals.sagepub.com") {
        await route.fulfill({ contentType: "text/html", body: `<a href="/doi/reader/10.1177/example">PDF/EPUB</a>` });
      } else {
        await route.fulfill({ contentType: "text/html", body: `<span>Get access</span><script>setTimeout(() => { const a = document.createElement("a"); a.href = "/paper.pdf"; a.textContent = "Download PDF"; document.body.appendChild(a); }, 250);</script>` });
      }
    });
    const downloader = new PersistentEdgeBrowser();
    await page.goto("https://www.nature.com/articles/s-test");
    assert.equal(await downloader.findPdfUrl(page), "https://www.nature.com/articles/s-test_reference.pdf");
    await page.goto("https://journals.sagepub.com/doi/10.1177/example");
    assert.equal(await downloader.findPdfUrl(page), "https://journals.sagepub.com/doi/pdf/10.1177/example");
    await page.goto("https://example.org/article");
    assert.equal(await downloader.waitForPdfUrl(page, 3000), "https://example.org/paper.pdf");
  } finally {
    await browser.close();
  }
});

test("a rejected in-page fetch falls back to browser navigation", async () => {
  const bytes = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
  let rejectedFetch = false;
  let navigated = false;
  const server = createServer((req, res) => {
    if (req.url === "/paper.pdf") {
      if (req.headers["sec-fetch-dest"] === "empty") {
        rejectedFetch = true;
        res.writeHead(403, { "content-type": "text/html" });
        res.end("blocked fetch");
      } else {
        navigated = true;
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(bytes);
      }
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><title>Article</title><body>Article</body></html>");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const tempRoot = path.resolve(os.tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, "paperdownloader-test-"));
  const previousCI = process.env.CI;
  process.env.CI = "true";
  const downloader = new PersistentEdgeBrowser(path.join(temp, "profile"));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await downloader.openPage(`${base}/article`);
    const output = path.join(temp, "paper.pdf");
    await downloader.fetchPdf(`${base}/paper.pdf`, output, page);
    assert.equal(rejectedFetch, true);
    assert.equal(navigated, true);
    assert.deepEqual(await readFile(output), bytes);
  } finally {
    await downloader.close();
    await new Promise(resolve => server.close(resolve));
    if (previousCI === undefined) delete process.env.CI; else process.env.CI = previousCI;
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("paperdownloader-test-")) throw new Error("Unsafe test cleanup path");
    await rm(resolved, { recursive: true, force: true });
  }
});

test("download result reports the actual PDF URL instead of stale metadata", async () => {
  const { PaperWorkflow } = await import("../dist/workflow/paperWorkflow.js");
  const oldMode = process.env.VPN_MODE;
  process.env.VPN_MODE = "none";
  const page = { close: async () => {}, title: async () => "Article" };
  const fakeBrowser = {
    openPage: async () => page,
    readCitationMeta: async () => ({ title: "Article", authors: [], pdfUrl: "https://example.org/stale.pdf" }),
    waitForPdfUrl: async () => "https://example.org/article_reference.pdf",
    fetchPdf: async (_url, output) => output,
  };
  try {
    const result = await new PaperWorkflow(fakeBrowser).downloadPaperPdf("https://example.org/article");
    assert.equal(result.pdfUrl, "https://example.org/article_reference.pdf");
    assert.equal(result.citation.pdfUrl, result.pdfUrl);
  } finally {
    if (oldMode === undefined) delete process.env.VPN_MODE; else process.env.VPN_MODE = oldMode;
  }
});
async function withPdfServer(handler, run) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/paper.pdf")) return handler(req, res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Article</title><body>Article</body></html>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const tempRoot = path.resolve(os.tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, "paperdownloader-test-"));
  const oldCI = process.env.CI;
  process.env.CI = "true";
  const downloader = new PersistentEdgeBrowser(path.join(temp, "profile"));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await downloader.openPage(`${base}/article`);
    await run({ downloader, page, base, output: path.join(temp, "paper.pdf") });
  } finally {
    await downloader.close();
    await new Promise(resolve => server.close(resolve));
    if (oldCI === undefined) delete process.env.CI; else process.env.CI = oldCI;
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("paperdownloader-test-")) throw new Error("Unsafe test cleanup path");
    await rm(resolved, { recursive: true, force: true });
  }
}

test("retries a temporary HTML response and saves the later PDF", async () => {
  let requests = 0;
  const bytes = Buffer.from("%PDF-1.4\nrecovered\n%%EOF\n");
  await withPdfServer((_req, res) => {
    requests++;
    if (requests < 3) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><title>Please wait</title>Loading</html>");
    } else {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(bytes);
    }
  }, async ({ downloader, page, base, output }) => {
    await downloader.fetchPdf(`${base}/paper.pdf`, output, page);
    assert.equal(requests, 3);
    assert.deepEqual(await readFile(output), bytes);
  });
});

test("does not repeatedly fetch a human verification page", async () => {
  let inPageRequests = 0;
  let navigations = 0;
  const bytes = Buffer.from("%PDF-1.4\nviewed\n%%EOF\n");
  await withPdfServer((req, res) => {
    if (req.headers["sec-fetch-dest"] === "empty") {
      inPageRequests++;
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><title>Just a moment...</title>Verify you are human</html>");
    } else {
      navigations++;
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(bytes);
    }
  }, async ({ downloader, page, base, output }) => {
    await downloader.fetchPdf(`${base}/paper.pdf`, output, page);
    assert.equal(inPageRequests, 1);
    assert.equal(navigations, 1);
    assert.deepEqual(await readFile(output), bytes);
  });
});

test("reports an unclassified HTML response without calling it a temporary error", async () => {
  let requests = 0;
  await withPdfServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Publisher page</title>Not a PDF</html>");
  }, async ({ downloader, page, base, output }) => {
    downloader.fetchPdfByNavigation = async () => { throw new Error("navigation fixture stopped"); };
    await assert.rejects(downloader.fetchPdf(`${base}/paper.pdf?secret=hidden`, output, page), /HTML response; cause unknown/);
    assert.equal(requests, 3);
  });
});
test("waits for a detected navigation challenge to clear before saving the PDF", async () => {
  let inPageRequests = 0;
  const messages = [];
  const previousError = console.error;
  const bytes = Buffer.from("%PDF-1.4\npost-verification\n%%EOF\n");
  console.error = (...args) => messages.push(args.join(" "));
  try {
    await withPdfServer((req, res) => {
      if (req.headers["sec-fetch-dest"] === "empty") inPageRequests++;
      if (req.url.includes("passed=1")) {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(bytes);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><title>Just a moment...</title><body>Verification fixture<script>setTimeout(() => location.href = "/paper.pdf?passed=1", 2500)</script></body></html>`);
      }
    }, async ({ downloader, page, base, output }) => {
      await downloader.fetchPdf(`${base}/paper.pdf`, output, page);
      assert.equal(inPageRequests, 1);
      assert.ok(messages.some(message => message.includes("Human verification required")));
      assert.deepEqual(await readFile(output), bytes);
    });
  } finally {
    console.error = previousError;
  }
});

test("reports explicit service errors as temporary after bounded retries", async () => {
  let requests = 0;
  await withPdfServer((_req, res) => {
    requests++;
    res.writeHead(503, { "content-type": "text/html" });
    res.end("<html><title>Service unavailable</title>Try again later</html>");
  }, async ({ downloader, page, base, output }) => {
    downloader.fetchPdfByNavigation = async () => { throw new Error("navigation fixture stopped"); };
    await assert.rejects(downloader.fetchPdf(`${base}/paper.pdf`, output, page), /HTTP 503.*temporary error indicated/);
    assert.equal(requests, 3);
  });
});
test("retries an ordinary HTML navigation and saves the subsequent PDF", async () => {
  let fetches = 0;
  let navigations = 0;
  const bytes = Buffer.from("%PDF-1.4\nnavigation-recovered\n%%EOF\n");
  await withPdfServer((req, res) => {
    if (req.headers["sec-fetch-dest"] === "empty") {
      fetches++;
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><title>Request blocked</title></html>");
    } else {
      navigations++;
      if (navigations === 1) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><title>Loading</title>Not yet a PDF</html>");
      } else {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(bytes);
      }
    }
  }, async ({ downloader, page, base, output }) => {
    await downloader.fetchPdf(`${base}/paper.pdf`, output, page);
    assert.equal(fetches, 1);
    assert.equal(navigations, 2);
    assert.deepEqual(await readFile(output), bytes);
  });
});