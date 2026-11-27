const workItemIdPattern = /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isWorkItemId(value: string): boolean {
  return workItemIdPattern.test(value);
}

export function appendWorkItemId(draft: string, id: string): string {
  return draft + (draft && !/\s$/.test(draft) ? ' ' : '') + id;
}
