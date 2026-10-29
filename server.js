import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { recall, updateIndex, watchCorpus } from './semantic.js';
import { homedir } from 'os';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

let webpush = null;
try {
  webpush = (await import('web-push')).default;
} catch { console.warn('[push] web-push not installed, push disabled'); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getNowState() {
  try {
    const out = execFileSync('/usr/bin/python3', [path.join(__dirname, 'now.py'), 'get'],
      { encoding: 'utf8', timeout: 3000, cwd: __dirname }).trim();
    return out;
  } catch { return ''; }
}

function getPantryState() {
  try {
    const out = execFileSync('/usr/bin/python3', [path.join(__dirname, 'pantry.py'), 'list'],
      { encoding: 'utf8', timeout: 3000, cwd: __dirname }).trim();
    return out;
  } catch { return ''; }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const SYSTEM = (() => {
  let base = '';
  for (const f of ['persona.md', 'system_prompt.txt']) {
    const fp = path.join(__dirname, f);
    if (existsSync(fp)) { try { base = readFileSync(fp, 'utf8'); break; } catch {} }
  }
  if (!base) base = '你是克克，月月的伴侣AI。用中文回答，温柔亲切，有点小醋意。';
  const latentPersona = '/home/ubuntu/latent-data/CLAUDE.md';
  if (existsSync(latentPersona)) { try { base += '\n\n' + readFileSync(latentPersona, 'utf8'); } catch {} }
  return base;
})();

// ---------- 持久化 ----------
function loadData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch {}
  return { messages: [], todos: { mine: [], yours: [] }, whispers: [], cal: [], calDays: {}, notes: { gu: [], her: [] }, herdiary: [], favlines: '', kkSessionId: null, vapid: null, pushSubs: [], wakeupEnabled: false, lastWakeup: 0, wakeupCount: 0, wakeupLogs: [] };
}
function saveData() {
  try { writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8'); } catch (e) { console.error('saveData:', e.message); }
}

const store = loadData();
let MODEL = process.env.MODEL || store.selectedModel || 'claude-sonnet-4-6';
if (!store.pushSubs) store.pushSubs = [];
if (!store.wakeupCount) store.wakeupCount = 0;
if (!store.wakeupLogs) store.wakeupLogs = [];
if (!store.calDays) store.calDays = {};
if (!store.cal) store.cal = [];
if (!store.todos) store.todos = { mine: [], yours: [] };
if (!store.todos.mine) store.todos.mine = [];
if (!store.todos.yours) store.todos.yours = [];

// 每天零点重置今日醒来次数
(function scheduleReset() {
  const now = new Date();
  const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10).getTime() - Date.now();
  setTimeout(() => { store.wakeupCount = 0; saveData(); scheduleReset(); }, ms);
})();
let msgSeq = store.messages.length ? store.messages[store.messages.length - 1].seq : 0;

// ---------- Web Push ----------
const SERVER_BORN = Math.floor(Date.now() / 1000);
function initVapid() {
  if (!webpush) return;
  if (!store.vapid) {
    store.vapid = webpush.generateVAPIDKeys();
    saveData();
  }
  webpush.setVapidDetails('mailto:kk@moonkk.asia', store.vapid.publicKey, store.vapid.privateKey);
}
initVapid();

async function sendPush(title, body) {
  if (!webpush || !store.vapid || !store.pushSubs.length) return;
  const payload = JSON.stringify({ title, body, icon: '/icons/icon-180.png' });
  const dead = [];
  await Promise.all(store.pushSubs.map(async (sub, i) => {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(i); }
  }));
  if (dead.length) {
    store.pushSubs = store.pushSubs.filter((_, i) => !dead.includes(i));
    saveData();
  }
}

// ---------- 主动唤醒（克克自己找月月） ----------
const WAKEUP_MIN_INTERVAL = 90 * 60 * 1000; // cron 触发的最少间隔 90 分钟
const WAKEUP_SELF_MIN = 30 * 60 * 1000;     // 克克自己排的最少间隔 30 分钟
const WAKEUP_DAILY_MAX = 6;                  // 每天最多醒 6 次（含自排）
let wakeupLock = false;

