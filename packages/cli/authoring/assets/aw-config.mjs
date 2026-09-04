#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RE2 } from './re2-wasm/build/src/re2.js';

/* Generated validator contract from packages/plugin-core/src/plugin-config.ts. */
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const STRING_FORMATS = new Set([
    'identifier',
    'slug',
    'semver',
    'url',
    'hostname',
    'email',
]);
const MAX_OBJECT_PROPERTIES = 32;
const MAX_PATTERN_CODE_POINTS = 512;
const MAX_STRING_CODE_POINTS = 4096;
const DANGEROUS_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function createPropertyMap() {
    return Object.create(null);
}
function ownProperty(value, property) {
    return value !== undefined && Object.hasOwn(value, property) ? value[property] : undefined;
}
function isDangerousConfigKey(value) {
    return DANGEROUS_CONFIG_KEYS.has(value);
}
function asObject(value, path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Invalid ${path}: expected an object.`);
    }
    return value;
}
function assertAllowedKeys(value, path, allowed) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new Error(`Invalid ${path}: unknown field "${key}".`);
        }
    }
}
function nonEmptyString(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Invalid ${path}: expected a non-empty string.`);
    }
    return value;
}
function optionalText(value, path) {
    return value === undefined ? undefined : nonEmptyString(value, path);
}
function optionalBoolean(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${path}: expected a boolean.`);
    }
    return value;
}
function finiteNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid ${path}: expected a finite number.`);
    }
    return value;
}
function nonNegativeInteger(value, path) {
    const result = finiteNumber(value, path);
    if (!Number.isInteger(result) || result < 0) {
        throw new Error(`Invalid ${path}: expected a non-negative integer.`);
    }
    return result;
}
function normalizeStringValidation(value, path) {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, ['minLength', 'maxLength', 'pattern', 'format']);
    const minLength = input.minLength === undefined
        ? undefined
        : nonNegativeInteger(input.minLength, `${path}.minLength`);
    const maxLength = input.maxLength === undefined
        ? undefined
        : nonNegativeInteger(input.maxLength, `${path}.maxLength`);
    if (maxLength !== undefined && maxLength > MAX_STRING_CODE_POINTS) {
        throw new Error(`Invalid ${path}.maxLength: expected at most ${MAX_STRING_CODE_POINTS}.`);
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        throw new Error(`Invalid ${path}: minLength must be less than or equal to maxLength.`);
    }
    if (input.pattern !== undefined && typeof input.pattern !== 'string') {
        throw new Error(`Invalid ${path}.pattern: expected a string.`);
    }
    const pattern = input.pattern;
    if (pattern !== undefined) {
        if ([...pattern].length > MAX_PATTERN_CODE_POINTS) {
            throw new Error(`Invalid ${path}.pattern: expected at most ${MAX_PATTERN_CODE_POINTS} Unicode code points.`);
        }
        if (maxLength === undefined) {
            throw new Error(`Invalid ${path}: maxLength is required when pattern is declared.`);
        }
        try {
            new RE2(pattern, 'u');
        }
        catch {
            throw new Error(`Invalid ${path}.pattern: expected a valid RE2 regular expression.`);
        }
    }
    const format = input.format === undefined
        ? undefined
        : nonEmptyString(input.format, `${path}.format`);
    if (format !== undefined && !STRING_FORMATS.has(format)) {
        throw new Error(`Invalid ${path}.format: unsupported string format "${format}".`);
    }
    return { minLength, maxLength, pattern, format };
}
function normalizeNumberValidation(value, path) {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, ['integer', 'minimum', 'maximum', 'multipleOf']);
    const integer = optionalBoolean(input.integer, `${path}.integer`);
    const minimum = input.minimum === undefined
        ? undefined
        : finiteNumber(input.minimum, `${path}.minimum`);
    const maximum = input.maximum === undefined
        ? undefined
        : finiteNumber(input.maximum, `${path}.maximum`);
    const multipleOf = input.multipleOf === undefined
        ? undefined
        : finiteNumber(input.multipleOf, `${path}.multipleOf`);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        throw new Error(`Invalid ${path}: minimum must be less than or equal to maximum.`);
    }
    if (multipleOf !== undefined && multipleOf <= 0) {
        throw new Error(`Invalid ${path}.multipleOf: expected a number greater than zero.`);
    }
    return { integer, minimum, maximum, multipleOf };
}
function createIssue(code, field, message, property) {
    return {
        code,
        path: property === undefined ? { field } : { field, property },
        message,
        recoverable: true,
    };
}
function stringFormatMatches(value, format) {
    if (format === 'identifier')
        return IDENTIFIER_PATTERN.test(value);
    if (format === 'slug')
        return SLUG_PATTERN.test(value);
    if (format === 'semver')
        return SEMVER_PATTERN.test(value);
    if (format === 'hostname')
        return HOSTNAME_PATTERN.test(value);
    if (format === 'email')
        return EMAIL_PATTERN.test(value);
    try {
        const url = new URL(value);
        return url.protocol.length > 1;
    }
    catch {
        return false;
    }
}
function validateString(value, validation, field, property) {
    if (typeof value !== 'string') {
        return [createIssue('type', field, 'Expected a string.', property)];
    }
    const issues = [];
    if (validation?.minLength !== undefined && [...value].length < validation.minLength) {
        issues.push(createIssue('minLength', field, `Expected at least ${validation.minLength} characters.`, property));
    }
    if (validation?.maxLength !== undefined && [...value].length > validation.maxLength) {
        issues.push(createIssue('maxLength', field, `Expected at most ${validation.maxLength} characters.`, property));
    }
    if (validation?.pattern !== undefined && !new RE2(validation.pattern, 'u').test(value)) {
        issues.push(createIssue('pattern', field, `Expected a value that matches ${validation.pattern}.`, property));
    }
    if (validation?.format !== undefined && !stringFormatMatches(value, validation.format)) {
        issues.push(createIssue('format', field, `Expected ${validation.format} format.`, property));
    }
    return issues;
}
function validateNumber(value, validation, field, property) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [createIssue('type', field, 'Expected a finite number.', property)];
    }
    const issues = [];
    if (validation?.integer === true && !Number.isInteger(value)) {
        issues.push(createIssue('integer', field, 'Expected an integer.', property));
    }
    if (validation?.minimum !== undefined && value < validation.minimum) {
        issues.push(createIssue('minimum', field, `Expected a number greater than or equal to ${validation.minimum}.`, property));
    }
    if (validation?.maximum !== undefined && value > validation.maximum) {
        issues.push(createIssue('maximum', field, `Expected a number less than or equal to ${validation.maximum}.`, property));
    }
    if (validation?.multipleOf !== undefined
        && Math.abs(value / validation.multipleOf - Math.round(value / validation.multipleOf)) > 1e-9) {
        issues.push(createIssue('multipleOf', field, `Expected a multiple of ${validation.multipleOf}.`, property));
    }
    return issues;
}
function validateScalarField(fieldDefinition, value, field, property, checkChoices = true) {
    const issues = fieldDefinition.type === 'string'
        ? validateString(value, fieldDefinition.validation, field, property)
        : fieldDefinition.type === 'number'
            ? validateNumber(value, fieldDefinition.validation, field, property)
            : typeof value === 'boolean'
                ? []
                : [createIssue('type', field, 'Expected a boolean.', property)];
    if (checkChoices
        && issues.length === 0
        && fieldDefinition.choices?.allowCustom === false
        && matchPluginConfigPreset(fieldDefinition, value) === undefined) {
        issues.push(createIssue('choice', field, 'Expected a declared preset value.', property));
    }
    return issues;
}
function validateObjectField(fieldDefinition, value, field, checkChoices = true) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [createIssue('type', field, 'Expected an object.')];
    }
    const input = value;
    const keys = Object.keys(input);
    const issues = [];
    if (keys.length > MAX_OBJECT_PROPERTIES) {
        issues.push(createIssue('maxProperties', field, `Expected at most ${MAX_OBJECT_PROPERTIES} properties.`));
    }
    if (fieldDefinition.validation?.minProperties !== undefined
        && keys.length < fieldDefinition.validation.minProperties) {
        issues.push(createIssue('minProperties', field, `Expected at least ${fieldDefinition.validation.minProperties} properties.`));
    }
    if (fieldDefinition.validation?.maxProperties !== undefined
        && keys.length > fieldDefinition.validation.maxProperties) {
        issues.push(createIssue('maxProperties', field, `Expected at most ${fieldDefinition.validation.maxProperties} properties.`));
    }
    for (const [property, child] of Object.entries(fieldDefinition.properties ?? {})) {
        if (child.required === true && !Object.hasOwn(input, property)) {
            issues.push(createIssue('required', field, 'Required property is missing.', property));
        }
    }
    for (const [property, childValue] of Object.entries(input)) {
        if (isDangerousConfigKey(property)) {
            issues.push(createIssue('dangerousKey', field, 'Dangerous config key is not allowed.', property));
            continue;
        }
        const child = ownProperty(fieldDefinition.properties, property);
        if (child !== undefined) {
            issues.push(...validateScalarField(child, childValue, field, property));
            continue;
        }
        const dynamicChild = fieldDefinition.additionalProperties;
        if (dynamicChild === undefined || dynamicChild === false) {
            issues.push(createIssue('additionalProperty', field, 'Additional property is not allowed.', property));
            continue;
        }
        if (fieldDefinition.validation?.key !== undefined) {
            issues.push(...validateString(property, fieldDefinition.validation.key, field, property));
        }
        issues.push(...validateScalarField(dynamicChild, childValue, field, property));
    }
    if (checkChoices
        && issues.length === 0
        && fieldDefinition.choices?.allowCustom === false
        && matchPluginConfigPreset(fieldDefinition, input) === undefined) {
        issues.push(createIssue('choice', field, 'Expected a declared preset value.'));
    }
    return issues;
}
function resolveValueArguments(first, second, third) {
    if (typeof first === 'string') {
        return {
            field: first,
            definition: second,
            value: third,
        };
    }
    return {
        definition: first,
        value: second,
        field: typeof third === 'string' ? third : 'value',
    };
}
export function validatePluginConfigValue(first, second, third) {
    const resolved = resolveValueArguments(first, second, third);
    return resolved.definition.type === 'object'
        ? validateObjectField(resolved.definition, resolved.value, resolved.field)
        : validateScalarField(resolved.definition, resolved.value, resolved.field);
}
export function validatePluginConfigDocument(definition, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [createIssue('type', '$document', 'Expected a config object.')];
    }
    const input = value;
    const issues = [];
    for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
        if (!Object.hasOwn(input, field)) {
            if (fieldDefinition.required === true) {
                issues.push(createIssue('required', field, 'Required field is missing.'));
            }
            continue;
        }
        issues.push(...validatePluginConfigValue(fieldDefinition, input[field], field));
    }
    for (const field of Object.keys(input)) {
        if (isDangerousConfigKey(field)) {
            issues.push(createIssue('dangerousKey', field, 'Dangerous config key is not allowed.'));
            continue;
        }
        if (!Object.hasOwn(definition.fields, field)) {
            issues.push(createIssue('unknownField', field, 'Unknown config field.'));
        }
    }
    return issues;
}
export function canonicalizePluginConfigValue(value) {
    if (typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
export function canonicalizePluginConfigValues(values) {
    return Object.fromEntries(Object.entries(values)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => [key, canonicalizePluginConfigValue(value)]));
}
export function stablePluginConfigStringify(value) {
    return JSON.stringify(canonicalizePluginConfigValue(value));
}
export function matchPluginConfigPreset(definition, value) {
    return definition.choices?.presets.find((preset) => stablePluginConfigStringify(preset.value) === stablePluginConfigStringify(value));
}
export function validatePluginConfigPreset(definition, preset, field = 'value') {
    return definition.type === 'object'
        ? validateObjectField(definition, preset.value, field, false)
        : validateScalarField(definition, preset.value, field, undefined, false);
}
export function redactPluginConfigValue(definition, value) {
    if (definition.type === 'string' && definition.sensitive === true)
        return '[redacted]';
    return value;
}
export function formatPluginConfigIssue(issue) {
    const path = issue.path.property === undefined
        ? issue.path.field
        : `${issue.path.field}.${issue.path.property}`;
    return `${path}: ${issue.message}`;
}
function normalizePreset(value, path) {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, ['id', 'title', 'description', 'value', 'recommended']);
    if (!Object.hasOwn(input, 'value')) {
        throw new Error(`Invalid ${path}.value: value is required.`);
    }
    if (input.recommended !== undefined && input.recommended !== true) {
        throw new Error(`Invalid ${path}.recommended: expected true.`);
    }
    return {
        id: nonEmptyString(input.id, `${path}.id`),
        title: nonEmptyString(input.title, `${path}.title`),
        description: optionalText(input.description, `${path}.description`),
        value: input.value,
        recommended: input.recommended,
    };
}
function normalizeChoices(value, path) {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, ['allowCustom', 'presets']);
    if (typeof input.allowCustom !== 'boolean') {
        throw new Error(`Invalid ${path}.allowCustom: expected a boolean.`);
    }
    if (!Array.isArray(input.presets)) {
        throw new Error(`Invalid ${path}.presets: expected an array.`);
    }
    return {
        allowCustom: input.allowCustom,
        presets: input.presets.map((preset, index) => normalizePreset(preset, `${path}.presets[${index}]`)),
    };
}
function normalizeScalarField(value, path, options) {
    const input = asObject(value, path);
    const type = nonEmptyString(input.type, `${path}.type`);
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        throw new Error(`Invalid ${path}.type: expected string, number, or boolean.`);
    }
    const allowed = ['type', 'title', 'description'];
    if (options.allowDefault)
        allowed.push('default');
    if (options.allowRequired)
        allowed.push('required');
    if (options.allowSensitive && type === 'string')
        allowed.push('sensitive');
    allowed.push('choices');
    if (type !== 'boolean')
        allowed.push('validation');
    assertAllowedKeys(input, path, allowed);
    const sensitive = options.allowSensitive && type === 'string'
        ? optionalBoolean(input.sensitive, `${path}.sensitive`)
        : undefined;
    if (sensitive === true && input.default !== undefined) {
        throw new Error(`Invalid ${path}.default: sensitive fields cannot declare a default.`);
    }
    if (sensitive === true && input.choices !== undefined) {
        throw new Error(`Invalid ${path}.choices: sensitive fields cannot declare choices.`);
    }
    const common = {
        title: optionalText(input.title, `${path}.title`),
        description: optionalText(input.description, `${path}.description`),
        required: options.allowRequired ? optionalBoolean(input.required, `${path}.required`) : undefined,
    };
    const defaultValue = options.allowDefault && input.default !== undefined
        ? input.default
        : undefined;
    if (type === 'string') {
        if (sensitive === true) {
            return {
                type,
                ...common,
                sensitive: true,
                validation: input.validation === undefined
                    ? undefined
                    : normalizeStringValidation(input.validation, `${path}.validation`),
            };
        }
        return {
            type,
            ...common,
            sensitive,
            default: defaultValue,
            choices: input.choices === undefined
                ? undefined
                : normalizeChoices(input.choices, `${path}.choices`),
            validation: input.validation === undefined
                ? undefined
                : normalizeStringValidation(input.validation, `${path}.validation`),
        };
    }
    if (type === 'number') {
        return {
            type,
            ...common,
            default: defaultValue,
            choices: input.choices === undefined
                ? undefined
                : normalizeChoices(input.choices, `${path}.choices`),
            validation: input.validation === undefined
                ? undefined
                : normalizeNumberValidation(input.validation, `${path}.validation`),
        };
    }
    return {
        type,
        ...common,
        default: defaultValue,
        choices: input.choices === undefined
            ? undefined
            : normalizeChoices(input.choices, `${path}.choices`),
    };
}
function assertChoices(definition, path) {
    if (definition.choices === undefined)
        return;
    if (definition.choices.allowCustom === false && definition.choices.presets.length === 0) {
        throw new Error(`Invalid ${path}.choices.presets: expected at least one preset when allowCustom is false.`);
    }
    const ids = new Set();
    const values = new Set();
    let recommendedCount = 0;
    for (const [index, preset] of definition.choices.presets.entries()) {
        if (ids.has(preset.id)) {
            throw new Error(`Invalid ${path}.choices.presets[${index}].id: duplicate preset id "${preset.id}".`);
        }
        ids.add(preset.id);
        const canonicalValue = stablePluginConfigStringify(preset.value);
        if (values.has(canonicalValue)) {
            throw new Error(`Invalid ${path}.choices.presets[${index}].value: duplicate preset value.`);
        }
        values.add(canonicalValue);
        if (preset.recommended === true)
            recommendedCount += 1;
        const issues = validatePluginConfigPreset(definition, preset, path);
        if (issues.length > 0) {
            throw new Error(`Invalid ${path}.choices.presets[${index}].value: ${formatPluginConfigIssue(issues[0])}`);
        }
    }
    if (recommendedCount > 1) {
        throw new Error(`Invalid ${path}.choices: expected at most one recommended preset.`);
    }
}
function normalizeObjectField(value, path) {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, [
        'type',
        'title',
        'description',
        'default',
        'required',
        'choices',
        'properties',
        'additionalProperties',
        'validation',
    ]);
    if (input.properties === undefined && (input.additionalProperties === undefined || input.additionalProperties === false)) {
        throw new Error(`Invalid ${path}: key-value object config requires a scalar additionalProperties field.`);
    }
    if (input.properties !== undefined && input.additionalProperties !== undefined && input.additionalProperties !== false) {
        throw new Error(`Invalid ${path}: fixed and key-value object config modes cannot be mixed.`);
    }
    let properties;
    if (input.properties !== undefined) {
        const propertiesInput = asObject(input.properties, `${path}.properties`);
        if (Object.keys(propertiesInput).length > MAX_OBJECT_PROPERTIES) {
            throw new Error(`Invalid ${path}.properties: expected at most ${MAX_OBJECT_PROPERTIES} properties.`);
        }
        properties = createPropertyMap();
        for (const [property, child] of Object.entries(propertiesInput)) {
            if (isDangerousConfigKey(property)) {
                throw new Error(`Invalid ${path}.properties: dangerous config key "${property}" is not allowed.`);
            }
            properties[property] = normalizeScalarField(child, `${path}.properties.${property}`, {
                allowDefault: false,
                allowRequired: true,
                allowSensitive: false,
            });
            assertChoices(properties[property], `${path}.properties.${property}`);
        }
    }
    let additionalProperties;
    if (input.additionalProperties === undefined || input.additionalProperties === false) {
        additionalProperties = false;
    }
    else {
        additionalProperties = normalizeScalarField(input.additionalProperties, `${path}.additionalProperties`, { allowDefault: false, allowRequired: false, allowSensitive: false });
        assertChoices(additionalProperties, `${path}.additionalProperties`);
    }
    let validation;
    if (input.validation !== undefined) {
        const validationInput = asObject(input.validation, `${path}.validation`);
        assertAllowedKeys(validationInput, `${path}.validation`, ['minProperties', 'maxProperties', 'key']);
        const minProperties = validationInput.minProperties === undefined
            ? undefined
            : nonNegativeInteger(validationInput.minProperties, `${path}.validation.minProperties`);
        const maxProperties = validationInput.maxProperties === undefined
            ? undefined
            : nonNegativeInteger(validationInput.maxProperties, `${path}.validation.maxProperties`);
        if (minProperties !== undefined && minProperties > MAX_OBJECT_PROPERTIES) {
            throw new Error(`Invalid ${path}.validation.minProperties: expected at most ${MAX_OBJECT_PROPERTIES}.`);
        }
        if (maxProperties !== undefined && maxProperties > MAX_OBJECT_PROPERTIES) {
            throw new Error(`Invalid ${path}.validation.maxProperties: expected at most ${MAX_OBJECT_PROPERTIES}.`);
        }
        if (minProperties !== undefined && maxProperties !== undefined && minProperties > maxProperties) {
            throw new Error(`Invalid ${path}.validation: minProperties must be less than or equal to maxProperties.`);
        }
        validation = {
            minProperties,
            maxProperties,
            key: validationInput.key === undefined
                ? undefined
                : normalizeStringValidation(validationInput.key, `${path}.validation.key`),
        };
    }
    return {
        type: 'object',
        title: optionalText(input.title, `${path}.title`),
        description: optionalText(input.description, `${path}.description`),
        default: input.default,
        required: optionalBoolean(input.required, `${path}.required`),
        choices: input.choices === undefined
            ? undefined
            : normalizeChoices(input.choices, `${path}.choices`),
        ...(properties === undefined
            ? { additionalProperties: additionalProperties }
            : { properties, additionalProperties: false }),
        validation,
    };
}
export function normalizePluginConfigDefinition(value, path = 'config') {
    const input = asObject(value, path);
    assertAllowedKeys(input, path, ['fields', 'presentation']);
    const fieldsInput = asObject(input.fields, `${path}.fields`);
    const fields = createPropertyMap();
    for (const [field, rawDefinition] of Object.entries(fieldsInput)) {
        if (!CONFIG_KEY_PATTERN.test(field) || isDangerousConfigKey(field)) {
            throw new Error(`Invalid ${path}.fields: config key "${field}" is not valid.`);
        }
        const rawField = asObject(rawDefinition, `${path}.fields.${field}`);
        const definition = rawField.type === 'object'
            ? normalizeObjectField(rawField, `${path}.fields.${field}`)
            : normalizeScalarField(rawField, `${path}.fields.${field}`, {
                allowDefault: true,
                allowRequired: true,
                allowSensitive: true,
            });
        assertChoices(definition, `${path}.fields.${field}`);
        if (definition.default !== undefined) {
            const issues = validatePluginConfigValue(definition, definition.default, field);
            if (issues.length > 0) {
                throw new Error(`Invalid ${path}.fields.${field}.default: ${formatPluginConfigIssue(issues[0])}`);
            }
        }
        fields[field] = definition;
    }
    let presentation;
    if (input.presentation !== undefined) {
        const presentationInput = asObject(input.presentation, `${path}.presentation`);
        assertAllowedKeys(presentationInput, `${path}.presentation`, ['groups']);
        if (presentationInput.groups !== undefined && !Array.isArray(presentationInput.groups)) {
            throw new Error(`Invalid ${path}.presentation.groups: expected an array.`);
        }
        const groupIds = new Set();
        const groupedFields = new Set();
        presentation = {
            groups: presentationInput.groups?.map((rawGroup, index) => {
                const groupPath = `${path}.presentation.groups[${index}]`;
                const group = asObject(rawGroup, groupPath);
                assertAllowedKeys(group, groupPath, ['id', 'title', 'description', 'fields', 'advanced']);
                const id = nonEmptyString(group.id, `${groupPath}.id`);
                if (groupIds.has(id)) {
                    throw new Error(`Invalid ${groupPath}.id: duplicate group id "${id}".`);
                }
                groupIds.add(id);
                if (!Array.isArray(group.fields)) {
                    throw new Error(`Invalid ${groupPath}.fields: expected an array.`);
                }
                const groupFields = group.fields.map((entry, fieldIndex) => {
                    const field = nonEmptyString(entry, `${groupPath}.fields[${fieldIndex}]`);
                    if (!Object.hasOwn(fields, field)) {
                        throw new Error(`Invalid ${groupPath}.fields[${fieldIndex}]: unknown config key "${field}".`);
                    }
                    if (groupedFields.has(field)) {
                        throw new Error(`Invalid ${groupPath}.fields[${fieldIndex}]: config key "${field}" is assigned to more than one group.`);
                    }
                    groupedFields.add(field);
                    return field;
                });
                return {
                    id,
                    title: nonEmptyString(group.title, `${groupPath}.title`),
                    description: optionalText(group.description, `${groupPath}.description`),
                    fields: groupFields,
                    advanced: optionalBoolean(group.advanced, `${groupPath}.advanced`),
                };
            }),
        };
    }
    return { fields, presentation };
}

