"""v0.90 index diet proof: replay every query the E2E run sent and show which indexes they need.

  uv run python hub/e2e/index_audit.py --db postgresql://postgres@127.0.0.1:55432/rotor_e2e \
      --log hub/e2e/.out/pg.log --out hub/e2e/.out/index-audit.json --drop hub.day_track_artist …

Run by `E2E_LOG_STATEMENTS=1 E2E_INDEX_AUDIT=<indexes> E2E_MAX_MIGRATION=31 npm run e2e` (THROWAWAY DB only:
refuses anything but localhost). The E2E run logs every statement the hub and the Python jobs send
(log_statement = all, switched on after the seed + migrations). This script then, per distinct query:

  1. BEGIN; SET LOCAL enable_seqscan = off; auto_explain at NOTICE level with nested statements
     (so the SQL inside hub.home_payload(), hub.wrapped_payload(), custom_playlist_preview() … is
     planned and reported too); run the query with its logged parameters; ROLLBACK.
     With sequential scans priced out, the planner takes ANY index that can serve the query, so an
     index that no plan picks here is not usable by any of these queries, whatever the data size.
  2. The same again after `DROP INDEX <candidates>` inside the transaction (rolled back).
  3. Verdict per dropped index: every statement that used it in (1) must, in (2), still reach that
     table through another index: no Seq Scan on it that wasn't already in (1) (a full rollup rebuild
     reads the whole table either way). Any new fallback → exit code 1.

It also lists prefix-redundant index pairs (pg_index) and each index's size on the seeded DB.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import psycopg

LINE = re.compile(r"^\d{4}-\d\d-\d\d [\d:.]+ \w+ \[(\d+)\] (\w+):  (.*)$")
PARAM = re.compile(r"\$(\d+) = (NULL|'(?:[^']|'')*')(?:, |$)")
REPLAYABLE = re.compile(r"^\s*\(?\s*(SELECT|WITH|UPDATE|DELETE|INSERT)\b", re.I)
SKIP = re.compile(r"pg_reload_conf|ALTER SYSTEM|pg_advisory|pg_notify|pg_sleep|set_config|current_setting\('rotor", re.I)


def parse_log(path: Path) -> list[tuple[str, dict[int, str]]]:
    """(sql, {n: literal}) for every logged statement/execute, in order."""
    entries: list[list] = []  # [pid, level, message]
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = LINE.match(raw)
        if m:
            entries.append([m.group(1), m.group(2), m.group(3)])
        elif raw.startswith("\t") and entries:
            entries[-1][2] += "\n" + raw[1:]
    out: list[tuple[str, dict[int, str]]] = []
    last_by_pid: dict[str, int] = {}
    for pid, level, msg in entries:
        if level == "LOG":
            m = re.match(r"^(?:statement|execute [^:]*): (.*)$", msg, re.S)
            if m:
                out.append((m.group(1), {}))
                last_by_pid[pid] = len(out) - 1
        elif level == "DETAIL" and msg.startswith("Parameters: ") and pid in last_by_pid:
            params = {int(n): v for n, v in PARAM.findall(msg[len("Parameters: "):])}
            out[last_by_pid[pid]] = (out[last_by_pid[pid]][0], params)
    return out


def bind(sql: str, params: dict[int, str]) -> str | None:
    for n in sorted(params, reverse=True):
        sql = re.sub(rf"\${n}(?!\d)", lambda _m, v=params[n]: v, sql)
    return None if re.search(r"\$\d+", sql) else sql


def norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def walk(plan: dict, seen: dict[str, set], node_rel: list):
    node = plan.get("Plan", plan)
    rel = node.get("Relation Name")
    schema = node.get("Schema")
    q = f"{schema}.{rel}" if rel and schema else rel
    if node.get("Index Name"):
        seen["index"].add(node["Index Name"])
        if q:
            seen["index_rel"].add(q)
    if node.get("Node Type") == "Seq Scan" and q:
        seen["seq"].add(q)
    for child in node.get("Plans", []) or []:
        walk(child, seen, node_rel)


def replay(conn, sql: str, drops: list[str]) -> dict:
    notices: list[str] = []
    handler = lambda d: notices.append(d.message_primary or "")  # noqa: E731
    conn.add_notice_handler(handler)
    seen: dict[str, set] = {"index": set(), "index_rel": set(), "seq": set()}
    err = None
    try:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL statement_timeout = '20s'")
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("LOAD 'auto_explain'")
            for s in ("auto_explain.log_min_duration = 0", "auto_explain.log_nested_statements = on",
                      "auto_explain.log_level = notice", "auto_explain.log_format = json", "auto_explain.log_verbose = on"):
                cur.execute(f"SET LOCAL {s}")
            for ix in drops:
                cur.execute(f"DROP INDEX IF EXISTS {ix}")
            notices.clear()
            cur.execute(sql)
    except Exception as e:  # noqa: BLE001 — record and move on (rolled back below)
        err = f"{type(e).__name__}: {str(e).splitlines()[0][:200]}"
    finally:
        conn.rollback()
        conn.remove_notice_handler(handler)
    for n in notices:
        i = n.find("{")
        if "plan:" not in n or i < 0:
            continue
        try:
            walk(json.loads(n[i:]), seen, [])
        except json.JSONDecodeError:
            continue
    return {"error": err, "index": sorted(seen["index"]), "seq": sorted(seen["seq"]), "plans": len(notices)}


def table_of(conn, qualified: str) -> str:
    with conn.cursor() as cur:
        cur.execute("""SELECT n.nspname || '.' || t.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                       JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                       WHERE c.oid = to_regclass(%s)""", (qualified,))
        r = cur.fetchone()
        return r[0] if r else "?"


def inventory(conn) -> tuple[list[dict], list[dict]]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT n.nspname, c.relname, t.relname, i.indisunique OR i.indisprimary, pg_relation_size(c.oid),
                   i.indkey::text, coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), ''),
                   am.amname, pg_get_indexdef(c.oid)
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = c.relam
            WHERE n.nspname IN ('public', 'hub') ORDER BY 1, 3, 2""")
        rows = [dict(zip(["schema", "index", "table", "unique", "bytes", "keys", "exprs", "pred", "am", "def"], r)) for r in cur.fetchall()]
    redundant = []
    for a in rows:
        for b in rows:
            if a is b or a["table"] != b["table"] or a["schema"] != b["schema"] or a["unique"] or a["am"] != "btree" or b["am"] != "btree":
                continue
            ka, kb = a["keys"].split(), b["keys"].split()
            if len(ka) < len(kb) and kb[: len(ka)] == ka and a["pred"] == b["pred"] and not a["exprs"] and "0" not in ka:
                redundant.append({"index": f"{a['schema']}.{a['index']}", "covered_by": f"{b['schema']}.{b['index']}",
                                  "bytes": a["bytes"], "def": a["def"], "covered_def": b["def"]})
    return rows, redundant


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--log", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--drop", action="append", default=[])
    ap.add_argument("--max-variants", type=int, default=2)
    args = ap.parse_args()
    if not re.search(r"@(127\.0\.0\.1|localhost)[:/]", args.db):
        sys.exit("refusing: --db must be the local throwaway E2E database")

    logged = parse_log(args.log)
    distinct: dict[str, list[str]] = defaultdict(list)
    for sql, params in logged:
        if not REPLAYABLE.match(sql) or SKIP.search(sql):
            continue
        bound = bind(sql, params)
        if bound is None:
            continue
        k = norm(sql)
        if len(distinct[k]) < args.max_variants and bound not in distinct[k]:
            distinct[k].append(bound)
    stmts = [(k, v) for k, vs in distinct.items() for v in vs]

    conn = psycopg.connect(args.db, autocommit=False)
    rows, redundant = inventory(conn)
    drops = args.drop
    drop_tables = {ix: table_of(conn, ix) for ix in drops}
    base_by_index: dict[str, list[int]] = defaultdict(list)
    results = []
    errors = 0
    for i, (k, sql) in enumerate(stmts):
        before = replay(conn, sql, [])
        after = replay(conn, sql, drops) if drops else None
        if before["error"]:
            errors += 1
        for ix in before["index"]:
            base_by_index[ix].append(i)
        results.append({"i": i, "sql": k[:400], "before": before, "after": after})

    verdicts = []
    failed = False
    for ix in drops:
        short = ix.split(".")[-1]
        users = base_by_index.get(short, [])
        tbl = drop_tables[ix]
        fallbacks = []
        alternatives: dict[str, int] = defaultdict(int)
        for i in users:
            a = results[i]["after"]
            if a["error"] and not results[i]["before"]["error"]:
                fallbacks.append({"i": i, "why": a["error"], "sql": results[i]["sql"]})
                continue
            # A NEW seq scan on the table. Some statements (hub.refresh_rollups(true): a full rebuild)
            # read the whole table in the baseline already; that is not caused by the drop.
            if tbl in a["seq"] and tbl not in results[i]["before"]["seq"]:
                fallbacks.append({"i": i, "why": f"new Seq Scan on {tbl}", "sql": results[i]["sql"]})
            for other in a["index"]:
                alternatives[other] += 1
        size = next((r["bytes"] for r in rows if f"{r['schema']}.{r['index']}" == ix), None)
        failed |= bool(fallbacks)
        verdicts.append({"index": ix, "table": tbl, "bytes_on_e2e_db": size, "statements_using_it": len(users),
                         "fallbacks_to_seq_scan": fallbacks, "served_instead_by": dict(alternatives),
                         "verdict": "SAFE" if not fallbacks else "NEEDED"})

    used = set(base_by_index)
    with conn.cursor() as cur:  # for extrapolating to production: each dropped index as a share of its table
        cur.execute("""SELECT n.nspname || '.' || c.relname, pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid)
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.relkind = 'r' AND n.nspname IN ('public', 'hub')""")
        tables = {r[0]: {"total": r[1], "heap": r[2], "indexes": r[3]} for r in cur.fetchall()}
    for v in verdicts:
        t = tables.get(v["table"])
        if t and v["bytes_on_e2e_db"]:
            v["share_of_table_total"] = round(v["bytes_on_e2e_db"] / t["total"], 4)
            v["table_bytes_on_e2e_db"] = t
    report = {
        "logged_statements": len(logged),
        "distinct_replayed": len(stmts),
        "replay_errors": errors,
        "drops": verdicts,
        "prefix_redundant": redundant,
        "never_used_with_seqscan_off": [f"{r['schema']}.{r['index']}" for r in rows if r["index"] not in used and not r["unique"]],
        "index_use_counts": {f"{r['schema']}.{r['index']}": len(base_by_index.get(r["index"], [])) for r in rows},
        "index_bytes_on_e2e_db": {f"{r['schema']}.{r['index']}": r["bytes"] for r in rows},
        "table_bytes_on_e2e_db": tables,
        "statements": results,
    }
    args.out.write_text(json.dumps(report, indent=1, default=str))
    print(f"[index-audit] {len(logged)} logged, {len(stmts)} distinct replayed ({errors} errored), report → {args.out}")
    for v in verdicts:
        print(f"[index-audit] {v['verdict']:6} {v['index']} ({v['table']}): used by {v['statements_using_it']} statements, "
              f"{len(v['fallbacks_to_seq_scan'])} fall back to a seq scan; served instead by {v['served_instead_by']}")
    for r in redundant:
        print(f"[index-audit] prefix-redundant: {r['index']} ⊂ {r['covered_by']}")
    print(f"[index-audit] never used (seqscan off), non-unique: {', '.join(report['never_used_with_seqscan_off']) or '—'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
