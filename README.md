# PaperDownloader

> Humans: you do not need to read this. Give it to your agent.

PaperDownloader downloads research-paper PDFs from article URLs or legitimate publisher and author sharing links. It uses the user's authorized institutional access and a persistent browser session. It offers MCP, CLI, and HTTP interfaces.

This is a download tool. It does not search for, select, rank, or recommend papers, and it does not provide research suggestions or prompts to language models. The caller supplies the paper to download. The existing page inspection, reading, and Zotero item interfaces are retained for compatibility.

## Codex Skill

The reusable Codex Skill is in [`skills/paperdownloader`](skills/paperdownloader/SKILL.md). Install that directory under the Codex skills directory to make it available across projects. The skill describes how to call this checkout; it does not bundle the downloader. Point it to a working checkout with `PAPERDOWNLOADER_ROOT`, applicable user instructions, or an optional machine-local `references/local-installation.md` in the installed skill directory. Do not put local paths, credentials, or browser state in the repository.

## Important: Elsevier robot verification

**ScienceDirect / Elsevier may ask “Are you a robot?” even when institutional access is already active.** Human verification may also be required for other publishers.

The user must complete verification in PaperDownloader's own browser window. The program does not solve CAPTCHAs or enter credentials. After verification, reuse the same browser profile and retry the download. A timeout or a missing PDF link does not by itself prove that the institution lacks access. Challenge detection is not guaranteed, and a PDF capture can time out before a challenge is completed.

## Requirements and setup

- Node.js 22 or later.
- A network connection and, when necessary, the user's valid institutional access. eduVPN is checked by default but is not required for downloading.
- A desktop session when a visible browser, institutional sign-in, or human verification is required. The optional eduVPN integration requires an interactive Windows desktop.
- Playwright Chromium. A persistent profile is separate from the user's regular Edge browser.

From the project directory:

```bash
npm install
npx playwright install chromium
npm run build
```

Configure environment variables as needed. The project loads a `.env` file if present. If `.env` is already a directory, leave it intact and use process environment variables instead.

When the project's `browsers/` directory exists, it is selected by default unless `PLAYWRIGHT_BROWSERS_PATH` is explicitly set. Browser binaries can instead be installed through Playwright in its normal location. The default download and browser-profile paths are relative to the project directory.

## Download a paper

### MCP

If PaperDownloader's MCP server is available, call `download_paper_pdf` with the article URL:

```json
{ "url": "https://publisher.example/article", "fileName": "optional-name" }
```

The result contains the local `pdfPath`, article title, citation metadata, PDF URL, and download source. The stdio server can be started with `npm run mcp` after building. An MCP client can use the absolute path to the built server:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/Paperdownloader/dist/mcp/server.js"]
}
```

The repository also includes a VS Code configuration at `.vscode/mcp.json`.

### CLI

Run from the project directory:

```powershell
npm run download -- 'https://publisher.example/article'
```

Multiple URLs can be passed in one command. The CLI prints one JSON result per URL and returns a nonzero exit code if any download fails.

### HTTP

```bash
npm run start
```

The server listens on `http://127.0.0.1:3000`. Send `POST /api/papers/download-pdf` with a JSON body containing `url` and, optionally, `fileName`.

## Optional VPN and institutional access

By default (`VPN_MODE=auto`), the downloader checks eduVPN on Windows and attempts to connect only when the saved target can be identified unambiguously. If it is unavailable or connection cannot be verified, downloading continues and the result reports the VPN status. To require a verified eduVPN connection, set `VPN_MODE=eduvpn`; set `VPN_MODE=none` to skip VPN management. The eduVPN integration requires an interactive Windows desktop and may briefly change keyboard focus. Use `EDUVPN_SERVER_NAME` and `EDUVPN_PROFILE_NAME` to restrict the target by exact display name. If either is set, `EDUVPN_ADAPTER_NAME` must also name its exact network adapter so the target connection can be verified; select the intended profile in eduVPN if it is not already selected. Complete any login or human verification yourself. The downloader does not read VPN passwords, guess between multiple profiles, or intentionally disconnect an existing tunnel. Detection of other VPN clients uses adapter-name heuristics and is not exhaustive: use `external` with a configured status check, or `none`, when preserving another client's state requires certainty.

