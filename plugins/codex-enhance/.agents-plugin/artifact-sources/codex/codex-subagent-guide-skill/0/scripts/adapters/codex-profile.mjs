/*! Bundled dependency licenses
smol-toml@1.9.1
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

*/
import { createRequire as awCreateRequire } from 'node:module'; const require = awCreateRequire(import.meta.url);

// skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isIP } from "node:net";

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
      state = 6;
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(ctx, key, table2, meta, type) {
  let t = table2;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var BARE_KEY = /^[a-z0-9-_]+$/i;
var HAS_WELLFORMED = !!"".isWellFormed;
function extendedTypeOf(obj) {
  let type = typeof obj;
  if (type === "object") {
    if (Array.isArray(obj))
      return "array";
    if (typeof obj.getUTCDate === "function" && obj instanceof Date)
      return "date";
    if (globalThis.Temporal) {
      if (obj.until) {
        if (obj instanceof Temporal.ZonedDateTime)
          return "temporal/tz+uc";
        if (obj instanceof Temporal.PlainDateTime || obj instanceof Temporal.PlainDate)
          return "temporal/uc";
        if (obj instanceof Temporal.PlainTime || obj instanceof Temporal.Instant)
          return "temporal";
        if (obj instanceof Temporal.PlainYearMonth)
          return "temporal/x";
      } else if (obj.toPlainDate && obj instanceof Temporal.PlainMonthDay || obj.negated && obj instanceof Temporal.Duration) {
        return "temporal/x";
      }
    }
  }
  return type;
}
function isArrayOfTables(obj) {
  for (let i = 0; i < obj.length; i++) {
    if (extendedTypeOf(obj[i]) !== "object")
      return false;
  }
  return obj.length != 0;
}
function formatWellFormedStringUnchecked(s) {
  return JSON.stringify(s).replaceAll("\x7F", "\\u007f");
}
function formatString(s) {
  return formatWellFormedStringUnchecked(HAS_WELLFORMED ? s.toWellFormed() : s);
}
function formatKey(s) {
  if (BARE_KEY.test(s))
    return s;
  if (HAS_WELLFORMED && !s.isWellFormed())
    throw new RangeError("key contains illegal lone surrogates");
  return formatWellFormedStringUnchecked(s);
}
function stringifyValue(val, type, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  switch (type) {
    // @ts-expect-error -- intentional fallthrough case
    case "number":
      if (isNaN(val))
        return "nan";
      if (val === Infinity)
        return "inf";
      if (val === -Infinity)
        return "-inf";
      if (Number.isInteger(val) && (numberAsFloat || !Number.isSafeInteger(val)))
        return val.toFixed(1);
    case "bigint":
    case "boolean":
    case "temporal":
      return val.toString();
    case "string":
      return formatString(val);
    case "date":
      if (isNaN(val.getTime()))
        throw new TypeError("cannot serialize invalid date");
      return val.toISOString();
    case "object":
      return stringifyInlineTable(val, depth, numberAsFloat, strictTemporal);
    case "array":
      return stringifyArray(val, depth, numberAsFloat, strictTemporal);
    // @ts-expect-error -- intentional fallthrough case
    case "temporal/tz+uc":
      if (strictTemporal) {
        let tz = val.timeZoneId;
        let tzc = tz.charCodeAt(0);
        if (
          // Classic offset
          tzc !== 43 && tzc !== 45 && // Fast pre-check pass; see below for the actually accepted values
          (tzc !== 85 && tzc !== 71 && tzc !== 90 && tzc !== 69 || // UTC and its aliases; Temporal implementations don't all canonicalise unfortunately
          tz !== "UTC" && tz !== "UCT" && tz !== "Universal" && tz !== "Zulu" && // GMT is a TZ but it's for all intents and purposes equivalent to UTC. Safe to downgrade.
          !tz.startsWith("GMT") && tz !== "Greenwich" && // Etc/* are all safe to downgrade to offset (either UTC, GMT, or offset)
          !tz.startsWith("Etc/"))
        ) {
          throw new TypeError("Temporal objects with an IANA timezone are not allowed in Temporal strict mode");
        }
      }
    case "temporal/uc":
      if (strictTemporal && val.calendarId !== "iso8601")
        throw new TypeError("Temporal objects with a non-default calendar are not allowed in Temporal strict mode");
      return val.toString({
        calendarName: "never",
        timeZoneName: "never"
      });
    case "temporal/x":
      throw new TypeError("Unsupported " + val[Symbol.toStringTag]);
  }
}
function stringifyInlineTable(obj, depth, numberAsFloat, strictTemporal) {
  let keys = Object.keys(obj);
  if (keys.length === 0)
    return "{}";
  let res = "{ ";
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (i)
      res += ", ";
    res += formatKey(k) + " = " + stringifyValue(obj[k], extendedTypeOf(obj[k]), depth - 1, numberAsFloat, strictTemporal);
  }
  return res + " }";
}
function stringifyArray(array, depth, numberAsFloat, strictTemporal) {
  if (array.length === 0)
    return "[]";
  let res = "[ ";
  for (let i = 0; i < array.length; i++) {
    if (i)
      res += ", ";
    if (array[i] === null || array[i] === void 0) {
      throw new TypeError("arrays cannot contain null or undefined values");
    }
    res += stringifyValue(array[i], extendedTypeOf(array[i]), depth - 1, numberAsFloat, strictTemporal);
  }
  return res + " ]";
}
function stringifyArrayTable(array, key, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let res = "";
  for (let i = 0; i < array.length; i++) {
    res += `${res && "\n"}[[${key}]]
`;
    res += stringifyTable(0, array[i], key, depth, numberAsFloat, strictTemporal);
  }
  return res;
}
function stringifyTable(tableKey, obj, prefix, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let preamble = "";
  let tables = "";
  let keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (obj[k] !== null && obj[k] !== void 0) {
      let type = extendedTypeOf(obj[k]);
      if (type === "symbol" || type === "function") {
        throw new TypeError(`cannot serialize values of type '${type}'`);
      }
      let key = formatKey(k);
      if (type === "array" && isArrayOfTables(obj[k])) {
        tables += (tables && "\n") + stringifyArrayTable(obj[k], prefix ? `${prefix}.${key}` : key, depth - 1, numberAsFloat, strictTemporal);
      } else if (type === "object") {
        let tblKey = prefix ? `${prefix}.${key}` : key;
        tables += (tables && "\n") + stringifyTable(tblKey, obj[k], tblKey, depth - 1, numberAsFloat, strictTemporal);
      } else {
        preamble += key;
        preamble += " = ";
        preamble += stringifyValue(obj[k], type, depth, numberAsFloat, strictTemporal);
        preamble += "\n";
      }
    }
  }
  if (tableKey && (preamble || !tables))
    preamble = preamble ? `[${tableKey}]
${preamble}` : `[${tableKey}]`;
  return preamble && tables ? `${preamble}
${tables}` : preamble || tables;
}
function stringify(obj, { maxDepth = 1e3, numbersAsFloat = false, strictTemporal = false } = {}) {
  if (extendedTypeOf(obj) !== "object") {
    throw new TypeError("stringify can only be called with an object");
  }
  let str = stringifyTable(0, obj, "", maxDepth, numbersAsFloat, strictTemporal);
  if (str[str.length - 1] !== "\n")
    return str + "\n";
  return str;
}

