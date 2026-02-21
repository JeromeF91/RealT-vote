# RealT-vote

Scrape [vote.realtoken.network](https://vote.realtoken.network) asset vote pages for **Listing Price** and **Estimated total cost of sales** (e.g. [assets/100818/vote/19](https://vote.realtoken.network/assets/100818/vote/19)).

## Quick start

```bash
npm install
```

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