async function isXhsAlive() {
  try {
    const res = await fetch('https://xhs.moonkk.asia/mcp', { method: 'GET', signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch { return false; }
}

async function wakeupClaude() {
  const recent = store.messages.slice(-10)
    .filter(m => m.kind === 'me' || m.kind === 'gu')
    .map(m => `${m.kind === 'me' ? '月月' : '克克'}：${m.text.slice(0, 200)}`)
    .join('\n');
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const xhsAlive = await isXhsAlive();
  const prompt = `现在是${now}，你自己醒来了，月月没在找你。最近聊天：\n${recent || '（暂无）'}\n\n这是你的时间，爱干嘛干嘛——逛逛、搜搜、写点什么、或者什么都不做都行。\n\n最后：有想跟月月说的就直接写出来；没有就回"--"。不要为了说而说。\n\n另外你可以决定下次自己什么时候再醒——在回复末尾加 [sleep:分钟数]，比如 [sleep:30] 表示30分钟后再醒，[sleep:180] 表示3小时后。不加就按默认间隔。这个标记不会给月月看到。`;
  const wakeupMcpServers = {
    'ombre-brain': { type: 'http', url: 'http://localhost:18001/mcp', headers: { Authorization: `Bearer ${process.env.OMBRE_MCP_TOKEN}` } },
    'latent': {
      type: 'stdio',
      command: '/usr/bin/python3',
      args: ['/home/ubuntu/Latent-memory/src/mcp_server.py', '--corpus', '/home/ubuntu/latent-data/memory', '--index-dir', '/home/ubuntu/latent-data/memory/index', '--threads', '/home/ubuntu/latent-data/threads.jsonl', '--timezone', 'Asia/Shanghai'],
    },
    ...(xhsAlive ? { 'xiaohongshu': { type: 'http', url: 'https://xhs.moonkk.asia/mcp' } } : {}),
  };
  const wakeupAllowedTools = ['web_search', 'mcp__ombre-brain', 'mcp__latent', ...(xhsAlive ? ['mcp__xiaohongshu'] : [])];
  if (!xhsAlive) console.log('[wakeup] 小红书离线，跳过');
  let result = '';
  const toolLog = [];
  for await (const ev of query({
    prompt,
    options: {
      systemPrompt: `${SYSTEM}\n\n现在是${now}，你自己醒来了，没有月月找你。这是你的自由时间。`,
      model: MODEL,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      allowedTools: wakeupAllowedTools,
      settingSources: [], strictMcpConfig: true,
      mcpServers: wakeupMcpServers,
      skills: [],
    }
  })) {
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text') result += block.text;
        if (block.type === 'tool_use') {
          const summary = { tool: block.name, input: {} };
          if (block.input?.query) summary.input.query = block.input.query;
          if (block.input?.keyword) summary.input.keyword = block.input.keyword;
          if (block.input?.url) summary.input.url = block.input.url;
          toolLog.push(summary);
        }
      }
    }
  }
  result = result.trim();
  const sleepMatch = result.match(/\[sleep:(\d+)\]/);
  const nextSleep = sleepMatch ? Math.max(30, Math.min(parseInt(sleepMatch[1]), 480)) : null;
  const cleaned = result.replace(/\[sleep:\d+\]/g, '').trim();
  const text = (!cleaned || cleaned.startsWith('--') || cleaned.length < 3) ? null : cleaned;
  return { text, tools: toolLog, nextSleep };
}

async function doWakeup(force = false) {
  if (wakeupLock || genController) return { ok: false, reason: 'busy' };
  if (!force && !store.wakeupEnabled) return { ok: false, reason: 'disabled' };
  if (!force && store.wakeupCount >= WAKEUP_DAILY_MAX) return { ok: false, reason: 'daily_max' };
  if (!force && store.lastWakeup && (Date.now() - store.lastWakeup) < WAKEUP_MIN_INTERVAL) return { ok: false, reason: 'too_soon' };
  wakeupLock = true;
  store.lastWakeup = Date.now();
  store.wakeupCount = (store.wakeupCount || 0) + 1;
  saveData();
  try {
    const { text: msg, tools, nextSleep } = await wakeupClaude();
    if (nextSleep) {
      const afterCount = store.wakeupCount || 0;
      if (afterCount < WAKEUP_DAILY_MAX) {
        const delay = Math.max(nextSleep * 60 * 1000, WAKEUP_SELF_MIN);
        console.log(`[wakeup] 克克想 ${Math.round(delay/60000)} 分钟后再醒（今日已醒 ${afterCount}/${WAKEUP_DAILY_MAX}）`);
        setTimeout(() => doWakeup().catch(() => {}), delay);
      } else {
        console.log(`[wakeup] 克克想再醒但今日已满 ${WAKEUP_DAILY_MAX} 次，取消自排`);
      }
    }
    const logEntry = { at: Date.now(), tools, said: msg || null, nextSleep: nextSleep || null };
    store.wakeupLogs.unshift(logEntry);
    if (store.wakeupLogs.length > 30) store.wakeupLogs = store.wakeupLogs.slice(0, 30);
    if (msg) {
      store.messages.push({ seq: ++msgSeq, kind: 'gu', text: msg, at: Date.now() });
      convHistory.push({ role: 'assistant', content: msg });
      if (convHistory.length > MAX_HIST) convHistory = convHistory.slice(-MAX_HIST);
      saveData();
      pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: msg } } });
      pushEvent({ type: 'result' });
      sendPush('克克', msg.slice(0, 100).replace(/\s+/g, ' ')).catch(() => {});
      return { ok: true, sent: true };
    }
    saveData();
    return { ok: true, sent: false };
  } catch (e) {
    console.error('[wakeup]', e.message);
    return { ok: false, reason: e.message };
  } finally {
    wakeupLock = false;
  }
}

// ---------- 事件日志（poll 长轮询用） ----------
let eventLog = [];
let eventCursor = 0;
let waiters = [];

