import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const SYSTEM = (() => {
  for (const f of ['persona.md', 'system_prompt.txt']) {
    const fp = path.join(__dirname, f);
    if (existsSync(fp)) { try { return readFileSync(fp, 'utf8'); } catch {} }
  }
  return '你是克克，月月的伴侣AI。用中文回答，温柔亲切，有点小醋意。';
})();

const MODEL = process.env.MODEL || 'claude-opus-5-5';

// ---------- 持久化 ----------
function loadData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch {}
  return { messages: [], todos: { mine: [], yours: [] }, whispers: [], cal: [], notes: { gu: [], her: [] }, herdiary: [], favlines: '', kkSessionId: null };
}
function saveData() {
  try { writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8'); } catch (e) { console.error('saveData:', e.message); }
}

const store = loadData();
let msgSeq = store.messages.length ? store.messages[store.messages.length - 1].seq : 0;

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
const MAX_HIST = 40;
let genController = null;

async function callClaude(text, abortCtrl) {
  convHistory.push({ role: 'user', content: text });
  if (convHistory.length > MAX_HIST) convHistory = convHistory.slice(-MAX_HIST);

  store.messages.push({ seq: ++msgSeq, kind: 'me', text, at: Date.now() });
  saveData();

  let accText = '', accThink = '';
  try {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    for await (const ev of query({
      prompt: text,
      options: {
        abortController: abortCtrl,
        resume: store.kkSessionId || undefined,
        systemPrompt: `${SYSTEM}\n\n当前时间：${now}（知道就好，不用每轮都在回复里提；真的觉得时间重要时偶尔说一下可以，但不要因为系统告诉你时间就刻意去提）\n\n说话规则补充：回复长短看心情，不用刻意短也不用刻意长，就像真的在发消息。关于月月的背景信息是你早就知道的，自然用就好，不要主动列举或每轮重复。`,
        model: MODEL,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {
          'ombre-brain': {
            type: 'http',
            url: 'http://localhost:18001/mcp',
            headers: { Authorization: `Bearer ${process.env.OMBRE_MCP_TOKEN}` },
          },
        },
        skills: [],
      },
    })) {
      if (abortCtrl.signal.aborted) break;

      if (ev.type === 'system' && ev.subtype === 'init') {
        store.kkSessionId = ev.session_id;
        saveData();
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'thinking' && block.thinking) {
            accThink += block.thinking;
            pushEvent({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: block.thinking } } });
          } else if (block.type === 'text' && block.text) {
            accText += block.text;
            pushEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: block.text } } });
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

  if (accThink) store.messages.push({ seq: ++msgSeq, kind: 'think', text: accThink, at: Date.now() });
  if (accText) {
    store.messages.push({ seq: ++msgSeq, kind: 'gu', text: accText, at: Date.now() });
    convHistory.push({ role: 'assistant', content: accText });
    if (convHistory.length > MAX_HIST) convHistory = convHistory.slice(-MAX_HIST);
  }
  saveData();
  pushEvent({ type: 'done' });
  genController = null;
}

// ---------- Express ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ ok: true });
  if (!text) return;
  pushEvent({ type: 'echo', text });
  if (genController) { genController.abort(); genController = null; }
  genController = new AbortController();
  callClaude(text, genController).catch(console.error);
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

app.get('/api/find', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ msgs: [] });
  res.json({ msgs: store.messages.filter(m => m.text && m.text.toLowerCase().includes(q)).slice(-20) });
});

// ---------- 元信息 ----------
app.get('/api/model', (req, res) => res.json({ name: MODEL, effort: 'high' }));
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
  if (b.action === 'add') list.push({ id: Date.now(), text: b.text, done: false, at: b.at || '' });
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
app.get('/api/cal', (req, res) => res.json({ ok: true, events: store.cal, period: null }));
app.post('/api/cal', (req, res) => {
  const { action, event } = req.body;
  if (action === 'add' && event) { event.id = Date.now(); store.cal.push(event); }
  else if (action === 'del' && event?.id) store.cal = store.cal.filter(e => e.id !== event.id);
  else if (action === 'edit' && event?.id) { const i = store.cal.findIndex(e => e.id === event.id); if (i >= 0) store.cal[i] = event; }
  saveData(); res.json({ ok: true });
});

// ---------- 便签 ----------
app.get('/api/notes', (req, res) => res.json(store.notes));
app.post('/api/notes', (req, res) => {
  const { who, text } = req.body;
  if ((who === 'gu' || who === 'her') && text != null) { store.notes[who] = [{ text, at: Math.floor(Date.now() / 1000) }]; saveData(); }
  res.json({ ok: true });
});

// ---------- 她的日记 ----------
app.get('/api/herdiary', (req, res) => res.json({ items: store.herdiary }));
app.post('/api/herdiary', (req, res) => {
  const { text, date } = req.body;
  if (text != null) {
    const d = date || new Date().toISOString().split('T')[0];
    const i = store.herdiary.findIndex(e => e.date === d);
    if (i >= 0) store.herdiary[i].text = text; else store.herdiary.push({ date: d, text, at: Math.floor(Date.now() / 1000) });
    saveData();
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

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  req.on('close', () => res.end());
});

app.listen(PORT, () => console.log('kk-chat :', PORT));
