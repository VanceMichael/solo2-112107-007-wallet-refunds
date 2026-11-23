// 事件存储：只追加（append-only）的 JSONL 日志 + 派生快照。
// 所有业务决定都先落事件，再由 projection 重放得到当前状态，保证可追溯、可重建。
// 同一来件文件按内容指纹去重，钱包事件按网络内业务事件号去重，天然支持重发与跨日续跑。

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export function fingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    this.logPath = join(dir, 'events.log');
    this.snapshotPath = join(dir, 'snapshot.json');
    this.lockPath = join(dir, '.lock');
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, '');
  }

  // 轻量进程锁：CLI 是短进程，持锁期间写日志与快照，避免两个经办并发串写。
  acquire() {
    if (existsSync(this.lockPath)) {
      const stale = readFileSync(this.lockPath, 'utf8');
      throw new Error(`存储目录已被其他经办占用（${stale}）。如确认无进程运行，可删除 ${this.lockPath}`);
    }
    writeFileSync(this.lockPath, `${process.pid}@${new Date().toISOString()}`);
  }

  release() {
    if (existsSync(this.lockPath)) {
      const owner = readFileSync(this.lockPath, 'utf8');
      if (owner.startsWith(String(process.pid) + '@')) unlinkSync(this.lockPath);
    }
  }

  readEvents() {
    const text = readFileSync(this.logPath, 'utf8');
    if (!text.trim()) return [];
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  append(event) {
    appendFileSync(this.logPath, JSON.stringify(event) + '\n');
  }

  // 原子写快照：先写临时文件再 rename，崩溃也不会留下半截快照。
  writeSnapshot(state) {
    const tmp = this.snapshotPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.snapshotPath);
  }

  readSnapshot() {
    return existsSync(this.snapshotPath) ? JSON.parse(readFileSync(this.snapshotPath, 'utf8')) : null;
  }

  // 保存原始来件（不可信数据单独存放），返回留档路径与指纹。
  archiveInbox(kind, key, payload) {
    const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = join(this.dir, 'inbox', `${kind}__${safe}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));
    return { file, hash: fingerprint(payload) };
  }

  hasInboxHash(hash) {
    return this.readEvents().some((event) => event.payloadHash === hash);
  }
}