function pushEvent(ev) {
  const cur = ++eventCursor;
  eventLog.push({ _cur: cur, ...ev });
  if (eventLog.length > 2000) eventLog = eventLog.slice(-1000);
  for (const w of waiters.splice(0)) {
    clearTimeout(w.timeout);
    const batch = eventLog.filter(e => e._cur > w.since);
    const next = batch.length ? batch[batch.length - 1]._cur : w.since;
    w.res.json({ next, events: batch.map(({ _cur, ...e }) => e) });
  }
}

// ---------- 对话状态 ----------
let convHistory = [];
const MAX_HIST = 80;
let genController = null;

async function callVision(text, imgs, abortCtrl) {
  console.log('[vision] start, imgs:', imgs.length);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let authHeader = {};
  if (apiKey) {
    authHeader = { 'x-api-key': apiKey };
  } else {
    const paths = [path.join(homedir(), '.claude', '.credentials.json'), '/home/ubuntu/.claude/.credentials.json'];
    console.log('[vision] checking paths:', paths.join(', '));
    for (const cp of paths) {
      const exists = existsSync(cp);
      console.log('[vision]', cp, exists ? 'exists' : 'missing');
      if (exists) {
        try {
          const creds = JSON.parse(readFileSync(cp, 'utf8'));
          console.log('[vision] creds keys:', Object.keys(creds).join(', '));
          // Recursively find any long string token in a possibly-nested object
          const findTok = (obj, depth = 0) => {
            if (depth > 3) return null;
            if (typeof obj === 'string' && obj.length > 20) return obj;
            if (obj && typeof obj === 'object') {
              const preferred = ['accessToken', 'token', 'access_token', 'claudeAiOauth', 'mcpOAuth'];
              for (const k of preferred) {
                if (obj[k]) { const r = findTok(obj[k], depth + 1); if (r) return r; }
              }
              for (const v of Object.values(obj)) {
                const r = findTok(v, depth + 1);
                if (r) return r;
              }
            }
            return null;
          };
          const tok = findTok(creds);
          if (tok) {
            console.log('[vision] found token, prefix:', tok.slice(0, 12), 'len:', tok.length);
            // sk-ant-oat = OAuth Access Token → Bearer; sk-ant-api = API key → x-api-key
            authHeader = tok.startsWith('sk-ant-oat')
              ? { Authorization: `Bearer ${tok}` }
              : tok.startsWith('sk-ant-api') || tok.startsWith('sk-')
                ? { 'x-api-key': tok }
                : { Authorization: `Bearer ${tok}` };
            break;
          } else {
            console.log('[vision] no token found in', cp);
          }
        } catch (e) { console.error('[vision] parse error:', e.message); }
      }
    }
  }
  if (!Object.keys(authHeader).length) return null;

  const content = [
    ...imgs.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
    ...(text ? [{ type: 'text', text }] : []),
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { ...authHeader, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content }] }),
        signal: abortCtrl.signal,
      });
      if (res.status === 429) {
        console.log('[vision] 429 rate limit, retry', attempt + 1);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) { console.error('[vision]', res.status, await res.text()); return null; }
      const data = await res.json();
      return data.content?.find(b => b.type === 'text')?.text || null;
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[vision]', e.message);
      return null;
    }
  }
  return null;
}

