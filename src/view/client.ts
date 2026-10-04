import type { Area, Behavior, Spec } from '../spec/types.js';

type ViewSpec = Pick<Spec, 'name' | 'description' | 'assumptions' | 'areas'>;
type Entry = { area: Area; behavior: Behavior; id: string };
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const search = byId<HTMLInputElement>('search');
const areaSelect = byId<HTMLSelectElement>('area-select');
const themeSelect = byId<HTMLSelectElement>('theme');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let theme = 'system';
try {
  const saved = localStorage.getItem('specify-theme');
  if (saved === 'light' || saved === 'dark') {
    theme = saved;
  }
} catch {
  // The reader still works when browser storage is disabled.
}
function applyTheme(): void {
  document.documentElement.dataset.theme =
    theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
  themeSelect.value = theme;
}
themeSelect.addEventListener('change', () => {
  theme = themeSelect.value;
  applyTheme();
  try {
    localStorage.setItem('specify-theme', theme);
  } catch {
    // An explicit choice still applies for this session.
  }
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();
let spec: ViewSpec;
let entries: Entry[] = [];
let areaId = '';
let page = 0;
const pageSize = 50;
let lastResponse = '';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function selectedId(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return '';
  }
}

function chooseArea(id: string): void {
  areaId = id;
  page = 0;
  const hash = id ? `#area=${encodeURIComponent(id)}` : '#';
  location.hash = hash;
  renderAreas();
  renderList();
  renderDetail();
}

function renderAreas(): void {
  const nav = byId('areas');
  nav.replaceChildren();
  const overview = element('a', 'Project overview', 'area');
  overview.href = '#';
  overview.setAttribute('aria-current', String(!selectedId()));
  nav.append(overview);
  areaSelect.replaceChildren();
  const groups = [
    { id: '', name: 'All behaviors', count: entries.length },
    ...spec.areas.map((area) => ({ ...area, count: area.behaviors.length })),
  ];
  for (const area of groups) {
    const button = element('button', '', 'area');
    button.append(element('span', area.name), element('span', String(area.count), 'count'));
    button.setAttribute('aria-current', String(areaId === area.id && Boolean(selectedId())));
    button.addEventListener('click', () => chooseArea(area.id));
    nav.append(button);
    const option = element('option', `${area.name} (${area.count})`);
    option.value = area.id;
    areaSelect.append(option);
  }
  areaSelect.value = areaId;
}

function filteredEntries(): Entry[] {
  const query = search.value.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const { area, behavior, id } = entry;
    const searchable = [id, area.name, area.prose, JSON.stringify(behavior)].join(' ');
    return (!areaId || area.id === areaId) && searchable.toLocaleLowerCase().includes(query);
  });
}

function renderList(): void {
  const matches = filteredEntries();
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages - 1);
  const list = byId('list');
  list.replaceChildren();
  for (const entry of matches.slice(page * pageSize, (page + 1) * pageSize)) {
    const link = element('a', '', 'behavior');
    link.href = `#${encodeURIComponent(entry.id)}`;
    link.setAttribute('aria-current', String(selectedId() === entry.id));
    link.append(
      element('span', entry.behavior.title ?? entry.behavior.description, 'behavior-title'),
    );
    if (entry.behavior.title) {
      link.append(element('span', entry.behavior.description, 'summary'));
    }
    link.append(element('code', entry.id));
    list.append(link);
  }
  if (!matches.length) {
    list.append(
      element('p', 'No behaviors match. Try another search or choose All behaviors.', 'empty'),
    );
  }
  byId('results-note').textContent = `${matches.length} of ${entries.length} behaviors`;
  byId('page').textContent = `${page + 1} / ${pages}`;
  byId<HTMLButtonElement>('previous').disabled = page === 0;
  byId<HTMLButtonElement>('next').disabled = page + 1 >= pages;
}

function section(parent: HTMLElement, title: string, text: string): void {
  parent.append(element('h2', title), element('p', text));
}

function renderOverview(detail: HTMLElement): void {
  detail.append(element('span', 'PROJECT SPEC', 'label'), element('h1', spec.name));
  if (spec.description) {
    detail.append(element('p', spec.description));
  }
  detail.append(
    element(
      'p',
      'Start with an area to understand its purpose, then inspect the precise contracts that support it.',
    ),
  );
  const areas = element('div', '', 'area-overview');
  for (const area of spec.areas) {
    const card = element('a', '', 'area-card');
    card.href = `#area=${encodeURIComponent(area.id)}`;
    card.append(element('h2', area.name));
    if (area.prose) {
      card.append(element('p', area.prose));
    }
    card.append(element('span', `${area.behaviors.length} behavioral contracts →`, 'reference'));
    areas.append(card);
  }
  detail.append(areas);
  for (const assumption of spec.assumptions ?? []) {
    section(detail, 'Assumption', assumption.description);
    if (assumption.check) {
      detail.append(element('p', assumption.check, 'reference'));
    }
  }
}

function renderArea(detail: HTMLElement, area: Area): void {
  detail.append(element('span', 'AREA PURPOSE', 'label'), element('h1', area.name));
  if (area.prose) {
    detail.append(element('p', area.prose, 'purpose'));
  }
  detail.append(element('h2', 'Behavioral contracts'));
  for (const behavior of area.behaviors) {
    const link = element('a', behavior.title ?? behavior.description, 'contract-link');
    link.href = `#${encodeURIComponent(`${area.id}/${behavior.id}`)}`;
    detail.append(link);
  }
}

