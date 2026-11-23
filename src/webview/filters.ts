import type { FromEditor, ToEditor } from '../core/filter-messages.ts';
import { buildQuery, emptyForm, parseQuery, type FilterForm, type FilterState, type FilterType } from '../core/filter-query.ts';
import type { CustomQuery, RepoLabel, SearchPreview } from '../core/github.ts';

declare function acquireVsCodeApi(): { postMessage(msg: FromEditor): void };

interface Draft {
  id: number;
  name: string;
  form: FilterForm;
}

type LabelInfo = { state: 'loading' } | { state: 'done'; labels: RepoLabel[]; error?: string };

type Preview =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; result: SearchPreview }
  | { state: 'error'; message: string };

const PREVIEW_DELAY_MS = 600;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

let loaded = false;
let baseline: CustomQuery[] = [];
let repos: string[] = [];
let drafts: Draft[] = [];
let nextId = 1;
let selected: number | null = null;
let status: { text: string; error: boolean } = { text: '', error: false };
let saving = false;
let preview: Preview = { state: 'idle' };
let previewSeq = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let labelTimer: ReturnType<typeof setTimeout> | undefined;
const labelInfo = new Map<string, LabelInfo>();

root.innerHTML = `
<div class="layout">
  <aside class="side">
    <div class="side-head">
      <h2 id="list-title">Filters</h2>
      <button type="button" id="new" class="secondary"><i class="codicon codicon-add"></i>New</button>
    </div>
    <ul id="list" aria-labelledby="list-title"></ul>
  </aside>
  <main class="main">
    <p id="empty" class="empty">Select a filter or create a new one.</p>
    <form id="form" novalidate hidden>
      <div class="field">
        <label for="f-name">Name</label>
        <input id="f-name" type="text" required aria-describedby="e-name">
        <div id="e-name" class="error" aria-live="polite"></div>
      </div>
      <div class="field">
        <label for="f-repo">Repository</label>
        <input id="f-repo" type="text" list="repos" placeholder="owner/name" spellcheck="false" required aria-describedby="e-repo">
        <datalist id="repos"></datalist>
        <div id="e-repo" class="error" aria-live="polite"></div>
      </div>
      <fieldset class="field">
        <legend>Type</legend>
        <label class="radio"><input type="radio" name="type" value="issue">Issues</label>
        <label class="radio"><input type="radio" name="type" value="pr">Pull requests</label>
        <label class="radio"><input type="radio" name="type" value="both">Both</label>
      </fieldset>
      <fieldset class="field">
        <legend>State</legend>
        <label class="radio"><input type="radio" name="state" value="open">Open</label>
        <label class="radio"><input type="radio" name="state" value="closed">Closed</label>
        <label class="radio"><input type="radio" name="state" value="all">All</label>
      </fieldset>
      <div class="field">
        <label for="f-label">Labels</label>
        <ul id="chips" class="chips" aria-label="Selected labels"></ul>
        <input id="f-label" type="text" list="labels" placeholder="Type a label and press Enter" spellcheck="false" aria-describedby="label-status">
        <datalist id="labels"></datalist>
        <div id="label-status" class="hint" aria-live="polite"></div>
      </div>
      <div class="pair">
        <div class="field">
          <label for="f-assignee">Assignee</label>
          <input id="f-assignee" type="text" placeholder="login or @me" spellcheck="false">
        </div>
        <div class="field">
          <label for="f-author">Author</label>
          <input id="f-author" type="text" placeholder="login or @me" spellcheck="false">
        </div>
      </div>
      <div class="field">
        <label for="f-extra">Extra query</label>
        <input id="f-extra" type="text" placeholder="sort:updated-desc no:milestone -label:wontfix" spellcheck="false">
      </div>
      <div class="field">
        <span class="label" id="query-title">Generated query</span>
        <code id="query" class="query" aria-labelledby="query-title"></code>
      </div>
      <section class="preview" aria-labelledby="preview-title">
        <div class="preview-head">
          <h3 id="preview-title">Preview</h3>
          <button type="button" id="test" class="secondary"><i class="codicon codicon-play"></i>Test</button>
        </div>
        <div id="preview" aria-live="polite"></div>
      </section>
    </form>
  </main>
</div>
<footer class="bar">
  <span id="status" role="status"></span>
  <button type="button" id="revert" class="secondary">Revert</button>
  <button type="button" id="save">Save</button>
</footer>`;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const list = $<HTMLUListElement>('list');
const form = $<HTMLFormElement>('form');
const empty = $<HTMLParagraphElement>('empty');
const nameInput = $<HTMLInputElement>('f-name');
const repoInput = $<HTMLInputElement>('f-repo');
const labelInput = $<HTMLInputElement>('f-label');
const assigneeInput = $<HTMLInputElement>('f-assignee');
const authorInput = $<HTMLInputElement>('f-author');
const extraInput = $<HTMLInputElement>('f-extra');
const saveButton = $<HTMLButtonElement>('save');
const revertButton = $<HTMLButtonElement>('revert');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function icon(name: string): HTMLElement {
  return el('i', `codicon codicon-${name}`);
}