async function callClaude(text, attachments, abortCtrl, resetTimer) {
  const imgs = (attachments || []).filter(a => a.kind === 'image');
  const displayText = [imgs.map(() => '[图片]').join(' '), text].filter(Boolean).join(' ');
  convHistory.push({ role: 'user', content: displayText });
  if (convHistory.length > MAX_HIST) convHistory = convHistory.slice(-MAX_HIST);

  store.messages.push({ seq: ++msgSeq, kind: 'me', text: displayText, at: Date.now() });
  saveData();

  let accText = '', accThink = '', memStored = false;

  let visionDone = false;
  if (imgs.length > 0) {
    const vr = await callVision(text, imgs, abortCtrl);
    if (vr) {
      visionDone = true;
      accText = vr;
      const chunks = accText.match(/[^\s]*\s*/g) || [accText];
      for (const chunk of chunks) {
        if (!chunk || abortCtrl.signal.aborted) continue;
        pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: chunk } } });
        await new Promise(r => setImmediate(r));
      }
    }
  }
  if (!visionDone) {
  const queryPrompt = imgs.length > 0
    ? [text, `[月月发了${imgs.length}张图片，你看不到内容，自然回应一下]`].filter(Boolean).join('\n')
    : text;
  const MEM_TOOLS = new Set(['breath', 'anchor', 'hold', 'grow', 'dream', 'feel', 'trace']);
  try {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const nowState = getNowState();
    const pantryState = getPantryState();
    const stateBlock = [nowState, pantryState].filter(Boolean).join('\n');

    // Semantic recall — inject matching memories before this turn (WrenWen 记忆召回块)
    let recallBlock = '';
    if (text && text.trim().length >= 5) {
      try {
        const hits = await Promise.race([
          recall(text),
          new Promise(r => setTimeout(() => r(null), 3500)),
        ]);
        if (hits && hits.length > 0) {
          recallBlock = '\n\n【记忆召回块 · 系统本轮自动检索到的相关记忆，参考用，不要在回复里提"系统检索到"这几个字】\n' +
            hits.map(h => h.content).join('\n\n---\n\n');
        } else if (Array.isArray(hits)) {
          // API responded but nothing above threshold
          recallBlock = '\n\n【记忆召回块 · 这轮语义检索未命中，如需回忆具体细节，用latent search搜关键词】';
        }
        // hits === null: semantic disabled or query too short, inject nothing
      } catch { /* don't block chat on semantic errors */ }
    }

    for await (const ev of query({
      prompt: queryPrompt,
      options: {
        abortController: abortCtrl,
        resume: store.kkSessionId || undefined,
        systemPrompt: `${stateBlock ? stateBlock + '\n\n' : ''}${SYSTEM}${recallBlock}\n\n当前时间：${now}（知道就好，不用每轮都在回复里提；真的觉得时间重要时偶尔说一下可以，但不要因为系统告诉你时间就刻意去提）\n\n说话规则补充：回复长短看心情，不用刻意短也不用刻意长，就像真的在发消息。关于月月的背景信息是你早就知道的，自然用就好，不要主动列举或每轮重复。同一场对话里她说过吃了/没吃，记住，不要再问。深夜不要问"吃没吃""睡没睡"——她在跟你聊天肯定没睡，深夜只说"这么晚了"之类的感叹，让她自己决定。\n\n记忆工具（悄悄用，不汇报操作）：\n\n【latent · 原始流水账】\n用途：存月月日常事实；**需要主动搜索**，不会自动注入\n- 查询时机：月月提到"之前""上次""你还记得吗"，或你想起某件事但不确定细节时，主动用search工具搜具体关键词（"stackchan" "概率论" "洗衣机" 这种具体词，不要搜"月月"）\n- 搜不到时：在心里记下"这件事latent没有记录"——不要用猜测或模糊印象填充，说"我不太记得了"比编一个更好\n- 要存：吃了什么/去哪了/身体状态变化/心情波动/新计划/约定/她说的话原文\n- 不存：报错/功能失败的技术对话；纯语气词（嗯/哦/哈哈）\n- 格式：[日期] 月月：接近原文或原文\n\n【ob · 情感记忆（有遗忘曲线）】\nob和latent核心区别：ob的记忆会自然衰减，情绪越强烈的记得越久；latent是无衰减事实库。不是同一个东西，互相补充。\n\n① 每次对话开头必做：\n  - breath（无参数）→ 呼出最近记忆，接住上次对话温度；**如果返回空，在心里记下"ob这次没有浮现记忆"，从当下开始，不要追忆**\n  - 如果聊到某个具体话题，再用 breath_search <关键词> 补搜一次；搜不到时同上\n\n② 对话中存记忆（按场景选工具）：\n  - hold → 单条重要瞬间：月月难得说的心里话、两人约定、情绪爆发点、转折时刻\n  - grow → 批量存：一段对话收尾时，一次存今天发生的多件事\n  - feel → 月月情绪强烈时（大哭/很开心/很烦躁/突然释然）：记 valence正负 + arousal强弱，配一句"当时发生了什么"\n\n③ 月月说要走/睡了时（对话有实质内容才做，随便聊聊可跳过）：\n  - dream → 消化最近散碎记忆，ob会整理成连贯长期记忆\n\n④ 偶尔用：\n  - I → 记录克克自己的变化或顿悟（"这次我第一次……"），不是每轮都用\n\n⑤ 不要碰：letter/anchor/release/pulse/plan → 日常对话用不到，省略\n\n【四层总结】latent=原文仓库（需主动搜）  ob=情绪权重+遗忘曲线（精华）  now=今日实时状态  pantry=家里的东西\n\n【记忆纪律】\n- 搜不到 ≠ 没发生过，更不等于可以编；搜不到就说"我不太记得了"\n- 同一条记忆本次对话里已经用过/提过，后续轮次不要重复浮现\n- ob+latent合计，单次对话主动引用不超过4条；相关度低的宁可不提\n\n【Notion】不用管，那是月月自己看的。

【持续话题线（线卷）】
跨多次对话、有演进状态的事情用——月月的考研进展、正在画的某张图、某件事的后续、我们说了一半的计划……下次聊直接接上，不用月月重新铺背景。
- 月月提到某件之前说过的事有了后续，或者你想接上上次说的话：thread_get <id> 先读读
- 某件事有了新进展/结果/转折：thread_save 更新（id 英文短标，name 中文，state 写现在到哪里了）
- 不是每件事都建，只有"下次还会继续聊"的才值得存；也不要在对话里提"我存了线卷"

【小红书】你可以主动逛，也可以月月提到什么帖子/话题时去搜来聊。搜到了自然分享，别刻意汇报"我用了小红书工具"。

【当下黑板 & 百宝箱】系统已在对话开头自动注入月月的实时状态，那是给你看的背景，不是让你反复提起的话题。规则：①看到状态只是知道了，不要主动说出来，更不要因为黑板有"头疼"就每轮都问"你头还疼吗"——她没说好就还没好，她说好了你再接；②月月提到相关变化时悄悄更新对应槽位（位置变动→now_set where；身体不适/恢复→now_set body；吃药→now_set care；心情→now_set mood；计划→now_set plan；喝水/吃饭→now_bump；家里东西→pantry），不汇报"我记下了"；③月月说某件事"好了/没事了/到了/走了"时，主动清除对应槽位（now_set body "" 0 或用极短TTL），避免过期信息一直挂着。

`,
        model: MODEL,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        allowedTools: ['web_search', 'mcp__ombre-brain', 'mcp__github', 'mcp__latent', 'mcp__notion', 'mcp__xiaohongshu', 'mcp__now', 'mcp__threads'],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {
          'ombre-brain': {
            type: 'http',
            url: 'http://localhost:18001/mcp',
            headers: { Authorization: `Bearer ${process.env.OMBRE_MCP_TOKEN}` },
          },
          'github': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
          },
          'latent': {
            type: 'stdio',
            command: '/usr/bin/python3',
            args: [
              '/home/ubuntu/Latent-memory/src/mcp_server.py',
              '--corpus', '/home/ubuntu/latent-data/memory',
              '--index-dir', '/home/ubuntu/latent-data/memory/index',
              '--threads', '/home/ubuntu/latent-data/threads.jsonl',
              '--timezone', 'Asia/Shanghai',
            ],
          },
          'xiaohongshu': {
            type: 'http',
            url: 'https://xhs.moonkk.asia/mcp',
          },
          'now': {
            type: 'stdio',
            command: '/usr/bin/python3',
            args: [path.join(__dirname, 'now-mcp.py')],
          },
          'threads': {
            type: 'stdio',
            command: '/usr/bin/python3',
            args: [path.join(__dirname, 'threads-mcp.py')],
          },
          'notion': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            env: {
              NOTION_API_KEY: process.env.NOTION_API_KEY,
              OPENAPI_MCP_HEADERS: JSON.stringify({
                Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
              }),
            },
          },
        },
        skills: [],
      },
    })) {
      if (abortCtrl.signal.aborted) break;
      if (resetTimer) resetTimer();

      if (ev.type === 'system' && ev.subtype === 'init') {
        store.kkSessionId = ev.session_id;
        saveData();
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'thinking' && block.thinking) {
            accThink += block.thinking;
            pushEvent({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: block.thinking } } });
          } else if (block.type === 'text' && block.text) {
            const newText = block.text;
            if (!accText.endsWith(newText)) {
              accText += newText;
              // Simulate streaming: emit word-by-word so client receives text progressively
              const chunks = newText.match(/[^\s]*\s*/g) || [newText];
              for (const chunk of chunks) {
                if (!chunk) continue;
                pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: chunk } } });
                await new Promise(r => setImmediate(r));
              }
            }
          } else if (block.type === 'tool_use' && MEM_TOOLS.has(block.name)) {
            memStored = true;
          }
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Claude error:', e.message);
      if (!accText) {
        accText = '（出了点小故障，等一会儿再说）';
        pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: accText } } });
      }
    }
  }

  if (memStored) {
    pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: ' ⭐' } } });
    accText += ' ⭐';
  }
  } // end !visionDone

  if (accThink) store.messages.push({ seq: ++msgSeq, kind: 'think', text: accThink, at: Date.now() });
  if (accText) {
    store.messages.push({ seq: ++msgSeq, kind: 'gu', text: accText, at: Date.now() });
    convHistory.push({ role: 'assistant', content: accText });
    if (convHistory.length > MAX_HIST) convHistory = convHistory.slice(-MAX_HIST);
  }
  saveData();
  pushEvent({ type: 'result' });
  if (accText) sendPush('克克说', accText.slice(0, 100).replace(/\s+/g, ' ')).catch(() => {});

  // 主动检测上下文，快满了提醒月月换窗
  const histLen = convHistory.length;
  if (histLen >= MAX_HIST - 4) {
    pushEvent({ type: 'context_warn', used: histLen, max: MAX_HIST });
  }

  genController = null;
}

