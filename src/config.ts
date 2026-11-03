import path from "node:path";
import { fileURLToPath } from "node:url";

// Project root (works from both src/ and dist/), so agents can launch the tools from any working directory.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch {
  // No .env file - rely on the real environment.
}

export const appConfig = {
  port: Number(process.env.PORT ?? "3000"),
  downloadDir: path.resolve(projectRoot, process.env.DOWNLOAD_DIR ?? "downloads"),
  userDataDir: path.resolve(projectRoot, process.env.USER_DATA_DIR ?? ".browser-profile"),
  // Empty = Playwright's bundled Chromium. Set to "msedge" to drive the system Edge instead.
  browserChannel: process.env.BROWSER_CHANNEL ?? "",
  // Elsevier TDM API: full text needs entitlement via institutional IP or an insttoken.
  elsevierApiKey: process.env.ELSEVIER_API_KEY ?? "",
  elsevierInstToken: process.env.ELSEVIER_INSTTOKEN ?? "",
  zoteroApiKey: process.env.ZOTERO_API_KEY ?? "",
  zoteroUserId: process.env.ZOTERO_USER_ID ?? "",
  zoteroLibraryType: process.env.ZOTERO_LIBRARY_TYPE ?? "user",
};
