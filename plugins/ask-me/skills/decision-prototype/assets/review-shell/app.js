import {
  annotationTargets,
  consumeSessionToken,
  feedbackValidationErrors,
  iframeSandbox,
  imageAnnotationTarget,
  markedAnnotationTarget,
} from './review-policy.mjs';

const state = {
  config: null,
  sessionToken: consumeSessionToken(window.location, window.history),
  selectedOptions: new Set(),
  activeOptionId: null,
  compare: false,
  viewport: 'desktop',
  answers: [],
  annotations: [],
  cssVariableValues: {},
  imageZoom: {},
  verdict: null,
  annotationDraft: null,
  annotationReturnFocus: null,
  availableAnnotationTargets: new Map(),
  previewCleanups: [],
  nextAnnotationId: 1,
  submitted: false,
};

const $ = (id) => document.getElementById(id);

function artifactUrl(artifactPath) {
  return new URL(`../${artifactPath}`, window.location.href).href;
}

function optionById(optionId) {
  return state.config.options.find((option) => option.id === optionId);
}

function appendList(target, values) {
  target.innerHTML = '';
  for (const value of values) {
    const item = document.createElement('li');
    item.textContent = value;
    target.append(item);
  }
}

function renderDecisionContext() {
  const context = state.config.decisionContext;
  $('decisionContext').hidden = false;
  $('decisionGoal').textContent = context.goal;
  appendList($('decisionPriorities'), context.priorities);
  appendList($('decisionConstraints'), context.constraints);
}

function syncPreviewActions() {
  $('compareToggle').hidden = state.config.options.length < 2;
  $('compareToggle').setAttribute('aria-pressed', String(state.compare));
  $('compareToggle').textContent = state.compare ? '结束并排比较' : '并排比较';
  const compareVisible = state.compare && !window.matchMedia('(max-width: 720px)').matches;
  const visibleOptions = compareVisible
    ? state.config.options
    : state.config.options.filter((option) => option.id === state.activeOptionId);
  $('viewportControls').hidden = !visibleOptions.some((option) => option.kind === 'html');
  for (const button of $('viewportControls').querySelectorAll('[data-viewport]')) {
    button.setAttribute('aria-pressed', String(button.dataset.viewport === state.viewport));
  }
}

function renderTabs() {
  const tabs = $('candidateTabs');
  tabs.innerHTML = '';
  tabs.hidden = state.config.options.length < 2;
  if (tabs.hidden) return;
  tabs.setAttribute('role', 'tablist');
  state.config.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.id = `candidate-tab-${option.id}`;
    button.dataset.optionId = option.id;
    button.setAttribute('aria-controls', `preview-${option.id}`);
    button.setAttribute('aria-selected', String(option.id === state.activeOptionId));
    button.tabIndex = option.id === state.activeOptionId ? 0 : -1;
    button.textContent = option.label;
    button.onclick = () => setActiveOption(option.id);
    button.onkeydown = (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + state.config.options.length) % state.config.options.length;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % state.config.options.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = state.config.options.length - 1;
      const next = state.config.options[nextIndex];
      setActiveOption(next.id);
      requestAnimationFrame(() => $(`candidate-tab-${next.id}`)?.focus());
    };
    tabs.append(button);
  });
}

function syncSelectionControls() {
  for (const input of $('selectionChoices').querySelectorAll('input')) {
    input.checked = state.selectedOptions.has(input.value);
    input.closest('label')?.classList.toggle('selected', input.checked);
  }
}

function syncSelectionForVerdict() {
  const requiresSelection = ['accepted', 'revise'].includes(state.verdict);
  if (!requiresSelection) {
    state.selectedOptions.clear();
  } else if (
    state.config.selectionMode !== 'none'
    && state.config.options.length === 1
  ) {
    state.selectedOptions.add(state.config.options[0].id);
  }
  const hasControls = state.config.options.length > 1 && state.config.selectionMode !== 'none';
  $('candidateSelection').hidden = !requiresSelection || !hasControls;
  $('candidateSelection').disabled = !requiresSelection;
  syncSelectionControls();
}