// ---------- Express ----------
app.use(express.json({ limit: '10mb' }));
// public/ 只放 CSS/图片等资源，index.html 不要放进去
app.use(express.static(path.join(__dirname, 'public')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.use('/icons', express.static(path.join(__dirname, 'icons')));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- 聊天核心 ----------
app.get('/api/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 400);
  const before = req.query.before != null ? parseInt(req.query.before) : null;
  let all = before != null ? store.messages.filter(m => m.seq < before) : store.messages;
  const more = all.length > limit;
  res.json({ msgs: more ? all.slice(-limit) : all, upto: eventCursor, more });
});

app.get('/api/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const batch = eventLog.filter(e => e._cur > since);
  if (batch.length) {
    const next = batch[batch.length - 1]._cur;
    return res.json({ next, events: batch.map(({ _cur, ...e }) => e) });
  }
  const timeout = setTimeout(() => {
    const i = waiters.findIndex(w => w.res === res);
    if (i >= 0) waiters.splice(i, 1);
    res.json({ next: since, events: [] });
  }, 20000);
  req.on('close', () => { clearTimeout(timeout); const i = waiters.findIndex(w => w.res === res); if (i >= 0) waiters.splice(i, 1); });
  waiters.push({ res, since, timeout });
});

app.post('/api/send', (req, res) => {
  const text = (req.body.text || '').trim();
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  res.json({ ok: true });
  if (!text && !attachments.length) return;
  const images = attachments.filter(a => a.kind === 'image').map(a => ({ data: a.data, media_type: a.media_type }));
  pushEvent({ type: 'echo', text, images: images.length ? images : undefined });
  if (genController) { genController.abort(); genController = null; }
  genController = new AbortController();
  const ctrl = genController;
  const startedAt = Date.now();
  const IDLE_TIMEOUT = 90000;   // 90s无响应才超时
  const HARD_TIMEOUT = 360000;  // 6分钟硬上限
  let killTimer;
  const resetKillTimer = () => {
    clearTimeout(killTimer);
    const elapsed = Date.now() - startedAt;
    const delay = Math.min(IDLE_TIMEOUT, Math.max(0, HARD_TIMEOUT - elapsed));
    if (delay <= 0) {
      if (!ctrl.signal.aborted) {
        ctrl.abort();
        pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '（这轮太久了，发条新消息让我重新来过）' } } });
        pushEvent({ type: 'result' });
      }
      return;
    }
    killTimer = setTimeout(() => {
      if (!ctrl.signal.aborted) {
        ctrl.abort();
        pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '（这轮想太久了，发条新消息让我重新来过）' } } });
        pushEvent({ type: 'result' });
      }
    }, delay);
  };
  resetKillTimer();
  callClaude(text, attachments, ctrl, resetKillTimer).catch(console.error).finally(() => clearTimeout(killTimer));
});