const CONFIG_DIR = 'plugin-config';
const CONFIG_FILE = 'config.json';
const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function readJsonFile(filePath, label) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    fail(`Unable to read ${label}.`);
  }
  try {
    return JSON.parse(content);
  } catch {
    fail(`invalidJson: Unable to parse ${label} as JSON.`);
  }
}

function safeSegment(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('Invalid plugin config segment.');
  if (
    value !== value.trim()
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) fail('Invalid plugin config segment.');
  return value;
}

function normalizeSchema(rawSchema) {
  try {
    return normalizePluginConfigDefinition({ fields: rawSchema }).fields;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid AW config schema.');
  }
}

function validateManifest(rawManifest) {
  if (!isRecord(rawManifest)) fail('Bundle manifest is not a JSON object.');
  const pluginName = safeSegment(rawManifest.name);
  if (!isRecord(rawManifest.config) || !isRecord(rawManifest.config.fields)) {
    fail(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return { pluginName, schema: normalizeSchema(rawManifest.config.fields) };
}

function locateBundleManifest() {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = path.join(currentDir, '.agents-plugin', 'plugin.json');
    if (fs.existsSync(manifestPath)) return { bundleRoot: currentDir, manifestPath };
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) fail('Unable to locate bundle .agents-plugin/plugin.json.');
    currentDir = parentDir;
  }
}