function renderSelectionControls() {
  const selection = $('candidateSelection');
  const choices = $('selectionChoices');
  choices.innerHTML = '';
  const hasControls = state.config.options.length > 1 && state.config.selectionMode !== 'none';
  selection.hidden = !hasControls || !['accepted', 'revise'].includes(state.verdict);
  if (!hasControls) return;

  for (const option of state.config.options) {
    const label = document.createElement('label');
    label.className = 'selection-card';
    const input = document.createElement('input');
    input.type = state.config.selectionMode === 'multiple' ? 'checkbox' : 'radio';
    input.name = 'selected-option';
    input.value = option.id;
    input.checked = state.selectedOptions.has(option.id);
    input.onchange = () => {
      if (state.config.selectionMode === 'single') state.selectedOptions.clear();
      if (input.checked) state.selectedOptions.add(option.id);
      else state.selectedOptions.delete(option.id);
      setActiveOption(option.id);
      syncSelectionControls();
      clearFieldError('selectionError', selection);
    };
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = option.label;
    const description = document.createElement('small');
    description.textContent = option.description || option.summary || '';
    text.append(title, description);
    label.append(input, text);
    label.classList.toggle('selected', input.checked);
    choices.append(label);
  }
}

function setActiveOption(optionId, { renderPreview = true } = {}) {
  state.activeOptionId = optionId;
  renderTabs();
  if (renderPreview) renderPreviews();
}

function injectMarkerStyles(iframeDocument) {
  if (iframeDocument.getElementById('prototype-review-marker-styles')) return;
  const style = iframeDocument.createElement('style');
  style.id = 'prototype-review-marker-styles';
  style.textContent = '.prototype-review-marker{position:fixed;z-index:2147483647;display:grid;place-items:center;width:28px;height:28px;margin:0;padding:0;border:2px solid white;border-radius:999px;background:#b42318;color:white;font:700 14px/1 system-ui;box-shadow:0 1px 5px #0008;cursor:pointer}.prototype-review-marker[hidden]{display:none!important}.prototype-review-marker:focus-visible{outline:3px solid #2563eb;outline-offset:2px}';
  iframeDocument.head?.append(style);
}

function annotationNumber(annotationId) {
  return state.annotations.findIndex((annotation) => annotation.id === annotationId) + 1;
}

function findMarkedElement(iframeDocument, elementId) {
  return [...iframeDocument.querySelectorAll('[data-prototype-id]')]
    .find((element) => element.getAttribute('data-prototype-id') === elementId);
}

function positionDomMarkers(iframe, optionId) {
  const iframeDocument = iframe.contentDocument;
  const iframeWindow = iframe.contentWindow;
  if (!iframeDocument || !iframeWindow) return;
  for (const marker of iframeDocument.querySelectorAll('.prototype-review-marker')) {
    const annotation = state.annotations.find((item) => item.id === marker.dataset.annotationId);
    if (!annotation || annotation.target.value.optionId !== optionId) continue;
    const target = findMarkedElement(iframeDocument, annotation.target.value.elementId);
    if (!target) {
      marker.hidden = true;
      continue;
    }
    const rect = target.getBoundingClientRect();
    const visible = rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < iframeWindow.innerHeight
      && rect.left < iframeWindow.innerWidth;
    marker.hidden = !visible;
    if (!visible) continue;
    marker.style.left = `${Math.max(4, Math.min(rect.right - 14, iframeWindow.innerWidth - 32))}px`;
    marker.style.top = `${Math.max(4, Math.min(rect.top + 4, iframeWindow.innerHeight - 32))}px`;
  }
}

function renderDomMarkers(iframe, optionId) {
  try {
    const iframeDocument = iframe.contentDocument;
    if (!iframeDocument) return;
    injectMarkerStyles(iframeDocument);
    for (const marker of iframeDocument.querySelectorAll('.prototype-review-marker')) marker.remove();
    for (const annotation of state.annotations) {
      if (!['dom', 'text', 'node'].includes(annotation.target.kind)) continue;
      if (annotation.target.value.optionId !== optionId) continue;
      const target = findMarkedElement(iframeDocument, annotation.target.value.elementId);
      if (!target) continue;
      const marker = iframeDocument.createElement('button');
      marker.type = 'button';
      marker.className = 'prototype-review-marker';
      marker.dataset.annotationId = annotation.id;
      marker.textContent = String(annotationNumber(annotation.id));
      marker.setAttribute('aria-label', `编辑标注 ${annotationNumber(annotation.id)}`);
      marker.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openAnnotationDrawer(annotation.target, annotation, marker);
      };
      iframeDocument.body.append(marker);
    }
    positionDomMarkers(iframe, optionId);
  } catch {
    // Cross-origin iframes remain view-only.
  }
}