function renderDetail(): void {
  const detail = byId('detail');
  detail.replaceChildren();
  if (selectedId().startsWith('area=')) {
    const area = spec.areas.find((item) => item.id === selectedId().slice(5));
    if (area) {
      renderArea(detail, area);
      return;
    }
  }
  const entry = entries.find((item) => item.id === selectedId());
  if (!entry) {
    if (selectedId()) {
      detail.append(
        element(
          'p',
          'This behavior is no longer in the current spec. Choose another behavior.',
          'notice',
        ),
      );
    }
    renderOverview(detail);
    return;
  }
  const { behavior, area, id } = entry;
  const parentLink = element('a', `← ${area.name}`, 'parent-link');
  parentLink.href = `#area=${encodeURIComponent(area.id)}`;
  detail.append(parentLink, element('h1', behavior.title ?? behavior.description));
  if (area.prose) {
    const context = element('div', '', 'context');
    context.append(element('span', 'AREA PURPOSE', 'label'), element('p', area.prose));
    detail.append(context);
  }
  if (behavior.rationale) {
    section(detail, 'Why this matters', behavior.rationale);
  }
  const contract = element('section', '', 'contract');
  contract.append(element('h2', 'Behavioral contract'), element('code', id, 'id'));
  // Old specs keep their original heading; the precise assertion is never inferred from an ID.
  contract.append(element('p', behavior.description));
  detail.append(contract);
  for (const tag of behavior.tags ?? []) {
    detail.append(element('span', tag, 'tag'));
  }
  if (behavior.details) {
    section(detail, 'Details', behavior.details);
  }
  if (behavior.source) {
    detail.append(element('h2', 'Original intent'), element('blockquote', behavior.source.text));
    if (behavior.source.reference) {
      detail.append(element('p', behavior.source.reference, 'reference'));
    }
  }
  if (behavior.formal?.length) {
    detail.append(element('h2', 'Linked formal properties'));
    for (const formal of behavior.formal) {
      const box = element('div', '', 'formal');
      box.append(
        element('span', formal.tool === 'lean' ? 'Lean' : `Quint · ${formal.mode}`, 'tag'),
      );
      box.append(element('p', formal.property), element('code', formal.file));
      if (formal.tool === 'quint') {
        const bounds = [`${formal.maxSteps} steps`, formal.main ? `module ${formal.main}` : ''];
        if (formal.mode === 'simulate') {
          bounds.push(`${formal.samples} samples`, `seed ${formal.seed}`);
        }
        box.append(element('p', bounds.filter(Boolean).join(' · '), 'reference'));
      }
      detail.append(box);
    }
    detail.append(
      element(
        'p',
        'References only. This viewer does not run checks or report proof status. Passing formal checks establish properties of the authored models, not application correctness.',
        'notice',
      ),
    );
  }
  detail.append(
    element(
      'p',
      'Validation is not assessed here. Spec lint checks structure; application tests check behavior. A test reference or formal model alone is not proof of this contract.',
      'notice',
    ),
  );
  for (const assumption of spec.assumptions ?? []) {
    section(detail, 'Project assumption', assumption.description);
    if (assumption.check) {
      detail.append(element('p', assumption.check, 'reference'));
    }
  }
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/spec', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    if (!response.ok) {
      const failure = JSON.parse(text) as { error?: string };
      throw new Error(failure.error ?? 'Could not load spec');
    }
    if (text !== lastResponse) {
      const firstLoad = lastResponse === '';
      spec = JSON.parse(text) as ViewSpec;
      lastResponse = text;
      entries = spec.areas.flatMap((area) =>
        area.behaviors.map((behavior) => ({ area, behavior, id: `${area.id}/${behavior.id}` })),
      );
      if (areaId && !spec.areas.some((area) => area.id === areaId)) {
        areaId = '';
      }
      if (firstLoad) {
        alignAreaWithSelection();
      }
      document.title = `${spec.name} · Specify`;
      byId('name').textContent = spec.name;
      renderAreas();
      renderList();
      renderDetail();
    }
    byId('error').hidden = true;
    byId('status').textContent = 'Local · Live updates';
  } catch (error) {
    byId('status').textContent = lastResponse ? 'Out of date' : 'Unable to load';
    const banner = byId('error');
    banner.hidden = false;
    banner.textContent = `${lastResponse ? 'Showing the last readable spec. ' : ''}${error instanceof Error ? error.message : 'Connection lost'}. Fix the spec or restart specify view; retrying automatically.`;
  } finally {
    window.setTimeout(() => void refresh(), 2000);
  }
}

search.addEventListener('input', () => {
  page = 0;
  renderList();
});
areaSelect.addEventListener('change', () => chooseArea(areaSelect.value));
byId('previous').addEventListener('click', () => {
  page--;
  renderList();
  byId('list').scrollTop = 0;
});
byId('next').addEventListener('click', () => {
  page++;
  renderList();
  byId('list').scrollTop = 0;
});
window.addEventListener('hashchange', () => {
  if (spec) {
    alignAreaWithSelection();
    renderAreas();
    renderList();
    renderDetail();
    byId('reader').scrollTop = 0;
    byId('reader').focus();
  }
});
function alignAreaWithSelection(): void {
  const selected = selectedId();
  const selectedArea = selected.startsWith('area=')
    ? selected.slice(5)
    : entries.find((entry) => entry.id === selected)?.area.id;
  if (selectedArea !== areaId) {
    areaId = selectedArea ?? '';
    page = 0;
  }
}
document.querySelector('.skip')?.addEventListener('click', (event) => {
  event.preventDefault();
  byId('reader').focus();
});
void refresh();