function resolveProjectRoot(cwd) {
  let currentDir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git')) || fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return path.resolve(cwd);
    currentDir = parentDir;
  }
}

function resolveAwHome() {
  return process.env.AW_HOME || path.join(os.homedir(), '.aw');
}

function resolveStorePath(sourceId, pluginName, scope, cwd) {
  const root = scope === 'user'
    ? resolveAwHome()
    : path.join(resolveProjectRoot(cwd), '.agent-workflows');
  return path.join(root, CONFIG_DIR, sourceId, pluginName, CONFIG_FILE);
}

function supportedValue(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return isRecord(value) && Object.values(value).every((child) =>
    typeof child === 'string'
    || typeof child === 'boolean'
    || (typeof child === 'number' && Number.isFinite(child)));
}

function validateValues(values, schema) {
  if (!isRecord(values)) fail('invalidValues: Store values must be an object.');
  for (const [key, value] of Object.entries(values)) {
    if (isDangerousConfigKey(key)) {
      fail(`dangerousKey: Config "${key}" is not allowed.`);
    }
    if (!supportedValue(value)) fail(`invalidValues: Config "${key}" has an unsupported value.`);
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!field) continue;
    const issues = validatePluginConfigValue(field, value, key);
    if (issues.length > 0) fail(`invalidValues: ${formatPluginConfigIssue(issues[0])}`);
  }
  return values;
}