function registerDomAnnotationTargets(iframe, option) {
  if (!state.config.allowAnnotations || state.config.htmlExecution !== 'static') return;
  try {
    let changed = false;
    for (const element of iframe.contentDocument.querySelectorAll('[data-prototype-id]')) {
      const target = markedAnnotationTarget(
        option.id,
        element.getAttribute('data-prototype-id'),
        element.getAttribute('data-prototype-kind'),
      );
      if (!target || state.availableAnnotationTargets.has(annotationTargetKey(target))) continue;
      state.availableAnnotationTargets.set(annotationTargetKey(target), target);
      changed = true;
    }
    if (changed) renderAnnotationTargets();
  } catch {
    // Cross-origin iframes remain view-only.
  }
}

function attachDomMarkerRefresh(iframe, optionId) {
  if (!state.config.allowAnnotations || state.config.htmlExecution !== 'static') return;
  const iframeWindow = iframe.contentWindow;
  const iframeDocument = iframe.contentDocument;
  if (!iframeWindow || !iframeDocument) return;
  let refreshFrame = null;
  const refresh = () => {
    if (refreshFrame !== null) return;
    refreshFrame = iframeWindow.requestAnimationFrame(() => {
      refreshFrame = null;
      if (iframe.isConnected) positionDomMarkers(iframe, optionId);
    });
  };
  iframeWindow.addEventListener('scroll', refresh, true);
  iframeWindow.addEventListener('resize', refresh);
  const previewObserver = new ResizeObserver(refresh);
  previewObserver.observe(iframe);
  const contentObserver = new iframeWindow.ResizeObserver(refresh);
  contentObserver.observe(iframeDocument.documentElement);
  state.previewCleanups.push(() => {
    iframeWindow.removeEventListener('scroll', refresh, true);
    iframeWindow.removeEventListener('resize', refresh);
    previewObserver.disconnect();
    contentObserver.disconnect();
    if (refreshFrame !== null) iframeWindow.cancelAnimationFrame(refreshFrame);
  });
}

function applyCssVariablesToIframe(iframe) {
  for (const [name, value] of Object.entries(state.cssVariableValues)) {
    try {
      iframe.contentDocument?.documentElement.style.setProperty(name, value);
    } catch {
      // Cross-origin iframes remain view-only.
    }
  }
}

function attachDomAnnotations(iframe, option) {
  if (!state.config.allowAnnotations || state.config.htmlExecution !== 'static') return;
  try {
    iframe.contentDocument.addEventListener('click', (event) => {
      const element = event.target.closest?.('[data-prototype-id]');
      if (!element) return;
      const target = markedAnnotationTarget(
        option.id,
        element.getAttribute('data-prototype-id'),
        element.getAttribute('data-prototype-kind'),
      );
      if (!target) return;
      event.preventDefault();
      openAnnotationDrawer(target);
    }, true);
  } catch {
    // Cross-origin iframes remain view-only.
  }
}

function renderHtmlPreview(container, option) {
  const frameShell = document.createElement('div');
  frameShell.className = 'html-frame-shell';
  frameShell.dataset.viewport = state.viewport;
  const iframe = document.createElement('iframe');
  iframe.src = artifactUrl(option.artifact);
  iframe.title = option.label;
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', iframeSandbox(state.config));
  iframe.dataset.optionId = option.id;
  iframe.onload = () => {
    applyCssVariablesToIframe(iframe);
    registerDomAnnotationTargets(iframe, option);
    attachDomAnnotations(iframe, option);
    renderDomMarkers(iframe, option.id);
    attachDomMarkerRefresh(iframe, option.id);
  };
  frameShell.append(iframe);
  container.append(frameShell);
}

