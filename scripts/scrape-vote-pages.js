#!/usr/bin/env node
/**
 * Scrapes vote pages like https://vote.realtoken.network/assets/100818/vote/19
 * and extracts for each:
 *   - Listing Price (USD) — "List the Property at an initial gross asking price of USD XXXXX (the \"Listing Price\")"
 *   - Estimated total cost of sales (USD) — "Estimated total cost of sales... USD XXXXX"
 *
 * Usage:
 *   node scripts/scrape-vote-pages.js [url1] [url2] ...
 *   node scripts/scrape-vote-pages.js   # uses default example URL
 *   node scripts/scrape-vote-pages.js --file proposal.txt   # parse from pasted proposal text
 *   HEADFUL=1 node scripts/scrape-vote-pages.js <url>   # show browser (connect wallet to Gnosis to load content)
 */

import puppeteer from 'puppeteer';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_URLS = ['https://vote.realtoken.network/assets/100818/vote/19'];
const HEADFUL = process.env.HEADFUL === '1';

function parseUsdAmount(str) {
  if (!str) return null;
  const n = str.replace(/[\s,]/g, '');
  const num = parseInt(n, 10);
  return Number.isNaN(num) ? null : num;
}

function extractFromText(fullText) {
  let listingPriceUsd = null;
  let estimatedCostUsd = null;

  // Listing Price: "USD 104900" in context of "(the \"Listing Price\")" or "Listing Price"
  const listingMatch = fullText.match(
    /(?:initial\s+gross\s+asking\s+price\s+of\s+)?USD\s*([\d,\s]+)\s*\([^)]*[Ll]isting\s+[Pp]rice/
  );
  if (!listingMatch) {
    const alt = fullText.match(/[Ll]isting\s+[Pp]rice[^.]*?USD\s*([\d,\s]+)/);
    if (alt) listingPriceUsd = parseUsdAmount(alt[1]);
  } else {
    listingPriceUsd = parseUsdAmount(listingMatch[1]);
  }

  // Estimated total cost of sales (allow "etc." and "at listed price" before USD amount)
  const costMatch = fullText.match(
    /[Ee]stimated\s+total\s+cost\s+of\s+sales[\s\S]*?USD\s*([\d,\s]+)/
  );
  if (costMatch) estimatedCostUsd = parseUsdAmount(costMatch[1]);
  else {
    const alt = fullText.match(/(?:total\s+cost\s+of\s+sales|cost\s+of\s+sales)[\s\S]*?USD\s*([\d,\s]+)/);
    if (alt) estimatedCostUsd = parseUsdAmount(alt[1]);
  }

  return { listingPriceUsd, estimatedCostUsd };
}

async function scrapeVoteUrl(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for proposal content (Listing Price or Estimated cost or any USD amount in body)
  await page.waitForFunction(
    () => {
      const body = document.body?.innerText || '';
      return (
        body.includes('Listing Price') ||
        body.includes('Estimated total cost') ||
        (body.includes('USD') && /\d{4,}/.test(body))
      );
    },
    { timeout: 15000 }
  ).catch(() => {});

  // Scroll down to ensure any lazy content is in DOM
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));

  let fullText = await page.evaluate(() => document.body?.innerText || '');
  let listingPriceUsd = null;
  let estimatedCostUsd = null;
  let extracted = extractFromText(fullText);
  listingPriceUsd = extracted.listingPriceUsd;
  estimatedCostUsd = extracted.estimatedCostUsd;

  // If not found, wait longer for GraphQL/content then retry
  if (listingPriceUsd == null && estimatedCostUsd == null) {
    await new Promise((r) => setTimeout(r, 5000));
    fullText = await page.evaluate(() => document.body?.innerText || '');
    extracted = extractFromText(fullText);
    listingPriceUsd = extracted.listingPriceUsd;
    estimatedCostUsd = extracted.estimatedCostUsd;
    if (listingPriceUsd == null && estimatedCostUsd == null && fullText.length > 0) {
      console.error('Page text snippet (first 2000 chars):', fullText.slice(0, 2000));
    }
  }

  const label = await page.evaluate(() => {
    const title = document.querySelector('h1, h2, [class*="title"]');
    if (title?.innerText) return title.innerText.slice(0, 80);
    const bread = document.querySelector('[class*="readcrumb"]');
    if (bread?.innerText) return bread.innerText.slice(0, 80);
    return null;
  });

  return {
    url,
    label: label || url.replace(/^.*\/assets\/(\d+)\/vote\/(\d+)$/, 'Asset $1 / Vote $2'),
    listingPriceUsd,
    estimatedCostUsd,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    const filePath = resolve(argv[fileIdx + 1]);
    if (!existsSync(filePath)) {
      console.error('File not found:', filePath);
      process.exit(1);
    }
    const text = readFileSync(filePath, 'utf8');
    const { listingPriceUsd, estimatedCostUsd } = extractFromText(text);
    console.log('Listing Price (USD):', listingPriceUsd ?? '—');
    console.log('Estimated total cost of sales (USD):', estimatedCostUsd ?? '—');
    return;
  }

  const urls = argv.filter((a) => a.startsWith('http'));
  const toScrape = urls.length ? urls : DEFAULT_URLS;

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

    // So the app can load (vote site may check chain)
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

    // Capture any API response that might contain proposal description (for parsing if page doesn't render it)
    const capturedBodies = [];
    page.on('response', async (res) => {
      try {
        const u = res.url();
        if (res.request().resourceType() !== 'fetch' && res.request().resourceType() !== 'xhr') return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text')) return;
        const body = await res.text();
        if (body && (body.includes('Listing Price') || body.includes('Estimated total cost'))) {
          capturedBodies.push(body);
        }
      } catch (_) {}
    });

    const results = [];
    for (const url of toScrape) {
      console.error('Scraping:', url);
      try {
        const before = capturedBodies.length;
        const row = await scrapeVoteUrl(page, url);
        // If page didn't have text but we captured an API body with the numbers, use it
        if ((row.listingPriceUsd == null || row.estimatedCostUsd == null) && capturedBodies.length > before) {
          const last = capturedBodies[capturedBodies.length - 1];
          const fromApi = extractFromText(last);
          if (fromApi.listingPriceUsd != null) row.listingPriceUsd = fromApi.listingPriceUsd;
          if (fromApi.estimatedCostUsd != null) row.estimatedCostUsd = fromApi.estimatedCostUsd;
        }
        results.push(row);
      } catch (e) {
        console.error('Error:', e.message);
        results.push({ url, label: url, listingPriceUsd: null, estimatedCostUsd: null, error: e.message });
      }
    }

    // Output table
    console.log('\nAsset / Vote | Listing Price (USD) | Estimated total cost of sales (USD)');
    console.log('-'.repeat(75));
    for (const r of results) {
      console.log(
        `${(r.label || r.url).slice(0, 45).padEnd(46)} | ${(r.listingPriceUsd ?? '—').toString().padEnd(20)} | ${r.estimatedCostUsd ?? '—'}`
      );
    }

    // JSON for piping
    if (process.stdout.isTTY === false) {
      process.stderr.write(JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
