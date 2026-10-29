// semantic.js — WrenWen-style semantic memory recall via SiliconFlow BAAI/bge-m3
// Reads the latent corpus, builds embeddings, injects a recall block per turn.
// Disabled silently if SILICONFLOW_API_KEY is not set.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import path from 'path';

const SF_URL   = 'https://api.siliconflow.cn/v1/embeddings';
const SF_MODEL = 'BAAI/bge-m3';
const CORPUS_DIR  = '/home/ubuntu/latent-data/memory';
const CACHE_PATH  = '/home/ubuntu/latent-data/.embed_cache.json';

const THRESHOLD   = 60;   // cosine×100; tune after seeing real data
const TOP_K       = 4;    // WrenWen main recall ≤4
const ANTI_ECHO_MS = 90 * 60 * 1000; // 90 min

let cache = {};  // filename → { content, embedding, mtime }
const lastShown = new Map(); // filename → epoch ms when last surfaced

// ---------- helpers ----------

function loadCache() {
  try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
}
function saveCache() {
  try { writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8'); } catch {}
}

async function embed(text) {
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key) throw new Error('SILICONFLOW_API_KEY not set');
  const res = await fetch(SF_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SF_MODEL, input: text.slice(0, 2000), encoding_format: 'float' }),
  });
  if (!res.ok) throw new Error(`SiliconFlow ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.data[0].embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- public API ----------

/**
 * Scan the latent corpus for new/changed files and update the embedding cache.
 * Call once on server start and after each latent archival.
 */
export async function updateIndex() {
  if (!process.env.SILICONFLOW_API_KEY) return;
  if (!existsSync(CORPUS_DIR)) return;
  loadCache();
  const files = readdirSync(CORPUS_DIR).filter(f => f.endsWith('.txt'));
  let changed = false;
  for (const f of files) {
    const fp = path.join(CORPUS_DIR, f);
    const mtime = statSync(fp).mtimeMs;
    if (cache[f]?.mtime === mtime) continue;      // unchanged
    const content = readFileSync(fp, 'utf8').trim();
    if (content.length < 10) continue;
    try {
      cache[f] = { content, embedding: await embed(content), mtime };
      changed = true;
      console.log('[semantic] indexed', f);
    } catch (e) {
      console.warn('[semantic] embed failed', f, e.message);
    }
  }
  if (changed) saveCache();
}

/**
 * Semantic recall for one user message.
 * Returns array of { content, score } above threshold (max TOP_K),
 * or null if the feature is disabled / query too short / API failed.
 */
export async function recall(query) {
  if (!process.env.SILICONFLOW_API_KEY) return null;
  if (!query || query.trim().length < 5) return null;
  loadCache();
  if (!Object.keys(cache).length) return null;

  let qv;
  try { qv = await embed(query); } catch (e) {
    console.warn('[semantic] query embed failed:', e.message);
    return null;
  }

  const now = Date.now();
  const hits = [];
  for (const [f, entry] of Object.entries(cache)) {
    if (!entry.embedding) continue;
    const base = cosine(qv, entry.embedding) * 100;
    const antiEcho = (lastShown.has(f) && now - lastShown.get(f) < ANTI_ECHO_MS) ? -12 : 0;
    const score = base + antiEcho;
    if (score >= THRESHOLD) hits.push({ f, content: entry.content, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, TOP_K);
  top.forEach(h => lastShown.set(h.f, now));
  return top;  // empty array = API worked, nothing above threshold
}
