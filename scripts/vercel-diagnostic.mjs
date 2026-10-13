/**
 * TRACEFAB — Proxy Vercel API
 * 
 * Ce fichier est un script Node.js à exécuter sur votre machine locale.
 * Il fait tous les appels Vercel nécessaires et affiche les résultats.
 * 
 * Usage:
 *   export VERCEL_TOKEN="votre_token"
 *   node scripts/vercel-diagnostic.mjs
 * 
 * ⚠️ Lecture seule — aucune modification de Vercel.
 */

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error('ERREUR: export VERCEL_TOKEN="votre_token" avant de lancer');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}` };

async function api(path) {
  const res = await fetch(`https://api.vercel.com${path}`, { headers });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log('='.repeat(60));
  console.log('TRACEFAB — Diagnostic Vercel');
  console.log('='.repeat(60));

  // 1. User
  console.log('\n--- 1. Utilisateur Vercel ---');
  const user = await api('/v2/user');
  console.log(JSON.stringify(user, null, 2));

  // 2. Projects
  console.log('\n--- 2. Projets ---');
  const projects = await api('/v9/projects');
  const tfProject = projects.data?.projects?.find(p => p.name === 'tracefab');
  
  if (projects.data?.projects) {
    for (const p of projects.data.projects) {
      console.log(`  ${p.name} | ID: ${p.id} | Framework: ${p.framework || 'none'}`);
    }
  }

  if (!tfProject) {
    console.log('ERREUR: projet tracefab non trouvé');
    return;
  }

  const PID = tfProject.id;
  console.log(`\n  → tracefab project ID: ${PID}`);

  // 3. Deployments
  console.log('\n--- 3. Derniers déploiements ---');
  const deps = await api(`/v6/deployments?projectId=${PID}&limit=10`);
  if (deps.data?.deployments) {
    for (const d of deps.data.deployments) {
      console.log(`  ${d.uid?.substring(0,10)} | ${d.environment} | ${d.state} | ${new Date(d.created * 1000).toISOString()} | ref: ${d.meta?.githubCommitRef || '?'}`);
    }
  }

  // 4. Env vars (names only)
  console.log('\n--- 4. Variables d\'environnement (noms seulement) ---');
  const envs = await api(`/v9/projects/${PID}/env`);
  if (envs.data?.envs) {
    for (const e of envs.data.envs) {
      const targets = (e.target || []).join(', ');
      const gitBranch = e.gitBranch ? ` (branch: ${e.gitBranch})` : '';
      console.log(`  ${e.key} [${targets}]${gitBranch}`);
    }
    console.log(`\n  Total: ${envs.data.envs.length} variables`);
  }

  // 5. Latest production deployment build logs
  console.log('\n--- 5. Logs du dernier déploiement Production ---');
  const prodDeps = await api(`/v6/deployments?projectId=${PID}&limit=1&target=production`);
  if (prodDeps.data?.deployments?.[0]) {
    const latest = prodDeps.data.deployments[0];
    console.log(`  Deployment: ${latest.uid}`);
    console.log(`  State: ${latest.state}`);
    console.log(`  Created: ${new Date(latest.created * 1000).toISOString()}`);
    console.log(`  Ready: ${latest.readyState || '?'}`);
    console.log(`  URL: ${latest.url || '?'}`);
    
    // Build logs
    const logs = await api(`/v5/deployments/${latest.uid}/events?direction=backward&limit=100`);
    if (Array.isArray(logs.data)) {
      console.log('\n  Build/Runtime logs:');
      for (const ev of logs.data) {
        const text = ev.text || ev.message || ev.payload?.text || '';
        if (text) console.log(`    ${text.substring(0, 300)}`);
      }
    } else {
      console.log('  Logs format:', typeof logs.data, JSON.stringify(logs.data).substring(0, 500));
    }
  }

  // 6. Domain info
  console.log('\n--- 6. Domaines ---');
  const domains = await api(`/v9/projects/${PID}/domains`);
  if (domains.data?.domains) {
    for (const d of domains.data.domains) {
      console.log(`  ${d.name} | verified: ${d.verified} | target: ${d.target || '?'}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Fin du diagnostic.');
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('Erreur fatale:', e.message);
  process.exit(1);
});