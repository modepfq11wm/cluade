#!/usr/bin/env python3
"""线卷 MCP Server — roleplay 故事线状态管理"""
import json, os, sys
from pathlib import Path
from datetime import datetime

THREADS_FILE = os.path.expanduser('~/latent-data/story_threads.json')

def load():
    try: return json.loads(Path(THREADS_FILE).read_text(encoding='utf-8'))
    except: return {}

def save(threads):
    Path(THREADS_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(THREADS_FILE).write_text(json.dumps(threads, ensure_ascii=False, indent=2), encoding='utf-8')

TOOLS = [
    {
        "name": "thread_list",
        "description": "列出所有故事线卷（ID、名称、最后更新时间）",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "thread_get",
        "description": "读取一条故事线的完整状态（角色表、当前进度、关键转折点）。月月说"继续XX"或提到故事角色时先调这个。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "线卷 ID"}},
            "required": ["id"]
        }
    },
    {
        "name": "thread_save",
        "description": "创建或更新一条故事线卷。故事有实质推进（不是每句话，是走了一段）时调一次。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id":         {"type": "string", "description": "线卷 ID，英文短标识，如 meigao_fen1"},
                "name":       {"type": "string", "description": "故事名称，中文可读，如"美高·封一""},
                "characters": {"type": "string", "description": "角色表：姓名、关系、主要特征"},
                "state":      {"type": "string", "description": "当前状态：故事走到哪里，下次继续的起点"},
                "moments":    {"type": "string", "description": "关键转折点（追加新条目，不要删旧的）"}
            },
            "required": ["id", "name", "state"]
        }
    }
]

def call_tool(name, args):
    threads = load()
    if name == 'thread_list':
        if not threads:
            return '（暂无故事线卷）'
        lines = [f"[{tid}] {t.get('name', tid)}  更新：{t.get('updated', '—')}" for tid, t in threads.items()]
        return '\n'.join(lines)

    if name == 'thread_get':
        tid = args.get('id', '')
        t = threads.get(tid)
        if not t:
            return f'找不到线卷：{tid}。可用：{", ".join(threads.keys()) or "（空）"}'
        parts = [f"【{t.get('name', tid)}】（{t.get('updated', '—')}）"]
        if t.get('characters'): parts.append(f"角色：{t['characters']}")
        if t.get('state'):      parts.append(f"当前状态：{t['state']}")
        if t.get('moments'):    parts.append(f"关键转折：{t['moments']}")
        return '\n'.join(parts)

    if name == 'thread_save':
        tid = args.get('id', '').strip()
        if not tid:
            return '缺少 id'
        existing = threads.get(tid, {})
        threads[tid] = {
            **existing,
            'name':       args.get('name',       existing.get('name', tid)),
            'characters': args.get('characters', existing.get('characters', '')),
            'state':      args.get('state',      existing.get('state', '')),
            'moments':    args.get('moments',    existing.get('moments', '')),
            'updated':    datetime.now().strftime('%Y-%m-%d %H:%M'),
        }
        save(threads)
        return f'线卷已保存：{tid}（{threads[tid]["name"]}）'

    return f'未知工具：{name}'

def handle(req):
    method = req.get('method', '')
    params = req.get('params', {})
    rid    = req.get('id')

    if method == 'initialize':
        return {"jsonrpc":"2.0","id":rid,"result":{
            "protocolVersion":"2024-11-05",
            "capabilities":{"tools":{}},
            "serverInfo":{"name":"threads-mcp","version":"1.0"}
        }}
    if method == 'tools/list':
        return {"jsonrpc":"2.0","id":rid,"result":{"tools":TOOLS}}
    if method == 'tools/call':
        text = call_tool(params.get('name',''), params.get('arguments',{}))
        return {"jsonrpc":"2.0","id":rid,"result":{"content":[{"type":"text","text":text}]}}
    if method in ('notifications/initialized','initialized'):
        return None
    return {"jsonrpc":"2.0","id":rid,"error":{"code":-32601,"message":f"unknown: {method}"}}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            resp = handle(json.loads(line))
            if resp is not None:
                print(json.dumps(resp, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc":"2.0","id":None,"error":{"code":-32700,"message":str(e)}}), flush=True)

if __name__ == '__main__':
    main()