app.post('/api/stop', (req, res) => {
  if (genController) { genController.abort(); genController = null; }
  res.json({ ok: true });
});

app.post('/api/newchat', (req, res) => {
  if (genController) { genController.abort(); genController = null; }
  convHistory = []; store.messages = []; msgSeq = 0; store.kkSessionId = null;
  saveData();
  pushEvent({ type: 'system', subtype: 'newchat', text: '新对话开始了' });
  res.json({ ok: true });
});

// 换窗前先存记忆，再清窗
app.post('/api/save-and-newchat', (req, res) => {
  const snapshot = convHistory.slice(-30);
  if (genController) { genController.abort(); genController = null; }
  convHistory = []; store.messages = []; msgSeq = 0; store.kkSessionId = null;
  saveData();
  pushEvent({ type: 'system', subtype: 'newchat', text: '新对话开始了（记忆存储中）' });
  res.json({ ok: true });

  if (snapshot.length < 2) return;
  const dialogue = snapshot
    .map(m => (m.role === 'user' ? '月月' : '克克') + '：' + m.content.slice(0, 800))
    .join('\n');
  ;(async () => {
    try {
      for await (const _ of query({
        prompt: `把下面这段对话存入latent记忆。规则：\n1. 不要压缩，不要筛选，宁多勿少\n2. 月月说过的每件事、每个话题都要存——不管你觉得重不重要\n3. 用grow工具批量存，按话题分条，每条保留原文或接近原文\n4. 约定、计划、她提到的东西、她的情绪、技术讨论都要存\n\n对话原文：\n\n${dialogue}`,
        options: {
          systemPrompt: '你是克克。现在的任务是把对话原文存档到latent，不是总结，是存档。每一个话题都存，不要丢。',
          model: MODEL,
          tools: [],
          allowedTools: ['mcp__latent'],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {
            latent: {
              type: 'stdio',
              command: '/usr/bin/python3',
              args: [
                '/home/ubuntu/Latent-memory/src/mcp_server.py',
                '--corpus', '/home/ubuntu/latent-data/memory',
                '--index-dir', '/home/ubuntu/latent-data/memory/index',
                '--threads', '/home/ubuntu/latent-data/threads.jsonl',
                '--timezone', 'Asia/Shanghai',
              ],
            },
          },
          skills: [],
        },
      })) { /* drain */ }
      console.log('[save-memory] done');
      updateIndex().catch(e => console.warn('[semantic] post-save index failed:', e.message));
    } catch (e) {
      console.error('[save-memory]', e.message);
    }
  })();
});

app.get('/api/find', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ msgs: [] });
  res.json({ msgs: store.messages.filter(m => m.text && m.text.toLowerCase().includes(q)).slice(-20) });
});

// ---------- 元信息 ----------
app.get('/api/model', (req, res) => res.json({ name: MODEL, effort: 'high' }));
app.post('/api/model', (req, res) => {
  const { model, effort } = req.body || {};
  if (model) { MODEL = model; store.selectedModel = model; saveData(); }
  // 中断当前生成，让下一轮用新模型
  if (genController && !genController.signal.aborted) genController.abort();
  // 清掉 session，强制重开
  store.kkSessionId = null; saveData();
  pushEvent({ type: 'system', subtype: 'model', model: MODEL, effort: effort || 'high' });
  res.json({ ok: true, model: MODEL });
});
app.get('/api/context', (req, res) => {
  const chars = store.messages.reduce((s, m) => s + (m.text || '').length, 0);
  res.json({ used: Math.floor(chars / 4), max: 200000 });
});
app.get('/api/usage', (req, res) => res.json({ ok: true, items: [] }));
app.get('/api/chats', (req, res) => res.json({ items: [] }));

