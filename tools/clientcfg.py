#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""clientcfg.py — GM10 client_cfg .bin parser (schema-driven, reference implementation).

Bin format (verified against ClientCfgPacker.Core.CfgBinWriter + runtime
MemoryPackDeserializer.DeserializeCfgDictWithStringTable, MemoryPack 1.21.4):

    [int32 LE stringTableLen]
    [stringTable]          MemoryPack Utf16 string[] :
                           [int32 count] then per string
                           [int32 charLen][UTF-16LE chars]   (charLen == -1 -> null)
    [dataSegment]          ReadonlyDenseDictionary_V2<T> :
                           [byte objectHeader = 2]
                           [int32 keyCount][int32 key] * keyCount
                           [int32 rowCount] then rows;
                           row = [byte fieldCount] + fields in *sorted* schema order

Field encodings (CfgTypeNode.Write):
    string        -> int32 index into stringTable (-1 -> null)
    string[]      -> int32 count (-1 -> null), then int32 indexes
    dict<K,V>     -> int32 count, then (K, V) pairs (strings inline, not via table)
    set<T>        -> int32 count, then elements (inline strings)
    T[] (T scalar)-> int32 count, then unmanaged LE elements
    scalars       -> unmanaged LE (int/uint 4, long/ulong/double 8, short/ushort 2,
                    bool/byte/sbyte 1, float 4)

Field order in row = CfgFieldSorter.Sort (see tools/../doc):
    1. id first; 2. value types before references; 3. size desc;
    4. alignment desc; 5. type literal asc; 6. original declaration order.

The table schema lives in res_dev/client_cfg_src/cfg_table_slots.json:
    {"define": {"table_name": {"field": "type", ...}, ...},
     "untranslate": {...}, "translation_replace": {...}}
