// 来件结构校验。上游资料是不可信数据，进入事件日志前先做最小结构校验，
// 校验失败要带上来源路径，方便对账员定位是哪一方的哪一页坏了。

export class ValidationError extends Error {
  constructor(path, message) {
    super(`来件校验失败（${path}）：${message}`);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_FAILED';
    this.path = path;
  }
}

export function requireObject(value, path) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(path, '应为对象');
  }
  return value;
}

export function requireArray(value, path) {
  if (!Array.isArray(value)) throw new ValidationError(path, '应为数组');
  return value;
}

export function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(path, `应为非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireInteger(value, path) {
  if (!Number.isInteger(value)) throw new ValidationError(path, `应为整数最小单位，收到 ${JSON.stringify(value)}`);
  return value;
}

export function requireBoolean(value, path) {
  if (typeof value !== 'boolean') throw new ValidationError(path, `应为布尔值，收到 ${JSON.stringify(value)}`);
  return value;
}

export function optional(value, predicate) {
  return value == null ? undefined : predicate(value);
}

export function requireOneOf(value, path, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(path, `取值 ${JSON.stringify(value)} 不在允许集合 ${allowed.join('、')} 中`);
  }
  return value;
}
