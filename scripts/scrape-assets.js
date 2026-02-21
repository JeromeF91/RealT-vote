#!/usr/bin/env node
/**
 * Scrapes https://vote.realtoken.network assets:
 * 1) Gets the list of asset IDs (from API, from --urls file, or from the page).
 * 2) For each asset, visits its detail page, then the vote page, to extract:
 *    - Name, Listing Price (USD), Estimated total cost of sales / fees (USD)
 *
 * Run: npm run scrape [-- --out results.csv]
 *      npm run scrape -- --from-api --out results.csv   # get asset list from api.realtoken.network (no browser for list)
 *      npm run scrape -- --urls asset-ids.txt --out results.csv
 */

import puppeteer from 'puppeteer';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ASSETS_URL = 'https://vote.realtoken.network/assets';
const BASE = 'https://vote.realtoken.network';
const API = 'https://api.realtoken.network/graphql';
const HEADFUL = process.env.HEADFUL === '1';

async function fetchAssetIdsFromApi() {
  const now = Math.floor(Date.now() / 1000).toString();
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://vote.realtoken.network',
    referer: 'https://vote.realtoken.network/',
  };
  const q = (name, timeOp, value) =>
    fetch(API, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationName: name,
        query: `query ${name} { realTokenGovGnosis { tokens(first: 1000, where: {proposals_: {endTimestamp_${timeOp}: "${value}"}}) { tokenId } } }`,
      }),
    }).then((r) => r.json());
  const [active, noActive] = await Promise.all([
    q('getAssetWithActiveProposals', 'gte', now),
    q('getAssetWithNoActiveProposals', 'lt', now),
  ]);
  const ids = new Set();
  for (const t of active?.data?.realTokenGovGnosis?.tokens ?? []) if (t?.tokenId) ids.add(String(t.tokenId));
  for (const t of noActive?.data?.realTokenGovGnosis?.tokens ?? []) if (t?.tokenId) ids.add(String(t.tokenId));
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

const API_HEADERS = {
  accept: '*/*',
  'content-type': 'application/json',
  origin: 'https://vote.realtoken.network',
  referer: 'https://vote.realtoken.network/',
};

/** Get proposals for a token; returns [{ proposalId, description }, ...] (newest first). */
async function fetchProposalsForToken(tokenId) {
  const res = await fetch(API, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify({
      operationName: 'GetAssetProposals',
      variables: {},
      query: `query GetAssetProposals {
        realTokenGovGnosis {
          proposals(
            first: 1000
            where: { token_: { tokenId: "${tokenId}" } }
            orderBy: startTimestamp
            orderDirection: desc
          ) {
            id
            proposalId
            description
            token { tokenId }
          }
        }
      }`,
    }),
  });
  const data = await res.json();
  const list = data?.data?.realTokenGovGnosis?.proposals ?? [];
  return list.map((p) => ({ proposalId: p.proposalId, description: p.description || '' }));
}

/** Parse asset id from path or url: /assets/19980 -> 19980, full url -> 19980 */
function toAssetPath(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const m = s.match(/\/assets\/(\d+)/);
  if (m) return `/assets/${m[1]}`;
  if (/^\d+$/.test(s)) return `/assets/${s}`;
  return null;
}

function parseUsdAmount(str) {
  if (!str) return null;
  const n = String(str).replace(/[\s,]/g, '');
  const num = parseInt(n, 10);
  return Number.isNaN(num) ? null : num;
}

