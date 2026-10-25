#!/usr/bin/env python3
"""A/B test: same tasks with headless Claude Code, without (A) and with (B) the kit (CLAUDE.md and skills) or the trim-token plugin.
Usage: abrun.py <output.jsonl> <tasks,...|all> <reps> [--arms A,B] [--workers N]
Each run happens in a clean copy of the test repository; grading is automatic.
The task prompts and the generated repository are in Portuguese, as they were when the results were measured.
"""
import concurrent.futures as cf
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time

AB = os.environ.get("AB_HOME", os.path.expanduser("~/ab"))
TEMPLATE = f"{AB}/template"
KITHOME = f"{AB}/kithome/.claude"
PLUGIN_DIR = os.environ.get("TRIMTOKEN_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNS = f"{AB}/runs"
NOISE = ["node_modules", ".venv"]
MODEL = "claude-sonnet-5-5"
MAX_TURNS = "60"
TIMEOUT_S = 1500
UNITTEST = ["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-t", "."]

TASKS = {
    "qa": "Preciso de dois valores de configuração deste repositório: (1) a janela de tolerância, em dias, que a "
          "reconciliação usa para casar um lançamento do banco com um do razão; (2) o modo de arredondamento padrão "
          "das conversões de câmbio. Para cada um, diga o valor e o arquivo:linha onde é definido. Não altere nada.",
    "bugfix": "A suíte de testes (`python -m unittest discover -s tests -t .`) está falhando. Encontre a causa raiz e "
              "corrija o código de produção, sem alterar os testes. No fim, rode a suíte e confirme que passa.",
    "feature": "Adicione ao relatório mensal (ledgerkit/reports/monthly.py) a função `render_monthly_csv(summary)`, que "
               "devolve CSV com o cabeçalho `month,category,total` e uma linha por par (mês, categoria), ordenadas por mês "
               "e depois por categoria, com o total em duas casas decimais (ponto decimal, sem separador de milhar). "
               "Adicione um teste em tests/test_reports.py e rode a suíte.",
    "triage": "O job de CI de 20/10 falhou; o log completo está em logs/ci-2026-10-20.log. Diga qual etapa falhou, qual "
              "teste e qual a mensagem de erro exata, e aponte o arquivo:linha do código onde o erro nasce. Não corrija nada.",
    "inventory": "Liste todas as classes de regra de categorização do pacote ledgerkit — subclasses diretas ou indiretas "
                 "de BaseRule — com o arquivo de cada uma. Não altere nada.",
    "audit": "Os leitores de extrato em ledgerkit/legacy/reconcile.py (funções parse_line_<banco>) não têm todos "
             "teste. Confira cada leitor contra a própria docstring e liste os que divergem dela, dizendo qual é a "
             "divergência em cada um. Não corrija nada.",
    "logdiff": "Compare os logs de CI de 19/10 e 20/10 (pasta logs/) e diga o que mudou entre as duas execuções: etapas, "
               "testes e erros. Não altere nada.",
    "rename": "Renomeie a função `_norm_desc` para `normalize_description` em todo o pacote ledgerkit e nos testes, "
              "inclusive todas as chamadas, sem deixar alias com o nome antigo. Rode a suíte no fim.",
}

PLANTED = ["neon", "xp", "stone"]
PLANTS = [
    ('when = datetime.strptime(cols[0], "%Y-%m-%d").date()\n    desc = _norm_desc(cols[1])\n    value = _to_decimal(cols[2], decimal_comma=True)\n    if not desc:\n        raise ReconcileError("linha neon',
     'when = datetime.strptime(cols[0], "%d-%m-%Y").date()\n    desc = _norm_desc(cols[1])\n    value = _to_decimal(cols[2], decimal_comma=True)\n    if not desc:\n        raise ReconcileError("linha neon'),
    ('value = _to_decimal(cols[2], decimal_comma=False)\n    flag = cols[3].upper()\n    if flag not in ("D", "C"):\n        raise ReconcileError("linha xp',
     'value = _to_decimal(cols[2], decimal_comma=True)\n    flag = cols[3].upper()\n    if flag not in ("D", "C"):\n        raise ReconcileError("linha xp'),
    ('desc = _norm_desc(cols[0])\n    value = _to_decimal(cols[2], decimal_comma=True)\n    if not desc:\n        raise ReconcileError("linha stone',
     'desc = _norm_desc(cols[2])\n    value = _to_decimal(cols[2], decimal_comma=True)\n    if not desc:\n        raise ReconcileError("linha stone'),
]
ALL_BANKS = None  # filled in by grade from BANK_PARSERS

RULE_CLASSES = ["RegexRule", "KeywordRule", "MerchantRule", "AmountRangeRule", "LargeExpenseRule", "RecurringRule",
                "AllOfRule", "AnyOfRule", "NotRule", "LegacyCategoryRule"]


def sh(cmd, cwd, **kw):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, **kw)


