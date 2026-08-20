function isJavaScriptIdentifierStart(value) {
  return value !== undefined && /[A-Za-z_$]/u.test(value);
}

function isJavaScriptIdentifierPart(value) {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value);
}

function decodeJavaScriptEscape(source, index) {
  const escaped = source[index];
  const simple = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '0': '\0',
  };
  if (escaped === '\n') return { value: '', next: index + 1 };
  if (escaped === '\r') {
    return { value: '', next: source[index + 1] === '\n' ? index + 2 : index + 1 };
  }
  if (escaped && Object.prototype.hasOwnProperty.call(simple, escaped)) {
    return { value: simple[escaped], next: index + 1 };
  }
  if (escaped === 'x') {
    const hex = source.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 3 };
    }
  }
  if (escaped === 'u') {
    if (source[index + 1] === '{') {
      const close = source.indexOf('}', index + 2);
      const hex = close === -1 ? '' : source.slice(index + 2, close);
      if (/^[0-9A-Fa-f]{1,6}$/u.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: close + 1 };
      }
    } else {
      const hex = source.slice(index + 1, index + 5);
      if (/^[0-9A-Fa-f]{4}$/u.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 5 };
      }
    }
  }
  return { value: escaped ?? '', next: Math.min(index + 1, source.length) };
}

function tokenizeJavaScriptImports(source) {
  const tokens = [];
  let index = 0;
  let previousToken;

  const push = (token) => {
    tokens.push(token);
    previousToken = token;
  };

  const skipQuotedString = (quote) => {
    index += 1;
    let value = '';
    while (index < source.length) {
      const current = source[index];
      if (current === quote) {
        index += 1;
        push({ kind: 'string', value });
        return;
      }
      if (current === '\\') {
        const decoded = decodeJavaScriptEscape(source, index + 1);
        value += decoded.value;
        index = decoded.next;
        continue;
      }
      value += current;
      index += 1;
    }
  };

  const canStartRegexLiteral = () => {
    if (!previousToken) return true;
    if (previousToken.kind === 'identifier') {
      return new Set([
        'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
        'return', 'throw', 'typeof', 'void', 'yield',
      ]).has(previousToken.value);
    }
    return previousToken.kind === 'punctuation'
      && ['(', '[', '{', '=', ':', ',', ';', '!', '&', '|', '?', '~', '+', '-', '*', '%', '^', '<', '>']
        .includes(previousToken.value);
  };

  const skipRegexLiteral = () => {
    index += 1;
    let inCharacterClass = false;
    while (index < source.length) {
      const current = source[index];
      if (current === '\\') {
        index = Math.min(index + 2, source.length);
        continue;
      }
      if (current === '[') inCharacterClass = true;
      if (current === ']') inCharacterClass = false;
      index += 1;
      if (current === '/' && !inCharacterClass) {
        while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1;
        push({ kind: 'literal', value: 'regex' });
        return;
      }
      if (current === '\n' || current === '\r') return;
    }
  };

  const scanCode = (stopAtTemplateExpressionEnd) => {
    let braceDepth = 0;
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];
      if (/\s/u.test(current)) {
        index += 1;
        continue;
      }
      if (current === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        index += 2;
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
        index = Math.min(index + 2, source.length);
        continue;
      }
      if (current === '\'' || current === '"') {
        skipQuotedString(current);
        continue;
      }
      if (current === '`') {
        index += 1;
        while (index < source.length) {
          if (source[index] === '\\') {
            index = Math.min(index + 2, source.length);
          } else if (source[index] === '`') {
            index += 1;
            break;
          } else if (source[index] === '$' && source[index + 1] === '{') {
            index += 2;
            const outerPrevious = previousToken;
            previousToken = undefined;
            scanCode(true);
            previousToken = outerPrevious;
          } else {
            index += 1;
          }
        }
        push({ kind: 'literal', value: 'template' });
        continue;
      }
      if (current === '/' && canStartRegexLiteral()) {
        skipRegexLiteral();
        continue;
      }
      if (isJavaScriptIdentifierStart(current)) {
        const start = index;
        index += 1;
        while (isJavaScriptIdentifierPart(source[index])) index += 1;
        push({ kind: 'identifier', value: source.slice(start, index) });
        continue;
      }
      if (/[0-9]/u.test(current)) {
        index += 1;
        while (/[A-Za-z0-9_.]/u.test(source[index] ?? '')) index += 1;
        push({ kind: 'literal', value: 'number' });
        continue;
      }
      if (current === '{') {
        braceDepth += 1;
        index += 1;
        push({ kind: 'punctuation', value: current });
        continue;
      }
      if (current === '}') {
        if (stopAtTemplateExpressionEnd && braceDepth === 0) {
          index += 1;
          return;
        }
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        push({ kind: 'punctuation', value: current });
        continue;
      }
      index += 1;
      push({ kind: 'punctuation', value: current });
    }
  };

  scanCode(false);
  return tokens;
}

export function scanJavaScriptImportSpecifiers(source) {
  const references = [];
  const tokens = tokenizeJavaScriptImports(source);
  let pendingStatic;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.value === ';') pendingStatic = undefined;
    if (pendingStatic && token.kind === 'identifier' && token.value === 'from') {
      const specifier = tokens[index + 1];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: pendingStatic });
      }
      pendingStatic = undefined;
      continue;
    }
    if (token.kind !== 'identifier' || previous?.value === '.') continue;
    if (token.value === 'require' && tokens[index + 1]?.value === '(') {
      const specifier = tokens[index + 2];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'require' });
      }
      continue;
    }
    if (
      token.value === 'require'
      && tokens[index + 1]?.value === '.'
      && tokens[index + 2]?.kind === 'identifier'
      && tokens[index + 2]?.value === 'resolve'
      && tokens[index + 3]?.value === '('
    ) {
      const specifier = tokens[index + 4];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'require-resolve' });
      }
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    pendingStatic = undefined;
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      const specifier = tokens[index + 2];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'dynamic-import' });
      }
      continue;
    }
    if (token.value === 'import' && tokens[index + 1]?.kind === 'string') {
      references.push({ specifier: tokens[index + 1].value, kind: 'import' });
      continue;
    }
    pendingStatic = token.value;
  }

  return references;
}
