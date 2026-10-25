# "Real" files of the ledgerkit package (hand-written). Their content stays in Portuguese, as measured.
FILES = {}

FILES["ledgerkit/__init__.py"] = '''"""ledgerkit — contabilidade pessoal e reconciliação bancária (somente stdlib)."""

from .money import Money
from .accounts import Account, Entry, Ledger
from .fx import RateTable, convert

__all__ = ["Money", "Account", "Entry", "Ledger", "RateTable", "convert"]
__version__ = "0.9.4"
'''

FILES["ledgerkit/config.py"] = '''"""Configuração padrão do ledgerkit."""

from dataclasses import dataclass, field


@dataclass
class Settings:
    base_currency: str = "BRL"
    date_format: str = "%Y-%m-%d"
    decimal_places: int = 2
    import_encoding: str = "utf-8"
    report_locale: str = "pt_BR"
    ignored_categories: list = field(default_factory=lambda: ["transferencia-interna"])


DEFAULT_SETTINGS = Settings()
'''

FILES["ledgerkit/money.py"] = '''"""Valor monetário com moeda e arredondamento explícitos."""

from decimal import Decimal, ROUND_HALF_UP

_QUANT = Decimal("0.01")


class CurrencyMismatch(ValueError):
    pass


class Money:
    __slots__ = ("amount", "currency")

    def __init__(self, amount, currency="BRL"):
        if isinstance(amount, float):
            amount = repr(amount)
        self.amount = Decimal(amount).quantize(_QUANT, rounding=ROUND_HALF_UP)
        self.currency = currency.upper()

    def _check(self, other):
        if not isinstance(other, Money):
            raise TypeError("operação exige Money")
        if other.currency != self.currency:
            raise CurrencyMismatch(f"{self.currency} != {other.currency}")

    def __add__(self, other):
        self._check(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other):
        self._check(other)
        return Money(self.amount - other.amount, self.currency)

    def __mul__(self, factor):
        return Money(self.amount * Decimal(str(factor)), self.currency)

    def __neg__(self):
        return Money(-self.amount, self.currency)

    def __eq__(self, other):
        return isinstance(other, Money) and self.amount == other.amount and self.currency == other.currency

    def __lt__(self, other):
        self._check(other)
        return self.amount < other.amount

    def __hash__(self):
        return hash((self.amount, self.currency))

    def __repr__(self):
        return f"Money({str(self.amount)!r}, {self.currency!r})"

    def __str__(self):
        return f"{self.currency} {self.amount:,.2f}"

    def is_zero(self):
        return self.amount == 0

    def allocate(self, ratios):
        """Divide o valor segundo `ratios`, sem perder centavos.

        Os centavos que sobram do arredondamento para baixo vão, um a um, para as
        primeiras partes. A soma das partes é sempre igual ao valor original.
        """
        if not ratios or any(r < 0 for r in ratios) or sum(ratios) == 0:
            raise ValueError("ratios inválidos")
        cents = int(self.amount * 100)
        total = sum(ratios)
        parts = [cents * r // total for r in ratios]
        remainder = cents - sum(parts)
        for i in range(remainder):
            parts[i] += 1
        return [Money(Decimal(p) / 100, self.currency) for p in parts]


def zero(currency="BRL"):
    return Money(0, currency)


def total(values, currency="BRL"):
    acc = zero(currency)
    for v in values:
        acc = acc + v
    return acc
'''

FILES["ledgerkit/fx.py"] = '''"""Conversão de moedas a partir de uma tabela de cotações."""

from decimal import Decimal, ROUND_HALF_EVEN

from .money import Money

# Conversões arredondam para o par mais próximo: evita viés acumulado em lotes grandes.
DEFAULT_ROUNDING = ROUND_HALF_EVEN


class MissingRate(KeyError):
    pass


class RateTable:
    """Cotações em relação a uma moeda base: 1 unidade estrangeira = rate unidades da base."""

    def __init__(self, base="BRL", rates=None):
        self.base = base.upper()
        self._rates = {self.base: Decimal(1)}
        for code, value in (rates or {}).items():
            self.set(code, value)

    def set(self, code, value):
        value = Decimal(str(value))
        if value <= 0:
            raise ValueError("cotação deve ser positiva")
        self._rates[code.upper()] = value

    def rate(self, src, dst):
        src, dst = src.upper(), dst.upper()
        try:
            return self._rates[src] / self._rates[dst]
        except KeyError as exc:
            raise MissingRate(exc.args[0]) from None

    def currencies(self):
        return sorted(self._rates)


def convert(money, to, table, rounding=DEFAULT_ROUNDING):
    if money.currency == to.upper():
        return money
    raw = money.amount * table.rate(money.currency, to)
    return Money(raw.quantize(Decimal("0.01"), rounding=rounding), to)
'''

