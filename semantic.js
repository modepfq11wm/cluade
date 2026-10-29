// semantic.js — WrenWen-style semantic memory recall via SiliconFlow BAAI/bge-m3
// Reads the latent corpus, builds embeddings, injects a recall block per turn.
// Disabled silently if SILICONFLOW_API_KEY is not set.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, watch } from 'fs';
import path from 'path';

const SF_URL   = 'https://api.siliconflow.cn/v1/embeddings';
const SF_MODEL = 'BAAI/bge-m3';
const CORPUS_DIR  = '/home/ubuntu/latent-data/memory';
const CACHE_PATH  = '/home/ubuntu/latent-data/.embed_cache.json';

// From the [semantic] score logs (10-29): everyday chat tops out around 45-51. Keep clear of that band.
const THRESHOLD   = 60;   // cosine×100
const TOP_K       = 4;    // WrenWen main recall ≤4
const ASSOC_THRESHOLD = 55;  // lower threshold for 联想专座; only shown alongside a main hit
const ASSOC_K     = 2;    // max 2 associative slots
const ANTI_ECHO_MS = 90 * 60 * 1000; // 90 min
const RECALL_TIMEOUT_MS = 3000;
const INDEX_TIMEOUT_MS  = 30000;
const MAX_INJECT_CHARS  = 800;

let cache = null;  // filename → { content, embedding, mtime }; loaded once, kept in memory
const lastShown = new Map(); // filename → epoch ms when last surfaced
let indexChain = Promise.resolve();

// ---------- helpers ----------

function ensureCache() {
  if (cache) return;
  try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
}
function saveCache() {
  try { writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8'); } catch {}
}

async function embed(text, timeoutMs) {
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key) throw new Error('SILICONFLOW_API_KEY not set');
  const res = await fetch(SF_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SF_MODEL, input: text.slice(0, 2000), encoding_format: 'float' }),
    signal: AbortSignal.timeout(timeoutMs),
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

function clip(s) {
  return s.length > MAX_INJECT_CHARS ? s.slice(0, MAX_INJECT_CHARS) + '……' : s;
}

async function doUpdateIndex() {
  if (!process.env.SILICONFLOW_API_KEY) return;
  if (!existsSync(CORPUS_DIR)) return;
  ensureCache();
  const files = new Set(readdirSync(CORPUS_DIR).filter(f => f.endsWith('.txt')));
  let changed = false;
  for (const f of Object.keys(cache)) {
    if (!files.has(f)) { delete cache[f]; changed = true; }
  }
  for (const f of files) {
    const fp = path.join(CORPUS_DIR, f);
    let mtime, content;
    try {
      mtime = statSync(fp).mtimeMs;
      if (cache[f]?.mtime === mtime) continue;
      content = readFileSync(fp, 'utf8').trim();
    } catch { continue; }  // file vanished between readdir and read
    if (content.length < 10) continue;
    try {
      cache[f] = { content, embedding: await embed(content, INDEX_TIMEOUT_MS), mtime };
      changed = true;
      console.log('[semantic] indexed', f);
    } catch (e) {
      console.warn('[semantic] embed failed', f, e.message);
    }
  }
  if (changed) saveCache();
}

// ---------- public API ----------

/**
 * Scan the latent corpus for new/changed/deleted files and update the embedding cache.
 * Calls are serialized so the watcher, startup and post-save runs never embed the same file twice.
 */
export function updateIndex() {
  indexChain = indexChain.catch(() => {}).then(doUpdateIndex);
  return indexChain;
}

/**
 * Watch the corpus directory for new/changed files (grow/hold memories written mid-conversation).
 * Triggers updateIndex() with a 3s debounce so rapid writes don't spam the API.
 */
export function watchCorpus() {
  if (!process.env.SILICONFLOW_API_KEY) return;
  if (!existsSync(CORPUS_DIR)) return;
  let timer = null;
  watch(CORPUS_DIR, (_, filename) => {
    if (!filename?.endsWith('.txt')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      updateIndex().catch(e => console.warn('[semantic] watch update failed:', e.message));
    }, 3000);
  });
  console.log('[semantic] watching', CORPUS_DIR);
}

/**
 * Semantic recall for one user message.
 * Returns { main, assoc } (arrays of { f, content, score }), both empty when nothing passes,
 * or null if the feature is disabled / query too short / API failed or timed out.
 */
export async function recall(query) {
  if (!process.env.SILICONFLOW_API_KEY) return null;
  if (!query || query.trim().length < 5) return null;
  ensureCache();
  if (!Object.keys(cache).length) return null;

  let qv;
  try { qv = await embed(query, RECALL_TIMEOUT_MS); } catch (e) {
    console.warn('[semantic] query embed failed:', e.message);
    return null;
  }

  const now = Date.now();
  const scored = [];
  for (const [f, entry] of Object.entries(cache)) {
    if (!entry.embedding) continue;
    const base = cosine(qv, entry.embedding) * 100;
    const antiEcho = (lastShown.has(f) && now - lastShown.get(f) < ANTI_ECHO_MS) ? -12 : 0;
    scored.push({ f, entry, score: base + antiEcho });
  }
  scored.sort((a, b) => b.score - a.score);
  const allHits = scored.filter(h => h.score >= ASSOC_THRESHOLD)
    .map(h => ({ f: h.f, content: clip(h.entry.content), score: h.score }));
  const main = allHits.filter(h => h.score >= THRESHOLD).slice(0, TOP_K);
  const mainFiles = new Set(main.map(h => h.f));
  const assoc = main.length ? allHits.filter(h => !mainFiles.has(h.f)).slice(0, ASSOC_K) : [];
  console.log(`[semantic] top ${scored.slice(0, 5).map(h => h.score.toFixed(1)).join(' ')} | main ${main.length} assoc ${assoc.length}`);
  [...main, ...assoc].forEach(h => lastShown.set(h.f, now));
  return { main, assoc };
}
