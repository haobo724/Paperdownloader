import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { paperWorkflow } from "../workflow/paperWorkflow.js";

// stdout is the MCP channel: all logging must go to stderr.
const server = new McpServer({ name: "paperdownloader", version: "1.0.0" });

async function asToolResult(task: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await task(), null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

server.registerTool(
  "download_paper_pdf",
  {
    description:
      "Download the full-text PDF of a paper given its article page URL (ScienceDirect, Springer, Nature, IEEE Xplore, " +
      "or any page exposing citation_pdf_url). Uses the persistent logged-in browser session. Returns pdfPath (absolute " +
      "local path), title and citation metadata. ScienceDirect may require institutional access or human verification.",
    inputSchema: {
      url: z.string().url().describe("Article landing page URL, e.g. https://link.springer.com/article/10.1007/..."),
      fileName: z.string().optional().describe("Optional file name without extension; default is derived from the title."),
    },
  },
  ({ url, fileName }) => asToolResult(() => paperWorkflow.downloadPaperPdf(url, fileName)),
);

server.registerTool(
  "inspect_paper",
  {
    description:
      "Open an article page and return its metadata (title, DOI, journal, authors) and the detected PDF URL without downloading. " +
      "A null pdfUrl means no link was detected; it does not determine access rights.",
    inputSchema: { url: z.string().url() },
  },
  ({ url }) => asToolResult(() => paperWorkflow.inspectPaper(url)),
);

server.registerTool(
  "read_paper",
  {
    description: "Return the visible text of an article page (abstract / HTML full text), truncated to maxChars.",
    inputSchema: {
      url: z.string().url(),
      maxChars: z.number().int().positive().max(200_000).optional().describe("Default 20000."),
    },
  },
  ({ url, maxChars }) => asToolResult(() => paperWorkflow.readPaper(url, maxChars)),
);

server.registerTool(
  "open_login_page",
  {
    description:
      "Open a page in the persistent browser window and leave it open so the HUMAN user can log in (institutional sign-in, " +
      "captcha). This uses the same persistent browser profile.",
    inputSchema: { url: z.string().url().describe("Usually the article URL that failed with a no-access error.") },
  },
  ({ url }) => asToolResult(() => paperWorkflow.openForLogin(url)),
);

server.registerTool(
  "archive_paper_to_zotero",
  {
    description: "Create a Zotero journalArticle item (title, URL; local PDF path noted in 'extra'). Requires ZOTERO_* in .env.",
    inputSchema: {
      url: z.string().url(),
      title: z.string().optional(),
      pdfPath: z.string().optional(),
    },
  },
  ({ title, url, pdfPath }) => asToolResult(() => paperWorkflow.archivePaper({ title, url, pdfPath })),
);

const shutdown = async () => {
  // Closing the browser persists session cookies for the next run.
  await paperWorkflow.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
console.error("PaperDownloader MCP server started");
