# Agent guide: PaperDownloader

PaperDownloader is a download tool. The caller supplies an identified article URL, DOI landing URL, or a legitimate publisher/author share link. It does not search, recommend, rank, or select papers, generate research suggestions, or provide LLM prompts. Perform discovery and selection outside this project. Existing inspect/read/archive interfaces are auxiliary compatibility functions, not literature search or selection tools.

## Local setup and invocation

- Use the project directory containing this file.
- Prefer its MCP server if the current session exposes it: `download_paper_pdf` accepts `{ "url": "...", "fileName": "optional" }`. In stdio clients, launch `node <project>/dist/mcp/server.js` after building; set `PLAYWRIGHT_BROWSERS_PATH` only if needed.
- If the MCP tool is unavailable, run from the project directory in PowerShell:

  ```powershell
  npm run download -- 'https://publisher.example/article'
  ```

- If needed run `npm run build`; CLI output is one JSON result per URL. Check `ok`, `pdfPath`, `title`, `citation`, `source`, and `vpn`. Do not claim success without a real result.
- Only one MCP, HTTP, CLI, or login process may use the persistent browser profile at once. Never start a second process with that profile. In MCP use `open_login_page` in the existing server; in CLI, close the login browser before running the download command again.

## VPN and human verification

- By default (`VPN_MODE=auto`), the tool checks eduVPN on Windows and attempts connection only when the target can be identified unambiguously; downloading continues if unavailable. Check the returned `vpn` status and ask about configuration when relevant. `VPN_MODE=none` skips VPN management; `VPN_MODE=eduvpn` requires an eduVPN connection. `VPN_MODE=external` supports other VPNs through explicitly configured status and optional connect executables; use the README for exit-code and argument rules. Do not guess between profiles, expose command arguments or credentials, or disconnect an active VPN.
- ScienceDirect / Elsevier may request a robot or other human verification even when institutional access is already active. The program waits for recognized challenges but cannot detect every challenge or guarantee that its PDF timeout waits for completion. Never solve CAPTCHAs or enter credentials. Ask the user to complete the challenge in the PaperDownloader browser, retain the same browser profile, and retry after confirmation. `open_login_page` is available in the running MCP server; for CLI use `npm run login -- '<article or legitimate share URL>'`, wait for the user to finish and close the browser, then retry. Do not equate a timeout, missing PDF link, or displayed institution name with proof of missing entitlement.
- The persistent profile and session-cookie snapshot are under `.browser-profile/`; they may expire or be revoked. Do not expose, copy into prompts, or commit credentials, cookies, profile files, or `.env`.

## Zotero authorization and attachments

- If the user requests downstream Zotero changes, reuse the same Zotero 10+ local API authorization for imports, edits, and attachment uploads. On Windows, use `scripts/zotero_local_auth.py` and the shared Windows Credential Manager entry identified by Zotero server ID; the key is not kept in the project. Use `status` or `verify` before requesting a new authorization. Call `setup` only when necessary and tell the user if Zotero requests approval. A single-use grant cannot cover a multi-request PDF upload; a reusable grant requires the user's own choice of “Always Allow”. Never log, commit, or expose credentials.
- Zotero local API keys are distinct from Web API keys. `archive_paper_to_zotero` uses the shared local API key by default; `ZOTERO_API_MODE=web` explicitly selects the legacy Web API. The archive is metadata-only. Do not pass a local key as `ZOTERO_API_KEY`. If the user's workflow requires an existing item or a PDF attachment, use an authorized Zotero local API workflow or another supported method and verify the target, parent item, file, and result. Connector save operations target the selected collection. Do not control the mouse or authorization dialogs when the user requested background API operation.
- Downloading a PDF and running an external translation plugin do not require a Zotero key. Use the shared local authorization only when those workflows write records or attachments to Zotero. When PDF2zh fails saving a long Windows path, retry with a short unique filename and confirm the output belongs to the original paper.

## Verify and report

- Confirm the result is a real PDF and that its title/DOI matches the requested paper; report the local `pdfPath` and source. A share link may give access independent of an institution, and an institution name alone does not prove entitlement.
- `archive_paper_to_zotero` creates a bibliographic item and records the PDF path in `extra`; it does not upload a PDF attachment. Use an appropriate Zotero workflow for requested attachments and verify them separately.
- Errors may indicate unavailable access, a challenge, page changes, or network failure. Report the actual result and any user action needed; do not claim a download or attachment that was not verified.
- For Nature article-in-press pages, the article-specific `_reference.pdf` link may be valid when the metadata PDF URL redirects to HTML. For Sage, the PDF/EPUB reader may be HTML while the `/doi/pdf/` route is a PDF. A 403 from in-page fetch does not establish that browser navigation is blocked. The downloader attempts navigation and reports available HTTP/content-type and challenge status on failure. Do not infer missing entitlement solely from a timeout.

- For a PDF URL returning non-verification HTML or an indicated temporary error, the downloader retries the in-page request up to two times before browser navigation; ordinary HTML from navigation can also be retried up to twice if no verification is detected. Detected human verification is not automatically retried; let the user complete it. HTTP 401/403 are not repeatedly fetched. Unclassified HTML is reported as cause unknown.
