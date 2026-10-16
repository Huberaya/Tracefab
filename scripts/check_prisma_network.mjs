#!/usr/bin/env node
// Chantier 2C.34 / 2C.35 — contrôle réseau uniquement, pas une preuve de génération.
import { PRISMA_BINARIES_HOST, probePrismaBinaries } from './prisma-network.mjs';

const result = await probePrismaBinaries();
const details = [];
if (result.statusCode) details.push(`status=${result.statusCode}`);
if (result.reason === 'network') details.push(`error=${result.errorCode}`);
else if (result.reason) details.push(`error=${result.reason}`);
console.log(`host=${PRISMA_BINARIES_HOST}${details.length ? ` ${details.join(' ')}` : ''} reachable=${result.reachable}`);
process.exitCode = result.reachable ? 0 : 1;
