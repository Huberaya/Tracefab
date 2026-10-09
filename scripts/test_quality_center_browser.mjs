import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 4175;
// On sert via dev_static_server.mjs, seul serveur local qui applique les
// reecritures de vercel.json. Un test qui valide contre un serveur ignorant le
// routage de production ne prouve rien sur la production.
const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

try {
  await delay(350);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Ce scenario verifie des libelles francais : la locale par defaut du site
  // est l'anglais depuis la couche i18n, donc on force la langue.
  await page.goto(`http://127.0.0.1:${port}/quality-center/?demo=1&lang=fr`, { waitUntil: 'domcontentloaded' });

  await page.getByRole('heading', { name: 'Décider avec des signaux explicables.' }).waitFor();
  await page.getByText('Les statuts déclaratifs ne sont jamais transformés en certification.').waitFor();
  await page.locator('[data-issue-action="ack"]').first().click();
  await page.getByText('Issue acquittée en mode démo.').waitFor();
  await page.locator('[data-issue-action="waive"]').first().click();
  await page.getByText('Waiver enregistré en mode démo.').waitFor();

  await browser.close();
  console.log('Quality Center browser flow passed: explainable issues, declared-versus-certified disclaimer, acknowledge and waiver actions');
} finally {
  server.kill('SIGTERM');
}