FILES["ledgerkit/accounts.py"] = '''"""Contas, lançamentos e razão (ledger) de partidas dobradas."""

from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional

from .money import Money, zero


class UnbalancedEntry(ValueError):
    pass


@dataclass(frozen=True)
class Account:
    code: str
    name: str
    kind: str = "asset"  # asset | liability | income | expense | equity

    @property
    def debit_normal(self):
        return self.kind in ("asset", "expense")


@dataclass
class Entry:
    when: date
    description: str
    lines: List[tuple] = field(default_factory=list)  # (account_code, Money); positivo = débito

    def add(self, account_code, money):
        self.lines.append((account_code, money))
        return self

    def is_balanced(self):
        if not self.lines:
            return False
        currency = self.lines[0][1].currency
        acc = zero(currency)
        for _, m in self.lines:
            acc = acc + m
        return acc.is_zero()


class Ledger:
    def __init__(self, currency="BRL"):
        self.currency = currency
        self.accounts = {}
        self.entries: List[Entry] = []

    def open(self, account: Account):
        if account.code in self.accounts:
            raise ValueError(f"conta {account.code} já existe")
        self.accounts[account.code] = account
        return account

    def post(self, entry: Entry):
        if not entry.is_balanced():
            raise UnbalancedEntry(entry.description)
        for code, _ in entry.lines:
            if code not in self.accounts:
                raise KeyError(code)
        self.entries.append(entry)
        return entry

    def balance(self, code, until: Optional[date] = None):
        acc = zero(self.currency)
        for e in self.entries:
            if until and e.when > until:
                continue
            for c, m in e.lines:
                if c == code:
                    acc = acc + m
        account = self.accounts[code]
        return acc if account.debit_normal else -acc

    def trial_balance(self):
        return {code: self.balance(code) for code in sorted(self.accounts)}
'''

FILES["ledgerkit/text.py"] = '''"""Normalização de texto de extratos."""

import re
import unicodedata

_SPACES = re.compile(r"\\s+")
_NOISE = re.compile(r"\\b(?:compra|pagamento|pgto|debito|credito|cartao)\\b", re.I)


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def _norm_desc(s):
    """Descrição canônica de um lançamento: sem acento, minúscula, sem ruído de banco."""
    s = strip_accents(s or "").lower()
    s = _NOISE.sub(" ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return _SPACES.sub(" ", s).strip()
'''

FILES["ledgerkit/transactions.py"] = '''"""Transação importada de extrato (antes de virar lançamento)."""

from dataclasses import dataclass
from datetime import date
from typing import Optional

from .money import Money


@dataclass
class Transaction:
    when: date
    description: str
    amount: Money
    category: Optional[str] = None
    source: str = "manual"
    ref: Optional[str] = None
'''

FILES["ledgerkit/rules/__init__.py"] = '''from .base import BaseRule
from .text import RegexRule, KeywordRule, MerchantRule
from .amount import AmountRangeRule, LargeExpenseRule, RecurringRule
from .composite import AllOfRule, AnyOfRule, NotRule
from .engine import RuleEngine, RuleSet
'''

FILES["ledgerkit/rules/base.py"] = '''"""Regra de categorização: decide a categoria de uma transação, ou passa."""


class BaseRule:
    priority = 100

    def __init__(self, category, priority=None):
        self.category = category
        if priority is not None:
            self.priority = priority

    def matches(self, tx):  # pragma: no cover - abstrato
        raise NotImplementedError

    def apply(self, tx):
        return self.category if self.matches(tx) else None

    def __repr__(self):
        return f"{type(self).__name__}({self.category!r})"
'''