function renderImageMarkers(canvas, optionId) {
  for (const annotation of state.annotations) {
    if (annotation.target.kind !== 'point' || annotation.target.value.optionId !== optionId) continue;
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'image-marker';
    marker.dataset.annotationId = annotation.id;
    marker.style.left = `${annotation.target.value.x * 100}%`;
    marker.style.top = `${annotation.target.value.y * 100}%`;
    marker.textContent = String(annotationNumber(annotation.id));
    marker.setAttribute('aria-label', `编辑标注 ${annotationNumber(annotation.id)}`);
    marker.onclick = (event) => {
      event.stopPropagation();
      openAnnotationDrawer(annotation.target, annotation, marker);
    };
    canvas.append(marker);
  }
}

function renderImagePreview(container, option) {
  const zoom = state.imageZoom[option.id] || 100;
  const controls = document.createElement('label');
  controls.className = 'zoom-control';
  controls.textContent = '图片缩放';
  const value = document.createElement('output');
  value.textContent = `${zoom}%`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '100';
  input.max = '200';
  input.step = '25';
  input.value = String(zoom);
  input.dataset.imageZoom = option.id;
  controls.append(input, value);

  const stage = document.createElement('div');
  stage.className = 'image-stage';
  const canvas = document.createElement('div');
  canvas.className = 'image-canvas';
  canvas.style.width = `${zoom}%`;
  const image = document.createElement('img');
  image.src = artifactUrl(option.artifact);
  image.alt = option.label;
  image.dataset.optionId = option.id;
  if (state.config.allowAnnotations) {
    image.onclick = (event) => {
      const rect = image.getBoundingClientRect();
      const target = imageAnnotationTarget(
        option.id,
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
      if (target) openAnnotationDrawer(target);
    };
  }
  canvas.append(image);
  renderImageMarkers(canvas, option.id);
  stage.append(canvas);
  input.oninput = () => {
    state.imageZoom[option.id] = Number(input.value);
    canvas.style.width = `${input.value}%`;
    value.textContent = `${input.value}%`;
  };
  container.append(controls, stage);
}

function renderTextPreview(container, option) {
  const pre = document.createElement('pre');
  pre.textContent = '加载中…';
  fetch(artifactUrl(option.artifact))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((text) => {
      if (pre.isConnected) pre.textContent = text;
    })
    .catch(() => {
      if (pre.isConnected) pre.textContent = '无法加载此候选。';
    });
  container.append(pre);
}

function renderPreview(option) {
  const panel = document.createElement('article');
  panel.className = 'preview-panel';
  panel.id = `preview-${option.id}`;
  panel.dataset.optionId = option.id;
  panel.setAttribute('aria-labelledby', state.config.options.length > 1 ? `candidate-tab-${option.id}` : 'candidatesHeading');
  if (state.compare) {
    const heading = document.createElement('h3');
    heading.textContent = option.label;
    panel.append(heading);
  }
  if (option.description || option.summary) {
    const description = document.createElement('p');
    description.className = 'option-description';
    description.textContent = option.description || option.summary;
    panel.append(description);
  }
  if (option.kind === 'html') renderHtmlPreview(panel, option);
  else if (option.kind === 'image') renderImagePreview(panel, option);
  else renderTextPreview(panel, option);
  return panel;
}

function renderPreviews() {
  const host = $('previewHost');
  const useCompare = state.compare && !window.matchMedia('(max-width: 720px)').matches;
  for (const cleanup of state.previewCleanups.splice(0)) cleanup();
  host.classList.toggle('compare', useCompare);
  host.innerHTML = '';
  const options = useCompare
    ? state.config.options
    : state.config.options.filter((option) => option.id === state.activeOptionId);
  for (const option of options) host.append(renderPreview(option));
  syncPreviewActions();
}

function renderGuidedQuestions() {
  const questions = state.config.guidedQuestions || [];
  if (questions.length === 0) return;
  $('guided').hidden = false;
  state.answers = questions.map((question) => ({ questionId: question.id, selected: [], comment: '' }));
  questions.forEach((question, index) => {
    const field = document.createElement('fieldset');
    field.className = 'guided-question';
    field.dataset.questionId = question.id;
    field.dataset.answerMode = question.selectionMode;
    const legend = document.createElement('legend');
    legend.textContent = question.label;
    field.append(legend);

    if (question.selectionMode === 'freeform') {
      const textarea = document.createElement('textarea');
      textarea.rows = 4;
      textarea.setAttribute('aria-label', question.label);
      textarea.oninput = () => { state.answers[index].comment = textarea.value; };
      field.append(textarea);
    } else {
      const choices = document.createElement('div');
      choices.className = 'guided-choices';
      for (const choice of question.choices || []) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = question.selectionMode === 'multiple' ? 'checkbox' : 'radio';
        input.name = `guided-${question.id}`;
        input.value = choice;
        input.onchange = () => {
          if (question.selectionMode === 'single') state.answers[index].selected = [];
          if (input.checked && !state.answers[index].selected.includes(choice)) {
            state.answers[index].selected.push(choice);
          }
          if (!input.checked) {
            state.answers[index].selected = state.answers[index].selected.filter((value) => value !== choice);
          }
          clearFieldError('guidedError', $('guided'));
        };
        label.append(input, document.createTextNode(` ${choice}`));
        choices.append(label);
      }
      const comment = document.createElement('input');
      comment.type = 'text';
      comment.placeholder = '补充说明（可选）';
      comment.setAttribute('aria-label', `${question.label}补充说明`);
      comment.oninput = () => { state.answers[index].comment = comment.value; };
      field.append(choices, comment);
    }
    $('guidedQuestions').append(field);
  });
}

