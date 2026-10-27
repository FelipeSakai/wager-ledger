// node-postgres may lose the socket code when a rollback is attempted on a dead client.
// Keep this allowlist tied to driver errors; unknown SQL/business errors must propagate.
export function isPostgresUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(
      code,
    ) ||
    /^08[0-9A-Z]{3}$/.test(code)
  )
    return true;
  if (code) return false;
  return (
    error instanceof Error &&
    [
      'Connection terminated unexpectedly',
      'Client has encountered a connection error and is not queryable',
    ].includes(error.message)
  );
}