function missingStore(filePath) {
  return { path: filePath, state: 'missing', exists: false, values: {} };
}

function readStore(filePath, identity, schema, scope) {
  if (!fs.existsSync(filePath)) return missingStore(filePath);
  const envelope = readJsonFile(filePath, 'plugin config store');
  if (!isRecord(envelope) || envelope.schemaVersion !== 4) {
    fail('schemaVersionUnsupported: Only plugin config store schemaVersion 4 is supported.');
  }
  if (
    envelope.sourceId !== identity.sourceId
    || envelope.pluginName !== identity.pluginName
  ) fail('identityMismatch: Plugin config store identity does not match its path.');
  const binding = envelope.binding;
  const bindingMatches = scope === 'user'
    ? isRecord(binding)
      && binding.kind === 'source'
      && binding.sourceIdentity === identity.sourceIdentity
      && Object.keys(binding).every((key) => ['kind', 'sourceIdentity'].includes(key))
    : isRecord(binding)
      && binding.kind === 'catalog'
      && binding.logicalIdentity === identity.logicalIdentity
      && Object.keys(binding).every((key) => ['kind', 'logicalIdentity'].includes(key));
  if (!bindingMatches) fail('identityMismatch: Plugin config store binding does not match its scope identity.');
  if (Object.keys(envelope).some((key) =>
    !['schemaVersion', 'sourceId', 'pluginName', 'binding', 'values'].includes(key))) {
    fail('schemaVersionUnsupported: Plugin config store schemaVersion 4 envelope is invalid.');
  }
  return {
    path: filePath,
    state: 'ready',
    exists: true,
    values: validateValues(envelope.values, schema),
  };
}

