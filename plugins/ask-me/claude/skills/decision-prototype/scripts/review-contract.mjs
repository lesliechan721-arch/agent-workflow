import { readFile } from 'node:fs/promises';

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

function applyDefaults(value, schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && matchesType(value, 'object')) {
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined && propertySchema.default !== undefined) {
        value[key] = structuredClone(propertySchema.default);
      }
      if (value[key] !== undefined) applyDefaults(value[key], propertySchema);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!(key in (schema.properties || {}))) applyDefaults(child, schema.additionalProperties);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (const child of value) applyDefaults(child, schema.items);
  }
}

function validate(value, schema, location, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validate(value, candidate, location, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${location} must match exactly one allowed shape`);
    return;
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${location} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
    return;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${location} must be ${schema.type}; received ${valueType(value)}`);
    return;
  }
  if (schema.type === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${location} must contain at least ${schema.minLength} character(s)`);
  }
  if ((schema.type === 'integer' || schema.type === 'number') && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location} must be at least ${schema.minimum}`);
  }
  if ((schema.type === 'integer' || schema.type === 'number') && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${location} must be at most ${schema.maximum}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) value.forEach((child, index) => validate(child, schema.items, `${location}[${index}]`, errors));
  }
  if (schema.type === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`${location}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validate(child, properties[key], `${location}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${location}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, `${location}.${key}`, errors);
      }
    }
  }
}