FILES["ledgerkit/rules/text.py"] = '''import re

from .base import BaseRule
from ..text import _norm_desc


class RegexRule(BaseRule):
    def __init__(self, pattern, category, priority=None):
        super().__init__(category, priority)
        self.pattern = re.compile(pattern, re.I)

    def matches(self, tx):
        return bool(self.pattern.search(tx.description))


class KeywordRule(BaseRule):
    def __init__(self, keywords, category, priority=None):
        super().__init__(category, priority)
        self.keywords = [_norm_desc(k) for k in keywords]

    def matches(self, tx):
        desc = _norm_desc(tx.description)
        return any(k in desc for k in self.keywords)


class MerchantRule(KeywordRule):
    """Palavra-chave restrita ao início da descrição (nome do estabelecimento)."""

    priority = 50

    def matches(self, tx):
        desc = _norm_desc(tx.description)
        return any(desc.startswith(k) for k in self.keywords)
'''

FILES["ledgerkit/rules/amount.py"] = '''from decimal import Decimal

from .base import BaseRule


class AmountRangeRule(BaseRule):
    def __init__(self, low, high, category, priority=None):
        super().__init__(category, priority)
        self.low = Decimal(str(low))
        self.high = Decimal(str(high))

    def matches(self, tx):
        return self.low <= tx.amount.amount <= self.high


class LargeExpenseRule(AmountRangeRule):
    priority = 10

    def __init__(self, threshold, category="revisar", priority=None):
        super().__init__(Decimal("-1e12"), -Decimal(str(threshold)), category, priority)


class RecurringRule(BaseRule):
    """Casa transações cuja descrição já apareceu em `history` com o mesmo valor."""

    def __init__(self, history, category="assinatura", priority=None):
        super().__init__(category, priority)
        self._seen = {(h.description.lower(), h.amount.amount) for h in history}

    def matches(self, tx):
        return (tx.description.lower(), tx.amount.amount) in self._seen
'''

FILES["ledgerkit/rules/composite.py"] = '''from .base import BaseRule


class AllOfRule(BaseRule):
    def __init__(self, rules, category, priority=None):
        super().__init__(category, priority)
        self.rules = list(rules)

    def matches(self, tx):
        return all(r.matches(tx) for r in self.rules)


class AnyOfRule(BaseRule):
    def __init__(self, rules, category, priority=None):
        super().__init__(category, priority)
        self.rules = list(rules)

    def matches(self, tx):
        return any(r.matches(tx) for r in self.rules)


class NotRule(BaseRule):
    def __init__(self, rule, category, priority=None):
        super().__init__(category, priority)
        self.rule = rule

    def matches(self, tx):
        return not self.rule.matches(tx)
'''

FILES["ledgerkit/rules/engine.py"] = '''"""Aplica regras em ordem de prioridade (menor número primeiro)."""


class RuleSet:
    """Coleção nomeada de regras (não é uma regra)."""

    def __init__(self, name, rules=()):
        self.name = name
        self.rules = list(rules)

    def __iter__(self):
        return iter(self.rules)


class RuleEngine:
    def __init__(self, rules=(), default="outros"):
        self.rules = sorted(rules, key=lambda r: r.priority)
        self.default = default

    def categorize(self, tx):
        for rule in self.rules:
            cat = rule.apply(tx)
            if cat:
                return cat
        return self.default

    def categorize_all(self, txs):
        for tx in txs:
            tx.category = self.categorize(tx)
        return txs
'''

FILES["ledgerkit/legacy/__init__.py"] = '"""Código herdado da versão 0.x; mantido por compatibilidade."""\n'

FILES["ledgerkit/legacy/rules_compat.py"] = '''"""Regras no formato antigo (dicionário de configuração)."""

from ..rules.base import BaseRule


class RuleLikeHelper:
    """Ajudante que monta regras a partir de dicionários. Não é uma regra."""

    def build(self, spec):
        return LegacyCategoryRule(spec["contains"], spec["category"])


class LegacyCategoryRule(BaseRule):
    def __init__(self, contains, category, priority=None):
        super().__init__(category, priority)
        self.contains = contains.lower()

    def matches(self, tx):
        return self.contains in tx.description.lower()
'''

