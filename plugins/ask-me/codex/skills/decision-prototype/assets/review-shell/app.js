import { annotationTargets, iframeSandbox, imageAnnotationTarget, markedAnnotationTarget } from './review-policy.mjs';

const state = { config: null, sessionToken: null, selectedOptions: new Set(), answers: [], annotations: [], cssVariableValues: {}, verdict: 'revise' };
const $ = (id) => document.getElementById(id);

function artifactUrl(path) {
  return new URL(`../${path}`, window.location.href).href;
}

function addAnnotation(target) {
  const comment = window.prompt('请说明问题。');
  if (!comment) return;
  const desiredOutcome = window.prompt('你希望得到什么结果？') || '';
  state.annotations.push({
    id: `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    target,
    category: 'prototype-feedback',
    comment,
    desiredOutcome,
  });
  renderAnnotations();
}

function renderAnnotations() {
  $('annotations').innerHTML = '';
  for (const item of state.annotations) {
    const li = document.createElement('li');
    li.className = 'annotation';
    const text = document.createElement('span');
    text.textContent = `${item.target.kind}: ${JSON.stringify(item.target.value)} — ${item.comment}`;
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.className = 'secondary';
    remove.onclick = () => {
      state.annotations = state.annotations.filter((value) => value.id !== item.id);
      renderAnnotations();
    };
    li.append(text, remove);
    $('annotations').append(li);
  }
}

function renderOption(option) {
  const card = document.createElement('article');
  card.className = 'option';
  card.dataset.optionId = option.id;
  const heading = document.createElement('h2');
  heading.textContent = option.label;
  const description = document.createElement('p');
  description.textContent = option.description || '';
  const choose = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.onchange = () => {
    if (checkbox.checked) state.selectedOptions.add(option.id);
    else state.selectedOptions.delete(option.id);
    card.classList.toggle('selected', checkbox.checked);
  };
  choose.append(checkbox, ' 选择此方案');
  card.append(heading, description, choose);

  if (option.kind === 'html') {
    const iframe = document.createElement('iframe');
    iframe.src = artifactUrl(option.artifact);
    iframe.title = option.label;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox', iframeSandbox(state.config));
    iframe.onload = () => {
      for (const [name, value] of Object.entries(state.cssVariableValues)) {
        try {
          iframe.contentDocument.documentElement.style.setProperty(name, value);
        } catch {
          // Cross-origin iframes remain view-only.
        }
      }
      if (!state.config.allowAnnotations) return;
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
          addAnnotation(target);
        }, true);
      } catch {
        // Cross-origin iframes remain view-only.
      }
    };
    card.append(iframe);
  } else if (option.kind === 'image') {
    const image = document.createElement('img');
    image.src = artifactUrl(option.artifact);
    image.alt = option.label;
    if (state.config.allowAnnotations) {
      image.onclick = (event) => {
        const rect = image.getBoundingClientRect();
        const target = imageAnnotationTarget(
          option.id,
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
        );
        if (target) addAnnotation(target);
      };
    }
    card.append(image);
  } else {
    const pre = document.createElement('pre');
    fetch(artifactUrl(option.artifact)).then((response) => response.text()).then((text) => { pre.textContent = text; }).catch((error) => { pre.textContent = String(error); });
    card.append(pre);
  }
  return card;
}

function renderGuided() {
  const questions = state.config.guidedQuestions || [];
  if (!questions.length) return;
  $('guided').hidden = false;
  $('guided').innerHTML = '<h2>引导问题</h2>';
  state.answers = questions.map((question) => ({ questionId: question.id, selected: [], comment: '' }));
  questions.forEach((question, index) => {
    const field = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = question.label;
    field.append(title);
    for (const choice of question.choices || []) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.onchange = () => {
        const values = state.answers[index].selected;
        if (input.checked && !values.includes(choice)) values.push(choice);
        if (!input.checked) state.answers[index].selected = values.filter((value) => value !== choice);
      };
      label.append(input, ` ${choice} `);
      field.append(label);
    }
    const comment = document.createElement('input');
    comment.type = 'text';
    comment.placeholder = '补充说明';
    comment.oninput = () => { state.answers[index].comment = comment.value; };
    field.append(comment);
    $('guided').append(field);
  });
}

function applyCssVariable(name, value) {
  state.cssVariableValues[name] = value;
  for (const iframe of document.querySelectorAll('.option iframe')) {
    try {
      iframe.contentDocument.documentElement.style.setProperty(name, value);
    } catch {
      // Cross-origin iframes remain view-only.
    }
  }
}

function renderEditableCssVariables() {
  const entries = Object.entries(state.config.editableCssVariables || {});
  if (!entries.length) return;
  $('tokens').hidden = false;
  const heading = document.createElement('h2');
  heading.textContent = '受控参数';
  $('tokens').append(heading);
  for (const [name, values] of entries) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const answer = { questionId: `css-variable:${name}`, selected: [String(values[0])], comment: '' };
    state.answers.push(answer);
    applyCssVariable(name, String(values[0]));
    const label = document.createElement('label');
    label.textContent = name;
    const select = document.createElement('select');
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    select.onchange = () => {
      answer.selected = [select.value];
      applyCssVariable(name, select.value);
    };
    label.append(select);
    $('tokens').append(label);
  }
}

function feedback() {
  return {
    schemaVersion: 1,
    prototypeId: state.config.id,
    prototypeRevision: state.config.revision,
    verdict: state.verdict,
    selectedOptions: [...state.selectedOptions],
    answers: state.answers,
    annotations: state.annotations,
    globalNotes: $('globalNotes').value,
  };
}

async function save(verdict) {
  state.verdict = verdict;
  const body = JSON.stringify(feedback(), null, 2);
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prototype-review-token': state.sessionToken },
      body,
    });
    if (!response.ok) throw new Error(await response.text());
    $('status').textContent = '已保存 feedback.json';
  } catch (error) {
    $('status').textContent = `未写入服务器，可下载 JSON：${error.message}`;
  }
}

function download() {
  const blob = new Blob([JSON.stringify(feedback(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'feedback.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

const [configResponse, sessionResponse] = await Promise.all([fetch('./config.json'), fetch('/api/session')]);
state.config = await configResponse.json();
state.sessionToken = (await sessionResponse.json()).token;
$('question').textContent = state.config.question;
$('meta').textContent = `${state.config.id} · revision ${state.config.revision}`;
if (state.config.decisionFrame) {
  $('frame').hidden = false;
  const heading = document.createElement('h2');
  heading.textContent = 'Decision frame';
  const content = document.createElement('pre');
  content.textContent = JSON.stringify(state.config.decisionFrame, null, 2);
  $('frame').append(heading, content);
}
for (const option of state.config.options) $('options').append(renderOption(option));
renderGuided();
renderEditableCssVariables();
$('otherVerdict').hidden = !state.config.allowOther;
const supportedAnnotationTargets = annotationTargets(state.config);
$('annotationPanel').hidden = supportedAnnotationTargets.length === 0;
if (supportedAnnotationTargets.length > 0) {
  const labels = [];
  if (supportedAnnotationTargets.includes('image')) labels.push('图片');
  if (supportedAnnotationTargets.includes('dom')) labels.push('带有稳定标记的页面元素、文本块或流程节点');
  $('annotationHelp').textContent = `点击${labels.join('或')}可添加标注。`;
}
for (const button of document.querySelectorAll('[data-verdict]')) button.onclick = () => save(button.dataset.verdict);
$('download').onclick = download;
