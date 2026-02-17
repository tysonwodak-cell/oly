const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const GAMES_CODE = process.env.GAMES_CODE || 'OWG2026';
const API_URL =
  process.env.API_URL ||
  `https://site.api.espn.com/apis/v2/sports/olympics/winter/2026/medals`;
const PAGE_URL =
  process.env.SOURCE_URL ||
  'https://www.espn.com/olympics/winter/2026/medals';
const WIKI_URL =
  process.env.WIKI_URL ||
  'https://en.wikipedia.org/wiki/2026_Winter_Olympics_medal_table';
const PAMEDIA_KEY = process.env.PAMEDIA_API_KEY;

function withScore(entry) {
  const g = Number(entry.gold);
  const s = Number(entry.silver);
  const b = Number(entry.bronze);
  return {
    ...entry,
    gold: g,
    silver: s,
    bronze: b,
    total: entry.total ? Number(entry.total) : g + s + b,
    score: g * 3 + s * 1.5 + b * 1,
  };
}

function sortTeams(list) {
  return list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.gold !== a.gold) return b.gold - a.gold;
    if (b.silver !== a.silver) return b.silver - a.silver;
    if (b.bronze !== a.bronze) return b.bronze - a.bronze;
    return (b.total ?? 0) - (a.total ?? 0);
  });
}

// Parse HTML fallback. For ESPN, the page embeds JSON that includes "medalStandings".
function parseFromHtml(html) {
  // Try to extract the medalStandings JSON block.
  const jsonMatch = /"medalStandings":(\[.*?\]),"medalLeaders"/s.exec(html);
  if (jsonMatch) {
    try {
      const standings = JSON.parse(jsonMatch[1]);
      const rows = standings?.[0]?.rows || [];
      const teams = rows.map((row) => {
        const [countryCell, gold, silver, bronze, total] = row.cells || [];
        const name =
          typeof countryCell === 'object' ? countryCell.text : countryCell;
        return withScore({
          code: name ? name.slice(0, 3).toUpperCase() : '',
          name: name || '',
          gold,
          silver,
          bronze,
          total,
        });
      });
      if (teams.length) return sortTeams(teams);
    } catch (err) {
      console.warn('Failed to parse embedded medalStandings JSON', err);
    }
  }

  // Fallback patterns (generic table scraping).
  const teams = [];
  const rx =
    /Image:\s*[A-Za-z ]+\s*([A-Z]{3})\s+([A-Za-zÀ-ÖØ-öø-ÿ .()'’-]+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/g;
  for (const m of html.matchAll(rx)) {
    teams.push(
      withScore({
        code: m[1],
        name: m[2].trim(),
        gold: m[3],
        silver: m[4],
        bronze: m[5],
        total: m[6],
      })
    );
  }

  if (teams.length === 0) {
    const rowRx =
      /<tr[^>]*>\s*<td[^>]*data-text="([A-Z]{3})"[^>]*>.*?<\/td>.*?<td[^>]*>\s*([A-Za-zÀ-ÖØ-öø-ÿ .()'’-]+?)\s*<\/td>.*?<td[^>]*>\s*(\d+)\s*<\/td>.*?<td[^>]*>\s*(\d+)\s*<\/td>.*?<td[^>]*>\s*(\d+)\s*<\/td>/gsi;
    for (const m of html.matchAll(rowRx)) {
      teams.push(
        withScore({
          code: m[1],
          name: m[2].trim(),
          gold: m[3],
          silver: m[4],
          bronze: m[5],
        })
      );
    }
  }

  return sortTeams(teams);
}

// Parse Wikipedia medal table (first wikitable).
function parseWikipedia(html) {
  const tableMatch = /<table class="wikitable sortable plainrowheaders[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(
    html
  );
  if (!tableMatch) return [];
  const tbody = tableMatch[1];
  const rowRx =
    /<tr[^>]*>\s*(?:<th[^>]*>.*?<\/th>\s*)?<th scope="row"[^>]*>(.*?)<\/th>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>/gims;
  const teams = [];
  for (const m of tbody.matchAll(rowRx)) {
    const nameText = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    teams.push(
      withScore({
        code: nameText.slice(0, 3).toUpperCase(),
        name: nameText,
        gold: m[2],
        silver: m[3],
        bronze: m[4],
        total: m[5],
      })
    );
  }
  return sortTeams(teams);
}

async function fetchApiJson() {
  const res = await httpGetJson(API_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (MedalTable/1.0; +https://example.com/medal-table)',
      accept: 'application/json, text/plain, */*',
      ...(PAMEDIA_KEY ? { apikey: PAMEDIA_KEY } : {}),
    },
  });
  const data = res;

  // ESPN API shape: { medalStandings: [{ rows: [ { cells: [ {text:"Norway"}, "12","7","7","26" ] } ] }] }
  const rows = data?.medalStandings?.[0]?.rows || [];
  const teams = rows.map((row) => {
    const [countryCell, gold, silver, bronze, total] = row.cells || [];
    const name = typeof countryCell === 'object' ? countryCell.text : countryCell;
    return withScore({
      code: name ? name.slice(0, 3).toUpperCase() : '',
      name: name || '',
      gold,
      silver,
      bronze,
      total,
    });
  });

  if (teams.length === 0) throw new Error('API returned no medal entries');
  return sortTeams(teams);
}

async function httpGetJson(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    // Fallback to curl if available.
    try {
      const { stdout } = await execFileAsync('curl', [
        '-sL',
        '-H',
        `User-Agent: ${opts.headers?.['User-Agent'] || 'Mozilla/5.0'}`,
        url,
      ]);
      return JSON.parse(stdout);
    } catch (curlErr) {
      throw err;
    }
  }
}

async function httpGetText(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    try {
      const args = ['-sL', url];
      if (opts.headers?.['User-Agent']) {
        args.unshift('-H', `User-Agent: ${opts.headers['User-Agent']}`);
      }
      const { stdout } = await execFileAsync('curl', args);
      return stdout;
    } catch (curlErr) {
      throw err;
    }
  }
}

async function fetchMedals() {
  // Prefer JSON API; fall back to HTML scrape.
  try {
    return await fetchApiJson();
  } catch (apiErr) {
    console.warn('API fetch failed, falling back to HTML scrape:', apiErr.message);
  }

  const html = await httpGetText(PAGE_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (MedalTable/1.0; +https://example.com/medal-table)',
    },
  });
  let teams = parseFromHtml(html);
  if (teams.length === 0) {
    console.warn('ESPN parse failed; trying Wikipedia fallback');
    const wikiHtml = await httpGetText(WIKI_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (MedalTable/1.0; +https://example.com/medal-table)',
      },
    });
    teams = parseWikipedia(wikiHtml);
  }
  if (teams.length === 0) {
    throw new Error('Could not parse medal table from source HTML');
  }
  return teams;
}

app.use(express.static('public', { maxAge: 0, etag: false }));

app.get('/api/medals', async (_req, res) => {
  try {
    const teams = await fetchMedals();
    res.set('Cache-Control', 'no-store');
    res.json({
      updatedAt: new Date().toISOString(),
      source: PAGE_URL,
      scoring: { gold: 3, silver: 1.5, bronze: 1 },
      teams,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to load medal data' });
  }
});

app.listen(PORT, () => {
  console.log(`Medal table server listening on http://localhost:${PORT}`);
});
