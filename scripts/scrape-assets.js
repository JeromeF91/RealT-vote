#!/usr/bin/env node
/**
 * Scrapes https://vote.realtoken.network/assets for each asset:
 * - Listing Price (e.g. "List the Property at an initial gross asking price of USD 104900 (the \"Listing Price\")")
 * - Estimated total cost of sales (e.g. "USD 26739")
 *
 * Run: npm install && npm run scrape
 * Optional: npm run scrape:headful to see the browser.
 */

import puppeteer from 'puppeteer';

const ASSETS_URL = 'https://vote.realtoken.network/assets';
const HEADFUL = process.env.HEADFUL === '1';

// Regex to find Listing Price: "USD 104900" near "Listing Price"
const LISTING_PRICE_REGEX = /(?:initial\s+gross\s+asking\s+price\s+of\s+)?USD\s*([\d,\s]+)\s*\([^)]*[Ll]isting\s+[Pp]rice/g;
// Also catch "Listing Price" then "USD"
const LISTING_PRICE_ALT = /[Ll]isting\s+[Pp]rice[^.]*?USD\s*([\d,\s]+)/g;

// Regex for Estimated total cost of sales at listed price
const ESTIMATED_COST_REGEX = /[Ee]stimated\s+total\s+cost\s+of\s+sales[^.]*?USD\s*([\d,\s]+)/g;
const ESTIMATED_COST_ALT = /(?:total\s+cost\s+of\s+sales|cost\s+of\s+sales)[^.]*?USD\s*([\d,\s]+)/g;