// scripts/node_modules/.pnpm/smol-toml@1.9.1/node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// skills/codex-subagent-guide/scripts/file-selection/contracts.mjs
var LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  selectors: 4096,
  patterns: 8192,
  patternBytes: 32768,
  braceRange: 1e3,
  expandedPatterns: 8192,
  entries: 1e5,
  operations: 5e5,
  files: 1e5,
  ignoreFileBytes: 1024 * 1024,
  ignoreTotalBytes: 4 * 1024 * 1024,
  durationMs: 3e4
});

// skills/codex-subagent-guide/scripts/runtime/contracts.mjs
var LIMITS2 = Object.freeze({
  taskBytes: 262144,
  instructionBytes: 262144,
  promptBytes: 524352,
  requestBytes: 8388608,
  outputBytes: 4194304,
  logBytes: 8388608,
  resultBytes: 33554432,
  messageBytes: 4096,
  messageBodyBytes: 24576,
  messageFrameBytes: 262144,
  controlFrameBytes: 4096,
  deliveryFrameBytes: 16384,
  receiveMs: 6e5,
  waitMs: 6e5,
  maximumWaitMs: 18e5
});
var RUNTIME_KEYS = Object.freeze(["subagentCommands", "subagentRetentionHours"]);
var STATES = Object.freeze(["completed", "failed", "cancelled", "unknown"]);
var RuntimeError = class extends Error {
  constructor(code, message, recoveryActions = []) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.recoveryActions = recoveryActions;
  }
};
function fail(code, message, recoveryActions = []) {
  throw new RuntimeError(code, message, recoveryActions);
}

