export function iframeSandbox(config) {
  return config.htmlExecution === 'sandboxed' ? 'allow-scripts' : 'allow-same-origin';
}

export function consumeSessionToken(location, history) {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  if (!token) throw new Error('Prototype Review session token is missing');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return token;
}

export function annotationTargets(config) {
  if (!config.allowAnnotations) return [];
  const targets = [];
  if (config.options.some((option) => option.kind === 'image')) targets.push('image');
  if (config.htmlExecution === 'static' && config.options.some((option) => option.kind === 'html')) {
    targets.push('dom', 'text', 'node');
  }
  return targets;
}

export function markedAnnotationTarget(optionId, elementId, markerKind) {
  if (!optionId || !elementId) return null;
  const kind = markerKind || 'dom';
  if (!['dom', 'text', 'node'].includes(kind)) return null;
  return { kind, value: { optionId, elementId } };
}

export function imageAnnotationTarget(optionId, x, y) {
  if (!optionId || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { kind: 'point', value: { optionId, x, y } };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function duplicates(values) {
  const seen = new Set();
  const result = new Set();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return result;
}

export function feedbackValidationErrors(feedback, prototype, label = 'feedback') {
  const errors = [];
  if (!isObject(feedback) || !isObject(prototype)) return errors;

  if (feedback.prototypeId !== prototype.id) {
    errors.push(`${label}.prototypeId must match the Prototype id`);
  }
  if (feedback.prototypeRevision !== prototype.revision) {
    errors.push(`${label}.prototypeRevision must match the Prototype revision`);
  }

  const options = new Map(
    Array.isArray(prototype.options)
      ? prototype.options.filter((option) => typeof option?.id === 'string').map((option) => [option.id, option])
      : [],
  );
  const selectedOptions = Array.isArray(feedback.selectedOptions) ? feedback.selectedOptions : [];
  for (const duplicate of duplicates(selectedOptions)) {
    errors.push(`${label}.selectedOptions contains duplicate option ${JSON.stringify(duplicate)}`);
  }
  for (const optionId of selectedOptions) {
    if (typeof optionId === 'string' && !options.has(optionId)) {
      errors.push(`${label}.selectedOptions references unknown option ${JSON.stringify(optionId)}`);
    }
  }

  const selectionMode = prototype.selectionMode || 'single';
  if (selectionMode === 'none' && selectedOptions.length !== 0) {
    errors.push(`${label}.selectedOptions must be empty when selectionMode is "none"`);
  }
  if (selectionMode === 'single' && selectedOptions.length > 1) {
    errors.push(`${label}.selectedOptions must contain at most one option when selectionMode is "single"`);
  }
  if (['rejected', 'new-material-question'].includes(feedback.verdict) && selectedOptions.length !== 0) {
    errors.push(`${label}.selectedOptions must be empty for a ${feedback.verdict} verdict`);
  }
  if (['accepted', 'revise'].includes(feedback.verdict) && selectionMode === 'single' && selectedOptions.length !== 1) {
    errors.push(`${label}.selectedOptions must contain exactly one option for an accepted or revise single-selection Prototype`);
  }
  if (['accepted', 'revise'].includes(feedback.verdict) && selectionMode === 'multiple' && selectedOptions.length < 1) {
    errors.push(`${label}.selectedOptions must contain at least one option for an accepted or revise multiple-selection Prototype`);
  }

  const questions = new Map(
    Array.isArray(prototype.guidedQuestions)
      ? prototype.guidedQuestions
        .filter((question) => typeof question?.id === 'string')
        .map((question) => [question.id, question])
      : [],
  );
  const answerIds = new Set();
  const answers = Array.isArray(feedback.answers) ? feedback.answers : [];
  for (const [index, answer] of answers.entries()) {
    if (!isObject(answer) || typeof answer.questionId !== 'string') continue;
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
    const selected = Array.isArray(answer.selected) ? answer.selected : [];
    for (const duplicate of duplicates(selected)) {
      errors.push(`${answerLabel}.selected contains duplicate value ${JSON.stringify(duplicate)}`);
    }
    const questionMode = question.selectionMode || 'single';
    if (questionMode === 'single' && selected.length > 1) {
      errors.push(`${answerLabel}.selected must contain at most one value`);
    }
    if (questionMode === 'freeform' && selected.length > 0) {
      errors.push(`${answerLabel}.selected must be empty for a freeform question`);
    }
    const allowedValues = new Set(question.choices || []);
    for (const selectedValue of selected) {
      if (questionMode !== 'freeform' && typeof selectedValue === 'string' && !allowedValues.has(selectedValue)) {
        errors.push(`${answerLabel}.selected contains undeclared value ${JSON.stringify(selectedValue)}`);
      }
    }
  }

  const annotations = Array.isArray(feedback.annotations) ? feedback.annotations : [];
  if (annotations.length > 0 && !prototype.allowAnnotations) {
    errors.push(`${label}.annotations are not allowed by the Prototype config`);
  }
  const annotationIds = new Set();
  for (const [index, annotation] of annotations.entries()) {
    if (!isObject(annotation)) continue;
    if (typeof annotation.id === 'string') {
      if (annotationIds.has(annotation.id)) {
        errors.push(`${label}.annotations contains duplicate id ${JSON.stringify(annotation.id)}`);
      }
      annotationIds.add(annotation.id);
    }
    const target = annotation.target;
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

  const cssVariables = isObject(prototype.editableCssVariables)
    ? prototype.editableCssVariables
    : {};
  const cssValues = isObject(feedback.cssVariableValues) ? feedback.cssVariableValues : {};
  for (const name of Object.keys(cssVariables)) {
    if (!(name in cssValues)) errors.push(`${label}.cssVariableValues.${name} is required`);
  }
  for (const [name, value] of Object.entries(cssValues)) {
    if (!Object.hasOwn(cssVariables, name)) {
      errors.push(`${label}.cssVariableValues contains undeclared variable ${JSON.stringify(name)}`);
      continue;
    }
    if (!cssVariables[name].includes(value)) {
      errors.push(`${label}.cssVariableValues.${name} contains undeclared value ${JSON.stringify(value)}`);
    }
  }

  if (feedback.verdict === 'revise') {
    const hasGuidedAnswer = answers.some((answer) => (
      (Array.isArray(answer?.selected) && answer.selected.length > 0) || hasText(answer?.comment)
    ));
    const hasCssChange = Object.entries(cssValues).some(([name, value]) => cssVariables[name]?.[0] !== value);
    if (!hasText(feedback.globalNotes) && !hasGuidedAnswer && annotations.length === 0 && !hasCssChange) {
      errors.push(`${label} revise verdict requires a global comment, guided answer, annotation, or non-default CSS value`);
    }
  }
  if (feedback.verdict === 'rejected') {
    if (!prototype.allowOther) errors.push(`${label}.verdict "rejected" is not allowed by the Prototype config`);
    if (!hasText(feedback.reason)) errors.push(`${label}.reason is required for a rejected verdict`);
  }
  if (feedback.verdict === 'new-material-question' && !hasText(feedback.materialQuestion)) {
    errors.push(`${label}.materialQuestion is required for a new-material-question verdict`);
  }

  return errors;
}

export function validateFeedbackForPrototype(feedback, prototype, label = 'feedback') {
  const errors = feedbackValidationErrors(feedback, prototype, label);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return feedback;
}
