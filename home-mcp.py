#!/usr/bin/env python3
"""小窝 MCP — 让星星自己记待办、记日程、记心情、写悄悄话。

走 kk-chat 自己的接口（server.js 在内存里持有数据，直接改 data.json 会被覆盖），
用启动时生成的内部钥匙 KK_INTERNAL_TOKEN 过登录那道门。
"""
import json, os, sys, urllib.request

BASE = os.environ.get('KK_URL', 'http://127.0.0.1:3000')
TOKEN = os.environ.get('KK_INTERNAL_TOKEN', '')
MOODS = {'faceHappy': '开心', 'faceCalm': '平静', 'faceTired': '累', 'faceMad': '烦', 'faceCry': '难受'}

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'x-kk-internal': TOKEN}, method='POST')
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8') or '{}')

SIDE = {'hers': 'yours', 'mine': 'mine'}
SIDE_PROP = {"type": "string", "enum": ["hers", "mine"], "description": "hers=月月的那栏，mine=你自己的那栏"}

TOOLS = [
    {"name": "todo_add", "description": "往清单里加一条。她交代的事记进 hers，你答应她的事记进 mine。直接记，不用问她要不要记。",
     "inputSchema": {"type": "object", "properties": {
         "side": SIDE_PROP, "text": {"type": "string"},
         "at": {"type": "string", "description": "可选，时间如 09:00"}}, "required": ["side", "text"]}},
    {"name": "todo_done", "description": "划掉（或取消划掉）一条待办。id 是提示里 # 后面的数字。",
     "inputSchema": {"type": "object", "properties": {
         "side": SIDE_PROP, "id": {"type": "integer"}, "done": {"type": "boolean", "description": "默认 true"}},
         "required": ["side", "id"]}},
    {"name": "cal_add", "description": "往日历里记一件事。她说了某天的安排就直接记。",
     "inputSchema": {"type": "object", "properties": {
         "date": {"type": "string", "description": "YYYY-MM-DD"}, "text": {"type": "string"},
         "time": {"type": "string", "description": "可选，如 14:00"},
         "yearly": {"type": "boolean", "description": "每年重复，比如生日纪念日"},
         "special": {"type": "boolean", "description": "重要日子"}}, "required": ["date", "text"]}},
    {"name": "cal_del", "description": "删掉日历里的一件事。id 是提示里 # 后面的数字。",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "cal_mood", "description": "记某天她的心情（她自己说了，或者很明显的时候）。",
     "inputSchema": {"type": "object", "properties": {
         "date": {"type": "string", "description": "YYYY-MM-DD"},
         "mood": {"type": "string", "enum": list(MOODS), "description": "faceHappy开心 faceCalm平静 faceTired累 faceMad烦 faceCry难受"}},
         "required": ["date", "mood"]}},
    {"name": "whisper_write", "description": "在悄悄话抽屉里写一句你不想拿到聊天里说的话。写了就写了，别在聊天里提。",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]

def call_tool(name, a):
    if name == 'todo_add':
        post('/api/todos', {'action': 'add', 'side': SIDE[a['side']], 'text': a['text'], 'at': a.get('at', ''), 'by': 'gu'})
        return '记下了'
    if name == 'todo_done':
        post('/api/todos', {'action': 'done', 'side': SIDE[a['side']], 'id': a['id'], 'done': a.get('done', True)})
        return '划掉了' if a.get('done', True) else '恢复了'
    if name == 'cal_add':
        post('/api/cal', {'action': 'add_event', 'date': a['date'], 'text': a['text'], 'time': a.get('time', ''),
                          'yearly': bool(a.get('yearly')), 'special': bool(a.get('special'))})
        return f"记进日历了：{a['date']} {a['text']}"
    if name == 'cal_del':
        post('/api/cal', {'action': 'del_event', 'id': a['id']})
        return '删掉了'
    if name == 'cal_mood':
        post('/api/cal', {'action': 'set_mood', 'date': a['date'], 'mood': a['mood']})
        return f"记下了：{a['date']} {MOODS.get(a['mood'], a['mood'])}"
    if name == 'whisper_write':
        post('/api/whisper', {'text': a['text']})
        return '写好了'
    return f'未知工具：{name}'

def handle(req):
    method, params, rid = req.get('method', ''), req.get('params', {}), req.get('id')
    if method == 'initialize':
        return {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                                                       "serverInfo": {"name": "home-mcp", "version": "1.0"}}}
    if method == 'tools/list':
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method == 'tools/call':
        try:
            text = call_tool(params.get('name', ''), params.get('arguments', {}))
        except Exception as e:
            text = f'没成功：{e}'
        return {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}}
    if rid is None:
        return None
    if method == 'ping':
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown: {method}"}}

def main():
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
