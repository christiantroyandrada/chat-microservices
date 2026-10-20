export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function canonicalUserId(value: string): string {
  return UUID.test(value.trim()) ? value.trim().toLowerCase() : value
}
