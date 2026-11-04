import { BadRequestException } from '@nestjs/common';

export interface PageCursor {
  createdAt: string;
  id: string;
}

export function pageSize(value?: string): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer.');
  }
  return Math.min(parsed, 100);
}

export function decodeCursor(value?: string): PageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      throw new Error('Bad cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is invalid.');
  }
}

export function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(row.created_at).toISOString(),
      id: row.id,
    }),
  ).toString('base64url');
}

export function paginated<T extends { created_at: Date; id: string }>(
  rows: T[],
  limit: number,
  map: (row: T) => unknown,
) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(map),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}
