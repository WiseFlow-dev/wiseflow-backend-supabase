export function log(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), event, ...meta }
  console.log(JSON.stringify(payload))
}

export function logError(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), level: 'error', event, ...meta }
  console.error(JSON.stringify(payload))
}
