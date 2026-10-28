#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简 MCP stdio server，暴露 now.py 和 pantry.py 的工具给克克调用。"""
import json, sys, subprocess, os

BASE = os.path.dirname(os.path.abspath(__file__))
NOW = os.path.join(BASE, 'now.py')
PANTRY = os.path.join(BASE, 'pantry.py')

TOOLS = [
    {
        'name': 'now_get',
        'description': '读取月月的当下黑板（在哪/身体/照护/待回访/心情/今天安排），每轮回复前可主动调用确认状态',
        'inputSchema': {'type': 'object', 'properties': {}}
    },
    {
        'name': 'now_set',
        'description': '更新月月的某个实时状态槽位（带TTL自动过期）。slot: where/body/care/focus/mood/plan/misc',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'slot': {'type': 'string', 'enum': ['where', 'body', 'care', 'focus', 'mood', 'plan', 'misc']},
                'value': {'type': 'string'},
                'ttl_hours': {'type': 'number', 'description': '有效小时数，默认24'}
            },
            'required': ['slot', 'value']
        }
    },
    {
        'name': 'now_bump',
        'description': '给今日计数器加数（如喝水杯数 water）',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': '计数器名，如 water'},
                'delta': {'type': 'integer', 'description': '增量，默认1'}
            },
            'required': ['name']
        }
    },
    {
        'name': 'pantry_get',
        'description': '读取小窝百宝箱（家里的药品/零食库存）',
        'inputSchema': {'type': 'object', 'properties': {}}
    },
    {
        'name': 'pantry_set',
        'description': '更新小窝某物品库存',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'qty': {'type': 'string', 'description': '数量（数字 或 有货/快没了）'},
                'unit': {'type': 'string'},
                'cat': {'type': 'string', 'description': '分类，如 药品/零食'},
                'loc': {'type': 'string', 'description': '存放位置'},
                'low': {'type': 'integer', 'description': '低库存警戒线，默认2'}
            },
            'required': ['name', 'qty']
        }
    },
    {
        'name': 'pantry_use',
        'description': '从百宝箱消耗某物品（扣减库存）',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'delta': {'type': 'integer', 'description': '使用数量，默认1'}
            },
            'required': ['name']
        }
    }
]

def run(py, args):
    r = subprocess.run([sys.executable, py] + [str(a) for a in args],
                       capture_output=True, text=True, cwd=BASE, timeout=10)
    return (r.stdout.strip() or r.stderr.strip() or 'ok')

def call_tool(name, args):
    if name == 'now_get':
        return run(NOW, ['get'])
    if name == 'now_set':
        return run(NOW, ['set', args['slot'], args['value'], args.get('ttl_hours', 24)])
    if name == 'now_bump':
        return run(NOW, ['bump', args['name'], args.get('delta', 1)])
    if name == 'pantry_get':
        return run(PANTRY, ['list'])
    if name == 'pantry_set':
        cmd = ['set', args['name'], str(args['qty'])]
        if args.get('unit'): cmd += [args['unit']]
        if args.get('cat'): cmd += ['--cat', args['cat']]
        if args.get('loc'): cmd += ['--loc', args['loc']]
        if args.get('low') is not None: cmd += ['--low', str(args['low'])]
        return run(PANTRY, cmd)
    if name == 'pantry_use':
        return run(PANTRY, ['use', args['name'], args.get('delta', 1)])
    return 'unknown tool'

def respond(id_, result=None, error=None):
    r = {'jsonrpc': '2.0', 'id': id_}
    if error: r['error'] = error
    else: r['result'] = result
    print(json.dumps(r, ensure_ascii=False), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
        id_ = req.get('id')
        method = req.get('method', '')
        params = req.get('params', {})
        if method == 'initialize':
            respond(id_, {
                'protocolVersion': '2024-11-05',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'kk-now', 'version': '1.0'}
            })
        elif method in ('notifications/initialized', 'ping'):
            if id_ is not None: respond(id_, {})
        elif method == 'tools/list':
            respond(id_, {'tools': TOOLS})
        elif method == 'tools/call':
            text = call_tool(params.get('name', ''), params.get('arguments', {}))
            respond(id_, {'content': [{'type': 'text', 'text': text}]})
        elif id_ is not None:
            respond(id_, {})
    except Exception as e:
        try: respond(req.get('id'), error={'code': -32603, 'message': str(e)})
        except: pass