function iconButton(name: string, label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', 'icon');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
}

function current(): Draft | undefined {
  return drafts.find((d) => d.id === selected);
}

function toStored(d: Draft): CustomQuery {
  return { name: d.name.trim(), query: buildQuery(d.form) };
}

function canonical(filters: CustomQuery[]): string {
  return JSON.stringify(filters.map((q) => ({ name: q.name.trim(), query: buildQuery(parseQuery(q.query)) })));
}

function isDirty(): boolean {
  return canonical(drafts.map(toStored)) !== canonical(baseline);
}

function errors(d: Draft): { name: string; repo: string } {
  const name = d.name.trim();
  let nameError = '';
  if (!name) {
    nameError = 'A name is required.';
  } else if (drafts.some((o) => o.id !== d.id && o.name.trim() === name)) {
    nameError = 'Another filter already has this name.';
  }
  return { name: nameError, repo: d.form.repo.trim() ? '' : 'A repository is required.' };
}

function hasErrors(d: Draft): boolean {
  const e = errors(d);
  return e.name !== '' || e.repo !== '';
}

function uniqueName(base: string): string {
  let name = base;
  for (let i = 2; drafts.some((d) => d.name.trim() === name); i++) {
    name = `${base} ${i}`;
  }
  return name;
}

function resetDrafts(): void {
  const keep = current()?.name;
  drafts = baseline.map((q) => ({ id: nextId++, name: q.name, form: parseQuery(q.query) }));
  selected = drafts.find((d) => d.name === keep)?.id ?? drafts[0]?.id ?? null;
}

function select(id: number | null): void {
  selected = id;
  preview = { state: 'idle' };
  fillForm();
  render();
  schedulePreview();
}

function fillForm(): void {
  const d = current();
  form.hidden = !d;
  empty.hidden = !!d;
  if (!d) {
    return;
  }
  nameInput.value = d.name;
  repoInput.value = d.form.repo;
  assigneeInput.value = d.form.assignee;
  authorInput.value = d.form.author;
  extraInput.value = d.form.extra;
  labelInput.value = '';
  for (const r of form.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    r.checked = r.value === (r.name === 'type' ? d.form.type : d.form.state);
  }
  requestLabels();
}

