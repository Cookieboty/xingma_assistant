import { randomUUID } from 'crypto';

/** 生成业务主键（内存/落库均可） */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id.replace(/-/g, '').slice(0, 16)}` : id;
}