For another VPN client, set `VPN_MODE=external` and configure `VPN_STATUS_EXECUTABLE`; optionally set `VPN_STATUS_ARGS_JSON` to a JSON array of arguments. The status command must exit **0** when connected, **1** when disconnected, and any other code when status is unknown. Optionally configure `VPN_CONNECT_EXECUTABLE` and `VPN_CONNECT_ARGS_JSON` (a JSON string array). The tool runs that command only after the status check explicitly reports disconnected, then checks the status again; unknown status never triggers a connection. External mode reports failures but does not block the download. Programs are executed without a shell, and their output and arguments are not included in diagnostics. Supply credentials using the VPN client's own secure mechanisms rather than command-line arguments. Only configure a trusted connection executable that will not disconnect or switch another tunnel; the downloader cannot verify a third-party program's internal behavior.
For institutional sign-in, open the article in PaperDownloader's persistent browser:

```bash
npm run login -- "https://publisher.example/article"
```

The user completes sign-in or robot verification in that window. For CLI use, close the login window before starting another download. If using an already-running MCP server, use its `open_login_page` tool instead of starting a second process with the same browser profile.

Browser state is stored in `.browser-profile/`; session cookies are periodically saved to `.browser-profile/session-cookies.json` and restored on later launches. Publishers control session validity, and a successful login or verification is not guaranteed to remain valid indefinitely. Keep these files private. The same browser profile must not be used by multiple MCP, HTTP, CLI, or login processes simultaneously.

## PDF retrieval and verification

For ScienceDirect, an Elsevier API key can enable the official API path. Otherwise, or if the API attempt fails, the browser uses the existing session to locate and fetch the PDF. The downloader checks for the `%PDF-` signature. Agents should also verify that the PDF title or DOI matches the requested paper before reporting success.

A publisher page showing an institution name does not itself prove that a particular article is covered. Likewise, access through an author's sharing link does not prove institutional entitlement.

Nature article-in-press pages can expose a stale metadata PDF URL while their main article link ends in `_reference.pdf`; the downloader checks for that article-specific link without selecting supplementary material. Sage article pages can link to an HTML PDF/EPUB reader; the downloader tries the corresponding direct `/doi/pdf/` route. Publisher layouts may change.

The tool first tries an in-page request and then browser navigation. If both fail, the error reports available HTTP status, response type, and whether a human-verification page was detected. A 403 from an in-page request does not prove that direct browser navigation will fail. Query strings and fragments are removed from PDF timeout diagnostics because they may contain temporary access tokens. Access and verification decisions remain with the publisher.

When the in-page PDF request returns ordinary HTML or indicates a temporary error, the downloader retries up to two times with short delays before browser navigation. Ordinary HTML returned by navigation can also be retried up to twice when no challenge is detected. Recognized human-verification pages and HTTP 401/403 are not repeatedly fetched; browser navigation may still succeed, or the user can complete verification. HTML without a recognizable reason is reported as cause unknown, not assumed to be a temporary error. For example, a PMC PDF link can return HTTP 200 with HTML rather than PDF; the status alone does not identify the cause.

