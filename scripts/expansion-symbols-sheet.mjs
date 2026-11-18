// Screenshot the tools/expansion-symbols review page (dark + light, 1x and 3x).
//   node scripts/expansion-symbols-sheet.mjs <sheet.html> <out-prefix>
// Needs playwright (e.g. NODE_PATH=~/tmp/first-user-qa/node_modules).
import { chromium } from 'playwright';

const [html, prefix] = process.argv.slice(2);
if (!html || !prefix) {
  console.error('usage: node expansion-symbols-sheet.mjs <sheet.html> <out-prefix>');
  process.exit(2);
}
const browser = await chromium.launch();
for (const scale of [1, 3]) {
  const page = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: scale });
  await page.goto(`file://${html}`);
  await page.waitForLoadState('networkidle');
  const path = `${prefix}-${scale}x.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(path);
  await page.close();
}
await browser.close();