def tree_hash(d, sub):
    h = hashlib.sha1()
    for root, _, files in sorted(os.walk(os.path.join(d, sub))):
        if "__pycache__" in root:
            continue
        for f in sorted(files):
            p = os.path.join(root, f)
            h.update(p[len(d):].encode())
            h.update(open(p, "rb").read())
    return h.hexdigest()


def prepare(task, arm, rep):
    d = f"{RUNS}/{task}-{arm}-{rep}"
    if os.path.exists(d):
        shutil.rmtree(d)
    shutil.copytree(TEMPLATE, d, ignore=shutil.ignore_patterns(*NOISE, "__pycache__"))
    for n in NOISE:  # noise: hardlinks (nobody should edit them)
        sh(["cp", "-al", f"{TEMPLATE}/{n}", f"{d}/{n}"], AB)
    if task == "bugfix":
        p = f"{d}/ledgerkit/money.py"
        s = open(p).read()
        s2 = s.replace("parts = [cents * r // total for r in ratios]", "parts = [round(cents * r / total) for r in ratios]")
        assert s2 != s
        open(p, "w").write(s2)
    if task == "audit":
        p = f"{d}/ledgerkit/legacy/reconcile.py"
        s = open(p).read()
        for old, new in PLANTS:
            assert s.count(old) == 1, old
            s = s.replace(old, new)
        open(p, "w").write(s)
        t = f"{d}/tests/test_reconcile.py"
        ts = open(t).read()
        for bank in PLANTED:
            ts = re.sub(rf"    def test_{bank}\(self\):\n(?:        .*\n)+", "", ts)
        open(t, "w").write(ts)
    for c in (["git", "init", "-q"], ["git", "add", "-A"],
              ["git", "-c", "user.name=dev", "-c", "user.email=dev@x", "commit", "-qm", "estado inicial"]):
        sh(c, d)
    if arm == "B":
        os.makedirs(f"{d}/.claude", exist_ok=True)
        settings = json.load(open(f"{KITHOME}/settings.json"))
        json.dump({"hooks": settings["hooks"]}, open(f"{d}/.claude/settings.json", "w"), indent=1)
        shutil.copytree(f"{KITHOME}/agents", f"{d}/.claude/agents")
        shutil.copytree(f"{KITHOME}/skills", f"{d}/.claude/skills")
        shutil.copy(f"{AB}/kithome/CLAUDE.md", f"{d}/CLAUDE.md")
    return d


def clean_env(tag):
    keep = ["PATH", "HOME", "HTTPS_PROXY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "LANG",
            "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update({"IS_SANDBOX": "1",
                "DISABLE_AUTOUPDATER": "1"})
    return env