function applyCssVariable(name, value) {
  state.cssVariableValues[name] = value;
  for (const iframe of document.querySelectorAll('.preview-panel iframe')) {
    applyCssVariablesToIframe(iframe);
  }
}

function renderEditableCssVariables() {
  const entries = Object.entries(state.config.editableCssVariables || {});
  if (entries.length === 0) return;
  $('tokens').hidden = false;
  for (const [name, values] of entries) {
    applyCssVariable(name, String(values[0]));
    const label = document.createElement('label');
    const code = document.createElement('code');
    code.textContent = name;
    const select = document.createElement('select');
    select.dataset.variableName = name;
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    select.onchange = () => {
      applyCssVariable(name, select.value);
      clearFieldError('tokensError', $('tokens'));
    };
    label.append(code, select);
    $('tokenControls').append(label);
  }
}

function targetSummary(target) {
  const option = optionById(target.value.optionId);
  if (target.kind === 'point') {
    return `${option.label} · 图片位置 ${Math.round(target.value.x * 100)}%, ${Math.round(target.value.y * 100)}%`;
  }
  const kinds = { dom: '页面元素', text: '文本块', node: '流程节点' };
  return `${option.label} · ${kinds[target.kind]} ${target.value.elementId}`;
}

function annotationTargetKey(target) {
  if (target.kind === 'point') return `point:${target.value.optionId}:${target.value.x}:${target.value.y}`;
  return `${target.kind}:${target.value.optionId}:${target.value.elementId}`;
}

function renderAnnotationTargets() {
  const container = $('annotationTargets');
  for (const target of state.availableAnnotationTargets.values()) {
    const targetKey = annotationTargetKey(target);
    const exists = [...container.querySelectorAll('[data-annotation-target-key]')]
      .some((button) => button.dataset.annotationTargetKey === targetKey);
    if (exists) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset.annotationTargetKey = targetKey;
    button.textContent = target.kind === 'point'
      ? `标注 ${optionById(target.value.optionId).label} · 图片中心（50%, 50%）`
      : `标注 ${targetSummary(target)}`;
    button.onclick = () => {
      state.compare = false;
      setActiveOption(target.value.optionId);
      openAnnotationDrawer(target, null, button);
    };
    container.append(button);
  }
}

