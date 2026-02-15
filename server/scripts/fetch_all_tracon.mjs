import fetch from 'node-fetch';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(join(process.cwd(), 'server', 'data', 'tracon'));
const API_ROOT = 'https://api.github.com/repos/vatsimnetwork/simaware-tracon-project/contents/Boundaries';
const RAW_BASE = 'https://raw.githubusercontent.com/vatsimnetwork/simaware-tracon-project/main/Boundaries';

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const headers = { 'User-Agent': 'vatsim-traffic-replay/1.0' };
if (token) headers.Authorization = `token ${token}`;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function downloadAll() {
  console.log('Listing Boundary regions...');
  const regions = await fetchJson(API_ROOT);
  const dirEntries = regions.filter(r => r.type === 'dir').map(r => r.name);
  console.log(`Found ${dirEntries.length} region folders`);

  let total = 0;
  for (const region of dirEntries) {
    try {
      console.log(`Processing region ${region}`);
      const regionDir = join(OUT_DIR, region);
      if (!existsSync(regionDir)) mkdirSync(regionDir, { recursive: true });
      const apiUrl = `${API_ROOT}/${region}`;
      const files = await fetchJson(apiUrl);
      for (const file of files) {
        if (!file.name || !file.name.toLowerCase().endsWith('.json')) continue;
        const rawUrl = `${RAW_BASE}/${region}/${file.name}`;
        try {
          const txt = await (await fetch(rawUrl, { headers })).text();
          writeFileSync(join(regionDir, file.name), txt, 'utf8');
          total++;
          process.stdout.write('.');
        } catch (e) {
          console.warn(`\nFailed to download ${rawUrl}: ${e.message}`);
        }
        await sleep(150);
      }
      process.stdout.write('\n');
    } catch (e) {
      console.warn(`Region ${region} error:`, e.message);
    }
    await sleep(200);
  }

  console.log(`Downloaded ${total} files into ${OUT_DIR}`);
}

(async () => {
  try {
    await downloadAll();
    process.exit(0);
  } catch (e) {
    console.error('fetch_all_tracon failed:', e.message);
    process.exit(2);
  }
})();
