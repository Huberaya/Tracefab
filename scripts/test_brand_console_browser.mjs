import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 4173;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

try {
  await delay(350);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/brand-console/?demo=1`, { waitUntil: 'domcontentloaded' });

  await page.getByRole('heading', { name: 'Bonjour Camille.' }).waitFor();
  await page.getByRole('button', { name: 'Produits' }).click();
  await page.locator('[data-product-id="demo-product-1"]').click();
  await page.getByRole('heading', { name: 'Essentiel coton' }).waitFor();

  await page.locator('#material-form select[name="materialId"]').selectOption('demo-material-1');
  await page.locator('#material-form input[name="percentage"]').fill('80');
  await page.locator('#material-form button[type="submit"]').click();
  await page.getByText('Coton biologique').first().waitFor();

  await page.locator('#identifier-form select[name="identifierType"]').selectOption('ean');
  await page.locator('#identifier-form input[name="identifierValue"]').fill('3760123456789');
  await page.locator('#identifier-form button[type="submit"]').click();
  await page.getByText('EAN').first().waitFor();

  await page.getByRole('button', { name: 'Fournisseurs' }).click();
  await page.locator('[data-supplier-id-view="demo-supplier-record"]').click();
  await page.getByRole('heading', { name: 'Nhãn Textile' }).waitFor();

  await browser.close();
  console.log('Brand Console browser flow passed: demo navigation, product composition, identifiers and supplier detail');
} finally {
  server.kill('SIGTERM');
}
