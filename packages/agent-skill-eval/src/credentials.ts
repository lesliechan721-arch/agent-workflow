const CREDENTIAL_PROXY_NAMES = new Set([
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
])

export function isCredentialEnvironmentName(name: string): boolean {
  return CREDENTIAL_PROXY_NAMES.has(name.toUpperCase()) ||
    /(?:api[_-]?key|access[_-]?key|private[_-]?key|token|password|passwd|secret|credential)/iu.test(name)
}

export function credentialEnvironmentNames(names: readonly string[]): string[] {
  return names.filter(isCredentialEnvironmentName)
}

export function credentialValues(
  sourceEnv: NodeJS.ProcessEnv,
  names: readonly string[],
): string[] {
  return [...new Set(credentialEnvironmentNames(names).flatMap((name) => {
    const value = sourceEnv[name]
    return value === undefined || value === '' ? [] : [value]
  }))].sort((left, right) => right.length - left.length)
}

export function secretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => {
    if (secret === '') return []
    const encoded = JSON.stringify(secret).slice(1, -1)
    return encoded === secret ? [secret] : [secret, encoded]
  }))].sort((left, right) => right.length - left.length)
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  return secretVariants(secrets).reduce(
    (current, secret) => current.replaceAll(secret, '[redacted]'),
    value,
  )
}
