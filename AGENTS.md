# Agent guide: PaperDownloader

Tool for downloading full-text paper PDFs from article page URLs via a persistent, institution-logged-in browser. It does **not** search for papers — the caller supplies article URLs (or DOIs resolved to `https://doi.org/<doi>`).

## How to call

Prefer the MCP server (stdio): `node <repo>/dist/mcp/server.js` (run `npm run build` first if `dist/` is missing).

| Tool | Input | Output |
|---|---|---|
| `download_paper_pdf` | `{ url, fileName? }` | `{ url, pdfUrl, pdfPath, title, citation{title,doi,journal,publicationDate,authors[]}, source }` |
| `inspect_paper` | `{ url }` | `{ pageUrl, title, citation, pdfUrl \| null }` |
| `read_paper` | `{ url, maxChars? }` | `{ pageUrl, title, citation, text, truncated }` |
| `open_login_page` | `{ url }` | opens a tab for the human to log in |
| `archive_paper_to_zotero` | `{ url, title?, pdfPath? }` | Zotero API result |

Without MCP, use the CLI from the repo root:

```bash
npm run download -- "<url1>" "<url2>"   # one JSON line per URL on stdout; exit code 1 if any failed
```

or the HTTP API (`npm run start`, `POST http://127.0.0.1:3000/api/papers/download-pdf` with `{ "url": "..." }`).

## Recommended flow

1. Call `download_paper_pdf` with the article landing page URL.
2. On success, use `pdfPath` (absolute path) and `citation`.
3. On an error mentioning *no full-text access*, *log in*, or *Timed out waiting for a PDF response*:
   call `open_login_page` with the same URL, tell the user to sign in via "Access through your institution" in the opened browser window, wait for their confirmation, then retry once.
4. On *No PDF link found*: the platform is unsupported — report the URL; do not loop.

## Rules

- Never try to log in, enter credentials, or solve captchas yourself; these are human-only steps. Human verification is waited for automatically (up to 5 min).
- Only one process may use the browser profile at a time. Do not run `npm run login` / `npm run download` while the MCP or HTTP server is running.
- Call tools sequentially; each download takes ~5–30 s and a visible browser window is used.
- Do not read or commit `.env`, `.browser-profile/`, or `downloads/`.

## Code map

- `src/browser/persistentBrowser.ts` — browser lifecycle, session-cookie persistence, PDF link detection (`findPdfUrl`; add platform-specific rules here), PDF capture.
- `src/workflow/paperWorkflow.ts` — high-level operations shared by MCP, HTTP, and CLI.
- `src/mcp/server.ts`, `src/server.ts`, `src/download.ts`, `src/login.ts` — entry points.
- Constraint: callbacks passed to `page.evaluate` must not contain named inner functions (tsx/esbuild `__name` issue).
