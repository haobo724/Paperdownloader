# PaperDownloader

> Humans: you do not need to read this. Give it to your agent.

PaperDownloader downloads research-paper PDFs from article URLs or legitimate publisher and author sharing links. It uses the user's authorized institutional access and a persistent browser session. It offers MCP, CLI, and HTTP interfaces.

This is a download tool. It does not search for, select, rank, or recommend papers, and it does not provide research suggestions or prompts to language models. The caller supplies the paper to download. The existing page inspection, reading, and Zotero item interfaces are retained for compatibility.

## Important: Elsevier robot verification

**ScienceDirect / Elsevier may ask “Are you a robot?” even when the FAU VPN and institutional login are already active.** Human verification may also be required for other publishers.

The user must complete verification in PaperDownloader's own browser window. The program does not solve CAPTCHAs or enter credentials. After verification, reuse the same browser profile and retry the download. A timeout or a missing PDF link does not by itself prove that the institution lacks access. Challenge detection is not guaranteed, and a PDF capture can time out before a challenge is completed.

## Requirements and setup

- Node.js 22 or later.
- Windows with the eduVPN client, a saved FAU profile, and valid authorization. The current download workflow checks the FAU VPN before every download.
- An interactive Windows desktop for automatic VPN connection, browser sign-in, and any human verification.
- Playwright Chromium. A persistent profile is separate from the user's regular Edge browser.

From the project directory:

```bash
npm install
npx playwright install chromium
npm run build
```

Configure environment variables as needed. The project loads a `.env` file if present, but on the current machine `.env` is already a directory containing private data. Do not overwrite it; use process environment variables instead.

On the current machine, the project is at `E:/Study/Paper-pool/Paperdownloader`, and the bundled browser directory is `E:/Study/Paper-pool/Paperdownloader/browsers`. When this directory exists, the project selects it by default unless `PLAYWRIGHT_BROWSERS_PATH` is explicitly set. Browser binaries can instead be installed through Playwright in its normal location. The default download and browser-profile paths are relative to the project directory.

## Download a paper

### MCP

If PaperDownloader's MCP server is available, call `download_paper_pdf` with the article URL:

```json
{ "url": "https://publisher.example/article", "fileName": "optional-name" }
```

The result contains the local `pdfPath`, article title, citation metadata, PDF URL, and download source. The stdio server can be started with `npm run mcp` after building. For the current machine, an MCP client can use:

```json
{
  "command": "node",
  "args": ["E:/Study/Paper-pool/Paperdownloader/dist/mcp/server.js"],
  "env": {
    "PLAYWRIGHT_BROWSERS_PATH": "E:/Study/Paper-pool/Paperdownloader/browsers"
  }
}
```

The repository also includes a VS Code configuration at `.vscode/mcp.json`.

### CLI

Run from the project directory:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = 'E:\Study\Paper-pool\Paperdownloader\browsers'
npm run download -- 'https://publisher.example/article'
```

Multiple URLs can be passed in one command. The CLI prints one JSON result per URL and returns a nonzero exit code if any download fails.

### HTTP

```bash
npm run start
```

The server listens on `http://127.0.0.1:3000`. Send `POST /api/papers/download-pdf` with a JSON body containing `url` and, optionally, `fileName`.

## VPN and institutional access

Before a PDF download, the program checks the Windows adapter `eduvpn.fau.de`. If already connected, it continues without changing the connection. Otherwise, it attempts to start eduVPN and connect the saved FAU profile through Windows UI Automation without moving the mouse, then checks that the adapter is up. Depending on the client screen, this may briefly change keyboard focus. The program does not read the user's VPN password.

This automatic connection depends on an interactive Windows desktop and the expected FAU client configuration. If it cannot connect, or the user must complete authentication or MFA, the download fails with a message and can be retried after the user resolves it. Starting the application alone is not evidence of a VPN connection.

For institutional sign-in, open the article in PaperDownloader's persistent browser:

```bash
npm run login -- "https://publisher.example/article"
```

The user completes sign-in or robot verification in that window. For CLI use, close the login window before starting another download. If using an already-running MCP server, use its `open_login_page` tool instead of starting a second process with the same browser profile.

Browser state is stored in `.browser-profile/`; session cookies are periodically saved to `.browser-profile/session-cookies.json` and restored on later launches. Publishers control session validity, and a successful login or verification is not guaranteed to remain valid indefinitely. Keep these files private. The same browser profile must not be used by multiple MCP, HTTP, CLI, or login processes simultaneously.

## PDF retrieval and verification

For ScienceDirect, an Elsevier API key can enable the official API path. Otherwise, or if the API attempt fails, the browser uses the existing session to locate and fetch the PDF. The downloader checks for the `%PDF-` signature. Agents should also verify that the PDF title or DOI matches the requested paper before reporting success.

A publisher page showing an institution name does not itself prove that a particular article is covered. Likewise, access through an author's sharing link does not prove institutional entitlement.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DOWNLOAD_DIR` | `downloads` | PDF output directory, relative to the project unless absolute |
| `USER_DATA_DIR` | `.browser-profile` | Persistent browser profile directory |
| `PLAYWRIGHT_BROWSERS_PATH` | Project `browsers/` if present; otherwise Playwright default | Chromium installation directory |
| `BROWSER_CHANNEL` | Playwright Chromium | Optional browser channel, such as `msedge` |
| `PLAYWRIGHT_HEADLESS` | `false` | Headless browser mode; publisher access may be affected |
| `EDUVPN_CLIENT_PATH` | Search standard Windows locations | Optional full path to `eduVPN.Client.exe` |
| `HUMAN_VERIFICATION_TIMEOUT_MS` | `300000` | Maximum wait for a recognized human-verification challenge |
| `PORT` | `3000` | Local HTTP server port |
| `ELSEVIER_API_KEY`, `ELSEVIER_INSTTOKEN` | Unset | Optional Elsevier API credentials; full text requires entitlement |
| `ZOTERO_API_KEY`, `ZOTERO_USER_ID`, `ZOTERO_LIBRARY_TYPE` | Unset, unset, `user` | Optional Zotero item creation settings |

## Compatibility interfaces

The MCP server also exposes `inspect_paper`, `read_paper`, `open_login_page`, and `archive_paper_to_zotero`. The HTTP server exposes corresponding `/api/papers/inspect`, `/api/papers/read`, `/api/papers/login`, and `/api/papers/archive` endpoints, plus `/health`.

`inspect_paper` returning a null PDF URL means no link was detected; it does not establish whether access is available. The Zotero archive function creates an item and records the local PDF path in `extra`; it **does not upload the PDF as an attachment**. Use and verify a separate Zotero attachment workflow when required.

The `.env`, `.browser-profile/`, `downloads/`, and `browsers/` paths are ignored by Git and should not be committed.