function extractListingPriceAndFees(fullText) {
  let listingPriceUsd = null;
  let feesUsd = null;

  const listingMatch = fullText.match(
    /(?:initial\s+gross\s+asking\s+price\s+of\s+)?USD\s*([\d,\s]+)\s*\([^)]*[Ll]isting\s+[Pp]rice/
  );
  if (listingMatch) listingPriceUsd = parseUsdAmount(listingMatch[1]);
  else {
    const alt = fullText.match(/[Ll]isting\s+[Pp]rice[^.]*?USD\s*([\d,\s]+)/);
    if (alt) listingPriceUsd = parseUsdAmount(alt[1]);
  }

  const costMatch = fullText.match(
    /[Ee]stimated\s+total\s+cost\s+of\s+sales[\s\S]*?USD\s*([\d,\s]+)/
  );
  if (costMatch) feesUsd = parseUsdAmount(costMatch[1]);
  else {
    const alt = fullText.match(/(?:total\s+cost\s+of\s+sales|cost\s+of\s+sales)[\s\S]*?USD\s*([\d,\s]+)/);
    if (alt) feesUsd = parseUsdAmount(alt[1]);
  }

  return { listingPriceUsd, feesUsd };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx !== -1 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]) : null;
  const urlsIdx = argv.indexOf('--urls');
  const fromApi = argv.includes('--from-api');
  let listItems = [];

  if (urlsIdx !== -1 && argv[urlsIdx + 1]) {
    const p = resolve(argv[urlsIdx + 1]);
    if (!existsSync(p)) {
      console.error('File not found:', p);
      process.exit(1);
    }
    const lines = readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      const path = toAssetPath(line);
      if (path) listItems.push({ name: path.replace(/^\/assets\//, 'Asset '), assetPath: path });
    }
    if (listItems.length === 0) {
      console.error('No valid asset IDs or /assets/ID lines in', p);
      process.exit(1);
    }
    console.log('Using', listItems.length, 'assets from', p);
  } else if (fromApi) {
    console.log('Fetching asset list from api.realtoken.network/graphql ...');
    const ids = await fetchAssetIdsFromApi();
    listItems = ids.map((id) => ({ name: `Asset ${id}`, assetPath: `/assets/${id}` }));
    console.log('Using', listItems.length, 'assets from API');
  }

  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.evaluateOnNewDocument(() => {
      window.ethereum = window.ethereum || {};
      if (!window.ethereum.request) {
        window.ethereum.request = ({ method }) => {
          if (method === 'eth_chainId') return Promise.resolve('0x64');
          if (method === 'eth_accounts') return Promise.resolve([]);
          return Promise.resolve(null);
        };
      }
    });

    const capturedProposalBodies = [];
    page.on('response', async (res) => {
      try {
        if (res.request().resourceType() !== 'fetch' && res.request().resourceType() !== 'xhr') return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text') && !ct.includes('markdown')) return;
        const text = await res.text();
        if (!text || text.length > 500000) return;
        if (
          text.includes('Listing Price') ||
          text.includes('Estimated total cost') ||
          (text.includes('gross asking price') && /\d{4,}/.test(text))
        ) {
          capturedProposalBodies.push(text);
        }
      } catch (_) {}
    });

    if (listItems.length === 0) {
      console.log('Step 1: Loading assets list at', ASSETS_URL);
      await page.goto(ASSETS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      await page.waitForFunction(
        () => {
          const links = document.querySelectorAll('a[href*="/assets/"]');
          for (const a of links) {
            const h = a.getAttribute('href') || '';
            if (/\/assets\/\d+$/.test(h) || /\/assets\/\d+\?/.test(h)) return true;
          }
          return false;
        },
        { timeout: 20000 }
      ).catch(() => {});

      await new Promise((r) => setTimeout(r, 3000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2000));

      listItems = await page.evaluate(() => {
        const getText = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
        const results = [];
        const links = document.querySelectorAll('a[href*="/assets/"]');
        const seen = new Set();
        for (const a of links) {
          const href = (a.getAttribute('href') || '').trim();
          const norm = href.replace(/\?.*/, '');
          if (!/^\/assets\/\d+$/.test(norm)) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          const card = a.closest('[class*="container"], [class*="card"], [class*="Pane"], article, li, div[class]');
          let name = '';
          if (card) {
            name = getText(card);
            name = name.replace(/\s*View\s*>\s*$/i, '').replace(/\s*\d+\s+votes?\s*/gi, '').trim();
          }
          if (!name) name = getText(a) === 'View >' ? norm : getText(a) || norm;
          results.push({
            name: name.slice(0, 200) || norm,
            assetPath: norm,
          });
        }
        return results;
      });

      if (listItems.length === 0) {
        console.log('No asset cards found. Use --urls asset-ids.txt with one asset ID or /assets/ID per line, or run with HEADFUL=1 and wallet on Gnosis.');
        const fallback = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="/assets/"]'))
            .map((a) => a.getAttribute('href'))
            .filter(Boolean);
        });
        console.log('Links found:', fallback.length ? fallback : 'none');
        if (outPath) writeFileSync(outPath, 'name,listing_price_usd,fees_usd,asset_url,vote_url\n', 'utf8');
        return;
      }
    }

    console.log('Found', listItems.length, 'assets. Step 2: Fetching listing price and fees from each vote page.');

    const results = [];
    for (let i = 0; i < listItems.length; i++) {
      const { name, assetPath } = listItems[i];
      const tokenId = assetPath.replace(/^\/assets\//, '').replace(/\?.*/, '').trim();
      const assetUrl = assetPath.startsWith('http') ? assetPath : BASE + assetPath;
      console.log(`  [${i + 1}/${listItems.length}] ${name || assetPath}`);

      let listingPriceUsd = null;
      let feesUsd = null;
      let displayName = name || assetPath;
      let voteUrl = null;

      try {
        const proposals = await fetchProposalsForToken(tokenId);
        const first = proposals[0];
        if (first?.proposalId) {
          voteUrl = `${BASE}/assets/${tokenId}/vote/${first.proposalId}`;
          const fromDesc = extractListingPriceAndFees(first.description);
          if (fromDesc.listingPriceUsd != null || fromDesc.feesUsd != null) {
            listingPriceUsd = fromDesc.listingPriceUsd;
            feesUsd = fromDesc.feesUsd;
          }
        }

        if ((listingPriceUsd == null && feesUsd == null) && voteUrl) {
          const beforeCapture = capturedProposalBodies.length;
          await page.goto(voteUrl, { waitUntil: 'networkidle2', timeout: 25000 });
          await page.waitForFunction(
            () => {
              const t = document.body?.innerText || '';
              return t.includes('Listing Price') || t.includes('USD') || t.length > 1000;
            },
            { timeout: 20000 }
          ).catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await new Promise((r) => setTimeout(r, 3000));
          await page.evaluate(() => window.scrollTo(0, 0));
          await new Promise((r) => setTimeout(r, 2000));
          let text = await page.evaluate(() => document.body?.innerText || '');
          let extracted = extractListingPriceAndFees(text);
          if ((extracted.listingPriceUsd == null && extracted.feesUsd == null) && capturedProposalBodies.length > beforeCapture) {
            const last = capturedProposalBodies[capturedProposalBodies.length - 1];
            extracted = extractListingPriceAndFees(last);
          }
          listingPriceUsd = extracted.listingPriceUsd ?? listingPriceUsd;
          feesUsd = extracted.feesUsd ?? feesUsd;
          const pageName = await page.evaluate(() => {
            const t = document.querySelector('h1, h2, [class*="title"]');
            if (t?.innerText) return t.innerText.trim().slice(0, 120);
            const bc = document.querySelector('[class*="readcrumb"]');
            if (bc?.innerText) return bc.innerText.trim().replace(/\s*\/\s*$/g, '').slice(0, 120);
            return null;
          });
          if (pageName) displayName = pageName;
        }
      } catch (e) {
        console.error('    Error:', e.message);
      }

      results.push({
        name: displayName,
        listingPriceUsd,
        feesUsd,
        assetUrl,
        voteUrl: voteUrl || '',
      });
    }

    console.log('\n--- Results ---');
    console.log('Name | Listing Price (USD) | Fees / Est. cost of sales (USD)');
    console.log('-'.repeat(70));
    for (const r of results) {
      console.log(
        `${(r.name || '—').slice(0, 45).padEnd(46)} | ${(r.listingPriceUsd ?? '—').toString().padEnd(20)} | ${r.feesUsd ?? '—'}`
      );
    }

    if (outPath) {
      const header = 'name,listing_price_usd,fees_usd,asset_url,vote_url';
      const rows = results.map(
        (r) =>
          `"${(r.name || '').replace(/"/g, '""')}",${r.listingPriceUsd ?? ''},${r.feesUsd ?? ''},"${(r.assetUrl || '').replace(/"/g, '""')}","${(r.voteUrl || '').replace(/"/g, '""')}"`
      );
      writeFileSync(outPath, [header, ...rows].join('\n'), 'utf8');
      console.log('\nWrote', results.length, 'rows to', outPath);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
