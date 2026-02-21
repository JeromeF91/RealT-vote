#!/usr/bin/env node
/**
 * Fetches the list of asset IDs from api.realtoken.network/graphql
 * (same API used by vote.realtoken.network). No browser needed.
 *
 * Run: node scripts/fetch-asset-ids-from-api.js [--out asset-ids.txt]
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

const API = 'https://api.realtoken.network/graphql';
const HEADERS = {
  accept: '*/*',
  'content-type': 'application/json',
  origin: 'https://vote.realtoken.network',
  referer: 'https://vote.realtoken.network/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

async function graphql(operationName, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function main() {
  const now = Math.floor(Date.now() / 1000).toString();
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 && process.argv[outIdx + 1] ? resolve(process.argv[outIdx + 1]) : null;

  const ids = new Set();

  try {
    const [active, noActive] = await Promise.all([
      graphql(
        'getAssetWithActiveProposals',
        `query getAssetWithActiveProposals {
          realTokenGovGnosis {
            tokens(first: 1000, where: {proposals_: {endTimestamp_gte: "${now}"}}) {
              tokenId
            }
          }
        }`
      ),
      graphql(
        'getAssetWithNoActiveProposals',
        `query getAssetWithNoActiveProposals {
          realTokenGovGnosis {
            tokens(first: 1000, where: {proposals_: {endTimestamp_lt: "${now}"}}) {
              tokenId
            }
          }
        }`
      ),
    ]);

    const tokens = (d) => d?.realTokenGovGnosis?.tokens ?? [];
    for (const t of tokens(active)) if (t?.tokenId) ids.add(String(t.tokenId));
    for (const t of tokens(noActive)) if (t?.tokenId) ids.add(String(t.tokenId));

    const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
    console.log('Asset IDs from API:', sorted.length);
    sorted.forEach((id) => console.log(' ', id));

    if (outPath && sorted.length > 0) {
      const content = '# RealToken asset IDs from api.realtoken.network/graphql\n' + sorted.join('\n') + '\n';
      writeFileSync(outPath, content, 'utf8');
      console.log('Wrote', outPath);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
