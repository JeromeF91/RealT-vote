#!/usr/bin/env node
/**
 * Tries to get the list of asset IDs (tokenIds) from:
 * 1) Capturing GraphQL/fetch response when loading vote.realtoken.network/assets
 * 2) Writing them to asset-ids.txt
 *
 * Run: node scripts/fetch-asset-ids.js [--out asset-ids.txt]
 */

import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const ASSETS_URL = 'https://vote.realtoken.network/assets';
const HEADFUL = process.env.HEADFUL === '1';

async function main() {
  const outPath = process.argv.includes('--out')
    ? resolve(process.argv[process.argv.indexOf('--out') + 1] || 'asset-ids.txt')
    : null;

  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const captured = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    page.on('response', async (res) => {
      const url = res.url();
      if (res.request().resourceType() !== 'fetch') return;
      try {
        const text = await res.text();
        if (!text || text.length > 5_000_000) return;
        if (text.includes('"tokenId"') && (text.includes('"tokens"') || text.includes('tokens'))) {
          captured.push({ url, body: text });
        }
      } catch (_) {}
    });

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

    console.log('Loading', ASSETS_URL);
    await page.goto(ASSETS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 8000));

    const ids = new Set();
    for (const { body } of captured) {
      try {
        const data = JSON.parse(body);
        const d = data?.data;
        if (!d) continue;
        const tokens = d.realTokenGov?.tokens ?? d.tokens ?? d.Tokens ?? [];
        if (Array.isArray(tokens)) {
          for (const t of tokens) {
            const id = t.tokenId ?? t.id ?? t.token_id;
            if (id != null) ids.add(String(id).trim());
          }
        }
        const active = d.realTokenGov?.active ?? d.active;
        const noActive = d.realTokenGov?.no_active ?? d.no_active;
        if (Array.isArray(active)) active.forEach((t) => { const id = t.tokenId ?? t.id; if (id != null) ids.add(String(id)); });
        if (Array.isArray(noActive)) noActive.forEach((t) => { const id = t.tokenId ?? t.id; if (id != null) ids.add(String(id)); });
      } catch (_) {}
    }

    if (ids.size === 0) {
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/assets/"]'))
          .map((a) => (a.getAttribute('href') || '').match(/\/assets\/(\d+)/)?.[1])
          .filter(Boolean)
      );
      links.forEach((id) => ids.add(id));
    }

    const sorted = [...ids].filter(Boolean).sort((a, b) => Number(a) - Number(b));
    console.log('Asset IDs found:', sorted.length);
    if (sorted.length > 0) {
      sorted.forEach((id) => console.log(' ', id));
      if (outPath) {
        const content = '# RealToken asset IDs (from vote.realtoken.network/assets)\n' + sorted.join('\n') + '\n';
        writeFileSync(outPath, content, 'utf8');
        console.log('Wrote', outPath);
      }
    } else {
      console.log('None. Page may need wallet connected on Gnosis, or GraphQL was not captured.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
