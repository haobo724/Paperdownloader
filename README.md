# PaperDownloader

可复用的论文 PDF 下载工具链：给定文章页面 URL，借助持久化登录的浏览器会话（机构登录）无人值守下载全文 PDF。提供 **MCP 工具**、**HTTP API**、**CLI** 三种接入方式，便于 agent 调用。

> 只负责“打开 / 读取 / 下载 / 归档”，不负责搜索论文。

## 已验证平台

| 平台 | PDF 定位方式 |
|---|---|
| ScienceDirect (Elsevier) | `pdfft` 链接（可选 Elsevier 官方 API） |
| Springer Link | `citation_pdf_url` |
| Nature | `citation_pdf_url` |
| IEEE Xplore | 由 arnumber 推导 `stampPDF/getPDF.jsp` |
| 其他平台 | 通用规则：`citation_pdf_url` → "View/Download PDF" → `.pdf` 链接 |

## 安装

```bash
npm install
npx playwright install chromium
cp .env.example .env        # 按需填写
npm run build
```

运行环境：Node ≥ 22，使用 Playwright 自带 Chromium（有界面运行）。本机 Edge 被组策略 `RemoteDebuggingAllowed=0` 禁止自动化，因此不用系统 Edge；在无此策略的机器上可设 `BROWSER_CHANNEL=msedge`。

## 一次性登录（人工）

```bash
npm run login -- "<文章URL1>" "<文章URL2>"
```

每个 URL 开一个标签页。在文章页点 **Access through your institution / Institutional Sign In**，搜索并选择机构完成登录（如有人机验证手动点一下），看到可下载 PDF 后等几秒再关闭浏览器。

- 登录态保存在 `.browser-profile/`（长期 cookie）和 `.browser-profile/session-cookies.json`（会话 cookie 快照，每 5 秒及退出时保存），任意网站通用。
- 机构 SSO（Shibboleth/OpenAthens）也会被记住，新平台通常只需点一次机构登录。
- 会话过期时下载会报错并提示重新登录。

## 使用方式

### 1. MCP（推荐给 agent）

```bash
npm run mcp      # = node dist/mcp/server.js（stdio）
```

VS Code 已在 [.vscode/mcp.json](.vscode/mcp.json) 中注册。其他客户端配置：

```json
{ "command": "node", "args": ["D:/Paperdownloader/dist/mcp/server.js"] }
```

| 工具 | 参数 | 说明 |
|---|---|---|
| `download_paper_pdf` | `url`, `fileName?` | 下载 PDF，返回 `pdfPath`、`title`、`citation` |
| `inspect_paper` | `url` | 只取元数据和 `pdfUrl`；`pdfUrl=null` 通常表示无权限 |
| `read_paper` | `url`, `maxChars?`(默认 20000) | 页面可见文本（摘要/HTML 全文） |
| `open_login_page` | `url` | 在浏览器中打开页面供**人工**登录 |
| `archive_paper_to_zotero` | `url`, `title?`, `pdfPath?` | 创建 Zotero 条目 |

### 2. CLI（批量）

```bash
npm run download -- "<url1>" "<url2>"
```

每篇输出一行 JSON：`{"ok":true,"pdfPath":...,"title":...,"citation":{...},"source":"browser"}` 或 `{"ok":false,"url":...,"error":...}`；任一失败则退出码为 1。

### 3. HTTP API

```bash
npm run start    # http://127.0.0.1:3000（仅本机）
```

| 方法 | 路径 | Body |
|---|---|---|
| GET | `/health` | – |
| POST | `/api/papers/download-pdf` | `{ "url", "fileName?" }` |
| POST | `/api/papers/inspect` | `{ "url" }` |
| POST | `/api/papers/read` | `{ "url", "maxChars?" }` |
| POST | `/api/papers/login` | `{ "url" }` |
| POST | `/api/papers/archive` | `{ "url", "title?", "pdfPath?" }` |

返回 `{ "ok": true, ... }` 或 `{ "ok": false, "error": "..." }`。

## 下载流程

1. ScienceDirect 且配置了 `ELSEVIER_API_KEY`：先尝试 Elsevier 官方 API，失败自动回退浏览器（`apiFallbackReason` 给出原因）。
2. 打开文章页 → 轮询（≤20s）找 PDF 链接 → 在页面内 `fetch`（携带登录 cookie）→ 失败则导航到 PDF 地址捕获响应。
3. 只接受以 `%PDF-` 开头的内容；30 秒内没拿到 PDF 即失败。若出现人机验证，会把窗口切到前台等待人工处理（最长 `HUMAN_VERIFICATION_TIMEOUT_MS`，默认 300000 ms），**程序不会自动点击验证**。

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOWNLOAD_DIR` | `downloads` | PDF 输出目录（相对项目根目录） |
| `USER_DATA_DIR` | `.browser-profile` | 浏览器配置/登录态目录 |
| `BROWSER_CHANNEL` | 空 | 空 = Playwright Chromium；`msedge` = 系统 Edge |
| `PLAYWRIGHT_HEADLESS` | `false` | 无头模式（ScienceDirect 会拦截，不建议） |
| `HUMAN_VERIFICATION_TIMEOUT_MS` | `300000` | 人机验证等待上限 |
| `PORT` | `3000` | HTTP 端口 |
| `ELSEVIER_API_KEY` / `ELSEVIER_INSTTOKEN` | 空 | Elsevier TDM API；全文需机构 IP 或 insttoken |
| `ZOTERO_API_KEY` / `ZOTERO_USER_ID` / `ZOTERO_LIBRARY_TYPE` | 空 / 空 / `user` | Zotero 归档 |

## 注意事项

- 同一时间只能有一个进程使用 `.browser-profile`（MCP、HTTP、CLI、login 互斥）。MCP 运行时需要登录请用 `open_login_page`。
- 公司网络的 TLS 检查会让 Node 侧 HTTPS 失败，因此 PDF 一律通过浏览器内请求获取。
- Zotero 目前只创建条目（PDF 本地路径写在 `extra`），尚未上传附件文件。
- `.env`、`.browser-profile/`、`downloads/` 已在 `.gitignore` 中，切勿提交。

## 目录结构

```
src/
  config.ts                   配置（路径相对项目根目录）
  browser/persistentBrowser.ts 持久化浏览器、会话 cookie、PDF 定位与抓取
  workflow/paperWorkflow.ts   工作流：inspect / read / download / login / archive
  services/elsevier.ts        Elsevier TDM API
  services/zotero.ts          Zotero Web API
  mcp/server.ts               MCP 工具（stdio）
  server.ts                   HTTP API
  download.ts                 CLI 批量下载
  login.ts                    CLI 人工登录
```
