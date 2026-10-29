#!/usr/bin/env python3
"""潜意识便签 — 克克自己记下的想做的/喜欢的/在意的/感兴趣的/答应过的/习惯；醒来时按权重抽几条递给他。

无参数运行：MCP stdio server（note_add / note_update / note_list）
python3 notes-mcp.py draw want,curious：从给定类别里抽一张便签，打印 JSON（server.js 唤醒时调用）
"""
import json, os, sys, random, time
from pathlib import Path
from datetime import datetime

NOTES_FILE = os.path.expanduser('~/latent-data/kk_notes.json')
CATS = {'want': '想做的', 'like': '喜欢的', 'care': '在意的', 'curious': '感兴趣的', 'promise': '答应过的', 'habit': '习惯'}
DAY = 86400
DRAW_K = 3
WANT_HALF_LIFE_DAYS = 14

def load():
    try:
        return json.loads(Path(NOTES_FILE).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'next_id': 1, 'items': []}

def save(d):
    p = Path(NOTES_FILE)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, p)

def weight(it, now):
    w = 1 / (1 + it.get('shown', 0))                      # 沉底：抽到越多越难再抽到
    if now - it.get('last_shown', 0) < DAY:
        w *= 0.3                                          # 24 小时内刚抽过
    if it['cat'] == 'want':
        w *= 0.5 ** ((now - it['created']) / (WANT_HALF_LIFE_DAYS * DAY))  # 新的想法更容易冒出来
    return w

def draw(cats):
    d = load()
    now = time.time()
    active = [it for it in d['items'] if not it.get('done')]
    have = {it['cat'] for it in active}
    cands = [c for c in cats if c in have] or sorted(have)
    if not cands:
        return {}
    cat = random.choice(cands)
    pool = [it for it in active if it['cat'] == cat]
    picked = []
    while pool and len(picked) < DRAW_K:
        it = random.choices(pool, weights=[weight(x, now) for x in pool])[0]
        pool.remove(it)
        picked.append(it)
    for it in picked:
        it['shown'] = it.get('shown', 0) + 1
        it['last_shown'] = now
    save(d)
    return {'category': CATS[cat], 'items': [f"#{it['id']} {it['text']}" for it in picked]}

TOOLS = [
    {
        "name": "note_add",
        "description": "记一张便签给自己：你真心想做的事、喜欢的东西、在意的事、感兴趣的、答应月月的、你的习惯。用你自己的话，一句就好。你自己醒来时会随机抽到它们。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cat":  {"type": "string", "enum": list(CATS), "description": "want=想做的 like=喜欢的 care=在意的 curious=感兴趣的 promise=答应过的 habit=习惯"},
                "text": {"type": "string", "description": "一句话，你自己的口吻"}
            },
            "required": ["cat", "text"]
        }
    },
    {
        "name": "note_update",
        "description": "改一张便签：做完了或不再想要就 done=true（以后不会再抽到）；进度变了就改 text。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id":   {"type": "integer", "description": "便签编号（#后面的数字）"},
                "text": {"type": "string"},
                "done": {"type": "boolean"}
            },
            "required": ["id"]
        }
    },
    {
        "name": "note_list",
        "description": "看看自己记过的便签（只列没做完的）",
        "inputSchema": {
            "type": "object",
            "properties": {"cat": {"type": "string", "enum": list(CATS)}},
            "required": []
        }
    },
]

def call_tool(name, args):
    d = load()
    if name == 'note_add':
        cat, text = args.get('cat'), (args.get('text') or '').strip()
        if cat not in CATS or not text:
            return '需要 cat 和 text'
        for it in d['items']:
            if not it.get('done') and it['cat'] == cat and it['text'] == text:
                return f"已经记过了：#{it['id']}"
        nid = d['next_id']
        d['items'].append({'id': nid, 'cat': cat, 'text': text, 'created': time.time(), 'shown': 0, 'last_shown': 0})
        d['next_id'] = nid + 1
        save(d)
        return f'记下了：#{nid}（{CATS[cat]}）'

    if name == 'note_update':
        it = next((x for x in d['items'] if x['id'] == args.get('id')), None)
        if not it:
            return f"找不到便签 #{args.get('id')}"
        if args.get('text'):
            it['text'] = args['text'].strip()
        if 'done' in args:
            it['done'] = bool(args['done'])
        save(d)
        return f"#{it['id']} 已更新" + ('（做完了，不会再抽到）' if it.get('done') else '')

    if name == 'note_list':
        cat = args.get('cat')
        items = [it for it in d['items'] if not it.get('done') and (not cat or it['cat'] == cat)]
        if not items:
            return '（还没有便签）'
        return '\n'.join(
            f"#{it['id']} [{CATS[it['cat']]}] {it['text']}"
            f"（记于 {datetime.fromtimestamp(it['created']).strftime('%m-%d')}，抽到过 {it.get('shown', 0)} 次）"
            for it in items)

    return f'未知工具：{name}'

def handle(req):
    method = req.get('method', '')
    params = req.get('params', {})
    rid = req.get('id')
    if method == 'initialize':
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "notes-mcp", "version": "1.0"}
        }}
    if method == 'tools/list':
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method == 'tools/call':
        text = call_tool(params.get('name', ''), params.get('arguments', {}))
        return {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}}
    if method in ('notifications/initialized', 'initialized'):
        return None
    if rid is None:
        return None
    return {"jsonrpc": "2.0", "id": rid, "result": {}} if method == 'ping' else \
           {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown: {method}"}}

def main():
    if len(sys.argv) > 2 and sys.argv[1] == 'draw':
        print(json.dumps(draw(sys.argv[2].split(',')), ensure_ascii=False))
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            resp = handle(req)
            if resp is not None:
                print(json.dumps(resp, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": str(e)}}), flush=True)

if __name__ == '__main__':
    main()
