#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(BASE, 'now_state.json')

SLOTS = ['focus', 'where', 'body', 'care', 'plan', 'mood', 'misc']
SLOT_LABEL = {
  'focus': '📌 惦记/待回访', 'where': '在哪', 'body': '身体',
  'care': '照护进度', 'plan': '今天安排', 'mood': '状态', 'misc': '其他',
}
DEFAULT_TTL = 24.0

def _load():
  if not os.path.exists(STATE):
    return {'slots': {}, 'counters': {}, 'goals': {}, 'history': []}
  with open(STATE, 'r', encoding='utf-8') as f:
    return json.load(f)

def _save(d):
  d['history'] = d.get('history', [])[-200:]
  with open(STATE + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
  os.replace(STATE + '.tmp', STATE)

def set_slot(slot, value, ttl_hours=DEFAULT_TTL):
  d = _load()
  now = datetime.now()
  exp = now + timedelta(hours=float(ttl_hours))
  old = d['slots'].get(slot)
  if old:
    d['history'].append({'slot': slot, **old, 'replaced_at': now.isoformat(timespec='seconds')})
  d['slots'][slot] = {
    'value': value,
    'updated_at': now.isoformat(timespec='seconds'),
    'expires_at': exp.isoformat(timespec='seconds'),
  }
  _save(d)

def bump_counter(name, delta=1):
  d = _load()
  today = datetime.now().strftime('%Y-%m-%d')
  bucket = d['counters'].setdefault(today, {})
  bucket[name] = bucket.get(name, 0) + int(delta)
  _save(d)
  return bucket[name]

def set_goal(name, target, unit=''):
  d = _load()
  d['goals'][name] = {'target': int(target), 'unit': unit}
  _save(d)

def format_for_surface():
  d = _load()
  now = datetime.now()
  lines = ['—— 当下黑板 (实时状态, 过期自动隐身) ——']
  for s in SLOTS:
    info = d['slots'].get(s)
    if not info: continue
    if datetime.fromisoformat(info['expires_at']) < now: continue
    mins = int((now - datetime.fromisoformat(info['updated_at'])).total_seconds() // 60)
    ago = f'{mins}分钟前' if mins < 60 else f'{mins // 60}小时前'
    lines.append(f"  [{SLOT_LABEL[s]}]{info['value']}  ({ago})")
  today = now.strftime('%Y-%m-%d')
  today_c = d.get('counters', {}).get(today, {})
  goals = d.get('goals', {})
  c_parts = []
  for k, g in goals.items():
    cur = today_c.get(k, 0)
    rem = max(0, g['target'] - cur)
    c_parts.append(f"{k}{cur}/{g['target']}{g['unit']}" + (f"(还差{rem}{g['unit']})" if rem else "已达标"))
  if c_parts:
    lines.append("  [今日计数] " + " | ".join(c_parts))
  return "\n".join(lines) if len(lines) > 1 else ""

if __name__ == '__main__':
  cmd = sys.argv[1] if len(sys.argv) > 1 else 'get'
  if cmd == 'set':
    set_slot(sys.argv[2], sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_TTL)
  elif cmd == 'bump':
    bump_counter(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
  elif cmd == 'goal':
    set_goal(sys.argv[2], int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else '')
  elif cmd == 'get':
    print(format_for_surface())