FILES["ledgerkit/parsers/__init__.py"] = ''
FILES["ledgerkit/parsers/csv_import.py"] = '''"""Importa extratos CSV (data;descrição;valor)."""

import csv
import io
from datetime import datetime
from decimal import Decimal

from ..money import Money
from ..text import _norm_desc
from ..transactions import Transaction


def parse_amount(raw):
    raw = raw.strip().replace("R$", "").replace(" ", "")
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    return Decimal(raw)


def read_csv(text, currency="BRL", delimiter=";", date_format="%d/%m/%Y"):
    rows = csv.reader(io.StringIO(text), delimiter=delimiter)
    out = []
    for i, row in enumerate(rows):
        if i == 0 and row and row[0].lower().startswith("data"):
            continue
        if not row or not any(c.strip() for c in row):
            continue
        when = datetime.strptime(row[0].strip(), date_format).date()
        out.append(Transaction(when, _norm_desc(row[1]), Money(parse_amount(row[2]), currency), source="csv"))
    return out
'''

FILES["ledgerkit/parsers/json_import.py"] = '''import json
from datetime import date

from ..money import Money
from ..transactions import Transaction


def read_json(text, currency="BRL"):
    data = json.loads(text)
    items = data["transactions"] if isinstance(data, dict) else data
    out = []
    for it in items:
        out.append(Transaction(date.fromisoformat(it["date"]), it["description"],
                               Money(str(it["amount"]), it.get("currency", currency)),
                               source="json", ref=it.get("id")))
    return out
'''

FILES["ledgerkit/parsers/ofx_import.py"] = '''"""Leitor mínimo de OFX (SGML) — só STMTTRN."""

import re
from datetime import datetime

from ..money import Money
from ..transactions import Transaction

_TRN = re.compile(r"<STMTTRN>(.*?)</STMTTRN>", re.S)
_TAG = re.compile(r"<(\\w+)>([^<\\r\\n]*)")


def read_ofx(text, currency="BRL"):
    out = []
    for block in _TRN.findall(text):
        tags = dict(_TAG.findall(block))
        when = datetime.strptime(tags["DTPOSTED"][:8], "%Y%m%d").date()
        out.append(Transaction(when, tags.get("MEMO", "").strip(), Money(tags["TRNAMT"], currency),
                               source="ofx", ref=tags.get("FITID")))
    return out
'''

FILES["ledgerkit/reports/__init__.py"] = ''
FILES["ledgerkit/reports/monthly.py"] = '''"""Resumo mensal por categoria."""

from collections import defaultdict
from decimal import Decimal


class MonthlySummary:
    def __init__(self):
        self.totals = defaultdict(lambda: defaultdict(Decimal))  # "YYYY-MM" -> categoria -> total

    def add(self, tx):
        month = tx.when.strftime("%Y-%m")
        self.totals[month][tx.category or "outros"] += tx.amount.amount

    def months(self):
        return sorted(self.totals)

    def categories(self, month):
        return dict(self.totals[month])


def summarize(transactions):
    s = MonthlySummary()
    for tx in transactions:
        s.add(tx)
    return s


def render_monthly_text(summary):
    lines = []
    for month in summary.months():
        lines.append(month)
        for cat, value in sorted(summary.categories(month).items()):
            lines.append(f"  {cat:<20} {value:>12.2f}")
    return "\\n".join(lines)


def render_monthly_markdown(summary):
    lines = ["| mês | categoria | total |", "|---|---|---:|"]
    for month in summary.months():
        for cat, value in sorted(summary.categories(month).items()):
            lines.append(f"| {month} | {cat} | {value:.2f} |")
    return "\\n".join(lines)
'''

FILES["ledgerkit/reports/cashflow.py"] = '''from collections import OrderedDict
from decimal import Decimal


def cashflow(transactions):
    """Entradas, saídas e saldo por mês, em ordem cronológica."""
    months = OrderedDict()
    for tx in sorted(transactions, key=lambda t: t.when):
        m = tx.when.strftime("%Y-%m")
        inc, out = months.get(m, (Decimal(0), Decimal(0)))
        if tx.amount.amount >= 0:
            inc += tx.amount.amount
        else:
            out += -tx.amount.amount
        months[m] = (inc, out)
    return [(m, i, o, i - o) for m, (i, o) in months.items()]
'''