function openAnnotationDrawer(target, annotation = null, trigger = document.activeElement) {
  if (state.submitted) return;
  state.annotationDraft = { target, annotationId: annotation?.id || null };
  state.annotationReturnFocus = trigger;
  $('annotationDrawerHeading').textContent = annotation ? '编辑标注' : '添加标注';
  $('annotationTarget').textContent = targetSummary(target);
  $('annotationCategory').value = annotation?.category.kind || 'information-hierarchy';
  $('annotationComment').value = annotation?.comment || '';
  $('annotationOutcome').value = annotation?.desiredOutcome || '';
  clearFieldError('annotationCommentError', $('annotationComment'));
  $('annotationDrawer').hidden = false;
  document.body.classList.add('drawer-open');
  $('annotationCategory').focus();
}

function closeAnnotationDrawer({ restoreFocus = true } = {}) {
  const returnFocus = state.annotationReturnFocus;
  state.annotationDraft = null;
  state.annotationReturnFocus = null;
  $('annotationDrawer').hidden = true;
  document.body.classList.remove('drawer-open');
  if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
    requestAnimationFrame(() => returnFocus.focus());
  }
}

function saveAnnotation() {
  const comment = $('annotationComment').value.trim();
  if (!comment) {
    showFieldError('annotationCommentError', '请具体说明这个位置的问题。', $('annotationComment'));
    $('annotationComment').focus();
    return;
  }
  const annotation = {
    id: state.annotationDraft.annotationId || `annotation-${state.nextAnnotationId++}`,
    target: state.annotationDraft.target,
    category: { kind: $('annotationCategory').value },
    comment,
    ...($('annotationOutcome').value.trim()
      ? { desiredOutcome: $('annotationOutcome').value.trim() }
      : {}),
  };
  const existingIndex = state.annotations.findIndex((item) => item.id === annotation.id);
  if (existingIndex >= 0) state.annotations[existingIndex] = annotation;
  else state.annotations.push(annotation);
  closeAnnotationDrawer();
  renderAnnotations();
  clearFieldError('annotationError', $('annotationPanel'));
}

function findAnnotationMarker(annotationId) {
  const imageMarker = document.querySelector(`.image-marker[data-annotation-id="${annotationId}"]`);
  if (imageMarker) return imageMarker;
  for (const iframe of document.querySelectorAll('.preview-panel iframe')) {
    try {
      const marker = iframe.contentDocument?.querySelector(`[data-annotation-id="${annotationId}"]`);
      if (marker) return marker;
    } catch {
      // Cross-origin iframes remain view-only.
    }
  }
  return null;
}

function focusAnnotation(annotation) {
  state.compare = false;
  setActiveOption(annotation.target.value.optionId);
  let attempts = 0;
  const focusMarker = () => {
    const marker = findAnnotationMarker(annotation.id);
    if (marker) {
      marker.scrollIntoView({ block: 'center', inline: 'center' });
      marker.focus();
      return;
    }
    attempts += 1;
    if (attempts < 20) setTimeout(focusMarker, 25);
  };
  requestAnimationFrame(focusMarker);
}

function renderAnnotations() {
  const list = $('annotations');
  list.innerHTML = '';
  $('annotationEmpty').hidden = state.annotations.length > 0;
  for (const annotation of state.annotations) {
    const item = document.createElement('li');
    item.className = 'annotation-item';
    const focus = document.createElement('button');
    focus.type = 'button';
    focus.className = 'annotation-summary';
    const number = document.createElement('span');
    number.className = 'annotation-number';
    number.textContent = String(annotationNumber(annotation.id));
    const summary = document.createElement('span');
    summary.textContent = `${targetSummary(annotation.target)}：${annotation.comment}`;
    focus.append(number, summary);
    focus.onclick = () => focusAnnotation(annotation);
    const actions = document.createElement('div');
    actions.className = 'annotation-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = '编辑';
    edit.onclick = () => openAnnotationDrawer(annotation.target, annotation);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = '删除';
    remove.onclick = () => {
      state.annotations = state.annotations.filter((itemValue) => itemValue.id !== annotation.id);
      renderAnnotations();
    };
    actions.append(edit, remove);
    item.append(focus, actions);
    list.append(item);
  }
  renderPreviews();
}

