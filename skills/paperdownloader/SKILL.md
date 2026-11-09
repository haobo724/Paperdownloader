---
name: paperdownloader
description: Download identified research papers with PaperDownloader using legitimate publisher or institutional access; verify PDFs and, when requested, coordinate local Zotero archiving and attachments.
---

# PaperDownloader

Use PaperDownloader by default for research-paper downloads unless the user selects another tool. The input is an identified article, DOI landing page, or legitimate author/publisher sharing URL. The project downloads papers; discovery, selection, ranking, research recommendations, and LLM prompts are outside its scope.

## Locate and run

1. Resolve the working checkout from, in order, `PAPERDOWNLOADER_ROOT` when set, the optional machine-local `references/local-installation.md` next to this skill when present, applicable user instructions, or a checkout in the current directory or its ancestors. Verify the root contains `package.json`, `README.md`, and `AGENTS.md`. If none is available, report that the checkout is needed; do not claim the tool ran. The source is https://github.com/haobo724/Paperdownloader.
2. Read that checkout's `README.md` and `AGENTS.md` for current setup and behavior. Prefer the `download_paper_pdf` MCP tool when exposed; otherwise run `npm run download -- '<article URL>'` from the checkout. The project's `browsers/` directory is detected automatically; set `PLAYWRIGHT_BROWSERS_PATH` to that directory if needed. Build first if required.
3. Run only one MCP, HTTP, CLI, or login process against the same persistent browser profile. Inspect the result's `ok`, `pdfPath`, `source`, and `vpn` fields. Verify the file is a parseable PDF and that its title, authors, or DOI matches the requested paper before reporting success.

## Access and verification

The downloader's default VPN mode is `auto`: on supported Windows setups it checks eduVPN and attempts connection, but continues if unavailable. Report an unavailable VPN when relevant, and ask about configuration when it would help. `VPN_MODE=none` skips VPN management; strict settings are documented by the project. Do not disconnect an active tunnel.

Publisher sign-in and human verification belong to the user. ScienceDirect/Elsevier may ask for robot verification even with institutional access. Use the existing MCP server's `open_login_page`, or the project's CLI login command when no server is running; ask the user to complete the challenge in the PaperDownloader browser and retry with the same profile. Do not automate CAPTCHA or credentials. A timeout, HTML response, or 403 alone does not establish lack of access; report the actual diagnostic. Keep browser profiles, cookies, credentials, and local keys private.

## Zotero and translated attachments

Only archive, translate, or modify Zotero when the user's task authorizes it. The compatibility archive interface uses Zotero 10+ local API by default, but creates metadata only: it does not upload the PDF. Verify target collection and existing items first; a `collectionKey` can identify a collection explicitly, and Connector saves instead follow the selected collection. Do not create duplicates.

For local writes, reuse the shared per-server authorization in Windows Credential Manager through the checkout's `scripts/zotero_local_auth.py`; check `status` or `verify` before requesting a new grant. Do not print or commit keys. If the key is absent, revoked, or rejected, explain that Zotero needs authorization and let the user approve its dialog. A one-time grant is single-use; a reusable grant requires the user's choice of **Always Allow**. Local keys and Web API keys are distinct. The optional local helper requires Windows, Python, and Zotero 10+; disclose unavailability rather than claiming success. Do not control the mouse or authorization dialog when the user requests API-only operation.

If PDF or translated-PDF attachments are requested, use a supported Zotero local API attachment workflow, such as the installed `zotero-paper-import` skill when available. Verify the parent item, attachment file, PDF parseability and file hash; for a translation, also check page count and Chinese text. PDF2zh on Windows can fail to save overlong output paths: retry with a short unique filename and preserve its mapping to the original. Report unavailable full texts, translation failures, or attachment failures accurately; do not imply a metadata-only archive uploaded a file.