Run `npm test` after changing PDF-link detection or download handling. The regression tests use intercepted pages and a local server; they cover delayed links, article versus supplementary PDFs, Sage readers, and navigation fallback after a rejected in-page request.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DOWNLOAD_DIR` | `downloads` | PDF output directory, relative to the project unless absolute |
| `USER_DATA_DIR` | `.browser-profile` | Persistent browser profile directory |
| `PLAYWRIGHT_BROWSERS_PATH` | Project `browsers/` if present; otherwise Playwright default | Chromium installation directory |
| `BROWSER_CHANNEL` | Playwright Chromium | Optional browser channel, such as `msedge` |
| `PLAYWRIGHT_HEADLESS` | `false` | Headless browser mode; publisher access may be affected |
| `VPN_MODE` | `auto` | `auto`: try eduVPN without blocking downloads; `none`: disabled; `eduvpn`: require eduVPN; `external`: use configured VPN commands |
| `EDUVPN_CLIENT_PATH` | Search standard Windows locations | Optional path to the eduVPN client |
| `EDUVPN_ADAPTER_NAME`, `EDUVPN_SERVER_NAME`, `EDUVPN_PROFILE_NAME` | Unset | Optional exact names for selecting the eduVPN adapter, saved server and profile |
| `VPN_STATUS_EXECUTABLE`, `VPN_STATUS_ARGS_JSON` | Unset, `[]` | External VPN status executable and JSON argument array; exit 0 connected, 1 disconnected, other unknown |
| `VPN_CONNECT_EXECUTABLE`, `VPN_CONNECT_ARGS_JSON` | Unset, `[]` | Optional external VPN connection executable and JSON argument array |
| `HUMAN_VERIFICATION_TIMEOUT_MS` | `300000` | Maximum wait for a recognized human-verification challenge |
| `PORT` | `3000` | Local HTTP server port |
| `ELSEVIER_API_KEY`, `ELSEVIER_INSTTOKEN` | Unset | Optional Elsevier API credentials; full text requires entitlement |
| `ZOTERO_API_MODE` | `local` | Use the local Zotero API by default; set to `web` explicitly for legacy Web API archiving |
| `ZOTERO_API_KEY`, `ZOTERO_USER_ID`, `ZOTERO_LIBRARY_TYPE` | Unset, unset, `user` | Web API item creation settings, used only in explicit `web` mode |

## Compatibility interfaces

The MCP server also exposes `inspect_paper`, `read_paper`, `open_login_page`, and `archive_paper_to_zotero`. The HTTP server exposes corresponding `/api/papers/inspect`, `/api/papers/read`, `/api/papers/login`, and `/api/papers/archive` endpoints, plus `/health`.

`inspect_paper` returning a null PDF URL means no link was detected; it does not establish whether access is available. The Zotero archive function creates an item and records the local PDF path in `extra`; it **does not upload the PDF as an attachment**. Use and verify a separate Zotero attachment workflow when required.

## Zotero authorization for downstream workflows

PaperDownloader is a downloader. Downloading and translating a PDF do not themselves require a Zotero key. When the user also requests Zotero changes, an agent may use a separate Zotero workflow to import or edit the item and attach files. The built-in `archive_paper_to_zotero` compatibility interface uses the **Zotero local API by default** and the same shared local credential. Set `ZOTERO_API_MODE=web` explicitly to use the legacy Web API and `ZOTERO_API_KEY` instead. Both modes create metadata only; neither uploads PDF files. Pass an optional `collectionKey` to choose a collection explicitly; otherwise the new item is not added to a collection.

Zotero Desktop 10+ also exposes a **local API** at `http://127.0.0.1:23119/api/`, separate from the Web API. It can edit local items and upload stored attachments. Local read requests require no key; local writes require a key granted by the user through Zotero's authorization dialog. Web API and local API keys are different and cannot be interchanged. Older Zotero local APIs are read-only. See the official [local API documentation](https://www.zotero.org/support/dev/web_api/v3/local_api) and [file upload documentation](https://www.zotero.org/support/dev/web_api/v3/file_upload).

On Windows, the optional `scripts/zotero_local_auth.py` helper uses the same Windows Credential Manager entry for all authorized local Zotero workflows on the same Zotero server. Python 3 and a running, enabled Zotero 10+ local API are required. If the shared key is missing or rejected, local archiving reports that authorization is needed; run `setup` and let the user approve before retrying. It stores no key in this repository. The local archive interface uses the helper. PDF translation plugins must use an authorized downstream Zotero workflow when attaching their output.

```powershell
python scripts/zotero_local_auth.py status  # Check for an existing local credential
python scripts/zotero_local_auth.py setup   # Reuse it or ask Zotero for authorization
python scripts/zotero_local_auth.py verify  # Validate it without changing library items
```

If authorization is needed, tell the user that Zotero will show a prompt. The user chooses whether to allow it; do not control the dialog or bypass it. **Allow** grants a single-use key. **Always Allow** grants a reusable key; the helper saves it in Windows Credential Manager for that Windows user and Zotero server ID, then reuses it across processes. A local key allows writes to all libraries the user can edit, so retain it securely and use it only for authorized tasks. Zotero can revoke remembered authorizations in Settings → Advanced. If a key is revoked, missing, or rejected with HTTP 401, remove the stale cached entry and request authorization again; do not repeatedly prompt without explaining why. Do not log keys or put them in repository files, prompts, command lines, or URLs.

Python callers may import `get_write_headers()` from the helper and use its returned headers in memory for local writes. On a 401, call `forget_key(server_id)` and retry only the request rejected as unauthorized after a fresh grant. Check the target collection and existing children before writing; Zotero Connector's save endpoints target the selected collection, unlike explicit local API item updates. Verify a saved attachment belongs to the intended item, is a parseable PDF, and matches the downloaded or translated file. Handle partial uploads without creating duplicates. A separate PDF2zh translation workflow should use short temporary filenames if Windows path lengths cause output-save errors; verify the translation before attaching it.

The `.env`, `.browser-profile/`, `downloads/`, and `browsers/` paths are ignored by Git and should not be committed.
