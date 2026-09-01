import type { EvalProvider } from './eval-spec.js'
import type { SelectedCaseSuiteKind } from './selected-cases.js'

function providerSuiteKind(provider: EvalProvider): SelectedCaseSuiteKind {
  if (provider === 'codex-trigger') return 'trigger'
  if (provider === 'codex-conversation') return 'conversation'
  return provider.type
}

export function validateEvalProviderSuiteKind(
  provider: EvalProvider,
  suiteKind: SelectedCaseSuiteKind,
): string[] {
  const expected = providerSuiteKind(provider)
  return expected === suiteKind
    ? []
    : [`EvalSpec provider requires selected suite kind ${expected}; received ${suiteKind}.`]
}

export function assertEvalProviderSuiteKind(
  provider: EvalProvider,
  suiteKind: SelectedCaseSuiteKind,
): void {
  const errors = validateEvalProviderSuiteKind(provider, suiteKind)
  if (errors.length > 0) throw new Error(errors.join('; '))
}
