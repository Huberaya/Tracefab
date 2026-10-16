#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchTestBrowser } from './lib/launch_chromium.mjs';
const BASE=process.env.TF_BASE||'http://127.0.0.1:3000';
const browser=await launchTestBrowser();
const page=await browser.newPage({viewport:{width:390,height:844}});
let checks=0; const ok=(value,message)=>{assert.ok(value,message);checks++;console.log(`  ok    ${message}`);};
const history=Array.from({length:7},(_,i)=>({
  id:`event-${i}`,event_type:i===0?'data_corrected':'evidence_added',
  recorded_at:`2026-10-${String(16-i).padStart(2,'0')}T10:00:00Z`,business_occurred_at:null,
  validation_status:i===0?'documented':(i===1?'controlled':'declared'),
  public_summary:i===0?'<img src=x onerror=window.__xss=1> Composition corrigée':`Événement public ${i}`,
}));
await page.route('**/api/dpp/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
  dpp:{productName:{value:'Chemise réelle',status:'sourced'},sku:{value:'LIVE-1',status:'sourced'},gtin:{value:'3760000000001',status:'sourced'},presentation:{source:'live'}},history,
  links:{digitalLinkUri:'/dpp/LIVE-1'}
})}));
await page.goto(`${BASE}/dpp/?id=LIVE-1`,{waitUntil:'networkidle'});
ok(await page.locator('#lifecycle-list').isVisible(),'chronologie visible sur mobile');
ok(await page.locator('.lifecycle-event').count()===5,'cinq événements affichés initialement');
ok(await page.locator('#lifecycle-count').textContent()==='7 événements','nombre total annoncé');
ok(await page.locator('.trust-badge[data-status="documented"]').count()===1,'niveau documenté visible');
ok(await page.locator('.trust-badge[data-status="controlled"]').count()===1,'niveau contrôlé visible');
ok(await page.locator('.lifecycle-event-title').first().textContent()==='<img src=x onerror=window.__xss=1> Composition corrigée','résumé rendu comme texte, sans HTML interprété');
ok(await page.evaluate(()=>window.__xss)!==1,'charge utile HTML non exécutée');
ok(await page.locator('[data-dpp-demo-only]:visible').count()===0,'affirmations de démonstration masquées pour un passeport réel');
ok(await page.locator('#lifecycle-more').getAttribute('aria-expanded')==='false','bouton replié annoncé aux technologies assistives');
await page.locator('#lifecycle-more').click();
ok(await page.locator('.lifecycle-event').count()===7,'historique complet affiché à la demande');
ok(await page.locator('#lifecycle-more').getAttribute('aria-expanded')==='true','état déplié annoncé');
ok((await page.locator('.lifecycle-event time').first().getAttribute('datetime'))?.startsWith('2026-10-16'),'date machine ISO conservée');

const failure=await browser.newPage({viewport:{width:390,height:844}});
await failure.route('**/api/dpp/**',route=>route.fulfill({status:404,contentType:'application/json',body:'{"error":"product_passport_not_found"}'}));
await failure.goto(`${BASE}/dpp/?id=UNKNOWN`,{waitUntil:'networkidle'});
ok(await failure.locator('[data-dpp-demo-only]:visible').count()===0,'aucune démonstration exposée pour un identifiant inconnu');
ok((await failure.locator('#dpp-demo-banner').textContent()).includes('Aucune donnée de démonstration'),'erreur honnête et explicite');
ok((await failure.locator('#lifecycle-status').textContent()).includes('pas pu être chargé'),'échec historique annoncé dans la zone live');
await browser.close();
console.log(`\nChronologie DPP publique : ${checks} contrôles navigateur réussis.`);
