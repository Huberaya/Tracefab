import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 4174;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

try {
  await delay(350);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/supplier-portal/?demo=1`, { waitUntil: 'domcontentloaded' });

  await page.getByRole('heading', { name: 'Bonjour Rui.' }).waitFor();
  await page.locator('button[data-view="profile"]').first().click();
  await page.locator('#profile-form input[name="contactPhone"]').fill('+351 211 222 333');
  await page.locator('#profile-form button[type="submit"]').click();
  await page.getByText('Profil enregistré en mode démonstration.').waitFor();

  await page.locator('button[data-view="requests"]').first().click();
  await page.locator('[data-request-id="demo-supplier-request-1"]').click();
  await page.getByRole('heading', { name: 'Données produit — collection automne' }).waitFor();

  await page.locator('[data-item-id="demo-item-1"] textarea[name="responseValue"]').fill('A cotton garment manufactured in Portugal.');
  await page.locator('[data-item-id="demo-item-1"] button[type="submit"]').click();
  await page.getByText('Réponse enregistrée en mode démonstration.').waitFor();
  await page.locator('[data-item-id="demo-item-3"] input[name="responseValue"]').fill('80');
  await page.locator('[data-item-id="demo-item-3"] button[type="submit"]').click();
  await page.locator('[data-item-id="demo-item-4"] textarea[name="responseValue"]').fill('[{"materialKey":"cotton","percentage":80}]');
  await page.locator('[data-item-id="demo-item-4"] button[type="submit"]').click();
  await page.getByRole('button', { name: 'Soumettre à la marque' }).click();
  await page.getByText('Demande soumise en mode démonstration.').waitFor();

  await browser.close();
  console.log('Supplier Portal browser flow passed: profile, request response and submission');
} finally {
  server.kill('SIGTERM');
}
