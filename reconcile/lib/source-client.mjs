// 来源客户端：从本地合成接口（或任何遵守同一协议的发布方）收取资料。
// 关键区分：
//   404 = 该页在本批次“暂缺”，属于批次清单已声明但文件未到，不能当成业务拒绝；
//   503 = 发布方暂不可用，按指数退避重试，重试耗尽向上抛出由调用方决定；
//   200 = 文件已到，其内容里的 state（pending/confirmed/rejected/reversed）才是业务结果。
// 阶段（opening/interim/confirmed）只用于选择观察视角，业务含义以正文编号与有效时间为准。

export class SourceUnavailableError extends Error {
  constructor(url, attempts) {
    super(`来源服务暂不可用：${url}（重试 ${attempts} 次后仍为 503）`);
    this.name = 'SourceUnavailableError';
    this.code = 'SOURCE_UNAVAILABLE';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url, { timeoutMs = 5000, retries = 3, backoffMs = 100 } = {}) {
  let attempt = 0;
  let lastStatus = 0;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new Error(`读取来源超时：${url}`);
      throw error;
    }
    clearTimeout(timer);
    lastStatus = response.status;

    if (response.status === 503 && attempt < retries) {
      attempt += 1;
      await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    }
    if (response.status === 404) {
      return { status: 404, release: response.headers.get('x-release'), data: null };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`来源返回 ${response.status}：${url} ${body.slice(0, 200)}`);
    }
    return {
      status: 200,
      release: response.headers.get('x-release'),
      data: await response.json(),
    };
  }
  void lastStatus;
  throw new SourceUnavailableError(url, retries);
}

// 向合成门户提交操作。门户协议：
//   首次接收 201；完全相同的报文重发按原请求返回 200；同 key 换报文 409；
//   503 表示门户未能及时回传回执，请求“可能已收到”，留给后续 inspect 核实。
export async function postPortal(url, payload, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: response.status, data };
}