// skills/codex-subagent-guide/scripts/adapters/codex-hooks.mjs
var hookEvents = Object.fromEntries(["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt"].map((name) => [name, name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`)]));
var table = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function mergeStateRecord(base, overlay) {
  const result = { ...base, ...overlay };
  for (const [key, value] of Object.entries(overlay)) {
    if (table(base?.[key]) && table(value)) result[key] = mergeStateRecord(base[key], value);
  }
  return result;
}
function convertHooks(value, { invalid, unsupported }) {
  if (!table(value)) invalid("hooks", "Hooks must be a table for source-state mapping.");
  const result = Object.assign(/* @__PURE__ */ Object.create(null), value);
  for (const [event, groups] of Object.entries(value)) {
    if (event === "state") {
      if (!table(groups)) invalid("hooks.state", "Hook state must be a table.");
      result.state = /* @__PURE__ */ Object.create(null);
      for (const [index, [key, state]] of Object.entries(groups).entries()) {
        const field2 = `hooks.state[${index}]`;
        if (!table(state)) invalid(field2, "A hook state record must be a table.");
        if (Object.hasOwn(state, "enabled") && typeof state.enabled !== "boolean") invalid(`${field2}.enabled`, "Hook enabled state must be a boolean.");
        if (Object.hasOwn(state, "trusted_hash") && typeof state.trusted_hash !== "string") invalid(`${field2}.trusted_hash`, "Hook trust state must be a string.");
        if (key.trim()) result.state[key.trim()] = mergeStateRecord(result.state[key.trim()], state);
      }
      continue;
    }
    const known = Object.hasOwn(hookEvents, event);
    const field = known ? `hooks.${event}` : "hooks.<event>";
    if (!Array.isArray(groups)) {
      if (known) invalid(field, "Hook event groups must be an array for source-state mapping.");
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      const groupField = `${field}[${groupIndex}]`;
      if (!table(group)) {
        if (known) invalid(groupField, "A hook group must be a table for source-state mapping.");
        continue;
      }
      if (Object.hasOwn(group, "hooks") && !Array.isArray(group.hooks)) {
        if (known) invalid(`${groupField}.hooks`, "Hook handlers must be an array for source-state mapping.");
        continue;
      }
      for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
        const handlerField = `${groupField}.hooks[${handlerIndex}]`;
        if (!table(handler)) {
          if (known) invalid(handlerField, "A hook handler must be a table for source-state mapping.");
          continue;
        }
        if (handler.type === "prompt" || handler.type === "agent") unsupported(`${handlerField}.type`, "This hook handler cannot execute in the supported Codex backend.");
        if (event === "SessionEnd" && handler.type === "mcp_tool") unsupported(`${handlerField}.type`, "The Codex backend does not execute MCP tool handlers for SessionEnd.");
      }
    }
  }
  return result;
}

// skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs
var threadFields = /* @__PURE__ */ new Set([
  "model",
  "service_tier",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope",
  "model_post_turn_compact_threshold_percent",
  "compact_prompt",
  "experimental_compact_prompt_file",
  "instructions",
  "developer_instructions",
  "model_instructions_file",
  "include_environment_context",
  "include_environment_context_time",
  "project_doc_max_bytes",
  "project_doc_fallback_filenames",
  "allow_login_shell",
  "shell_environment_policy",
  "background_terminal_max_timeout",
  "tool_output_token_limit",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "sandbox_workspace_write",
  "permissions",
  "default_permissions",
  "auto_review",
  "web_search",
  "tools",
  "mcp_servers",
  "mcp_optional_startup_grace_ms",
  "skills",
  "agents",
  "hooks",
  "thread_unload_delay_secs"
]);
var structuredFeatures = /* @__PURE__ */ new Set(["code_mode", "multi_agent_v2", "network_proxy", "sleep_tool", "runtime_agent_instances"]);
var aliases = [["agents", "max_threads", "max_concurrent_threads_per_session"], ["memories", "no_memories_if_mcp_or_web_search", "disable_on_external_context"]];
var absolutePaths = ["model_instructions_file", "experimental_compact_prompt_file", "model_catalog_json", "sqlite_home", "log_dir"];
var unsupportedFields = {
  allow_symlinked_codex_home: "Runtime overrides cannot preserve the required host user-layer identity.",
  profile: "Use the profile-v2 selection entry instead of a configuration profile selector.",
  profiles: "Legacy profile definitions cannot be used as profile-v2 runtime overrides.",
  js_repl_node_path: "The Codex backend marks this deprecated setting as ignored.",
  js_repl_node_module_dirs: "The Codex backend marks this deprecated setting as ignored.",
  tui: "This execution mode has no terminal UI consumer.",
  desktop: "This execution mode has no desktop UI consumer.",
  file_opener: "This execution mode has no file-opener consumer."
};
function normalizeAliases(value) {
  if (!table(value)) return value;
  const result = Object.assign(/* @__PURE__ */ Object.create(null), value);
  for (const [parent, alias, canonical] of aliases) {
    if (!table(result[parent]) || !Object.hasOwn(result[parent], alias)) continue;
    result[parent] = Object.assign(/* @__PURE__ */ Object.create(null), result[parent]);
    if (!Object.hasOwn(result[parent], canonical)) result[parent][canonical] = result[parent][alias];
    delete result[parent][alias];
  }
  return result;
}
var asciiLower = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
function normalizeHost(value) {
  let host = value.trim();
  if (host.startsWith("[") && host.includes("]")) host = host.slice(1, host.indexOf("]"));
  else if ([...host].filter((letter) => letter === ":").length === 1) host = host.split(":", 1)[0];
  host = asciiLower(host).replace(/\.+$/, "");
  for (const separator of ["%25", "%"]) {
    const index = host.indexOf(separator);
    if (index >= 0 && isIP(host.slice(0, index))) return `${host.slice(0, index)}%${host.slice(index + separator.length)}`;
  }
  return host;
}
function normalizeKeys(value, normalize) {
  const result = /* @__PURE__ */ Object.create(null);
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) result[normalize(key)] = item;
  return result;
}
function mergeConfiguration(left, right, { platform = process.platform } = {}) {
  const merge = (base, overlay, keys) => {
    const feature = keys.length === 2 && keys[0] === "features" && structuredFeatures.has(keys[1]);
    if (feature && typeof base === "boolean" && table(overlay)) base = { enabled: base };
    else if (feature && table(base) && typeof overlay === "boolean") overlay = { enabled: overlay };
    if (!table(overlay)) return Array.isArray(overlay) ? overlay.map((item) => merge(void 0, item, [...keys, "[]"])) : overlay;
    let output = table(base) ? Object.assign(/* @__PURE__ */ Object.create(null), base) : /* @__PURE__ */ Object.create(null);
    if (keys.length === 1 && keys[0] === "shell_environment_policy") {
      if (Object.hasOwn(overlay, "filters")) {
        delete output.exclude;
        delete output.include_only;
      } else if (Object.hasOwn(overlay, "exclude") || Object.hasOwn(overlay, "include_only")) delete output.filters;
    }
    const filters = keys.length === 2 && keys[0] === "shell_environment_policy" && keys[1] === "filters";
    const domains = keys.length === 4 && keys[0] === "permissions" && keys[2] === "network" && keys[3] === "domains" || keys.length === 3 && keys[0] === "application" && keys[1] === "network" && keys[2] === "domains";
    if (filters || domains) {
      const normalize = filters ? (key) => key.toLowerCase() : normalizeHost;
      output = normalizeKeys(output, normalize);
      overlay = normalizeKeys(overlay, normalize);
    }
    if (keys.length === 3 && keys[0] === "features" && structuredFeatures.has(keys[1]) && keys[2] === "credentials") {
      for (const [provider, value] of Object.entries(overlay)) {
        if (!Array.isArray(value?.env)) continue;
        for (const [existing, previous] of Object.entries(output)) {
          const sources = Array.isArray(overlay[existing]?.env) ? overlay[existing].env : previous?.env;
          if (existing !== provider && Array.isArray(sources) && sources.some((source) => typeof source === "string" && value.env.some((next) => typeof next === "string" && (source === next || platform === "win32" && asciiLower(source) === asciiLower(next))))) delete output[existing];
        }
      }
    }
    for (const [key, value] of Object.entries(overlay)) output[key] = merge(output[key], value, [...keys, key]);
    return output;
  };
  return merge(normalizeAliases(left), normalizeAliases(right), []);
}
function jsonValue(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error();
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) throw new Error();
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (table(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  throw new Error();
}
function checkTomlValue(value) {
  if (value instanceof Date) fail("profileConversionUnsupported", "The TOML parser cannot preserve original date and time precision. Use a configuration representation supported without loss.");
  if (Object.is(value, -0)) fail("profileConversionUnsupported", "The TOML serializer cannot preserve negative floating-point zero without loss.");
  if (Array.isArray(value)) {
    for (const item of value) checkTomlValue(item);
  } else if (table(value)) {
    for (const item of Object.values(value)) checkTomlValue(item);
  } else if (!["string", "boolean", "number", "bigint"].includes(typeof value)) fail("profileConversionUnsupported", "The value cannot be represented as TOML without loss.");
}
function parseProfile(text, diagnostics = []) {
  try {
    const document = parse(text, { integersAsBigInt: true });
    checkTomlValue(document);
    return document;
  } catch (error) {
    if (error.code === "profileConversionUnsupported") {
      diagnostics.push({ code: error.code, field: "profile", message: error.message });
      throw error;
    }
    diagnostics.push({ code: "profileValueInvalid", field: "profile", message: "The profile is not valid TOML." });
    fail("profileValueInvalid", "The profile is not valid TOML.");
  }
}
function tomlValue(value) {
  checkTomlValue(value);
  const wrapper = stringify({ value: [[value]] }, { numbersAsFloat: true });
  return wrapper.slice(wrapper.indexOf("=") + 1).trim().replace(/^\[\s*\[\s*/, "").replace(/\s*\]\s*\]$/, "");
}
function parseConfigArgument(argument, { diagnostics = [] } = {}) {
  let document;
  try {
    try {
      document = parse(argument, { integersAsBigInt: true });
    } catch {
      const equals = argument.indexOf("=");
      const raw = argument.slice(equals + 1);
      if (equals < 1 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      document = parse(`${argument.slice(0, equals)}=${tomlValue(raw)}`, { integersAsBigInt: true });
    }
  } catch {
    const message = "A config override is not a valid TOML assignment.";
    diagnostics.push({ code: "adapterArgumentsInvalid", field: "args.config", message });
    fail("adapterArgumentsInvalid", message);
  }
  try {
    checkTomlValue(document);
  } catch (error) {
    if (error.code === "profileConversionUnsupported") diagnostics.push({ code: error.code, field: "args.config", message: error.message });
    throw error;
  }
  return document;
}
function convertProfile(document, { diagnostics = [], explicit = false, baseDir = process.cwd(), environment = process.env, platform = process.platform, privateMcpServer } = {}) {
  const report = (code, field, message) => {
    diagnostics.push({ code, field, message });
    fail(code, message);
  };
  const invalid = (field, message) => report(explicit ? "adapterArgumentsInvalid" : "profileValueInvalid", field, message);
  const unsupported = (field, message) => report("profileFieldUnsupported", field, message);
  const conversionUnsupported = (field, message) => report("profileConversionUnsupported", field, message);
  const controlled = (field, message) => report("adapterArgumentsInvalid", field, message);
  if (!table(document)) invalid("profile", "Configuration must be a TOML table.");
  for (const [key, message] of Object.entries(unsupportedFields)) if (Object.hasOwn(document, key)) unsupported(key, message);
  for (const key of ["cwd", "bypass_hook_trust"]) {
    if (Object.hasOwn(document, key)) controlled(key, key === "cwd" ? "AW controls the workspace for this task." : "AW controls hook trust bypass. Use the executor codexBypassHookTrust setting.");
  }
  if (table(document.agents) && Object.hasOwn(document.agents, "job_max_runtime_seconds")) unsupported("agents.job_max_runtime_seconds", "The Codex backend accepts this removed agent-job setting for compatibility but does not execute it.");
  if (table(document.orchestrator) && Object.hasOwn(document.orchestrator, "skills")) unsupported("orchestrator.skills", "The Codex backend ignores this deprecated setting.");
  if (table(document.ghost_snapshot)) {
    for (const field of ["ignore_large_untracked_files", "ignore_untracked_files_over_bytes", "ignore_large_untracked_dirs", "large_untracked_dir_warning_threshold", "disable_warnings"]) {
      if (Object.hasOwn(document.ghost_snapshot, field)) unsupported(`ghost_snapshot.${field}`, "The Codex backend ignores this deprecated setting.");
    }
  }
  if (Object.hasOwn(document, "mcp_servers") && !table(document.mcp_servers)) invalid("mcp_servers", "MCP servers must be a table for the AW private binding merge.");
  if (privateMcpServer && table(document.mcp_servers) && Object.hasOwn(document.mcp_servers, privateMcpServer)) controlled("mcp_servers.<private>", "The configuration conflicts with the AW private MCP binding.");
  if (Object.hasOwn(document, "model") && typeof document.model !== "string") invalid("model", "The model mapping must be a string.");
  const result = mergeConfiguration({}, document, { platform });
  if (Object.hasOwn(result, "hooks")) result.hooks = convertHooks(result.hooks, { invalid, unsupported });
  const paths = platform === "win32" ? path.win32 : path.posix;
  const resolvePath = (value, field) => {
    if (typeof value !== "string") return value;
    let target = value;
    if (platform === "win32") {
      target = target.replace(/^\\\\[?.]\\UNC\\/, "\\\\").replace(/^\\\\[?.]\\(?=[A-Za-z]:[\\/])/, "");
      if (/^[A-Za-z]:(?![\\/])/.test(target) || /^\\\\[?.]\\/.test(target)) conversionUnsupported(field, "This Windows path representation cannot be converted reliably. Use an absolute drive or UNC path.");
    }
    const homeRelative = target === "~" || target.startsWith("~/") || platform === "win32" && target.startsWith("~\\");
    if (homeRelative) {
      const home = platform === "win32" ? environment.USERPROFILE || (platform === process.platform ? os.homedir() : void 0) : environment.HOME || (platform === process.platform ? os.homedir() : void 0);
      if (!home || !paths.isAbsolute(home)) conversionUnsupported(field, "The effective home directory cannot be resolved. Use an absolute path.");
      target = paths.join(home, target.slice(1).replace(platform === "win32" ? /^[\\/]+/ : /^\/+/, ""));
    }
    if (!paths.isAbsolute(baseDir)) conversionUnsupported(field, "The configuration source directory cannot be resolved. Use an absolute path.");
    return paths.resolve(baseDir, target);
  };
  for (const field of absolutePaths) if (Object.hasOwn(result, field)) result[field] = resolvePath(result[field], field);
  if (Array.isArray(result.sandbox_workspace_write?.writable_roots)) result.sandbox_workspace_write.writable_roots = result.sandbox_workspace_write.writable_roots.map((value, index) => resolvePath(value, `sandbox_workspace_write.writable_roots[${index}]`));
  if (table(result.agents)) {
    for (const agent of Object.values(result.agents)) if (table(agent) && Object.hasOwn(agent, "config_file")) agent.config_file = resolvePath(agent.config_file, "agents.<name>.config_file");
  }
  if (Array.isArray(result.skills?.config)) {
    for (const [index, skill] of result.skills.config.entries()) if (table(skill) && Object.hasOwn(skill, "path")) skill.path = resolvePath(skill.path, `skills.config[${index}].path`);
  }
  for (const exporter of ["exporter", "trace_exporter", "metrics_exporter"]) {
    for (const transport of ["otlp-http", "otlp-grpc"]) {
      const tls = result.otel?.[exporter]?.[transport]?.tls;
      if (!table(tls)) continue;
      for (const field of ["ca-certificate", "client-certificate", "client-private-key"]) if (Object.hasOwn(tls, field)) tls[field] = resolvePath(tls[field], `otel.${exporter}.${transport}.tls.${field}`);
    }
  }
  try {
    tomlValue(result);
  } catch {
    conversionUnsupported("configuration", "The configuration cannot be serialized as TOML without loss.");
  }
  return result;
}
async function readCodexProfile(name, environment, diagnostics = [], cwd = process.cwd()) {
  if (name === void 0) return {};
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) fail("profileValueInvalid", "The Codex profile must be a plain profile-v2 name.");
  let profilePath, text;
  try {
    let home;
    if (environment.CODEX_HOME) {
      home = await fs.realpath(path.resolve(cwd, environment.CODEX_HOME));
      if (!(await fs.stat(home)).isDirectory()) throw new Error();
    } else {
      const userHome = process.platform === "win32" ? environment.USERPROFILE || os.homedir() : environment.HOME || os.homedir();
      home = path.join(userHome, ".codex");
    }
    profilePath = path.join(home, `${name}.config.toml`);
    text = await fs.readFile(profilePath, "utf8");
  } catch {
    diagnostics.push({ code: "profileUnreadable", field: "profile", message: "The selected profile file could not be read." });
    fail("profileUnreadable", "The selected profile file could not be read.");
  }
  return { profilePath, document: parseProfile(text, diagnostics) };
}
function splitConfiguration(value, { diagnostics = [] } = {}) {
  const launch = /* @__PURE__ */ Object.create(null), thread = /* @__PURE__ */ Object.create(null);
  const threadValue = (key, item, target = key) => {
    try {
      thread[target] = jsonValue(item);
    } catch {
      if (key === "hooks") {
        const message = "Hooks cannot be represented as JSON without loss while preserving source-state mapping.";
        diagnostics.push({ code: "profileConversionUnsupported", field: "hooks", message });
        fail("profileConversionUnsupported", message);
      }
      if (key === "features.hooks") launch.features = { ...launch.features, hooks: item };
      else launch[key] = item;
    }
  };
  for (const [key, item] of Object.entries(value)) {
    if (key === "features" && table(item)) {
      const features = Object.fromEntries(Object.entries(item).filter(([name]) => name !== "hooks"));
      if (Object.keys(features).length) launch.features = { ...launch.features, ...features };
      if (Object.hasOwn(item, "hooks")) threadValue("features.hooks", item.hooks);
    } else if (threadFields.has(key)) threadValue(key, item);
    else launch[key] = item;
  }
  return { launch, thread };
}
function launchArguments(launch, extra = [], platform = process.platform) {
  const argv = ["app-server", ...extra];
  try {
    for (const [key, value] of Object.entries(launch)) argv.push("-c", `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlValue(key)}=${tomlValue(value)}`);
  } catch {
    fail("profileConversionUnsupported", "Startup configuration cannot be serialized as TOML without loss.");
  }
  const size = argv.reduce((total, value) => total + (platform === "win32" ? value.length * 2 : Buffer.byteLength(value)) + 3, 0);
  if (size > (platform === "win32" ? 28e3 : 12e4)) fail("profileConversionUnsupported", "Startup configuration exceeds the supported command-line size. Reduce startup overrides.");
  return argv;
}
export {
  convertProfile,
  launchArguments,
  mergeConfiguration,
  parseConfigArgument,
  parseProfile,
  readCodexProfile,
  splitConfiguration,
  tomlValue
};
