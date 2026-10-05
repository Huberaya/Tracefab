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

  await page.locator('button[data-view="sites"]').first().click();
  await page.locator('#site-form input[name="name"]').fill('Nhãn Lisbon');
  await page.locator('#site-form input[name="countryCode"]').fill('PT');
  await page.locator('#site-form button[type="submit"]').click();
  await page.getByText('Site ajouté en mode démonstration.').waitFor();

  await page.locator('button[data-view="certifications"]').first().click();
  await page.locator('#certification-form input[name="standardName"]').fill('OEKO-TEX');
  await page.locator('#certification-form button[type="submit"]').click();
  await page.getByText('Certificat déclaré en mode démonstration.').waitFor();

  await page.locator('button[data-view="materials"]').first().click();
  await page.locator('#material-form input[name="name"]').fill('Lin européen');
  await page.locator('#material-form input[name="materialType"]').fill('fiber');
  await page.locator('#material-form button[type="submit"]').click();
  await page.getByText('Matériau ajouté en mode démonstration.').waitFor();

  await page.locator('button[data-view="documents"]').first().click();
  await page.locator('#document-form input[name="file"]').setInputFiles({ name:'audit-note.txt', mimeType:'text/plain', buffer:Buffer.from('private evidence demo') });
  await page.locator('#document-form button[type="submit"]').click();
  await page.getByText('Preuve ajoutée en mode démonstration.').waitFor();

  await page.locator('button[data-view="dataPoints"]').first().click();
  await page.locator('#data-point-form input[name="dataKey"]').fill('annual_production_capacity');
  await page.locator('#data-point-form select[name="dataType"]').selectOption('number');
  await page.locator('#data-point-form textarea[name="value"]').fill('125000');
  await page.locator('#data-point-form button[type="submit"]').click();
  await page.getByText('Donnée enregistrée en mode démonstration.').waitFor();

  await page.locator('button[data-view="members"]').first().click();
  await page.locator('#member-invite-form input[name="email"]').fill('quality@nhan-textile.example');
  await page.locator('#member-invite-form button[type="submit"]').click();
  await page.getByText('Invitation créée en mode démonstration.').waitFor();
  await page.locator('#organization-switcher').selectOption('demo-supplier-org-2');
  await page.locator('#organization-switcher').selectOption('demo-supplier-org');

  await page.locator('button[data-view="quality"]').first().click();
  await page.getByRole('button', { name: 'Recalculer le score' }).click();
  await page.getByText('Score qualité recalculé en mode démonstration.').waitFor();

  await page.locator('button[data-view="requests"]').first().click();
  await page.locator('[data-request-id="demo-supplier-request-1"]').click();
  await page.getByRole('heading', { name: 'Données produit — collection automne' }).waitFor();

  await page.locator('[data-item-id="demo-item-1"] textarea[name="responseValue"]').fill('A cotton garment manufactured in Portugal.');
  await page.locator('[data-item-id="demo-item-1"] button[type="submit"]').click();
  await page.getByText('Réponse enregistrée en mode démonstration.').waitFor();
  await page.locator('[data-item-id="demo-item-3"] input[name="responseValue"]').fill('80');
  await page.locator('[data-item-id="demo-item-3"] select[name="sourceDocumentId"]').selectOption('demo-document-1');
  await page.locator('[data-item-id="demo-item-3"] button[type="submit"]').click();
  await page.locator('[data-item-id="demo-item-4"] textarea[name="responseValue"]').fill('[{"materialKey":"cotton","percentage":80}]');
  await page.locator('[data-item-id="demo-item-4"] select[name="sourceDocumentId"]').selectOption('demo-document-1');
  await page.locator('[data-item-id="demo-item-4"] button[type="submit"]').click();
  await page.getByRole('button', { name: 'Soumettre à la marque' }).click();
  await page.getByText('Demande soumise en mode démonstration.').waitFor();

  await browser.close();
  console.log('Supplier Portal browser flow passed: profile, sites, certifications, materials, private evidence, data points, team, multi-organization switch, quality, request response and submission');
} finally {
  server.kill('SIGTERM');
}