function createState(schema) {
  return {
    values: Object.create(null),
    redactedValues: Object.create(null),
    sources: Object.fromEntries(Object.keys(schema).map((key) => [key, 'missing'])),
    ignoredUnknownKeys: [],
    issues: [],
  };
}

function applyLayer(state, schema, entries, source) {
  validateValues(entries, schema);
  for (const [key, field] of Object.entries(schema)) {
    if (!Object.hasOwn(entries, key)) continue;
    const value = entries[key];
    state.values[key] = value;
    state.redactedValues[key] = redactPluginConfigValue(field, value);
    state.sources[key] = source;
  }
}

function collectUnknownKeys(state, schema, store, scope) {
  for (const key of Object.keys(store.values)) {
    if (!Object.hasOwn(schema, key)) state.ignoredUnknownKeys.push({ scope, key });
  }
}

function addRequiredIssues(state, schema) {
  for (const [key, field] of Object.entries(schema)) {
    if (field.required === true && !Object.hasOwn(state.values, key)) {
      state.issues.push({
        type: 'missing-required',
        key,
        source: state.sources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }
}

function resolveFromStores({ identity, schema, scope, stores }) {
  const state = createState(schema);
  if (scope === 'effective') {
    for (const [key, field] of Object.entries(schema)) {
      if (field.default !== undefined) applyLayer(state, { [key]: field }, { [key]: field.default }, 'default');
    }
    for (const [storeKey, source] of [['user', 'user'], ['project', 'project']]) {
      collectUnknownKeys(state, schema, stores[storeKey], source);
      applyLayer(state, schema, stores[storeKey].values, source);
    }
    addRequiredIssues(state, schema);
  } else {
    collectUnknownKeys(state, schema, stores[scope], scope);
    applyLayer(state, schema, stores[scope].values, scope);
  }
  return {
    pluginName: identity.pluginName,
    sourceId: identity.sourceId,
    sourceIdentity: identity.sourceIdentity,
    logicalIdentity: identity.logicalIdentity,
    pluginId: `${identity.sourceId}/${identity.pluginName}`,
    scope,
    values: state.values,
    redactedValues: state.redactedValues,
    sources: state.sources,
    schema,
    diagnostics: { issues: state.issues, ignoredUnknownKeys: state.ignoredUnknownKeys },
    paths: { configStores: { user: stores.user.path, project: stores.project.path } },
  };
}

function contextIdentity(context, pluginName) {
  const sourceId = context.plugin?.sourceId;
  const sourceIdentity = context.plugin?.sourceIdentity;
  const logicalIdentity = context.plugin?.logicalIdentity;
  if ([sourceId, sourceIdentity, logicalIdentity].some((value) => value === undefined)
    && [sourceId, sourceIdentity, logicalIdentity].some((value) => value !== undefined)) {
    fail('AW_PLUGIN_CONTEXT contains an incomplete source identity.');
  }
  if (sourceId === undefined) return null;
  if (typeof sourceIdentity !== 'string' || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)) {
    fail('AW_PLUGIN_CONTEXT contains an invalid source identity.');
  }
  if (typeof logicalIdentity !== 'string' || logicalIdentity.trim() === '') {
    fail('AW_PLUGIN_CONTEXT contains an invalid Catalog logical identity.');
  }
  return { pluginName, sourceId: safeSegment(sourceId), sourceIdentity, logicalIdentity };
}

function resolveFromContext(scope) {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) return null;
  const context = readJsonFile(contextPath, 'AW_PLUGIN_CONTEXT');
  if (!isRecord(context) || !isRecord(context.config)) fail('AW_PLUGIN_CONTEXT does not contain config data.');
  const schema = normalizeSchema(context.config.schema);
  const pluginName = safeSegment(context.plugin?.name || context.pluginName || context.config.pluginName || 'plugin');
  const identity = contextIdentity(context, pluginName);
  if (scope === 'effective') {
    const state = createState(schema);
    const values = validateValues(context.config.values, schema);
    applyLayer(state, schema, values, 'missing');
    for (const [key, source] of Object.entries(isRecord(context.config.sources) ? context.config.sources : {})) {
      if (
        Object.hasOwn(schema, key)
        && ['default', 'user', 'project', 'missing'].includes(source)
      ) state.sources[key] = source;
    }
    const contextStorePaths = isRecord(context.paths?.configStores)
      ? context.paths.configStores
      : {};
    return {
      pluginName,
      ...(identity ? {
        sourceId: identity.sourceId,
        sourceIdentity: identity.sourceIdentity,
        logicalIdentity: identity.logicalIdentity,
        pluginId: `${identity.sourceId}/${pluginName}`,
      } : {}),
      scope,
      values: state.values,
      redactedValues: state.redactedValues,
      sources: state.sources,
      schema,
      diagnostics: {
        issues: Array.isArray(context.config.issues) ? context.config.issues : [],
        ignoredUnknownKeys: Array.isArray(context.config.ignoredUnknownKeys)
          ? context.config.ignoredUnknownKeys : [],
      },
      paths: {
        configStores: {
          ...(typeof contextStorePaths.user === 'string' ? { user: contextStorePaths.user } : {}),
          ...(typeof contextStorePaths.project === 'string' ? { project: contextStorePaths.project } : {}),
        },
      },
    };
  }
  if (!identity) fail('AW_PLUGIN_CONTEXT must provide a source identity for scoped config reads.');
  const storePath = context.paths?.configStores?.[scope];
  if (typeof storePath !== 'string' || storePath.trim() === '') {
    fail(`AW_PLUGIN_CONTEXT does not provide a ${scope} config store path.`);
  }
  const store = readStore(storePath, identity, schema, scope);
  return resolveFromStores({
    identity,
    schema,
    scope,
    stores: {
      user: scope === 'user' ? store : missingStore(''),
      project: scope === 'project' ? store : missingStore(''),
    },
  });
}

function resolveFallback(scope) {
  const { bundleRoot, manifestPath } = locateBundleManifest();
  const { pluginName, schema } = validateManifest(readJsonFile(manifestPath, 'bundle manifest'));
  const pluginsRoot = path.dirname(bundleRoot);
  const marketplaceRoot = path.dirname(pluginsRoot);
  if (path.basename(pluginsRoot) !== 'plugins' || path.basename(bundleRoot) !== pluginName) {
    fail('Bundle manifest is not inside a namespaced local marketplace.');
  }
  const marketplace = readJsonFile(path.join(marketplaceRoot, 'config.json'), 'marketplace config');
  const sourceId = safeSegment(marketplace.sourceId);
  const sourceIdentity = marketplace.sourceIdentity;
  const logicalIdentity = marketplace.logicalIdentity;
  if (
    marketplace.schemaVersion !== 2
    || sourceId !== path.basename(marketplaceRoot)
    || typeof sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)
    || typeof logicalIdentity !== 'string'
    || logicalIdentity.trim() === ''
    || !['aw', `aw-${sourceId}`].includes(marketplace.marketplaceName)
  ) fail('Marketplace config does not contain a canonical schema 2 source identity.');
  const identity = { sourceId, sourceIdentity, logicalIdentity, pluginName };
  const cwd = process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  for (const legacyPath of [
    path.join(resolveAwHome(), CONFIG_DIR, pluginName, CONFIG_FILE),
    path.join(projectRoot, '.agent-workflows', CONFIG_DIR, pluginName, CONFIG_FILE),
  ]) {
    if (fs.existsSync(legacyPath)) fail('Legacy non-namespaced plugin config is not supported.');
  }
  const stores = {
    user: scope === 'project'
      ? missingStore('')
      : readStore(resolveStorePath(sourceId, pluginName, 'user', cwd), identity, schema, 'user'),
    project: scope === 'user'
      ? missingStore('')
      : readStore(resolveStorePath(sourceId, pluginName, 'project', cwd), identity, schema, 'project'),
  };
  return resolveFromStores({ identity, schema, scope, stores });
}