function validatePrototypeCapabilities(value, label, errors) {
  if (!matchesType(value, 'object') || !Array.isArray(value.options)) return;

  const optionIds = new Set();
  for (const option of value.options) {
    if (typeof option?.id !== 'string') continue;
    if (optionIds.has(option.id)) errors.push(`${label}.options contains duplicate id ${JSON.stringify(option.id)}`);
    optionIds.add(option.id);
  }

  const questionIds = new Set();
  if (Array.isArray(value.guidedQuestions)) {
    for (const question of value.guidedQuestions) {
      if (typeof question?.id !== 'string') continue;
      if (questionIds.has(question.id)) errors.push(`${label}.guidedQuestions contains duplicate id ${JSON.stringify(question.id)}`);
      questionIds.add(question.id);
    }
  }

  const hasHtml = value.options.some((option) => option?.kind === 'html');
  const hasImage = value.options.some((option) => option?.kind === 'image');
  const hasStaticHtml = hasHtml && value.htmlExecution === 'static';

  if (value.htmlExecution === 'sandboxed' && !hasHtml) {
    errors.push(`${label}.htmlExecution "sandboxed" requires at least one html option`);
  }
  if (value.allowAnnotations && !hasImage && !hasStaticHtml) {
    errors.push(`${label}.allowAnnotations requires an image or static html option`);
  }
  if (value.editableCssVariables === undefined) return;

  const names = matchesType(value.editableCssVariables, 'object')
    ? Object.keys(value.editableCssVariables)
    : [];
  if (names.length === 0) {
    errors.push(`${label}.editableCssVariables must contain at least one CSS custom property`);
  }
  for (const name of names) {
    if (!name.startsWith('--') || name.length === 2) {
      errors.push(`${label}.editableCssVariables.${name} must start with "--" and include a name`);
    }
    const questionId = `css-variable:${name}`;
    if (questionIds.has(questionId)) {
      errors.push(`${label}.guidedQuestions id ${JSON.stringify(questionId)} conflicts with an editable CSS variable`);
    }
  }
  if (!hasStaticHtml) {
    errors.push(`${label}.editableCssVariables requires at least one static html option`);
  }
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function validateFeedbackReferences(value, prototype, label, errors) {
  if (!matchesType(value, 'object') || !matchesType(prototype, 'object')) return;

  if (!prototype.allowOther && value.verdict === 'rejected') {
    errors.push(`${label}.verdict "rejected" is not allowed by the Prototype config`);
  }

  const options = new Map(
    Array.isArray(prototype.options)
      ? prototype.options.filter((option) => typeof option?.id === 'string').map((option) => [option.id, option])
      : [],
  );
  const questions = new Map();
  if (Array.isArray(prototype.guidedQuestions)) {
    for (const question of prototype.guidedQuestions) {
      if (typeof question?.id !== 'string') continue;
      questions.set(question.id, { kind: 'guided', values: question.choices || [] });
    }
  }
  if (matchesType(prototype.editableCssVariables, 'object')) {
    for (const [name, values] of Object.entries(prototype.editableCssVariables)) {
      questions.set(`css-variable:${name}`, { kind: 'css-variable', values });
    }
  }

  if (Array.isArray(value.selectedOptions)) {
    for (const duplicate of duplicateValues(value.selectedOptions)) {
      errors.push(`${label}.selectedOptions contains duplicate option ${JSON.stringify(duplicate)}`);
    }
    for (const optionId of value.selectedOptions) {
      if (typeof optionId === 'string' && !options.has(optionId)) {
        errors.push(`${label}.selectedOptions references unknown option ${JSON.stringify(optionId)}`);
      }
    }
  }

  const answerIds = new Set();
  if (Array.isArray(value.answers)) {
    for (const [index, answer] of value.answers.entries()) {
      if (!matchesType(answer, 'object') || typeof answer.questionId !== 'string') continue;
      const answerLabel = `${label}.answers[${index}]`;
      if (answerIds.has(answer.questionId)) {
        errors.push(`${label}.answers contains duplicate questionId ${JSON.stringify(answer.questionId)}`);
      }
      answerIds.add(answer.questionId);
      const question = questions.get(answer.questionId);
      if (!question) {
        errors.push(`${answerLabel}.questionId references unknown question ${JSON.stringify(answer.questionId)}`);
        continue;
      }
      if (question.kind === 'css-variable' && (!Array.isArray(answer.selected) || answer.selected.length !== 1)) {
        errors.push(`${answerLabel}.selected must contain exactly one CSS variable value`);
      }
      if (!Array.isArray(answer.selected)) continue;
      for (const duplicate of duplicateValues(answer.selected)) {
        errors.push(`${answerLabel}.selected contains duplicate value ${JSON.stringify(duplicate)}`);
      }
      const allowedValues = new Set(question.values);
      for (const selected of answer.selected) {
        if (typeof selected === 'string' && !allowedValues.has(selected)) {
          errors.push(`${answerLabel}.selected contains undeclared value ${JSON.stringify(selected)}`);
        }
      }
    }
  }

  if (!Array.isArray(value.annotations)) return;
  if (value.annotations.length > 0 && !prototype.allowAnnotations) {
    errors.push(`${label}.annotations are not allowed by the Prototype config`);
  }
  for (const [index, annotation] of value.annotations.entries()) {
    const target = annotation?.target;
    const optionId = target?.value?.optionId;
    if (typeof optionId !== 'string' || typeof target?.kind !== 'string') continue;
    const annotationLabel = `${label}.annotations[${index}].target`;
    const option = options.get(optionId);
    if (!option) {
      errors.push(`${annotationLabel} references unknown option ${JSON.stringify(optionId)}`);
      continue;
    }
    if (target.kind === 'point' && option.kind !== 'image') {
      errors.push(`${annotationLabel} point annotations require an image option`);
    }
    if (
      ['dom', 'text', 'node'].includes(target.kind)
      && (option.kind !== 'html' || prototype.htmlExecution !== 'static')
    ) {
      errors.push(`${annotationLabel} ${target.kind} annotations require a static html option`);
    }
  }
}

export async function readJsonSchema(schemaPath) {
  return JSON.parse(await readFile(schemaPath, 'utf8'));
}

export function normalizeAndValidate(value, schema, label) {
  const normalized = structuredClone(value);
  applyDefaults(normalized, schema);
  const errors = [];
  validate(normalized, schema, label, errors);
  if (schema.title === 'PrototypeReviewConfig') {
    validatePrototypeCapabilities(normalized, label, errors);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return normalized;
}

export function validateFeedbackAgainstPrototype(value, prototype, label = 'feedback') {
  const errors = [];
  validateFeedbackReferences(value, prototype, label, errors);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return value;
}
