# PaperDownloader

可复用的论文 PDF 下载工具链：给定文章页面 URL，借助持久化登录的浏览器会话（机构登录）无人值守下载全文 PDF。提供 **MCP 工具**、**HTTP API**、**CLI** 三种接入方式，便于 agent 调用。

> 定位是论文下载工具：由调用方提供已确定的论文链接或合法分享链接。本项目不搜索、推荐、筛选论文，也不向 LLM 提供研究建议或提示词。已有页面读取和 Zotero 条目接口仅作兼容用途。

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
# 按需通过环境变量配置；仅在 .env 不存在时才创建配置文件
npm run build
```

运行环境：Node ≥ 22，使用 Playwright 自带 Chromium（有界面运行）。本机 Edge 被组策略 `RemoteDebuggingAllowed=0` 禁止自动化，因此不用系统 Edge；在无此策略的机器上可设 `BROWSER_CHANNEL=msedge`。

项目迁移后，默认使用项目目录下的 `downloads/`、`.browser-profile/` 和 `browsers/`；如未复制 `browsers/`，需在新环境重新安装 Playwright Chromium。显式设置的 `PLAYWRIGHT_BROWSERS_PATH` 优先。Windows 上 eduVPN 优先从常见安装目录查找，也可通过 `EDUVPN_CLIENT_PATH` 指定程序完整路径。跨电脑迁移浏览器资料不保证保留登录态，可能需要重新登录。连接 FAU 仍依赖本机已安装 eduVPN、已配置 FAU 入口及有效授权。

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
{ "command": "node", "args": ["E:/Study/Paper-pool/Paperdownloader/dist/mcp/server.js"], "env": { "PLAYWRIGHT_BROWSERS_PATH": "E:/Study/Paper-pool/Paperdownloader/browsers" } }
```

| 工具 | 参数 | 说明 |
|---|---|---|
| `download_paper_pdf` | `url`, `fileName?` | 下载 PDF，返回 `pdfPath`、`title`、`citation` |
| `inspect_paper` | `url` | 只取元数据和 `pdfUrl`；`pdfUrl=null` 表示未检测到链接，原因需进一步判断 |
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

下载前检查 Windows 中 `eduvpn.fau.de` 网络适配器。已连接时直接继续；未连接时启动 eduVPN（如有必要），通过 Windows 辅助功能接口选中已保存的 FAU 入口并发送 Enter，或在已选 FAU 配置页调用连接开关，不移动鼠标，然后等待并检查隧道状态。此操作需要交互式桌面，会短暂切换键盘焦点；需要重新登录、验证或无法连接时会报错，由用户处理后重试。不会自动断开已有 VPN，也不会读取 VPN 密码。

1. ScienceDirect 且配置了 `ELSEVIER_API_KEY`：先尝试 Elsevier 官方 API，失败自动回退浏览器（`apiFallbackReason` 给出原因）。
2. 打开文章页 → 轮询（≤20s）找 PDF 链接 → 在页面内 `fetch`（携带登录 cookie）→ 失败则导航到 PDF 地址捕获响应。
3. 只接受以 `%PDF-` 开头的内容，并应核验首页标题或 DOI。ScienceDirect / Elsevier 即使已有 FAU 登录，也可能要求“Are you a robot”等人机验证。识别到验证时，程序会提示用户在 PaperDownloader 浏览器中完成；不能保证识别所有验证，PDF 捕获也可能先超时。完成后复用同一浏览器资料重试，不自动点击验证、不输入凭据。超时、未找到链接或出现机构名称本身，都不足以证明有没有全文权限。

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOWNLOAD_DIR` | `downloads` | PDF 输出目录（相对项目根目录） |
| `USER_DATA_DIR` | `.browser-profile` | 浏览器配置/登录态目录 |
| `BROWSER_CHANNEL` | 空 | 空 = Playwright Chromium；`msedge` = 系统 Edge |
| `PLAYWRIGHT_HEADLESS` | `false` | 无头模式（ScienceDirect 会拦截，不建议） |
| `EDUVPN_CLIENT_PATH` | 自动查找常见目录 | eduVPN.Client.exe 的完整路径，可覆盖自动查找 |
| `HUMAN_VERIFICATION_TIMEOUT_MS` | `300000` | 人机验证等待上限 |
| `PORT` | `3000` | HTTP 端口 |
| `ELSEVIER_API_KEY` / `ELSEVIER_INSTTOKEN` | 空 | Elsevier TDM API；全文需机构 IP 或 insttoken |
| `ZOTERO_API_KEY` / `ZOTERO_USER_ID` / `ZOTERO_LIBRARY_TYPE` | 空 / 空 / `user` | Zotero 归档 |

## 注意事项

- 同一时间只能有一个进程使用 `.browser-profile`（MCP、HTTP、CLI、login 互斥）。MCP 运行时需要登录请用 `open_login_page`。
- 公司网络的 TLS 检查会让 Node 侧 HTTPS 失败，因此 PDF 一律通过浏览器内请求获取。
- Zotero 目前只创建条目（PDF 本地路径写在 `extra`），尚未上传附件文件。
- `.env`、`.browser-profile/`、`downloads/` 已在 `.gitignore` 中，切勿提交。当前机器的 `.env` 是目录，配置请使用进程环境变量；不要覆盖该目录。

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
