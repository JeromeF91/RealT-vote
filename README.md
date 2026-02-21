# RealT-vote

Scrape [vote.realtoken.network/assets](https://vote.realtoken.network/assets) for each asset: **name**, **Listing Price (USD)**, and **fees** (Estimated total cost of sales). The list page shows asset cards (e.g. "19980 Alcoy", "20553 Pelkey"); for each asset the script visits the vote page and extracts the two amounts from the proposal text.

## Quick start

```bash
npm install
```

### Scrape the assets list (name, listing price, fees)

**Recommended:** Get the asset list from the same API as the vote site, then scrape each asset’s vote page:

```bash
npm run scrape -- --from-api --out assets.csv
```

This calls `https://api.realtoken.network/graphql` (no browser needed for the list) to get all asset IDs, then uses a browser to visit each asset and its vote page for name, listing price, and fees.

Other options:

```bash
# Use a local list (e.g. asset-ids.txt)
npm run scrape -- --urls asset-ids.txt --out assets.csv

# Try scraping the list from the /assets page (needs wallet on Gnosis in headful)
npm run scrape -- --out assets.csv
```

**Refresh the asset ID list** (writes `asset-ids.txt`):

```bash
node scripts/fetch-asset-ids-from-api.js --out asset-ids.txt
```

**Getting listing price and fees (they’re on the vote page):**  
In headless mode the vote page often doesn’t load the proposal body, so those columns stay empty. To fill them, run with a **visible browser** and **connect your wallet to Gnosis** so the vote page can load the proposal text; then run:

```bash
npm run scrape:headful -- --from-api --out assets.csv
```

The script will open each vote URL, wait for the page content, and extract “Listing Price” and “Estimated total cost of sales” from the visible text.

Output columns: `name`, `listing_price_usd`, `fees_usd`, `asset_url`, `vote_url`.

---

### Option 1: Parse from pasted proposal text

Put the proposal text (the paragraph with "Listing Price" and "Estimated total cost of sales") into a file, then:

```bash
npm run scrape:votes -- --file proposal.txt
```

Example output:

```
Listing Price (USD): 104900
Estimated total cost of sales (USD): 26739
```

See `sample-proposal.txt` for the expected text format.

### Option 2: Scrape vote page(s) with browser

```bash
# One or more vote URLs
npm run scrape:votes -- https://vote.realtoken.network/assets/100818/vote/19

# With browser visible (connect wallet to Gnosis so proposal content loads)
npm run scrape:votes:headful -- https://vote.realtoken.network/assets/100818/vote/19
```

Without a connected wallet on Gnosis, the vote page often shows only the shell; the script will still run and report `—` if the proposal body didn’t load. Use `--file` with pasted text when the browser doesn’t load the content.

### Multiple vote pages

```bash
npm run scrape:votes -- \
  'https://vote.realtoken.network/assets/100818/vote/19' \
  'https://vote.realtoken.network/assets/XXXXXX/vote/YY'
```

Output is a table: asset/vote label, Listing Price (USD), Estimated total cost of sales (USD).