function renderList(focus?: { id: number; role: string }): void {
  list.textContent = '';
  drafts.forEach((d, i) => {
    const li = el('li', `item${d.id === selected ? ' sel' : ''}`);
    const pick = el('button', 'pick');
    pick.type = 'button';
    pick.dataset.role = 'pick';
    pick.setAttribute('aria-current', String(d.id === selected));
    const label = el('span', 'name', d.name.trim() || '(unnamed)');
    const query = el('span', 'desc', buildQuery(d.form) || 'no query');
    pick.append(label, query);
    if (hasErrors(d)) {
      const warn = icon('warning');
      warn.classList.add('warn');
      warn.title = 'This filter has errors';
      pick.append(warn);
      pick.setAttribute('aria-invalid', 'true');
    }
    pick.addEventListener('click', () => select(d.id));
    pick.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        move(d.id, e.key === 'ArrowUp' ? -1 : 1, 'pick');
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const items = [...list.querySelectorAll<HTMLButtonElement>('button.pick')];
        items[items.indexOf(pick) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
        e.preventDefault();
      } else if (e.key === 'Delete') {
        remove(d.id);
        e.preventDefault();
      }
    });
    const up = iconButton('arrow-up', `Move ${d.name} up`, () => move(d.id, -1, 'up'), i === 0);
    up.dataset.role = 'up';
    const down = iconButton('arrow-down', `Move ${d.name} down`, () => move(d.id, 1, 'down'), i === drafts.length - 1);
    down.dataset.role = 'down';
    const del = iconButton('trash', `Delete ${d.name}`, () => remove(d.id));
    del.dataset.role = 'delete';
    const acts = el('span', 'acts');
    acts.append(up, down, del);
    li.dataset.id = String(d.id);
    li.append(pick, acts);
    list.append(li);
  });
  if (drafts.length === 0) {
    list.append(el('li', 'none', 'No filters yet.'));
  }
  if (focus) {
    const li = list.querySelector<HTMLElement>(`li[data-id="${focus.id}"]`);
    const target = li?.querySelector<HTMLButtonElement>(`[data-role="${focus.role}"]`);
    (target && !target.disabled ? target : li?.querySelector<HTMLButtonElement>('button.pick'))?.focus();
  }
}

function move(id: number, delta: number, role: string): void {
  const i = drafts.findIndex((d) => d.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= drafts.length) {
    return;
  }
  [drafts[i], drafts[j]] = [drafts[j]!, drafts[i]!];
  renderList({ id, role });
  renderFooter();
}

function remove(id: number): void {
  const i = drafts.findIndex((d) => d.id === id);
  if (i < 0) {
    return;
  }
  drafts.splice(i, 1);
  const next = drafts[Math.min(i, drafts.length - 1)];
  if (selected === id) {
    select(next?.id ?? null);
  } else {
    render();
  }
  if (next) {
    renderList({ id: next.id, role: 'pick' });
  } else {
    $<HTMLButtonElement>('new').focus();
  }
}

function create(): void {
  const d: Draft = { id: nextId++, name: uniqueName('New filter'), form: emptyForm(repos[0] ?? '') };
  drafts.push(d);
  select(d.id);
  nameInput.focus();
  nameInput.select();
}

function textColor(hex: string): string {
  const n = Number.parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
}

function knownLabels(): RepoLabel[] {
  const info = labelInfo.get(current()?.form.repo.trim() ?? '');
  return info?.state === 'done' ? info.labels : [];
}

function renderLabels(): void {
  const d = current();
  const chips = $<HTMLUListElement>('chips');
  chips.textContent = '';
  if (!d) {
    return;
  }
  const known = knownLabels();
  for (const name of d.form.labels) {
    const chip = el('li', 'chip');
    const color = known.find((l) => l.name === name)?.color ?? '';
    if (/^[0-9a-f]{6}$/i.test(color)) {
      chip.style.backgroundColor = `#${color}`;
      chip.style.color = textColor(color);
      chip.classList.add('colored');
    }
    chip.append(el('span', '', name));
    chip.append(iconButton('close', `Remove label ${name}`, () => {
      d.form.labels = d.form.labels.filter((l) => l !== name);
      changed();
      labelInput.focus();
    }));
    chips.append(chip);
  }
  const datalist = $<HTMLDataListElement>('labels');
  datalist.textContent = '';
  for (const l of known) {
    if (!d.form.labels.includes(l.name)) {
      const o = el('option');
      o.value = l.name;
      datalist.append(o);
    }
  }
  const info = labelInfo.get(d.form.repo.trim());
  const hint = $<HTMLDivElement>('label-status');
  hint.classList.toggle('error', info?.state === 'done' && !!info.error);
  if (!info) {
    hint.textContent = REPO_RE.test(d.form.repo.trim()) ? '' : 'Enter a repository to get its labels.';
  } else if (info.state === 'loading') {
    hint.textContent = 'Loading labels...';
  } else if (info.error) {
    hint.textContent = `Could not load labels: ${info.error}`;
  } else {
    hint.textContent = `${info.labels.length} labels in ${d.form.repo.trim()}`;
  }
}

