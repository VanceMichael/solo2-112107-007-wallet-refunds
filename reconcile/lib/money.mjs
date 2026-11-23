// 金额领域规则：
// 所有金额都以“固定币种的最小单位”整数表达，且金额对象始终自带币种。
// 消费者扣款额（charged）与清算额（settled）可能是不同币种，分别记账，
// 任何求和只能在同一币种下进行，跨币种相加直接报错而不是隐式换算。

export class CurrencyMismatchError extends Error {
  constructor(left, right, where = '金额汇总') {
    super(`${where}不能跨币种相加：${left} 与 ${right}`);
    this.name = 'CurrencyMismatchError';
    this.code = 'CURRENCY_MISMATCH';
  }
}

export function money(minor, ccy) {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`金额最小单位必须是整数，收到 ${minor}`);
  }
  if (typeof ccy !== 'string' || ccy.length !== 3) {
    throw new TypeError(`币种必须是三字母代码，收到 ${ccy}`);
  }
  return { minor, ccy };
}

export function sameCcy(a, b) {
  return a.ccy === b.ccy;
}

// 同币种相加；空集合返回 null（表示“没有金额”，而不是 0）。
export function sum(items, where = '金额汇总') {
  let total = null;
  for (const item of items) {
    if (item == null) continue;
    if (total == null) {
      total = money(item.minor, item.ccy);
    } else if (!sameCcy(total, item)) {
      throw new CurrencyMismatchError(total.ccy, item.ccy, where);
    } else {
      total.minor += item.minor;
    }
  }
  return total;
}

export function add(a, b, where) {
  if (a == null) return b == null ? null : money(b.minor, b.ccy);
  if (b == null) return money(a.minor, a.ccy);
  return sum([a, b], where);
}

export function negate(a) {
  return a == null ? null : money(-a.minor, a.ccy);
}

// 取绝对值（钱包退款常以负数表达，核对合资格净额时用正向最小单位）。
export function abs(a) {
  return a == null ? null : money(Math.abs(a.minor), a.ccy);
}

// 按币种分桶，保证不同币种永不混加。
export function groupByCurrency(items) {
  const buckets = new Map();
  for (const item of items) {
    if (item == null) continue;
    if (!buckets.has(item.ccy)) buckets.set(item.ccy, []);
    buckets.get(item.ccy).push(item);
  }
  const out = {};
  for (const [ccy, list] of buckets) out[ccy] = sum(list, `币种 ${ccy} 汇总`);
  return out;
}
