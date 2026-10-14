import { NotFoundError, type Id, type Repo } from "@mgpl-diagnostics/db-kit";

/** The entity when it belongs to `orgId`, otherwise null (tenant isolation). */
export const owned = <T extends { orgId: Id }>(entity: T | null | undefined, orgId: Id): T | null => (entity && entity.orgId === orgId ? entity : null);

/** The entity when it belongs to `orgId`; NotFoundError otherwise (another organisation's data looks absent). */
export function mustOwn<T extends { orgId: Id }>(entity: T | null | undefined, orgId: Id, what: string, id: Id): T {
  const e = owned(entity, orgId);
  if (!e) throw new NotFoundError(what, id);
  return e;
}

/** Drops undefined and null values (partial updates). */
export const clean = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;

/** Branch-aware list: all branches, or a merge of each allowed branch, newest first. */
export async function scopedFind<T extends { id: Id }>(
  repo: Repo<T>,
  filter: Record<string, unknown>,
  scope: "all" | Id[],
  limit: number,
  offset: number,
  sortField: string,
): Promise<T[]> {
  const sort = { field: sortField as keyof T & string, dir: "desc" as const };
  if (scope === "all") return repo.find(filter as never, { limit, offset, sort });
  const lists = await Promise.all(scope.map((b) => repo.find({ ...filter, branchId: b } as never, { limit: limit + offset, sort })));
  const key = (x: T) => +((x as Record<string, unknown>)[sortField] as Date);
  return lists.flat().sort((a, b) => key(b) - key(a)).slice(offset, offset + limit);
}
