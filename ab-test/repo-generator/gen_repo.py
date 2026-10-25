import os, random, shutil, sys, textwrap
from core_files import FILES

OUT = sys.argv[1]
random.seed(42)
if os.path.exists(OUT):
    shutil.rmtree(OUT)

def w(rel, content):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)

for rel, c in FILES.items():
    w(rel, c)

# ---------------- legacy/reconcile.py (large) ----------------
BANKS = ["itau", "bradesco", "santander", "caixa", "bb", "nubank", "inter", "c6", "original", "safra",
         "btg", "sicoob", "sicredi", "banrisul", "brb", "mercantil", "daycoval", "pine", "abc", "bmg",
         "pan", "agibank", "neon", "next", "picpay", "pagbank", "mercadopago", "xp", "modal", "sofisa",
         "rendimento", "banestes", "banpara", "bnb", "basa", "triangulo", "paulista", "votorantim", "bs2", "cora",
         "stone", "iti", "will", "digio", "omni"]
DELIMS = [";", ",", "|", "\\t"]
DATEFMTS = ["%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y%m%d"]

parts = ['''"""Reconciliação de extrato bancário contra o razão (módulo herdado da 0.x).

Cada banco exporta o extrato num layout próprio; os leitores abaixo convertem uma linha
desse layout em (data, descrição canônica, valor). `match_entries` casa as transações do
banco com as do razão.
"""

from datetime import datetime, timedelta
from decimal import Decimal

from ..text import _norm_desc


class ReconcileError(ValueError):
    pass


def _to_decimal(raw, decimal_comma=True):
    raw = raw.strip().replace("R$", "").replace(" ", "")
    if decimal_comma and "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    return Decimal(raw)


def similar(a, b):
    """Similaridade simples entre descrições canônicas (Jaccard de palavras)."""
    wa, wb = set(_norm_desc(a).split()), set(_norm_desc(b).split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def match_entries(bank_txs, book_txs, window_days=6, amount_tol=Decimal("0.01"), min_similarity=0.34):
    """Casa transações do banco com as do razão.

    Um par casa quando o valor difere no máximo `amount_tol`, as datas distam no máximo
    `window_days` dias e as descrições têm similaridade >= `min_similarity`. Cada lado é
    usado uma vez; entre candidatos, vence o de data mais próxima.
    Devolve (pares, só_no_banco, só_no_razão).
    """
    window = timedelta(days=window_days)
    free = list(book_txs)
    pairs, only_bank = [], []
    for b in sorted(bank_txs, key=lambda t: t.when):
        best, best_gap = None, None
        for k in free:
            if abs(k.amount.amount - b.amount.amount) > amount_tol:
                continue
            gap = abs(k.when - b.when)
            if gap > window or similar(k.description, b.description) < min_similarity:
                continue
            if best is None or gap < best_gap:
                best, best_gap = k, gap
        if best is None:
            only_bank.append(b)
        else:
            free.remove(best)
            pairs.append((b, best))
    return pairs, only_bank, free

''']
reg = []
for i, bank in enumerate(BANKS):
    d = DELIMS[i % 4]
    fmt = DATEFMTS[(i // 4) % 4]
    sign = "neg_is_debit" if i % 3 else "dc_column"
    comma = i % 2 == 0
    cols = [0, 1, 2] if i % 5 else [1, 0, 2]
    body = []
    body.append(f'def parse_line_{bank}(line):')
    body.append(f'    """Lê uma linha do extrato {bank.upper()} (layout v{1 + i % 3}).')
    body.append('')
    body.append(f'    Colunas: data na posição {cols[0]}, descrição na {cols[1]}, valor na {cols[2]}; separador {d!r}.')
    body.append(f'    Datas no formato {fmt}. ' + ('Débito vem com sinal negativo.' if sign == 'neg_is_debit' else 'Débito/crédito em coluna própria (D/C) na posição 3.'))
    body.append(f'    Valores com {"vírgula" if comma else "ponto"} decimal.')
    body.append('')
    body.append('    Observações do layout:')
    body.append(f"      - linhas iniciadas por '#' são comentários do exportador {bank.upper()} e são ignoradas por parse_statement;")
    body.append('      - o exportador pode trazer espaços à direita em todas as colunas, por isso cada coluna passa por strip();')
    body.append('      - descrições longas são truncadas pelo próprio banco em 60 caracteres, antes de chegar aqui;')
    body.append('      - quando o layout usa ponto decimal, o valor nunca traz separador de milhar;')
    body.append('      - estornos chegam como lançamentos independentes, com o mesmo texto e sinal invertido.')
    body.append('    Histórico do layout:')
    body.append('      v1 — layout original do convênio, com coluna de saldo ao final;')
    body.append('      v2 — coluna de saldo removida pelo banco (a leitura ignora colunas extras);')
    body.append('      v3 — parte das agências passou a exportar a data sem separador.')
    body.append('    """')
    body.append(f'    cols = [c.strip() for c in line.rstrip("\\n").split("{d}")]')
    body.append(f'    if len(cols) < {4 if sign == "dc_column" else 3}:')
    body.append(f'        raise ReconcileError("linha {bank}: colunas insuficientes: %r" % line)')
    body.append(f'    when = datetime.strptime(cols[{cols[0]}], "{fmt}").date()')
    body.append(f'    desc = _norm_desc(cols[{cols[1]}])')
    body.append(f'    value = _to_decimal(cols[{cols[2]}], decimal_comma={comma})')
    if sign == "dc_column":
        body.append('    flag = cols[3].upper()')
        body.append('    if flag not in ("D", "C"):')
        body.append(f'        raise ReconcileError("linha {bank}: indicador D/C inválido: %r" % flag)')
        body.append('    if flag == "D":')
        body.append('        value = -abs(value)')
        body.append('    else:')
        body.append('        value = abs(value)')
    else:
        body.append('    if not desc:')
        body.append(f'        raise ReconcileError("linha {bank}: descrição vazia")')
    body.append('    return when, desc, value')
    body.append('')
    body.append('')
    parts.append("\n".join(body))
    reg.append(f'    "{bank}": parse_line_{bank},')
parts.append("BANK_PARSERS = {\n" + "\n".join(reg) + "\n}\n\n\n")
parts.append('''def parse_statement(bank, text):
    try:
        parser = BANK_PARSERS[bank]
    except KeyError:
        raise ReconcileError(f"banco sem leitor: {bank}") from None
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            out.append(parser(line))
        except (ValueError, IndexError) as exc:
            raise ReconcileError(f"{bank} linha {n}: {exc}") from exc
    return out


def summarize_unmatched(only_bank, only_book):
    """Texto curto para o relatório de pendências."""
    lines = [f"{len(only_bank)} só no banco, {len(only_book)} só no razão"]
    for t in only_bank[:20]:
        lines.append(f"  banco  {t.when} {_norm_desc(t.description)[:40]:<40} {t.amount.amount:>10}")
    for t in only_book[:20]:
        lines.append(f"  razão  {t.when} {_norm_desc(t.description)[:40]:<40} {t.amount.amount:>10}")
    return "\\n".join(lines)
''')
w("ledgerkit/legacy/reconcile.py", "".join(parts))

# ---------------- tests ----------------
w("tests/__init__.py", "")
w("tests/test_money.py", '''import unittest
from decimal import Decimal

from ledgerkit.money import Money, CurrencyMismatch, total


class MoneyTest(unittest.TestCase):
    def test_add_same_currency(self):
        self.assertEqual(Money("1.10") + Money("2.20"), Money("3.30"))

    def test_add_other_currency_fails(self):
        with self.assertRaises(CurrencyMismatch):
            Money(1, "BRL") + Money(1, "USD")

    def test_float_is_exact(self):
        self.assertEqual(Money(0.1).amount, Decimal("0.10"))

    def test_mul(self):
        self.assertEqual(Money("10.00") * 0.15, Money("1.50"))

    def test_total(self):
        self.assertEqual(total([Money(1), Money(2), Money("0.5")]), Money("3.50"))

    def test_str(self):
        self.assertEqual(str(Money("1234.5")), "BRL 1,234.50")


class AllocateTest(unittest.TestCase):
    def test_allocate_sum_preserved(self):
        for value, ratios in [("10.00", [1, 1, 1]), ("0.02", [1, 1, 1]), ("100.00", [70, 30]), ("7.77", [3, 2, 2])]:
            parts = Money(value).allocate(ratios)
            self.assertEqual(sum(p.amount for p in parts), Decimal(value), (value, ratios))

    def test_allocate_remainder_goes_first(self):
        parts = Money("0.05").allocate([2, 1])
        self.assertEqual([p.amount for p in parts], [Decimal("0.04"), Decimal("0.01")])

    def test_allocate_small_amount(self):
        parts = Money("0.02").allocate([1, 1, 1])
        self.assertEqual([p.amount for p in parts], [Decimal("0.01"), Decimal("0.01"), Decimal("0.00")])

    def test_allocate_invalid(self):
        with self.assertRaises(ValueError):
            Money(1).allocate([0, 0])


if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_fx.py", '''import unittest
from decimal import Decimal

from ledgerkit.fx import RateTable, convert, MissingRate
from ledgerkit.money import Money


class FxTest(unittest.TestCase):
    def setUp(self):
        self.t = RateTable("BRL", {"USD": "5.00", "EUR": "5.50"})

    def test_convert_to_base(self):
        self.assertEqual(convert(Money("10", "USD"), "BRL", self.t), Money("50.00", "BRL"))

    def test_cross_rate(self):
        self.assertEqual(convert(Money("11", "EUR"), "USD", self.t), Money("12.10", "USD"))

    def test_half_even_rounding(self):
        t = RateTable("BRL", {"USD": "0.125"})
        self.assertEqual(convert(Money("1", "USD"), "BRL", t), Money("0.12", "BRL"))

    def test_missing_rate(self):
        with self.assertRaises(MissingRate):
            convert(Money("1", "JPY"), "BRL", self.t)

    def test_same_currency_noop(self):
        m = Money("3", "BRL")
        self.assertIs(convert(m, "brl", self.t), m)


if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_accounts.py", '''import unittest
from datetime import date

from ledgerkit.accounts import Account, Entry, Ledger, UnbalancedEntry
from ledgerkit.money import Money


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.l = Ledger()
        self.l.open(Account("1.1", "Caixa", "asset"))
        self.l.open(Account("3.1", "Salário", "income"))
        self.l.open(Account("4.1", "Mercado", "expense"))

    def test_post_and_balance(self):
        self.l.post(Entry(date(2026, 1, 5), "salário").add("1.1", Money(5000)).add("3.1", Money(-5000)))
        self.l.post(Entry(date(2026, 1, 9), "mercado").add("4.1", Money(320)).add("1.1", Money(-320)))
        self.assertEqual(self.l.balance("1.1"), Money(4680))
        self.assertEqual(self.l.balance("3.1"), Money(5000))

    def test_unbalanced(self):
        with self.assertRaises(UnbalancedEntry):
            self.l.post(Entry(date(2026, 1, 1), "x").add("1.1", Money(1)))

    def test_until(self):
        self.l.post(Entry(date(2026, 2, 1), "s").add("1.1", Money(10)).add("3.1", Money(-10)))
        self.assertEqual(self.l.balance("1.1", until=date(2026, 1, 31)), Money(0))


if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_rules.py", '''import unittest
from datetime import date

from ledgerkit.money import Money
from ledgerkit.rules import (RegexRule, KeywordRule, MerchantRule, AmountRangeRule, LargeExpenseRule,
                             RecurringRule, AllOfRule, AnyOfRule, NotRule, RuleEngine)
from ledgerkit.legacy.rules_compat import LegacyCategoryRule
from ledgerkit.transactions import Transaction


def tx(desc, value):
    return Transaction(date(2026, 3, 1), desc, Money(value))


class RulesTest(unittest.TestCase):
    def test_regex(self):
        self.assertEqual(RegexRule(r"uber|99", "transporte").apply(tx("UBER *TRIP", -20)), "transporte")

    def test_keyword_accents(self):
        self.assertTrue(KeywordRule(["farmácia"], "saude").matches(tx("Compra FARMACIA Sao Joao", -30)))

    def test_merchant_prefix(self):
        r = MerchantRule(["padaria"], "alimentacao")
        self.assertTrue(r.matches(tx("Padaria Real", -9)))
        self.assertFalse(r.matches(tx("Pix para Padaria", -9)))

    def test_amount_and_large(self):
        self.assertTrue(AmountRangeRule(-100, -10, "pequeno").matches(tx("x", -50)))
        self.assertTrue(LargeExpenseRule(1000).matches(tx("x", -1500)))

    def test_recurring(self):
        r = RecurringRule([tx("Netflix", -55.9)])
        self.assertTrue(r.matches(tx("NETFLIX", -55.9)))

    def test_composites(self):
        a, b = RegexRule("a", "x"), RegexRule("b", "x")
        self.assertTrue(AllOfRule([a, b], "c").matches(tx("ab", 1)))
        self.assertTrue(AnyOfRule([a, b], "c").matches(tx("b", 1)))
        self.assertTrue(NotRule(a, "c").matches(tx("z", 1)))

    def test_engine_priority(self):
        e = RuleEngine([KeywordRule(["mercado"], "mercado"), LargeExpenseRule(500)])
        self.assertEqual(e.categorize(tx("Mercado Bom", -900)), "revisar")
        self.assertEqual(e.categorize(tx("Mercado Bom", -90)), "mercado")
        self.assertEqual(e.categorize(tx("???", -1)), "outros")

    def test_legacy(self):
        self.assertEqual(LegacyCategoryRule("posto", "combustivel").apply(tx("POSTO SHELL", -100)), "combustivel")


if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_parsers.py", '''import unittest
from decimal import Decimal

from ledgerkit.parsers.csv_import import read_csv, parse_amount
from ledgerkit.parsers.json_import import read_json
from ledgerkit.parsers.ofx_import import read_ofx


class ParsersTest(unittest.TestCase):
    def test_parse_amount(self):
        self.assertEqual(parse_amount("R$ 1.234,56"), Decimal("1234.56"))
        self.assertEqual(parse_amount("-12.5"), Decimal("-12.5"))

    def test_csv(self):
        txs = read_csv("Data;Descrição;Valor\\n05/01/2026;Compra PADARIA Real;-9,50\\n")
        self.assertEqual(len(txs), 1)
        self.assertEqual(txs[0].description, "padaria real")
        self.assertEqual(txs[0].amount.amount, Decimal("-9.50"))

    def test_json(self):
        txs = read_json('{"transactions":[{"date":"2026-01-02","description":"x","amount":"3.2","id":"a"}]}')
        self.assertEqual(txs[0].ref, "a")

    def test_ofx(self):
        ofx = "<STMTTRN>\\n<TRNAMT>-10.00\\n<DTPOSTED>20260110\\n<FITID>9\\n<MEMO>LOJA\\n</STMTTRN>"
        txs = read_ofx(ofx)
        self.assertEqual(txs[0].amount.amount, Decimal("-10.00"))
        self.assertEqual(txs[0].ref, "9")


if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_reports.py", '''import unittest
from datetime import date
from decimal import Decimal

from ledgerkit.money import Money
from ledgerkit.reports.monthly import summarize, render_monthly_text, render_monthly_markdown
from ledgerkit.reports.cashflow import cashflow
from ledgerkit.transactions import Transaction


def data():
    return [Transaction(date(2026, 1, 3), "a", Money("-10.5"), "mercado"),
            Transaction(date(2026, 1, 9), "b", Money("-4.5"), "mercado"),
            Transaction(date(2026, 1, 20), "c", Money("3000"), "salario"),
            Transaction(date(2026, 2, 2), "d", Money("-99.9"), "lazer")]


class ReportsTest(unittest.TestCase):
    def test_summary(self):
        s = summarize(data())
        self.assertEqual(s.months(), ["2026-01", "2026-02"])
        self.assertEqual(s.categories("2026-01")["mercado"], Decimal("-15.0"))

    def test_text(self):
        self.assertIn("mercado", render_monthly_text(summarize(data())))

    def test_markdown(self):
        md = render_monthly_markdown(summarize(data()))
        self.assertIn("| 2026-02 | lazer | -99.90 |", md)

    def test_cashflow(self):
        cf = cashflow(data())
        self.assertEqual(cf[0][0], "2026-01")
        self.assertEqual(cf[0][3], Decimal("2985.0"))


if __name__ == "__main__":
    unittest.main()
''')
# per-bank tests (generated)
SAMPLE = {}
tl = ['''import unittest
from datetime import date, timedelta
from decimal import Decimal

from ledgerkit.legacy import reconcile as R
from ledgerkit.money import Money
from ledgerkit.transactions import Transaction


class MatchTest(unittest.TestCase):
    def test_match_within_window(self):
        bank = [Transaction(date(2026, 1, 10), "padaria real", Money("-9.50"))]
        book = [Transaction(date(2026, 1, 14), "Padaria Real", Money("-9.50"))]
        pairs, ob, ok = R.match_entries(bank, book)
        self.assertEqual(len(pairs), 1)

    def test_outside_window(self):
        bank = [Transaction(date(2026, 1, 1), "padaria real", Money("-9.50"))]
        book = [Transaction(date(2026, 1, 20), "padaria real", Money("-9.50"))]
        pairs, ob, ok = R.match_entries(bank, book)
        self.assertEqual((len(pairs), len(ob), len(ok)), (0, 1, 1))

    def test_closest_date_wins(self):
        bank = [Transaction(date(2026, 1, 10), "netflix", Money("-55.90"))]
        book = [Transaction(date(2026, 1, 13), "netflix", Money("-55.90")),
                Transaction(date(2026, 1, 11), "netflix", Money("-55.90"))]
        pairs, _, _ = R.match_entries(bank, book)
        self.assertEqual(pairs[0][1].when, date(2026, 1, 11))

    def test_unknown_bank(self):
        with self.assertRaises(R.ReconcileError):
            R.parse_statement("banco-x", "")

    def test_summarize_unmatched(self):
        t = Transaction(date(2026, 1, 1), "Compra Loja Ácida", Money("-1"))
        self.assertIn("loja acida", R.summarize_unmatched([t], []))


class BankParsersTest(unittest.TestCase):
    pass

''']
import datetime as _dt
for i, bank in enumerate(BANKS):
    d = DELIMS[i % 4].replace("\\t", "\t")
    fmt = DATEFMTS[(i // 4) % 4]
    sign = "neg_is_debit" if i % 3 else "dc_column"
    comma = i % 2 == 0
    cols = [0, 1, 2] if i % 5 else [1, 0, 2]
    day = _dt.date(2026, 1 + i % 12, 1 + i % 27)
    ds = day.strftime(fmt)
    val = "1.234,56" if comma else "1234.56"
    raw = [None, None, None]
    raw[cols[0]] = ds; raw[cols[1]] = f"Compra LOJA {bank.upper()} Centro"; raw[cols[2]] = ("-" if sign == "neg_is_debit" else "") + val
    if sign == "dc_column":
        raw.append("D")
    line = d.join(raw)
    tl.append(f'''    def test_{bank}(self):
        when, desc, value = R.parse_line_{bank}({line!r})
        self.assertEqual(when, date({day.year}, {day.month}, {day.day}))
        self.assertEqual(desc, "loja {bank} centro")
        self.assertEqual(value, Decimal("-1234.56"))
''')
tl.append('''

if __name__ == "__main__":
    unittest.main()
''')
w("tests/test_reconcile.py", "\n".join(tl))
w("tests/integration/__init__.py", "")
w("tests/integration/test_live_rates.py", '''import os
import unittest

from ledgerkit.fx import RateTable, convert
from ledgerkit.money import Money


@unittest.skipUnless(os.environ.get("LIVE_RATES") == "1", "integração: requer LIVE_RATES=1 e acesso à API de cotações")
class LiveRatesTest(unittest.TestCase):
    def test_fx_cross_rate(self):
        table = RateTable("USD", {"EUR": "1.08"})
        convert(Money("10", "BRL"), "EUR", table)

    def test_fetch_latest(self):
        self.assertTrue(True)
''')

w("README.md", '''# ledgerkit

Contabilidade pessoal e reconciliação bancária em Python puro (sem dependências).

```bash
python -m unittest discover -s tests -t .      # testes unitários
LIVE_RATES=1 python -m unittest tests.integration.test_live_rates   # integração (rede)
```

Pacotes: `money` (valores e rateio), `fx` (câmbio), `accounts` (razão), `rules` (categorização),
`parsers` (CSV/JSON/OFX), `reports` (relatórios), `legacy` (reconciliação herdada da 0.x).
''')
w("pyproject.toml", '''[project]
name = "ledgerkit"
version = "0.9.4"
requires-python = ">=3.10"
''')
w(".gitignore", "__pycache__/\n.venv/\nnode_modules/\nbuild/\n")
w("docs/index.md", "# ledgerkit\n\nDocumentação do site (gerada com o pacote de docs em node_modules).\n")
w("package.json", '{\n  "name": "ledgerkit-docs",\n  "private": true,\n  "scripts": {"docs": "docs-build docs build/site"}\n}\n')

# ---------------- noise: generated build/site ----------------
for i in range(240):
    w(f"build/site/api/page-{i:03d}.html", "<html><body>" + ("<div class='x'>ledgerkit api</div>" * 60) + "</body></html>\n")

# ---------------- CI log (2.4 MB, ANSI, progress, failure in the middle) ----------------
L = []
def step(name):
    L.append(f"\x1b[36m##[group]Run {name}\x1b[0m")
L.append("2026-10-20T03:12:01.112Z Runner: ubuntu-24.04 · job ci/test · attempt 1")
step("checkout")
for i in range(40):
    L.append(f"remote: Counting objects: {i*2}% ({i}/{40})\rremote: Counting objects: {min(100,i*2+2)}% ({i+1}/40)")
step("setup-python 3.12")
step("install dependencies")
for i in range(1200):
    L.append(f"\x1b[33mWARNING:\x1b[0m pip is configured with locations that require TLS/SSL, however the ssl module is not available.")
for i in range(300):
    L.append(f"Downloading package-{i}.whl {'#'*10} 10%\rDownloading package-{i}.whl {'#'*50} 50%\rDownloading package-{i}.whl {'#'*100} 100%")
step("lint")
for i in range(900):
    L.append(f"ledgerkit/legacy/reconcile.py:{100+i}:80: E501 line too long (101 > 79 characters)")
step("unit tests")
for rep in range(14):
    for t in ["test_add_same_currency", "test_mul", "test_total", "test_convert_to_base", "test_cross_rate", "test_post_and_balance"] + [f"test_{b}" for b in BANKS]:
        L.append(f"{t} (tests.test_x.Case{rep}) ... \x1b[32mok\x1b[0m")
L.append("ConnectionResetError: [Errno 104] Connection reset by peer — retry 1/3")
L.append("retry 2/3 ... ok")
L.append("Ran 1806 tests in 41.210s")
L.append("\x1b[32mOK\x1b[0m")
step("integration tests")
L.append("LIVE_RATES=1 python -m unittest discover -s tests/integration -t .")
for i in range(3000):
    L.append(f"[http] GET https://rates.example.com/v2/latest?base=USD -> 200 ({120+i%40} ms) cache=miss")
L.append("test_fetch_latest (tests.integration.test_live_rates.LiveRatesTest.test_fetch_latest) ... ok")
L.append("test_fx_cross_rate (tests.integration.test_live_rates.LiveRatesTest.test_fx_cross_rate) ... \x1b[31mERROR\x1b[0m")
L.append("")
L.append("======================================================================")
L.append("ERROR: test_fx_cross_rate (tests.integration.test_live_rates.LiveRatesTest.test_fx_cross_rate)")
L.append("----------------------------------------------------------------------")
L.append("Traceback (most recent call last):")
L.append('  File "/home/runner/work/ledgerkit/ledgerkit/ledgerkit/fx.py", line 37, in rate')
L.append("    return self._rates[src] / self._rates[dst]")
L.append("           ~~~~~~~~~~~^^^^^")
L.append("KeyError: 'BRL'")
L.append("")
L.append("During handling of the above exception, another exception occurred:")
L.append("ledgerkit.fx.MissingRate: 'BRL'")
L.append("----------------------------------------------------------------------")
L.append("Ran 2 tests in 3.002s")
L.append("FAILED (errors=1)")
L.append("\x1b[31m##[error]Process completed with exit code 1.\x1b[0m")
for i in range(2500):
    L.append(f"[http] GET https://rates.example.com/v2/history?day={i} -> 200 ({90+i%30} ms) cache=hit")
step("package")
L.append("Skipping: previous step failed")
step("post-job cleanup")
for i in range(400):
    L.append(f"Cleaning up orphan process {1000+i}")
w("logs/ci-2026-10-20.log", "\n".join(L) + "\n")
w("logs/ci-2026-10-19.log", "\n".join(x for x in L if "ERROR" not in x and "KeyError" not in x and "FAILED" not in x).replace("integration tests", "integration tests (skipped)") + "\n")
print("ok")
