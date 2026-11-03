import { PaperWorkflow } from "./workflow/paperWorkflow.js";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('Usage: npm run download -- "<paper URL>" ["<paper URL>" ...]');
  process.exit(1);
}

const workflow = new PaperWorkflow();
let failed = 0;

try {
  for (const url of urls) {
    try {
      const result = await workflow.downloadPaperPdf(url);
      console.log(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ ok: false, url, error: error instanceof Error ? error.message : String(error) }));
    }
  }
} finally {
  await workflow.close();
}

process.exit(failed > 0 ? 1 : 0);
