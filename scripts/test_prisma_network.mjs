#!/usr/bin/env node
/** Tests de classification HTTP/réseau de la sonde Prisma. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probePrismaBinaries } from './prisma-network.mjs';

function fakeRequest(outcomes) {
  const calls = [];
  const requestImpl = (options, onResponse) => {
    calls.push(options);
    const outcome = outcomes.shift() || { kind: 'error', code: 'NO_FIXTURE' };
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      if (outcome.kind === 'error') {
        const error = Object.assign(new Error('mock network failure'), { code: outcome.code || 'ECONNRESET' });
        request.emit('error', error);
      } else if (outcome.kind === 'timeout') {
        request.emit('timeout');
      } else {
        const response = {
          statusCode: outcome.statusCode,
          headers: outcome.headers || {},
          resume() {},
        };
        onResponse(response);
      }
    });
    request.destroy = () => {};
    return request;
  };
  return { requestImpl, calls };
}

const check = async (label, outcomes, expected) => {
  const fake = fakeRequest(outcomes);
  const result = await probePrismaBinaries({ requestImpl: fake.requestImpl });
  assert.equal(result.reachable, expected.reachable, `${label}: reachable`);
  if (expected.reason) assert.equal(result.reason, expected.reason, `${label}: reason`);
  if (expected.statusCode) assert.equal(result.statusCode, expected.statusCode, `${label}: status`);
  if (expected.redirects !== undefined) assert.equal(result.redirects, expected.redirects, `${label}: redirects`);
  if (expected.errorCode) assert.equal(result.errorCode, expected.errorCode, `${label}: error code`);
  console.log(`  ok    ${label}`);
  return fake;
};

await check('HTTP 200 est exploitable', [{ kind: 'response', statusCode: 200 }], {
  reachable: true, statusCode: 200, redirects: 0,
});
await check('HTTP 204 est exploitable pour HEAD', [{ kind: 'response', statusCode: 204 }], {
  reachable: true, statusCode: 204,
});
for (const statusCode of [400, 403, 404, 429, 500, 502, 503]) {
  await check(`HTTP ${statusCode} est refusé`, [{ kind: 'response', statusCode }], {
    reachable: false, reason: 'http', statusCode,
  });
}
await check('redirection HTTPS suivie jusqu’au HTTP 200', [
  { kind: 'response', statusCode: 302, headers: { location: '/redirected-checksum' } },
  { kind: 'response', statusCode: 200 },
], { reachable: true, statusCode: 200, redirects: 1 });
await check('redirection HTTPS vers HTTP refusée', [
  { kind: 'response', statusCode: 302, headers: { location: 'http://example.invalid/checksum' } },
], { reachable: false, reason: 'insecure-redirect', statusCode: 302 });
await check('refus réseau distingué', [{ kind: 'error', code: 'ECONNRESET' }], {
  reachable: false, reason: 'network', errorCode: 'ECONNRESET',
});
await check('délai dépassé distingué', [{ kind: 'timeout' }], {
  reachable: false, reason: 'timeout',
});

console.log('  Sonde réseau Prisma : tests OK (ces tests ne génèrent pas le client).');
