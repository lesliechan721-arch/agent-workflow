import { fail } from '../runtime/contracts.mjs';

export function rejectOption(option) {
  fail('adapterArgumentConflict', `The adapter owns ${option}. Remove it from args.`);
}

/** Protect invocation controls while leaving ordinary options to the backend. */
export function checkArguments(args, { owned, commands = [], short = {}, booleans = [], values = [], variadic = [], onOption }) {
  let valueExpected = false;
  let variadicExpected = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (valueExpected) { valueExpected = false; continue; }
    if (variadicExpected && !argument.startsWith('-')) continue;
    variadicExpected = false;
    if (argument === '--' || argument === '-') rejectOption(argument);
    if (!argument.startsWith('-')) fail('adapterArgumentConflict', 'args must contain backend options and their values, not a command or prompt.');
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const option = equals < 0 ? argument : argument.slice(0, equals);
      const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
      if (owned.includes(option)) rejectOption(option);
      onOption?.(option, value);
      variadicExpected = equals < 0 && variadic.includes(option);
      valueExpected = equals < 0 && !variadicExpected && (values.includes(option) || (!booleans.includes(option) && typeof value === 'string' && !value.startsWith('-')));
      continue;
    }
    for (let offset = 1; offset < argument.length; offset++) {
      const option = `-${argument[offset]}`;
      if (owned.includes(option)) rejectOption(option);
      const kind = short[option];
      if (kind === 'value') {
        const value = argument.slice(offset + 1) || args[index + 1];
        onOption?.(option, value);
        variadicExpected = variadic.includes(option);
        valueExpected = !variadicExpected && offset + 1 === argument.length;
        break;
      }
      if (kind !== 'boolean') {
        const next = args[index + 1];
        if (commands.includes(next)) rejectOption(next);
        valueExpected = offset + 1 === argument.length && typeof next === 'string' && !next.startsWith('-');
        break;
      }
      onOption?.(option, undefined);
    }
  }
}