def grade(task, d, text, tests_hash0):
    text = text or ""
    suite = sh(UNITTEST, d)
    suite_ok = suite.returncode == 0 and "OK" in suite.stderr
    tracked_diff = sh(["git", "diff", "--name-only"], d).stdout.split()
    if task == "qa":
        ok = bool(re.search(r"\b6\b", text)) and "ROUND_HALF_EVEN" in text and "reconcile.py" in text and "fx.py" in text
        return ok and not tracked_diff, {"noedit": not tracked_diff}
    if task == "bugfix":
        same_tests = tree_hash(d, "tests") == tests_hash0
        return suite_ok and same_tests, {"suite": suite_ok, "tests_untouched": same_tests}
    if task == "feature":
        hidden = (
            "import sys; sys.path.insert(0, '.')\n"
            "from datetime import date\nfrom ledgerkit.money import Money\nfrom ledgerkit.transactions import Transaction\n"
            "from ledgerkit.reports.monthly import summarize, render_monthly_csv\n"
            "d=[Transaction(date(2026,2,2),'d',Money('-99.9'),'lazer'),Transaction(date(2026,1,3),'a',Money('-10.5'),'mercado'),"
            "Transaction(date(2026,1,9),'b',Money('-4.5'),'mercado'),Transaction(date(2026,1,20),'c',Money('3000'),'salario'),"
            "Transaction(date(2026,1,21),'e',Money('1234567.8'),'bonus')]\n"
            "out=[l.strip() for l in render_monthly_csv(summarize(d)).strip().splitlines()]\n"
            "exp=['month,category,total','2026-01,bonus,1234567.80','2026-01,mercado,-15.00','2026-01,salario,3000.00','2026-02,lazer,-99.90']\n"
            "assert out==exp, out\nprint('HIDDEN-OK')\n")
        h = sh(["python3", "-B", "-c", hidden], d)
        hidden_ok = "HIDDEN-OK" in h.stdout
        return hidden_ok and suite_ok, {"hidden": hidden_ok, "suite": suite_ok, "hidden_err": h.stderr[-300:]}
    if task == "triage":
        ok = ("test_fx_cross_rate" in text and re.search(r"KeyError:?\s*'BRL'", text) is not None
              and re.search(r"integra", text, re.I) is not None and "fx.py" in text)
        return ok and not tracked_diff, {"noedit": not tracked_diff}
    if task == "inventory":
        found = [c for c in RULE_CLASSES if re.search(rf"\b{c}\b", text)]
        return len(found) == len(RULE_CLASSES) and not tracked_diff, {"found": len(found)}
    if task == "audit":
        src = open(f"{d}/ledgerkit/legacy/reconcile.py").read()
        banks = re.findall(r"def parse_line_(\w+)\(", src)
        low = text.lower()
        hit = lambda b: re.search(rf"(?<![a-z0-9]){b}(?![a-z0-9])", low) is not None  # parse_line_x conta
        found = [b for b in PLANTED if hit(b)]
        others = [b for b in banks if b not in PLANTED and hit(b)]
        ok = len(found) == len(PLANTED) and len(others) <= 2 and not tracked_diff
        return ok, {"found": found, "other_banks_mentioned": others}
    if task == "logdiff":
        ok = ("test_fx_cross_rate" in text and re.search(r"KeyError:?\s*'?BRL", text) is not None
              and re.search(r"skip|pulad|ignorad", text, re.I) is not None and re.search(r"integra", text, re.I) is not None)
        return ok and not tracked_diff, {"noedit": not tracked_diff}
    if task == "rename":
        g = sh(["grep", "-rn", "--include=*.py", "_norm_desc", "ledgerkit", "tests"], d)
        defined = "def normalize_description" in open(f"{d}/ledgerkit/text.py").read()
        return (g.stdout.strip() == "" and defined and suite_ok), {"leftover": len(g.stdout.splitlines()), "defined": defined, "suite": suite_ok}
    raise KeyError(task)