function renderAnnotationPanel() {
  const supportedTargets = annotationTargets(state.config);
  $('annotationPanel').hidden = supportedTargets.length === 0;
  if (supportedTargets.length === 0) return;
  const labels = [];
  if (supportedTargets.includes('image')) labels.push('图片位置');
  if (supportedTargets.includes('dom')) labels.push('页面中有稳定标记的元素');
  $('annotationHelp').textContent = `点击${labels.join('或')}，添加带编号的标注。`;
  $('annotationKeyboardHelp').textContent = '也可以用键盘选择下方目标。图片键盘入口使用图像中心点。';
  for (const option of state.config.options) {
    if (option.kind !== 'image') continue;
    const target = imageAnnotationTarget(option.id, 0.5, 0.5);
    if (target) state.availableAnnotationTargets.set(annotationTargetKey(target), target);
  }
  renderAnnotationTargets();
}

function renderVerdictDetail() {
  const detail = $('verdictDetail');
  detail.hidden = !['rejected', 'new-material-question'].includes(state.verdict);
  if (detail.hidden) return;
  const rejected = state.verdict === 'rejected';
  $('verdictDetailLabel').textContent = rejected ? '不接受的原因' : '需要先澄清的问题';
  $('verdictDetailInput').placeholder = rejected
    ? '说明当前候选为什么不成立。'
    : '说明哪个新问题会改变当前决定。';
}

function syncProgressiveFeedback() {
  $('detailFeedback').hidden = !['accepted', 'revise'].includes(state.verdict);
  syncSelectionForVerdict();
  renderVerdictDetail();
}

function feedback() {
  const value = {
    schemaVersion: 2,
    reviewShellVersion: 2,
    prototypeId: state.config.id,
    prototypeRevision: state.config.revision,
    verdict: state.verdict,
    selectedOptions: [...state.selectedOptions],
    answers: state.answers,
    annotations: state.annotations,
    cssVariableValues: state.cssVariableValues,
    globalNotes: $('globalNotes').value,
  };
  if (state.verdict === 'rejected') value.reason = $('verdictDetailInput').value;
  if (state.verdict === 'new-material-question') value.materialQuestion = $('verdictDetailInput').value;
  return value;
}

function showFieldError(errorId, message, field) {
  const error = $(errorId);
  error.textContent = message;
  error.hidden = false;
  field?.setAttribute('aria-invalid', 'true');
}

function clearFieldError(errorId, field) {
  const error = $(errorId);
  error.hidden = true;
  error.textContent = '';
  field?.removeAttribute('aria-invalid');
}

function clearValidationErrors() {
  for (const [errorId, fieldId] of [
    ['selectionError', 'candidateSelection'],
    ['guidedError', 'guided'],
    ['tokensError', 'tokens'],
    ['annotationError', 'annotationPanel'],
    ['notesError', 'globalNotes'],
    ['verdictError', 'verdictFieldset'],
    ['verdictDetailError', 'verdictDetailInput'],
    ['formError', 'reviewForm'],
  ]) clearFieldError(errorId, $(fieldId));
}

function clientValidation() {
  clearValidationErrors();
  if (!state.verdict) {
    showFieldError('verdictError', '请选择一个总体判断。', $('verdictFieldset'));
    return { valid: false, focus: document.querySelector('input[name="verdict"]') };
  }
  const errors = feedbackValidationErrors(feedback(), state.config);
  if (errors.length === 0) return { valid: true, focus: null };
  let focus = null;
  for (const error of errors) {
    if (error.includes('selectedOptions')) {
      showFieldError('selectionError', '接受当前方向前，请按候选选择规则完成选择。', $('candidateSelection'));
      focus ||= $('selectionChoices').querySelector('input');
    } else if (error.includes('revise verdict requires')) {
      showFieldError('notesError', '请至少提供一项具体反馈：整体说明、引导回答、局部标注或非默认参数。', $('globalNotes'));
      focus ||= $('globalNotes');
    } else if (error.includes('.reason is required')) {
      showFieldError('verdictDetailError', '请说明当前候选不合适的原因。', $('verdictDetailInput'));
      focus ||= $('verdictDetailInput');
    } else if (error.includes('.materialQuestion is required')) {
      showFieldError('verdictDetailError', '请写出需要先澄清的新问题。', $('verdictDetailInput'));
      focus ||= $('verdictDetailInput');
    } else if (error.includes('cssVariableValues')) {
      showFieldError('tokensError', '请选择所有受控参数的有效值。', $('tokens'));
      focus ||= $('tokenControls').querySelector('select');
    } else if (error.includes('.answers')) {
      showFieldError('guidedError', '请检查引导问题的回答。', $('guided'));
      focus ||= $('guidedQuestions').querySelector('input, textarea');
    } else if (error.includes('.annotations')) {
      showFieldError('annotationError', '请检查局部标注。', $('annotationPanel'));
      focus ||= $('annotations').querySelector('button');
    } else {
      showFieldError('formError', '反馈与当前原型不匹配，请检查后重试。', $('reviewForm'));
      focus ||= $('formError');
    }
  }
  return { valid: false, focus };
}

