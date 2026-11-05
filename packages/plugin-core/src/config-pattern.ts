/* Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * https://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Pattern translation adapted from re2-wasm 1.0.2, src/re2.ts.
 */
import re2Wasm from 're2-wasm/build/wasm/re2.js'
import type { WrappedRE2 } from 're2-wasm/build/wasm/re2.js'

// The high-level RE2 constructor leaks its native handle on invalid patterns
// and allocates capture-name containers without deleting them. Own the native
// binding directly so all three handles can be released synchronously.
interface NativeHandle {
  delete(): void
}

export class ConfigPatternMemoryError extends Error {
  readonly code = 'configValidationMemoryExhausted'

  constructor() {
    super('configValidationMemoryExhausted: configuration pattern validation ran out of memory. Restart AW and retry.')
  }
}

function translatePattern(pattern: string): string {
  // Preserve the high-level RE2 wrapper's escaping and Unicode translations.
  pattern = pattern.replace(/(^|[^\\])((?:\\\\)*)\//g, '$1$2\\/')
  if (pattern === '') return '(?:)'
  const result: string[] = []
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index]!
    if (char === '\\' && index + 1 < pattern.length) {
      const escape = pattern[index + 1]!
      if (escape === 'c' && index + 2 < pattern.length) {
        const code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(pattern[index + 2]!) + 1
        if (code >= 0) {
          result.push(`\\x${code.toString(16).padStart(2, '0').toUpperCase()}`)
          index += 3
          continue
        }
      }
      if (escape === 'u' && index + 2 < pattern.length) {
        if (/^[0-9a-f]$/iu.test(pattern[index + 2]!)) {
          let end = index + 3
          while (end < index + 6 && end < pattern.length && /^[0-9a-f]$/iu.test(pattern[end]!)) end += 1
          result.push(`\\x{${pattern.slice(index + 2, end)}}`)
          index = end
          continue
        }
        if (pattern[index + 2] === '{') {
          result.push('\\x')
          index += 2
          continue
        }
      }
      result.push(char, escape)
      index += 2
      continue
    }
    if (char === '/') {
      result.push('\\/')
    } else if (pattern.slice(index, index + 3) === '(?<'
      && pattern[index + 3] !== '=' && pattern[index + 3] !== '!') {
      result.push('(?P<')
      index += 3
      continue
    } else {
      result.push(char)
    }
    index += 1
  }
  return result.join('')
}

export function testConfigPattern(pattern: string, value?: string): boolean {
  try {
    // re2-wasm's declarations omit the embind delete() method.
    const regex = new re2Wasm.WrappedRE2(translatePattern(pattern), false, false, false) as WrappedRE2 & NativeHandle
    try {
      if (!regex.ok()) throw new SyntaxError('Invalid configuration pattern.')
      const names = regex.capturingGroupNames() as ReturnType<WrappedRE2['capturingGroupNames']> & NativeHandle
      try {
        const keys = names.keys() as ReturnType<typeof names.keys> & NativeHandle
        try {
          const known: Record<string, number> = {}
          for (let index = 0; index < keys.size(); index += 1) {
            const key = keys.get(index)
            const name = names.get(key)
            if (name in known) throw new SyntaxError('Invalid configuration capture group name.')
            known[name] = key
          }
        } finally {
          keys.delete()
        }
      } finally {
        names.delete()
      }
      return value === undefined || regex.match(value, 0, false).index >= 0
    } finally {
      regex.delete()
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot enlarge memory arrays')) {
      throw new ConfigPatternMemoryError()
    }
    throw error
  }
}