function printUsage() {
  process.stdout.write(`Usage:
  node aw-config.mjs get <key> [--scope effective|user|project]
  node aw-config.mjs json [--scope effective|user|project]

Options:
  --scope <scope>  Read effective, user, or project config. Default: effective.
  -h, --help       Show this help message.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift();
  if (command === '-h' || command === '--help') return { help: true };
  let scope = 'effective';
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scope') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) fail('--scope requires a value.');
      scope = value;
      index += 1;
    } else if (arg.startsWith('--scope=')) {
      scope = arg.slice('--scope='.length);
    } else {
      positional.push(arg);
    }
  }
  if (!['effective', 'user', 'project'].includes(scope)) fail('--scope must be effective, user, or project.');
  if (command !== 'get' && command !== 'json') fail('Usage: node aw-config.mjs get <key> | json');
  if (command === 'get' && positional.length !== 1) fail('Usage: node aw-config.mjs get <key>');
  if (command === 'json' && positional.length !== 0) fail('Usage: node aw-config.mjs json');
  return { command, key: positional[0], scope };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }
  const result = resolveFromContext(args.scope) || resolveFallback(args.scope);
  if (args.command === 'get') {
    if (!Object.hasOwn(result.schema, args.key)) fail(`Unknown config key "${args.key}".`);
    if (!Object.hasOwn(result.values, args.key)) fail(`Config key "${args.key}" is not set.`);
    const value = result.redactedValues[args.key];
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...result, values: result.redactedValues }, null, 2)}\n`);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[aw-config] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