"""
import json
import re
import struct

SCALAR_SIZES = {
    "double": (8, "<d"), "long": (8, "<q"), "ulong": (8, "<Q"),
    "int": (4, "<i"), "uint": (4, "<I"), "float": (4, "<f"),
    "short": (2, "<h"), "ushort": (2, "<H"),
    "bool": (1, "<b"), "byte": (1, "<B"), "sbyte": (1, "<b"),
}
SCALARS = set(SCALAR_SIZES) | {"string"}
REFERENCE_KINDS = ("string",)  # everything else is value-type for sorting

_SIZE_LOOKUP = {**{k: v[0] for k, v in SCALAR_SIZES.items()}, "string": 8}


def _type_size(t):
    if t.endswith("[]"):
        return 8
    return _SIZE_LOOKUP.get(t, 8)


def _is_reference(t):
    return t == "string" or t.endswith("[]") or t.startswith("dict<") or t.startswith("set<")


def sort_fields(fields):
    """CfgFieldSorter.Sort equivalent. fields: list of (name, type)."""
    out = [(f, i) for i, f in enumerate(fields)]
    out.sort(key=lambda x: (
        0 if x[0][0] == "id" else 1,           # id first
        1 if _is_reference(x[0][1]) else 0,    # value types first
        -_type_size(x[0][1]),                  # size desc
        -min(_type_size(x[0][1]), 8),          # alignment desc (clamp 8)
        x[0][1],                               # type literal asc
        x[1],                                  # original order
    ))
    return [f for f, _ in out]


def _split_top_level(s):
    parts, depth, start = [], 0, 0
    for i, c in enumerate(s):
        if c == "<":
            depth += 1
        elif c == ">":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return parts


class TypeSpec:
    """Parsed field type: scalar / array / dict / set."""
    def __init__(self, text):
        self.text = text.strip()
        if self.text.endswith("[]"):
            self.kind = "array"
            self.elem = TypeSpec(self.text[:-2])
        elif self.text.startswith("dict<") and self.text.endswith(">"):
            args = _split_top_level(self.text[5:-1])
            self.kind = "dict"
            self.key = args[0].strip()
            self.value = TypeSpec(args[1].strip())
        elif self.text.startswith("set<") and self.text.endswith(">"):
            self.kind = "set"
            self.elem = self.text[4:-1].strip()
        else:
            self.kind = "scalar"
            self.scalar = self.text


class Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def i32(self):
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return v

    def byte(self):
        v = self.data[self.pos]
        self.pos += 1
        return v

    def scalar(self, scalar_type):
        size, fmt = SCALAR_SIZES[scalar_type]
        v = struct.unpack_from(fmt, self.data, self.pos)[0]
        self.pos += size
        return v

    def raw(self, n):
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v


class CfgTable:
    def __init__(self, name, fields, key_to_row=None):
        self.name = name
        self.fields = fields          # sorted [(name, TypeSpec)]
        self.key_to_row = key_to_row or {}
        self.keys = []

    def to_source_json(self):
        """Reconstruct the source-JSON shape: {key(int str): {field: value}}."""
        out = {}
        for k in self.keys:
            row = self.key_to_row[k]
            obj = {}
            for name, _ in self.fields:
                obj[name] = row[name]
            out[str(k)] = obj
        return out


def _read_value(r, spec, strings):
    if spec.kind == "scalar":
        if spec.scalar == "string":
            idx = r.i32()
            return None if idx < 0 else strings[idx]
        return r.scalar(spec.scalar)
    if spec.kind == "array":
        n = r.i32()
        if n < 0:
            return None
        return [_read_value(r, spec.elem, strings) for _ in range(n)]
    if spec.kind == "set":
        n = r.i32()
        if n < 0:
            return None
        items = []
        for _ in range(n):
            items.append(_read_value(r, TypeSpec(spec.elem), strings))
        return items
    if spec.kind == "dict":
        n = r.i32()
        if n < 0:
            return None
        key_spec = TypeSpec(spec.key)
        d = {}
        for _ in range(n):
            k = _read_value(r, key_spec, strings)
            v = _read_value(r, spec.value, strings)
            d[k] = v
        return d
    raise ValueError(spec.text)


def parse_client_cfg(data, table_name, fields):
    """fields: declaration-order [(name, type_str)]. Returns CfgTable."""
    # --- string table ---
    st_len = struct.unpack_from("<i", data, 0)[0]
    r = Reader(data[4:4 + st_len])
    n = r.i32()
    strings = []
    if n >= 0:
        for _ in range(n):
            l = r.i32()
            if l < 0:
                strings.append(None)
            else:
                strings.append(r.raw(l * 2).decode("utf-16-le", "replace"))
    if r.pos != len(r.data):
        raise ValueError(f"string table parsed {r.pos}/{len(r.data)} bytes")

    # --- data segment ---
    r = Reader(data[4 + st_len:])
    assert r.byte() == 2, "object header must be 2"
    nk = r.i32()
    keys = [r.i32() for _ in range(nk)]
    nr = r.i32()

    sorted_fields = [(name, TypeSpec(t)) for name, t in sort_fields(fields)]
    table = CfgTable(table_name, sorted_fields, {})
    table.keys = keys
    for i in range(nr):
        fc = r.byte()
        if fc != len(sorted_fields):
            raise ValueError(f"fieldCount={fc} != schema {len(sorted_fields)} at 0x{r.pos-1:X}")
        row = {}
        for name, spec in sorted_fields:
            row[name] = _read_value(r, spec, strings)
        table.key_to_row[keys[i]] = row
    if r.pos != len(r.data):
        raise ValueError(f"data segment parsed {r.pos}/{len(r.data)} bytes")
    return table


def _strip_json_extras(text):
    """Remove // line comments, trailing commas and escape raw control chars,
    while respecting string literals. Output is strict JSON."""
    out = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            if c == "\\":
                out.append(c)
                if i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
            elif c == '"':
                in_str = False
                out.append(c)
            elif ord(c) < 0x20:
                out.append("\\u%04x" % ord(c))
            else:
                out.append(c)
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        elif c == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                i = j  # drop comma, keep closer
                continue
            out.append(c)
        else:
            out.append(c)
        i += 1
    return "".join(out)


def load_json_tolerant(path):
    return json.loads(_strip_json_extras(open(path, encoding="utf-8").read()))


def load_slots(path):
    return load_json_tolerant(path)


def load_table_fields(slots, table_name):
    for section in ("define",):
        if table_name in slots.get(section, {}):
            return list(slots[section][table_name].items())
    return None


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("bin")
    ap.add_argument("--slots", help="path to cfg_table_slots.json")
    ap.add_argument("--table", help="table name (default: derive from bin filename)")
    ap.add_argument("--out", help="write parsed JSON here (else print to stdout)")
    ap.add_argument("--fields", help="comma list name:type (fallback if no slots)")
    args = ap.parse_args()

    data = open(args.bin, "rb").read()
    name = args.table or re.sub(r"\.bin$", "", args.bin.rsplit("/", 1)[-1].rsplit("\\", 1)[-1])
    fields = None
    if args.fields:
        fields = [(p.split(":", 1)[0], p.split(":", 1)[1]) for p in args.fields.split(",")]
    elif args.slots:
        slots = load_slots(args.slots)
        fields = load_table_fields(slots, name)
        if fields is None:
            print(f"table '{name}' not found in {args.slots}", file=__import__("sys").stderr)
            raise SystemExit(2)
    else:
        print("need --slots or --fields", file=__import__("sys").stderr)
        raise SystemExit(2)

    table = parse_client_cfg(data, name, fields)
    out = json.dumps(table.to_source_json(), ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(out)
        print(f"wrote {args.out}: {len(table.key_to_row)} rows")
    else:
        print(out)
