#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(BASE, 'pantry_state.json')

def _load():
  if not os.path.exists(STATE): return {'items': {}}
  with open(STATE, 'r', encoding='utf-8') as f: return json.load(f)

def _save(d):
  with open(STATE + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
  os.replace(STATE + '.tmp', STATE)

def set_item(name, qty, unit='', loc='', cat='其他', exp='', low=2):
  d = _load()
  is_num = str(qty).isdigit()
  d['items'][name] = {
    'qty': int(qty) if is_num else str(qty),
    'unit': unit, 'loc': loc, 'cat': cat, 'exp': exp, 'low': int(low),
    'updated_at': datetime.now().strftime('%Y-%m-%d %H:%M')
  }
  _save(d)

def use_item(name, delta=1):
  d = _load()
  it = d['items'].get(name)
  if not it: return
  if isinstance(it['qty'], int):
    it['qty'] = max(0, it['qty'] - int(delta))
  elif it['qty'] == '有货':
    it['qty'] = '快没了'
  _save(d)

def format_for_surface():
  d = _load()
  items = d.get('items', {})
  if not items: return ''
  by_cat, warns = {}, []
  for name, it in items.items():
    q = f"{it['qty']}{it.get('unit','')}"
    loc = f"@{it['loc']}" if it.get('loc') else ""
    by_cat.setdefault(it.get('cat', '其他'), []).append(f"{name}:{q}{loc}")
    if (isinstance(it['qty'], int) and it['qty'] <= it.get('low', 2)) or it['qty'] in ('快没了', '没了', 0):
      warns.append(f"⚠️【余量告警】{name} 状态为「{it['qty']}」，记得提醒补货")
  summary = "  ".join(f"[{c}: {' | '.join(v)}]" for c, v in by_cat.items())
  out = ["——🏠 小窝百宝箱（顺嘴自动记）——", f"  {summary}"]
  out.extend(f"  {w}" for w in warns)
  return "\n".join(out)

if __name__ == '__main__':
  cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
  if cmd == 'set':
    name, qty = sys.argv[2], sys.argv[3]
    unit = sys.argv[4] if len(sys.argv) > 4 and not sys.argv[4].startswith('--') else ''
    args = sys.argv[4:]
    loc = args[args.index('--loc')+1] if '--loc' in args else ''
    cat = args[args.index('--cat')+1] if '--cat' in args else '其他'
    exp = args[args.index('--exp')+1] if '--exp' in args else ''
    low = int(args[args.index('--low')+1]) if '--low' in args else 2
    set_item(name, qty, unit, loc, cat, exp, low)
  elif cmd == 'use':
    use_item(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
  else:
    print(format_for_surface())
