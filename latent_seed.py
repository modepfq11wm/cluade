#!/usr/bin/env python3
"""把 CLAUDE.md 按段落写入 latent corpus，顺便清掉旧index让它重建"""
import json, os, re, shutil, subprocess, sys

PERSONA  = os.path.expanduser('~/latent-data/CLAUDE.md')
CORPUS   = os.path.expanduser('~/latent-data/memory')
INDEX    = os.path.join(CORPUS, 'index')
THREADS  = os.path.expanduser('~/latent-data/threads.jsonl')

MCP_CMD = [
    '/usr/bin/python3',
    '/home/ubuntu/Latent-memory/src/mcp_server.py',
    '--corpus', CORPUS,
    '--index-dir', INDEX,
    '--threads', THREADS,
    '--timezone', 'Asia/Shanghai',
]

def split_persona(text):
    parts = re.split(r'\n(?=## )', text)
    return [p.strip() for p in parts if p.strip()]

def mcp(proc, method, params=None, req_id=1):
    msg = json.dumps({'jsonrpc':'2.0','id':req_id,'method':method,'params':params or {}}) + '\n'
    proc.stdin.write(msg.encode())
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())

def try_via_mcp(chunks):
    proc = subprocess.Popen(MCP_CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        init_resp = mcp(proc, 'initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'latent-seed', 'version': '1.0'}
        })
        # discover tool name
        tools_resp = mcp(proc, 'tools/list', {}, req_id=99)
        tool_names = [t['name'] for t in tools_resp.get('result', {}).get('tools', [])]
        print('可用工具:', tool_names)
        save_tool = next((n for n in tool_names if 'save' in n or 'memory' in n.lower() or 'store' in n), None)
        if not save_tool:
            print('没找到 save 工具，改用直接写文件')
            proc.stdin.close(); proc.wait()
            return False
        for i, chunk in enumerate(chunks):
            header = chunk.split('\n')[0][:40]
            r = mcp(proc, 'tools/call', {'name': save_tool, 'arguments': {'content': chunk}}, req_id=i+2)
            print(f'  [{i+1}/{len(chunks)}] {header}')
        proc.stdin.close(); proc.wait()
        return True
    except Exception as e:
        print(f'MCP 调用出错: {e}，改用直接写文件')
        try: proc.stdin.close(); proc.wait(timeout=2)
        except: proc.kill()
        return False

def write_directly(chunks):
    os.makedirs(CORPUS, exist_ok=True)
    # 删掉旧的 seed 文件
    for f in os.listdir(CORPUS):
        if f.startswith('seed_') and f.endswith('.txt'):
            os.remove(os.path.join(CORPUS, f))
    for i, chunk in enumerate(chunks):
        header = chunk.split('\n')[0][:40]
        fpath = os.path.join(CORPUS, f'seed_{i:02d}.txt')
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(chunk)
        print(f'  [{i+1}/{len(chunks)}] {header}')
    # 删index让它重建
    if os.path.exists(INDEX):
        shutil.rmtree(INDEX)
        print('旧 index 已清除，下次启动自动重建')

def main():
    if not os.path.exists(PERSONA):
        print(f'找不到 {PERSONA}，先跑 latent init 生成 CLAUDE.md')
        sys.exit(1)
    with open(PERSONA, encoding='utf-8') as f:
        text = f.read()
    chunks = split_persona(text)
    print(f'切出 {len(chunks)} 个记忆块，开始写入...')
    if not try_via_mcp(chunks):
        write_directly(chunks)
    print('完成 (≧ω≦)')

if __name__ == '__main__':
    main()
