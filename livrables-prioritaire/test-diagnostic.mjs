import assert from 'node:assert/strict';
import { diagnosticProvisionnement } from '../scripts/lib/diagnostic_provisionnement.mjs';
const secret = 'MOT_DE_PASSE_SENTINELLE';
const output = diagnosticProvisionnement({ status: 1, signal: null,
  stdout: `ECHEC provisionnement du schéma migrateur — ALTER SCHEMA → 42501 secret=${secret}`,
  stderr: `ReferenceError: ROLE_WORKER is not defined\npostgresql://postgres:${secret}@host/base\ncode: '42501'`,
}, 1).join('\n');
assert.match(output, /ReferenceError ROLE_WORKER non defini/);
assert.match(output, /SQLSTATE 42501/);
assert.match(output, /provisionnement du schema migrateur/);
assert.ok(!output.includes(secret));
assert.ok(!output.includes('postgresql://'));
const fake = diagnosticProvisionnement({ status: 1, stdout: `ReferenceError: ${secret} is not defined\ncode: 'ABCDE'` }, 2).join('\n');
assert.ok(!fake.includes(secret));
assert.ok(!fake.includes('ABCDE'));
assert.equal(diagnosticProvisionnement({status:0,stdout:secret},1).length,0);
console.log('OK diagnostics utiles : ReferenceError, SQLSTATE, libellé et masquage des données arbitraires');