function renderRepos(): void {
  const all = new Set([...repos, ...drafts.map((d) => d.form.repo.trim())].filter((r) => r !== ''));
  const datalist = $<HTMLDataListElement>('repos');
  const key = [...all].join('\n');
  if (datalist.dataset.key === key) {
    return;
  }
  datalist.dataset.key = key;
  datalist.textContent = '';
  for (const r of all) {
    const o = el('option');
    o.value = r;
    datalist.append(o);
  }
}

function renderPreview(): void {
  const box = $<HTMLDivElement>('preview');
  box.textContent = '';
  box.classList.toggle('error', preview.state === 'error');
  if (preview.state === 'idle') {
    box.append(el('span', 'hint', 'Results appear here as you edit.'));
  } else if (preview.state === 'running') {
    box.append(el('span', 'hint', 'Searching...'));
  } else if (preview.state === 'error') {
    box.append(icon('error'), el('span', '', preview.message));
  } else {
    const { count, items } = preview.result;
    box.append(el('div', 'count', count === 1 ? '1 result' : `${count} results`));
    const ul = el('ul', 'results');
    for (const item of items) {
      const li = el('li');
      const a = el('a', '', `#${item.number} ${item.title}`);
      a.href = item.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'open', url: item.url });
      });
      li.append(a);
      ul.append(li);
    }
    box.append(ul);
  }
}

function renderFooter(): void {
  const dirty = isDirty();
  const invalid = drafts.some(hasErrors);
  saveButton.disabled = saving || !dirty || invalid;
  revertButton.disabled = saving || !dirty;
  const s = $<HTMLSpanElement>('status');
  s.classList.toggle('error', status.error || (dirty && invalid));
  if (status.text) {
    s.textContent = status.text;
  } else if (dirty && invalid) {
    s.textContent = 'Fix the marked filters to save.';
  } else {
    s.textContent = dirty ? 'Unsaved changes' : '';
  }
}

function render(): void {
  const d = current();
  const focus = (document.activeElement as HTMLElement | null)?.closest('li[data-id]') as HTMLElement | null;
  const role = (document.activeElement as HTMLElement | null)?.dataset.role;
  renderList(focus && role ? { id: Number(focus.dataset.id), role } : undefined);
  renderRepos();
  if (d) {
    const e = errors(d);
    $<HTMLDivElement>('e-name').textContent = e.name;
    $<HTMLDivElement>('e-repo').textContent = e.repo;
    nameInput.setAttribute('aria-invalid', String(e.name !== ''));
    repoInput.setAttribute('aria-invalid', String(e.repo !== ''));
    $<HTMLElement>('query').textContent = buildQuery(d.form) || '(empty)';
    renderLabels();
    renderPreview();
  }
  renderFooter();
}

function changed(): void {
  status = { text: '', error: false };
  render();
  schedulePreview();
}

function runPreview(): void {
  clearTimeout(previewTimer);
  const d = current();
  const query = d ? buildQuery(d.form) : '';
  if (!query) {
    preview = { state: 'idle' };
    renderPreview();
    return;
  }
  preview = { state: 'running' };
  renderPreview();
  vscode.postMessage({ type: 'preview', seq: ++previewSeq, query });
}

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, PREVIEW_DELAY_MS);
}

