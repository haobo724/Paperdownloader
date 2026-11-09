import express, { type Request, type Response } from "express";
import { appConfig } from "./config.js";
import { paperWorkflow } from "./workflow/paperWorkflow.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "ready" });
});

/** Validate body.url, run the task and send { ok: true, ...result } or { ok: false, error }. */
function route(task: (body: Record<string, unknown>, url: string) => Promise<object>) {
  return async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.url !== "string" || !URL.canParse(body.url)) {
      res.status(400).json({ ok: false, error: "url (absolute URL) is required" });
      return;
    }
    try {
      res.json({ ok: true, ...(await task(body, body.url)) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

app.post("/api/papers/download-pdf", route((body, url) => paperWorkflow.downloadPaperPdf(url, optionalString(body.fileName))));
app.post("/api/papers/inspect", route((_body, url) => paperWorkflow.inspectPaper(url)));
app.post(
  "/api/papers/read",
  route((body, url) => paperWorkflow.readPaper(url, typeof body.maxChars === "number" ? body.maxChars : undefined)),
);
app.post("/api/papers/login", route((_body, url) => paperWorkflow.openForLogin(url)));
app.post(
  "/api/papers/archive",
  route((body, url) =>
    paperWorkflow.archivePaper({ url, title: optionalString(body.title), pdfPath: optionalString(body.pdfPath), collectionKey: optionalString(body.collectionKey) }),
  ),
);

// Bind to localhost only: the API drives a logged-in browser and must not be reachable from the network.
app.listen(appConfig.port, "127.0.0.1", () => {
  console.log(`PaperDownloader API is running on http://127.0.0.1:${appConfig.port}`);
  console.log(`Persistent browser profile: ${appConfig.userDataDir}`);
  console.log(`Download directory: ${appConfig.downloadDir}`);
});

const shutdown = async () => {
  await paperWorkflow.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
