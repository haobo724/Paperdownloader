import { PersistentEdgeBrowser } from "./browser/persistentBrowser.js";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push("https://www.sciencedirect.com");
}

const browser = new PersistentEdgeBrowser();

let page = await browser.openPage(urls[0]);
for (const url of urls.slice(1)) {
  page = await browser.openPage(url);
}
console.log(`Persistent browser opened ${urls.length} tab(s): ${urls.join(", ")}`);
console.log("Manually log in to each site (and complete any captcha), then close the browser window or press Ctrl+C.");

const shutdown = async () => {
  await browser.close().catch(() => undefined);
  process.exit(0);
};

page.context().on("close", () => process.exit(0));
process.on("SIGINT", shutdown);

await new Promise<void>(() => {
  // Keep the Node event loop alive until the browser window is closed or Ctrl+C is pressed.
});