function requestLabels(): void {
  const repo = current()?.form.repo.trim() ?? '';
  const info = labelInfo.get(repo);
  if (!REPO_RE.test(repo) || (info && !(info.state === 'done' && info.error !== undefined))) {
    return;
  }
  labelInfo.set(repo, { state: 'loading' });
  vscode.postMessage({ type: 'labels', repo });
}

function addLabel(): void {
  const d = current();
  const name = labelInput.value.trim();
  labelInput.value = '';
  if (d && name && !d.form.labels.includes(name)) {
    d.form.labels.push(name);
    changed();
  }
}

function bindText(input: HTMLInputElement, apply: (d: Draft, value: string) => void): void {
  input.addEventListener('input', () => {
    const d = current();
    if (d) {
      apply(d, input.value);
      changed();
    }
  });
}

bindText(nameInput, (d, v) => {
  d.name = v;
});
bindText(repoInput, (d, v) => {
  d.form.repo = v;
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => {
    requestLabels();
    renderLabels();
  }, PREVIEW_DELAY_MS);
});
bindText(assigneeInput, (d, v) => {
  d.form.assignee = v.trim();
});
bindText(authorInput, (d, v) => {
  d.form.author = v.trim();
});
bindText(extraInput, (d, v) => {
  d.form.extra = v;
});

for (const r of form.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
  r.addEventListener('change', () => {
    const d = current();
    if (d && r.checked) {
      if (r.name === 'type') {
        d.form.type = r.value as FilterType;
      } else {
        d.form.state = r.value as FilterState;
      }
      changed();
    }
  });
}

labelInput.addEventListener('keydown', (e) => {
  const d = current();
  if (e.key === 'Enter') {
    addLabel();
    e.preventDefault();
  } else if (e.key === 'Backspace' && labelInput.value === '' && d && d.form.labels.length > 0) {
    d.form.labels.pop();
    changed();
    e.preventDefault();
  }
});

labelInput.addEventListener('input', (e) => {
  const picked = !(e instanceof InputEvent) || e.inputType === 'insertReplacementText';
  if (picked && knownLabels().some((l) => l.name === labelInput.value)) {
    addLabel();
  }
});

form.addEventListener('submit', (e) => e.preventDefault());
$<HTMLButtonElement>('new').addEventListener('click', create);
$<HTMLButtonElement>('test').addEventListener('click', runPreview);

saveButton.addEventListener('click', () => {
  if (saveButton.disabled) {
    return;
  }
  saving = true;
  status = { text: 'Saving...', error: false };
  renderFooter();
  vscode.postMessage({ type: 'save', filters: drafts.map(toStored) });
});

revertButton.addEventListener('click', () => {
  resetDrafts();
  status = { text: '', error: false };
  select(selected);
});

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ToEditor;
  switch (msg.type) {
    case 'settings': {
      const wasDirty = loaded && isDirty();
      baseline = msg.filters;
      repos = msg.repos;
      if (!wasDirty) {
        resetDrafts();
        select(selected);
      } else {
        render();
      }
      loaded = true;
      break;
    }
    case 'select': {
      const d = drafts.find((x) => x.name.trim() === msg.name);
      if (d) {
        select(d.id);
        nameInput.focus();
      }
      break;
    }
    case 'create':
      create();
      break;
    case 'labels':
      labelInfo.set(msg.repo, msg.error !== undefined
        ? { state: 'done', labels: msg.labels, error: msg.error }
        : { state: 'done', labels: msg.labels });
      if (current()?.form.repo.trim() === msg.repo) {
        renderLabels();
      }
      break;
    case 'preview':
      if (msg.seq === previewSeq) {
        preview = { state: 'done', result: msg.result };
        renderPreview();
      }
      break;
    case 'previewError':
      if (msg.seq === previewSeq) {
        preview = { state: 'error', message: msg.message };
        renderPreview();
      }
      break;
    case 'saved':
      saving = false;
      baseline = drafts.map(toStored);
      status = { text: 'Saved', error: false };
      render();
      break;
    case 'saveFailed':
      saving = false;
      status = { text: `Save failed: ${msg.message}`, error: true };
      renderFooter();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
