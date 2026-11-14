"""An independent implementation of the CDM canonical form, in Python (03 §2; CDM-011).

It shares no code with the TypeScript implementation: it reads the defaults and the mark order
from the published ProseMirror schema (spec/cdm/cdm-1.prosemirror.json) and applies the rules of
03 §2 and ADR 0018 to every fixture input. It prints, for each case, whether its bytes and its
SHA-256 equal the expected ones.

Usage: python -I canonical.py <cdm-1.prosemirror.json> <fixtures/canonical/index.json>
"""
import hashlib
import json
import os
import sys


def utf16(s):
    """Sort key: UTF-16 code units, as RFC 8785 requires."""
    return s.encode("utf-16-be")


def jcs(value):
    """RFC 8785 serialisation of I-JSON whose numbers are all integers."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise ValueError("the CDM has no floating-point numbers")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(value[k]) for k in keys) + "}"
    raise TypeError("not JSON: %r" % (value,))


class Schema:
    def __init__(self, spec):
        self.node_attrs = {name: s.get("attrs", {}) for name, s in spec["nodes"]}
        self.mark_attrs = {name: s.get("attrs", {}) for name, s in spec["marks"]}
        self.mark_rank = {name: i for i, (name, _) in enumerate(spec["marks"])}


def strip_defaults(attrs, spec):
    if not attrs:
        return None
    out = {}
    for key, value in attrs.items():
        a = spec.get(key)
        if a is not None and jcs(value) == jcs(a.get("default")):
            continue
        out[key] = value
    return out or None


def canonical_marks(marks, schema):
    if not marks:
        return None
    keyed = []
    for m in marks:
        attrs = strip_defaults(m.get("attrs"), schema.mark_attrs.get(m["type"], {}))
        mark = {"type": m["type"]}
        if attrs:
            mark["attrs"] = attrs
        rank = schema.mark_rank.get(m["type"], 2**53)
        keyed.append((rank, utf16(jcs(attrs or {})), utf16(m["type"]), mark))
    keyed.sort(key=lambda k: (k[0], k[1], k[2]))
    return [k[3] for k in keyed]


def marks_key(marks):
    return jcs(marks) if marks else "[]"


def canonical_node(node, schema):
    out = {"type": node["type"]}
    if node["type"] == "text":
        out["text"] = node.get("text", "")
        marks = canonical_marks(node.get("marks"), schema)
        if marks:
            out["marks"] = marks
        return out
    attrs = strip_defaults(node.get("attrs"), schema.node_attrs.get(node["type"], {}))
    if attrs:
        out["attrs"] = attrs
    merged = []
    for child in node.get("content") or []:
        c = canonical_node(child, schema)
        if c["type"] == "text":
            if not c["text"]:
                continue
            prev = merged[-1] if merged else None
            if prev is not None and prev["type"] == "text" and marks_key(prev.get("marks")) == marks_key(c.get("marks")):
                prev["text"] += c["text"]
                continue
        merged.append(c)
    if merged:
        out["content"] = merged
    marks = canonical_marks(node.get("marks"), schema)
    if marks:
        out["marks"] = marks
    return out


def canonical_envelope(env, schema):
    return {
        "cdm": env["cdm"],
        "requires": sorted(set(env["requires"]), key=utf16),
        "doc": canonical_node(env["doc"], schema),
    }


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        schema = Schema(json.load(f))
    index_path = sys.argv[2]
    base = os.path.dirname(index_path)
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)
    results = {}
    for case in index["cases"]:
        with open(os.path.join(base, case["input"]), encoding="utf-8") as f:
            value = json.load(f)
        if case["kind"] == "envelope":
            text = jcs(canonical_envelope(value, schema))
        else:
            text = jcs(canonical_node(value, schema))
        data = text.encode("utf-8")
        with open(os.path.join(base, case["expected"]), "rb") as f:
            expected = f.read()
        results[case["name"]] = {
            "bytes": data == expected,
            "sha256": hashlib.sha256(data).hexdigest() == case["sha256"],
        }
    print(json.dumps(results))


if __name__ == "__main__":
    main()