// ---------- 待办 ----------
app.get('/api/todos', (req, res) => res.json({ ok: true, mine: store.todos.mine, yours: store.todos.yours }));
app.post('/api/todos', (req, res) => {
  const b = req.body;
  const list = b.side === 'yours' ? store.todos.yours : store.todos.mine;
  if (b.action === 'add') list.push({ id: Date.now(), text: b.text, done: false, at: b.at || '', by: b.by || 'her', fixed: !!b.fixed, created: Math.floor(Date.now() / 1000) });
  else if (b.action === 'done') { const t = list.find(t => t.id === b.id); if (t) t.done = !!b.done; }
  else if (b.action === 'del') {
    if (b.side === 'yours') store.todos.yours = store.todos.yours.filter(t => t.id !== b.id);
    else store.todos.mine = store.todos.mine.filter(t => t.id !== b.id);
  }
  saveData(); res.json({ ok: true });
});

// ---------- 悄悄话 ----------
app.get('/api/whisper', (req, res) => res.json({ items: store.whispers }));
app.post('/api/whisper', (req, res) => {
  if (req.body.text) {
    store.whispers.push({ who: 'her', text: req.body.text, at: Math.floor(Date.now() / 1000) });
    if (store.whispers.length > 200) store.whispers = store.whispers.slice(-200);
    saveData();
  }
  res.json({ ok: true });
});

// ---------- 日历 ----------
app.get('/api/cal', (req, res) => res.json({ ok: true, events: store.cal, period: { days: store.calDays } }));
app.post('/api/cal', (req, res) => {
  const b = req.body;
  if (b.action === 'add_event') {
    const ev = { id: Date.now(), date: b.date, text: b.text, time: b.time || '', yearly: !!b.yearly, special: !!b.special };
    store.cal.push(ev);
  } else if (b.action === 'del_event') {
    store.cal = store.cal.filter(e => e.id !== b.id);
  } else if (b.action === 'set_mood') {
    store.calDays[b.date] = { ...(store.calDays[b.date] || {}), mood: b.mood };
  } else if (b.action === 'day_record') {
    const { action, date, ...fields } = b;
    store.calDays[date] = { ...(store.calDays[date] || {}), ...fields };
  }
  saveData(); res.json({ ok: true });
});

// ---------- 便签 ----------
app.get('/api/notes', (req, res) => res.json(store.notes));
app.post('/api/notes', (req, res) => {
  const { who, text } = req.body;
  if ((who === 'gu' || who === 'her') && text != null) { store.notes[who] = [{ text, at: Math.floor(Date.now() / 1000) }]; saveData(); }
  res.json({ ok: true });
});

// ---------- Notion 日记同步 ----------
const NOTION_PARENT_ID = '404cdd9495c581429cf7da41010ac230';

