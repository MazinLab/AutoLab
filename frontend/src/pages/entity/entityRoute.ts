export function entityRoute(entityId: string): string {
  const id = encodeURIComponent(entityId);
  return `/entity/${id}`;
}
