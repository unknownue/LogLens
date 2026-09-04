#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify clientcfg.py output against res_dev source JSON for many tables."""
import sys, os, json, re
sys.path.insert(0, os.path.dirname(__file__))
from clientcfg import parse_client_cfg, load_slots, load_table_fields, load_json_tolerant

BIN_DIR = r"E:\Work\GM10\qa_branch\code\client_csharp\res\csharp\data\client_cfg\default"
SRC_DIR = r"E:\Work\GM10\qa_branch\code\client_csharp\res_dev\client_cfg_src"
SLOTS = os.path.join(SRC_DIR, "cfg_table_slots.json")

def norm(v):
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, float):
        return round(v, 4)
    return v

def main():
    slots = load_slots(SLOTS)
    define = slots["define"]
    tables = sys.argv[1:] or sorted(define.keys())
    total_diff = 0
    ok = fail = 0
    for name in tables:
        bin_path = os.path.join(BIN_DIR, name + ".bin")
        src_path = os.path.join(SRC_DIR, name + ".json")
        if not os.path.exists(bin_path) or not os.path.exists(src_path):
            print(f"SKIP {name} (missing bin or src)")
            continue
        fields = load_table_fields(slots, name)
        try:
            t = parse_client_cfg(open(bin_path, "rb").read(), name, fields)
        except Exception as e:
            print(f"FAIL {name}: parse error: {e}")
            fail += 1
            continue
        raw = open(src_path, encoding="utf-8").read()
        src = load_json_tolerant(src_path)
        # src is dict keyed by row key
        diffs = 0
        if len(t.keys) != len(src):
            print(f"DIFF {name}: bin rows={len(t.keys)} src rows={len(src)}")
            diffs += 1
        for k, v in src.items():
            r = t.key_to_row.get(int(k))
            if r is None:
                diffs += 1
                continue
            for f, fv in v.items():
                bv = norm(r.get(f))
                sv = norm(fv)
                if isinstance(bv, float) and isinstance(sv, float):
                    bv, sv = round(bv, 4), round(sv, 4)
                if bv != sv:
                    diffs += 1
                    print(f"DIFF {name} key={k} {f}: bin={bv!r} src={sv!r}")
        if diffs == 0:
            ok += 1
            print(f"OK   {name}: {len(t.keys)} rows identical")
        else:
            fail += 1
            print(f"DIFF {name}: {diffs} field differences")
        total_diff += diffs
    print(f"\n== ok={ok} fail={fail} total_diff={total_diff}")

if __name__ == "__main__":
    main()