function markSubmitted({ accepted = true } = {}) {
  state.submitted = true;
  closeAnnotationDrawer({ restoreFocus: false });
  $('reviewForm').hidden = true;
  $('success').hidden = false;
  $('successMessage').textContent = accepted
    ? '反馈已提交。Agent 已收到，可以关闭本页。'
    : '已有反馈先完成提交。本次内容没有覆盖已提交的结果，可以关闭本页。';
  $('success').focus();
}

async function submitFeedback(event) {
  event.preventDefault();
  if (state.submitted) return;
  const result = clientValidation();
  if (!result.valid) {
    result.focus?.focus();
    return;
  }
  const button = $('submitFeedback');
  button.disabled = true;
  $('status').textContent = '正在提交…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-prototype-review-token': state.sessionToken,
      },
      body: JSON.stringify(feedback()),
    });
    if (!response.ok) throw new Error('提交失败');
    const receipt = await response.json();
    markSubmitted({ accepted: receipt.accepted !== false });
  } catch {
    showFieldError('formError', '反馈未提交。请确认会话仍在运行，然后重试。', $('reviewForm'));
    $('status').textContent = '';
    $('formError').focus();
    button.disabled = false;
  }
}

async function initialize() {
  const response = await fetch('./config.json');
  if (!response.ok) throw new Error('无法加载 Prototype 配置。');
  state.config = await response.json();
  state.activeOptionId = state.config.options[0].id;
  if (state.config.options.length === 1 && state.config.selectionMode !== 'none') {
    state.selectedOptions.add(state.config.options[0].id);
  }
  $('question').textContent = state.config.question;
  $('meta').textContent = `Revision ${state.config.revision}`;
  renderDecisionContext();
  renderTabs();
  renderSelectionControls();
  renderGuidedQuestions();
  renderEditableCssVariables();
  renderAnnotationPanel();
  renderPreviews();
  $('rejectedVerdict').hidden = !state.config.allowOther;
  syncProgressiveFeedback();
}

$('reviewForm').addEventListener('submit', submitFeedback);
$('compareToggle').onclick = () => {
  state.compare = !state.compare;
  renderPreviews();
};
for (const button of $('viewportControls').querySelectorAll('[data-viewport]')) {
  button.onclick = () => {
    state.viewport = button.dataset.viewport;
    renderPreviews();
  };
}
for (const input of document.querySelectorAll('input[name="verdict"]')) {
  input.onchange = () => {
    state.verdict = input.value;
    $('verdictDetailInput').value = '';
    syncProgressiveFeedback();
    clearFieldError('verdictError', $('verdictFieldset'));
    clearFieldError('verdictDetailError', $('verdictDetailInput'));
  };
}
$('saveAnnotation').onclick = saveAnnotation;
$('cancelAnnotation').onclick = closeAnnotationDrawer;
$('closeAnnotation').onclick = closeAnnotationDrawer;
$('annotationDrawer').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAnnotationDrawer();
});
window.addEventListener('resize', () => {
  if (state.config && state.compare) renderPreviews();
});

try {
  await initialize();
} catch (error) {
  $('question').textContent = '无法打开 Prototype Review';
  showFieldError('formError', error.message, $('reviewForm'));
}