def transcript_stats(session_id):
    stats = {"tool_calls": 0, "tools": {}, "hook_notes": 0, "denies": 0, "subagents": 0}
    base = os.path.expanduser("~/.claude/projects")
    files = []
    for root, _, fs in os.walk(base):
        for f in fs:
            if f.endswith(".jsonl") and (session_id in f or session_id in root):
                files.append(os.path.join(root, f))
    for p in files:
        for line in open(p, encoding="utf8", errors="replace"):
            if "[trimtoken]" in line:
                stats["hook_notes"] += line.count("[trimtoken]")
                stats["denies"] += line.count("[trimtoken] Blocked")
            try:
                o = json.loads(line)
            except Exception:
                continue
            msg = o.get("message") or {}
            if o.get("type") == "assistant" and isinstance(msg.get("content"), list):
                for b in msg["content"]:
                    if b.get("type") == "tool_use":
                        stats["tool_calls"] += 1
                        stats["tools"][b["name"]] = stats["tools"].get(b["name"], 0) + 1
                        if b["name"] in ("Task", "Agent"):
                            stats["subagents"] += 1
    stats["transcripts"] = len(files)
    return stats


def run_one(task, arm, rep):
    d = prepare(task, arm, rep)
    tests_hash0 = tree_hash(d, "tests")
    cmd = ["claude", "-p", TASKS[task], "--output-format", "json", "--model", MODEL, "--max-turns", MAX_TURNS,
           "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", f"{AB}/empty-mcp.json",
           "--permission-mode", "bypassPermissions"]
    if arm == "E":
        cmd += ["--plugin-dir", PLUGIN_DIR]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=d, env=clean_env(f"{task}{arm}{rep}"), capture_output=True, text=True, timeout=TIMEOUT_S)
        out, err = p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        out, err = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), "TIMEOUT"
    wall = time.time() - t0
    try:
        res = json.loads(out)
    except Exception:
        res = {"parse_error": True, "raw": out[-2000:], "stderr": err[-2000:]}
    text = res.get("result", "")
    ok, details = grade(task, d, text, tests_hash0)
    mu = res.get("modelUsage") or {}
    tok = {k: sum(v.get(k, 0) for v in mu.values()) for k in ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")}
    row = {"task": task, "arm": arm, "rep": rep, "pass": ok, "details": details,
           "cost_usd": res.get("total_cost_usd"), "turns": res.get("num_turns"), "wall_s": round(wall, 1),
           "tokens": tok, "models": {k: round(v.get("costUSD", 0), 4) for k, v in mu.items()},
           "is_error": res.get("is_error"), "subtype": res.get("subtype"), "session_id": res.get("session_id"),
           "result": text}
    if res.get("session_id"):
        row["transcript"] = transcript_stats(res["session_id"])
    return row


def main():
    out_path, tasks, reps = sys.argv[1], sys.argv[2], int(sys.argv[3])
    arms = ["A", "B"]
    workers = 4
    if "--arms" in sys.argv:
        arms = sys.argv[sys.argv.index("--arms") + 1].split(",")
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])
    tasks = list(TASKS) if tasks == "all" else tasks.split(",")
    open(f"{AB}/empty-mcp.json", "w").write('{"mcpServers":{}}')
    jobs = [(t, a, r) for r in range(1, reps + 1) for t in tasks for a in arms]
    random.Random(7).shuffle(jobs)
    with cf.ThreadPoolExecutor(workers) as ex, open(out_path, "a") as fo:
        futs = {ex.submit(run_one, *j): j for j in jobs}
        for f in cf.as_completed(futs):
            j = futs[f]
            try:
                row = f.result()
            except Exception as e:  # record it and move on
                row = {"task": j[0], "arm": j[1], "rep": j[2], "pass": False, "crash": repr(e)}
            fo.write(json.dumps(row, ensure_ascii=False) + "\n")
            fo.flush()
            print(f"{row['task']:<10} {row['arm']} r{row['rep']}  pass={row['pass']}  ${row.get('cost_usd')}  turns={row.get('turns')}", flush=True)


if __name__ == "__main__":
    main()