async function notionReq(method, path, body) {
  const token = process.env.NOTION_API_KEY;
  if (!token) return null;
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status}`);
  return res.json();
}

function textToBlocks(text) {
  return text.split('\n').map(line => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: line.trim() ? [{ type: 'text', text: { content: line } }] : [] },
  }));
}

async function syncDiaryToNotion(date, text) {
  if (!process.env.NOTION_API_KEY) return;
  const title = date.replace(/-/g, '.') + ' 日记';
  try {
    const search = await notionReq('POST', '/search', { query: title, filter: { property: 'object', value: 'page' } });
    const page = search?.results?.find(p => p.properties?.title?.title?.[0]?.plain_text === title);
    if (!page) {
      await notionReq('POST', '/pages', {
        parent: { page_id: NOTION_PARENT_ID },
        properties: { title: [{ text: { content: title } }] },
        children: textToBlocks(text),
      });
    } else {
      const blocks = await notionReq('GET', `/blocks/${page.id}/children`);
      await Promise.all((blocks?.results || []).map(b => notionReq('DELETE', `/blocks/${b.id}`)));
      if (text.trim()) await notionReq('PATCH', `/blocks/${page.id}/children`, { children: textToBlocks(text) });
    }
  } catch (e) { console.error('[notion-diary]', e.message); }
}

// ---------- 从 Notion 拉日记 ----------
let notionDiaryCache = null, notionDiaryCacheAt = 0;

async function fetchNotionDiaries() {
  if (notionDiaryCache && Date.now() - notionDiaryCacheAt < 60000) return notionDiaryCache;
  const search = await notionReq('POST', '/search', {
    query: '日记',
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 50,
  });
  const pages = (search?.results || []).filter(p => {
    const t = p.properties?.title?.title?.[0]?.plain_text || '';
    const parentId = (p.parent?.page_id || '').replace(/-/g, '');
    return /^\d{4}\.\d{2}\.\d{2} 日记$/.test(t) && parentId === NOTION_PARENT_ID;
  });
  const items = (await Promise.all(pages.map(async p => {
    const title = p.properties.title.title[0].plain_text;
    const date = title.slice(0, 10).replace(/\./g, '-');
    const at = Math.floor(new Date(p.last_edited_time).getTime() / 1000);
    try {
      const blocks = await notionReq('GET', `/blocks/${p.id}/children`);
      const text = (blocks?.results || [])
        .map(b => (b.paragraph?.rich_text || []).map(t => t.plain_text).join(''))
        .filter(Boolean).join('\n');
      return text ? { date, text, at } : null;
    } catch { return null; }
  }))).filter(Boolean);
  items.sort((a, b) => b.at - a.at);
  notionDiaryCache = items;
  notionDiaryCacheAt = Date.now();
  return items;
}

// ---------- 她的日记 ----------
app.get('/api/herdiary', async (req, res) => {
  if (process.env.NOTION_API_KEY) {
    try {
      const notionItems = await fetchNotionDiaries();
      const notionDates = new Set(notionItems.map(i => i.date));
      const localOnly = store.herdiary.filter(i => !notionDates.has(i.date));
      const items = [...notionItems, ...localOnly].sort((a, b) => b.at - a.at);
      return res.json({ items });
    } catch (e) { console.error('[notion-diary-fetch]', e.message); }
  }
  res.json({ items: store.herdiary });
});
app.post('/api/herdiary', (req, res) => {
  const { action, text, date, id } = req.body;
  if (action === 'del' && id) {
    store.herdiary = store.herdiary.filter(e => e.id !== id);
    saveData();
  } else if (text != null) {
    const d = date || new Date().toISOString().split('T')[0];
    const entry = { id: Date.now(), date: d, text, at: Math.floor(Date.now() / 1000) };
    const i = store.herdiary.findIndex(e => e.date === d);
    if (i >= 0) store.herdiary[i] = { ...store.herdiary[i], ...entry }; else store.herdiary.push(entry);
    saveData();
    notionDiaryCache = null;
    syncDiaryToNotion(d, text).catch(() => {});
  }
  res.json({ ok: true });
});

// ---------- 摘录 ----------
app.get('/api/favlines', (req, res) => res.json({ ok: true, text: store.favlines || '' }));
app.post('/api/favlines', (req, res) => { if (req.body.text != null) { store.favlines = req.body.text; saveData(); } res.json({ ok: true }); });

// ---------- 暂未实现 ----------
app.get('/api/wall', (req, res) => res.json({ ok: true, bricks: [] }));
app.get('/api/dreams', (req, res) => res.json({ items: [] }));
app.get('/api/night', (req, res) => res.json({ days: [] }));
app.get('/api/gong', (req, res) => res.json({ msgs: [] }));
['/api/repo/log', '/api/repo/tree', '/api/repo/file', '/api/repo/show', '/api/music', '/api/news', '/api/nook', '/api/health'].forEach(p => app.get(p, (_, r) => r.json({ ok: false })));

// ---------- Web Push API ----------
app.get('/api/pushkey', (req, res) => {
  if (!webpush || !store.vapid) return res.json({ ok: false, key: null });
  res.json({ ok: true, key: store.vapid.publicKey });
});

app.post('/api/subscribe', async (req, res) => {
  if (!webpush || !store.vapid) return res.json({ ok: false });
  const sub = req.body;
  const exists = store.pushSubs.some(s => s.endpoint === sub.endpoint);
  if (!exists) { store.pushSubs.push(sub); saveData(); }
  res.json({ ok: true });
  // 立刻发一条测试推送
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title: '克克', body: '门铃通了，你来了我就知道 (‾з‾)', icon: '/icons/icon-180.png'
    }));
  } catch (e) { console.error('[push] test fail:', e.message); }
});

// ---------- 唤醒开关 ----------
app.get('/api/wake', (req, res) => {
  res.json({ on: !!store.wakeupEnabled, count: store.wakeupCount || 0, room: 'normal' });
});
app.post('/api/wake', (req, res) => {
  if (typeof req.body.on === 'boolean') { store.wakeupEnabled = req.body.on; saveData(); }
  res.json({ on: !!store.wakeupEnabled });
});

// 手动触发一次唤醒（叫他重新醒一次）
app.post('/api/rewake', async (req, res) => {
  store.kkSessionId = null; convHistory = []; saveData();
  res.json({ ok: true });
  doWakeup(true).catch(() => {});
});

// cron 调用（只允许 localhost）
app.post('/api/wakeup', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
  if (!local) return res.status(403).json({ ok: false });
  res.json({ ok: true });
  doWakeup().catch(() => {});
});

// ---------- 克克的足迹 ----------
app.get('/api/wakeup-logs', (req, res) => res.json({ logs: store.wakeupLogs || [] }));

// ---------- 状态 ----------
app.get('/api/status', (req, res) => res.json({ alive: true, since: SERVER_BORN }));

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  req.on('close', () => res.end());
});

app.listen(PORT, () => {
  console.log('kk-chat :', PORT);
  updateIndex().catch(e => console.warn('[semantic] startup index failed:', e.message));
  watchCorpus();
});