function strip(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function parseUsdAmount(str) {
  if (!str) return null;
  const n = str.replace(/[\s,]/g, '');
  const num = parseInt(n, 10);
  return Number.isNaN(num) ? null : num;
}

async function main() {
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

    const apiCalls = [];
    const graphqlResponses = [];
    page.on('request', (req) => {
      const u = req.url();
      if (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
        apiCalls.push(u);
      }
    });
    page.on('response', async (res) => {
      const u = res.url();
      if (
        (u.includes('graph') || u.includes('subgraph') || u.includes('gateway')) &&
        res.request().resourceType() === 'fetch'
      ) {
        try {
          const body = await res.text();
          if (body && (body.includes('tokens') || body.includes('proposals')))
            graphqlResponses.push({ url: u, body });
        } catch (_) {}
      }
    });

    // Inject Gnosis chain so the app may load assets (vote site uses chainId for subgraph)
    await page.evaluateOnNewDocument(() => {
      window.ethereum = window.ethereum || {};
      const chainIdHex = '0x64'; // 100 = Gnosis
      if (!window.ethereum.request) {
        window.ethereum.request = ({ method }) => {
          if (method === 'eth_chainId') return Promise.resolve(chainIdHex);
          if (method === 'eth_accounts') return Promise.resolve([]);
          return Promise.resolve(null);
        };
      }
    });

    console.log('Navigating to', ASSETS_URL);
    await page.goto(ASSETS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for content: either links/cards that look like assets or text containing "Listing Price" / "USD"
    await page.waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return (
          body.includes('Listing Price') ||
          body.includes('USD') ||
          document.querySelector('[href*="asset"]') != null ||
          document.querySelector('table, [role="grid"], [class*="card"], [class*="asset"]') != null
        );
      },
      { timeout: 15000 }
    ).catch(() => {});

    // Extra time and scroll to trigger lazy content
    await new Promise((r) => setTimeout(r, 2000));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 3000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      const getText = (el) => (el ? el.innerText || el.textContent || '' : '');
      const root = document.body;

      // Try to find discrete asset blocks: links to /assets/..., cards, or rows
      const assetLinks = Array.from(root.querySelectorAll('a[href*="/assets/"], a[href*="asset"]'));
      const possibleCards = Array.from(
        root.querySelectorAll(
          'article, [class*="card"], [class*="Asset"], [data-testid*="asset"], tr[class*="row"]'
        )
      );
      const allLinks = Array.from(root.querySelectorAll('a[href]')).map((a) => ({
        href: a.getAttribute('href'),
        text: getText(a).slice(0, 80),
      }));

      const fullText = getText(root);

      return {
        fullText: fullText.slice(0, 100000),
        assetLinkHrefs: assetLinks.map((a) => a.getAttribute('href')).filter(Boolean),
        cardTexts: possibleCards.slice(0, 100).map((c) => getText(c)),
        allLinks: allLinks.slice(0, 80),
        htmlSnippet: root.innerHTML.slice(0, 15000),
      };
    });

    const { fullText, assetLinkHrefs, cardTexts, allLinks, htmlSnippet } = result;

    console.log('All links on page (sample):');
    allLinks.forEach(({ href, text }) => {
      if (href && !href.startsWith('#')) console.log(' ', href, '|', text.slice(0, 50));
    });

    // Parse Listing Price and Estimated cost from full page text
    const listingPrices = [];
    let m;
    const re1 = /(?:initial\s+gross\s+asking\s+price\s+of\s+)?USD\s*([\d,\s]+)\s*\([^)]*[Ll]isting\s+[Pp]rice/g;
    while ((m = re1.exec(fullText)) !== null) listingPrices.push(parseUsdAmount(m[1]));
    const re2 = /[Ll]isting\s+[Pp]rice[^.]*?USD\s*([\d,\s]+)/g;
    while ((m = re2.exec(fullText)) !== null) listingPrices.push(parseUsdAmount(m[1]));

    const estimatedCosts = [];
    const re3 = /[Ee]stimated\s+total\s+cost\s+of\s+sales[^.]*?USD\s*([\d,\s]+)/g;
    while ((m = re3.exec(fullText)) !== null) estimatedCosts.push(parseUsdAmount(m[1]));
    const re4 = /(?:total\s+cost\s+of\s+sales|cost\s+of\s+sales)[^.]*?USD\s*([\d,\s]+)/g;
    while ((m = re4.exec(fullText)) !== null) estimatedCosts.push(parseUsdAmount(m[1]));

    // Try to associate with asset names by looking at card text or link labels
    const assets = [];
    const seenListing = new Set();
    const seenCost = new Set();

    for (const cardText of cardTexts) {
      const listingMatch = cardText.match(/(?:asking\s+price\s+of\s+)?USD\s*([\d,\s]+)\s*\([^)]*[Ll]isting\s+[Pp]rice/);
      const costMatch = cardText.match(/[Ee]stimated\s+total\s+cost[^.]*?USD\s*([\d,\s]+)/);
      const nameMatch = cardText.match(/^[\s\S]{0,200}/); // first chunk as possible name
      const name = nameMatch ? strip(nameMatch[0]).slice(0, 120) : null;
      const listing = listingMatch ? parseUsdAmount(listingMatch[1]) : null;
      const cost = costMatch ? parseUsdAmount(costMatch[1]) : null;
      if (listing != null || cost != null) {
        assets.push({
          name: name || 'Unknown',
          listingPriceUsd: listing,
          estimatedCostOfSalesUsd: cost,
        });
        if (listing != null) seenListing.add(listing);
        if (cost != null) seenCost.add(cost);
      }
    }

    // If we didn't get per-asset from cards, build one row per unique (listing, cost) from full text
    if (assets.length === 0 && (listingPrices.length > 0 || estimatedCosts.length > 0)) {
      const uniqueListing = [...new Set(listingPrices.filter(Boolean))];
      const uniqueCost = [...new Set(estimatedCosts.filter(Boolean))];
      const n = Math.max(uniqueListing.length, uniqueCost.length, 1);
      for (let i = 0; i < n; i++) {
        assets.push({
          name: `Asset ${i + 1}`,
          listingPriceUsd: uniqueListing[i] ?? null,
          estimatedCostOfSalesUsd: uniqueCost[i] ?? null,
        });
      }
    }

    // If still nothing, dump raw numbers we found
    if (assets.length === 0) {
      console.log('No structured asset blocks found. Raw numbers from page:');
      console.log('Listing Price (USD) found:', [...new Set(listingPrices.filter(Boolean))]);
      console.log('Estimated cost of sales (USD) found:', [...new Set(estimatedCosts.filter(Boolean))]);
      if (fullText.length < 5000) console.log('\nPage text snippet:\n', fullText.slice(0, 3000));
    } else {
      console.log('\nAssets (Listing Price & Estimated total cost of sales):\n');
      console.log(
        'Asset name / identifier | Listing Price (USD) | Estimated total cost of sales (USD)'
      );
      console.log('-'.repeat(75));
      for (const a of assets) {
        console.log(
          `${(a.name || '—').slice(0, 45).padEnd(46)} | ${(a.listingPriceUsd ?? '—').toString().padEnd(20)} | ${a.estimatedCostOfSalesUsd ?? '—'}`
        );
      }
    }

    if (assetLinkHrefs.length > 0) {
      console.log('\nAsset links found:', assetLinkHrefs.length);
      assetLinkHrefs.slice(0, 20).forEach((h) => console.log(' ', h));
    }

    if (apiCalls.length > 0) {
      console.log('\nAPI/fetch URLs seen:');
      [...new Set(apiCalls)].filter((u) => !u.includes('google') && !u.includes('gtm')).forEach((u) => console.log(' ', u));
    }

    // Parse captured GraphQL responses for token list
    for (const { body } of graphqlResponses) {
      try {
        const data = JSON.parse(body);
        const tokens = data?.data?.realTokenGov?.tokens || data?.data?.tokens;
        if (tokens && Array.isArray(tokens) && tokens.length > 0) {
          console.log('\nTokens from GraphQL:', tokens.length);
          tokens.slice(0, 5).forEach((t) => console.log(' ', t.tokenId || t.id, t.totalProposals));
        }
      } catch (_) {}
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
