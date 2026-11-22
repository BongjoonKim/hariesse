import { h, md, mount, type Child } from './dom';
import { act, removeVocab, rerender, state, toast, upsertVocab, upsertWriting } from './app';
import { startReview, startWriting, vocabAnswer } from './session';
import { addForm } from './today';
import type { TodayPayload, VocabEntry, WritingEntry } from '../../src/lib/web-types';

/** 단어장 · 문장 탭 — 한 번에 훑어보기, 찾기, 골라서 복습, 고치기. */

type VocabFilter = 'all' | 'due' | 'learning' | 'mastered' | 'weak' | 'word' | 'sentence' | 'recent';
const VOCAB_FILTERS: [VocabFilter, string][] = [
  ['all', '전체'],
  ['due', '복습 차례'],
  ['weak', '자주 헷갈림'],
  ['recent', '최근 7일'],
  ['learning', '학습 중'],
  ['mastered', '외움'],
  ['word', '단어'],
  ['sentence', '문장'],
];

const ui = {
  q: '',
  filter: 'all' as VocabFilter,
  hide: false,
  open: undefined as string | undefined,
  editing: false,
  wq: '',
  wSource: '' as string,
  wHide: true,
  wOpen: undefined as string | undefined,
  showAdd: false,
};

const daysAgo = (today: string, n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

function filterVocab(): VocabEntry[] {
  const today = state.today?.date ?? '';
  const due = new Set(state.today?.dueIds ?? []);
  const q = ui.q.trim().toLowerCase();
  const weekAgo = today ? daysAgo(today, 7) : '';
  return (state.lib?.vocab ?? [])
    .filter((e) => {
      switch (ui.filter) {
        case 'due': return due.has(e.pageId);
        case 'learning': return e.status !== 'mastered';
        case 'mastered': return e.status === 'mastered';
        case 'weak': return e.missCount >= 2;
        case 'word': return e.kind !== 'sentence';
        case 'sentence': return e.kind === 'sentence';
        case 'recent': return (e.createdDate ?? '') >= weekAgo;
        default: return true;
      }
    })
    .filter((e) => !q || `${e.text}\n${e.meaning ?? ''}\n${e.synonyms ?? ''}\n${e.tags.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) =>
      ui.filter === 'weak' ? b.missCount - a.missCount : (b.createdDate ?? '') < (a.createdDate ?? '') ? -1 : (b.createdDate ?? '') > (a.createdDate ?? '') ? 1 : 0
    );
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function vocabView(): Child {
  if (!state.lib) return h('p', { class: 'boot' }, '불러오는 중…');
  const listEl = h('div', { class: `card list${ui.hide ? ' hide' : ''}` });
  const countEl = h('span', { class: 'grow small muted' });
  const practiceBtn = h('button', { class: 'btn sm' }, '이 목록 복습');
  let current: VocabEntry[] = [];
  const refresh = () => {
    current = filterVocab();
    countEl.textContent = `${current.length}개`;
    (practiceBtn as HTMLButtonElement).disabled = current.length === 0;
    mount(listEl, current.length ? current.slice(0, 300).map(vocabRow) : h('p', { class: 'muted center', style: 'padding:20px' }, '해당하는 표현이 없어요'), current.length > 300 && h('p', { class: 'muted small center', style: 'padding:10px' }, `처음 300개만 보여요 — 검색으로 좁혀 보세요`));
  };
  practiceBtn.addEventListener('click', () => {
    // 복습 차례 필터는 밀린 순서 그대로, 나머지는 섞어서 최대 30개
    const ids = ui.filter === 'due' ? (state.today?.dueIds ?? []).filter((id) => current.some((e) => e.pageId === id)) : shuffled(current).slice(0, 30).map((e) => e.pageId);
    startReview(ids, '골라서 복습');
  });
  refresh();
  return [
    h('div', { class: 'topbar' }, h('h1', null, '단어장'), toggleAdd()),
    ui.showAdd && h('div', { class: 'card', style: 'margin-bottom:12px' }, addForm('vocab')),
    h('input', {
      type: 'search',
      placeholder: '표현·뜻·태그 검색',
      'aria-label': '단어장 검색',
      value: ui.q,
      oninput: (e: Event) => {
        ui.q = (e.target as HTMLInputElement).value;
        refresh();
      },
    }),
    h(
      'div',
      { class: 'chips', style: 'margin-top:10px' },
      VOCAB_FILTERS.map(([k, label]) =>
        h(
          'button',
          {
            class: `chip${ui.filter === k ? ' on' : ''}`,
            onclick: () => {
              ui.filter = k;
              rerender();
            },
          },
          label
        )
      )
    ),
    h(
      'div',
      { class: 'row', style: 'margin:6px 2px 10px' },
      countEl,
      h(
        'button',
        {
          class: 'btn ghost sm',
          'aria-pressed': String(ui.hide),
          onclick: () => {
            ui.hide = !ui.hide;
            rerender();
          },
        },
        ui.hide ? '뜻 보이기' : '뜻 가리기'
      ),
      practiceBtn
    ),
    listEl,
    ui.open && vocabSheet(ui.open),
  ];
}

function toggleAdd(): HTMLElement {
  return h(
    'button',
    {
      class: 'btn ghost sm',
      onclick: () => {
        ui.showAdd = !ui.showAdd;
        rerender();
      },
    },
    ui.showAdd ? '닫기' : '＋ 등록'
  );
}

function boxDots(e: VocabEntry): HTMLElement {
  return h('span', { class: 'dots', title: `박스 ${e.box}/5` }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= e.box ? 'f' : '' })));
}

function vocabRow(e: VocabEntry): HTMLElement {
  const today = state.today?.date ?? '';
  const isDue = e.status !== 'mastered' && e.nextReview !== undefined && e.nextReview <= today;
  const badge = e.status === 'mastered' ? '🎓 외움' : isDue ? '복습 차례' : e.nextReview ? `${md(e.nextReview)} 복습` : '뜻 채우는 중';
  return h(
    'button',
    {
      class: 'item',
      onclick: () => {
        ui.open = e.pageId;
        ui.editing = false;
        rerender();
      },
    },
    h('span', { class: 't', lang: 'en' }, e.text),
    h('span', { class: `badge${isDue ? ' due' : ''}` }, badge),
    h('span', { class: 'm' }, e.meaning ?? '—')
  );
}

function closeSheet(): void {
  ui.open = undefined;
  ui.wOpen = undefined;
  ui.editing = false;
  rerender();
}

function sheet(...children: Child[]): HTMLElement {
  return h(
    'div',
    {
      class: 'sheet-back',
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) closeSheet();
      },
    },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, children)
  );
}

function field(label: string, name: string, value: string | undefined, rows = 1): HTMLElement {
  return h('label', { class: 'field' }, label, rows > 1 ? h('textarea', { name, rows, value: value ?? '' }) : h('input', { type: 'text', name, value: value ?? '' }));
}

function formValues(form: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[name]').forEach((el) => (out[el.name] = el.value));
  return out;
}

function vocabSheet(pageId: string): Child {
  const e = state.lib?.vocab.find((x) => x.pageId === pageId);
  if (!e) return null;
  const update = async (body: Record<string, unknown>, done: string) => {
    const res = await act<{ entry: VocabEntry; today: TodayPayload }>('/vocab/update', { pageId, ...body });
    if (res) {
      upsertVocab(res.entry);
      ui.editing = false;
      toast(done);
    }
    rerender();
  };
  if (ui.editing) {
    const form = h(
      'div',
      { class: 'stack' },
      field('표현', 'text', e.text),
      field('뜻', 'meaning', e.meaning, 2),
      field('예문', 'example', e.example, 3),
      field('동의어', 'synonyms', e.synonyms),
      field('메모', 'note', e.note, 3)
    );
    return sheet(
      h('h2', null, '고치기'),
      form,
      h(
        'div',
        { class: 'duo' },
        h('button', { class: 'btn ghost', onclick: () => ((ui.editing = false), rerender()) }, '취소'),
        h('button', { class: 'btn', onclick: () => void update({ fields: formValues(form) }, '고쳤어요 (Notion에도 반영)') }, '저장')
      )
    );
  }
  const remove = async () => {
    if (!confirm(`"${e.text}"을(를) 삭제할까요?\nNotion 휴지통으로 이동합니다 (30일 안에 복구 가능).`)) return;
    const res = await act('/vocab/delete', { pageId });
    if (res) {
      removeVocab(pageId);
      ui.open = undefined;
      toast('삭제했어요');
    }
    rerender();
  };
  return sheet(
    h('div', { class: 'row' }, h('h2', { class: 'grow', lang: 'en' }, e.text), h('button', { class: 'x', 'aria-label': '닫기', onclick: closeSheet }, '✕')),
    h('div', { class: 'small muted' }, [e.pos, e.pronunciation].filter(Boolean).join(' · '), ' ', boxDots(e), ` 박스 ${e.box}`, e.missCount > 0 && ` · 헷갈림 ${e.missCount}`, e.nextReview && ` · 다음 복습 ${md(e.nextReview)}`),
    vocabAnswer(e),
    e.tags.length > 0 && h('div', null, e.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn ghost sm', onclick: () => ((ui.editing = true), rerender()) }, '✏️ 고치기'),
      e.status === 'mastered'
        ? h('button', { class: 'btn ghost sm', onclick: () => void update({ action: 'relearn' }, '내일부터 다시 복습해요') }, '🔁 다시 복습')
        : h('button', { class: 'btn ghost sm', onclick: () => void update({ action: 'master' }, '외움으로 옮겼어요') }, '🎓 외웠어요'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn bad sm', onclick: () => void remove() }, '삭제')
    )
  );
}

// ---------------------------------------------------------------- Writing 문장

function filterWriting(): WritingEntry[] {
  const q = ui.wq.trim().toLowerCase();
  return (state.lib?.writing ?? []).filter(
    (e) => (!ui.wSource || (e.source ?? '기타') === ui.wSource) && (!q || `${e.text}\n${e.korean ?? ''}`.toLowerCase().includes(q))
  );
}

export function writingView(): Child {
  if (!state.lib) return h('p', { class: 'boot' }, '불러오는 중…');
  const sources = [...new Set(state.lib.writing.map((e) => e.source ?? '기타'))];
  const listEl = h('div', { class: `card list${ui.wHide ? ' hide' : ''}` });
  const countEl = h('span', { class: 'grow small muted' });
  let current: WritingEntry[] = [];
  const refresh = () => {
    current = filterWriting();
    countEl.textContent = `${current.length}문장`;
    const rows: Child[] = [];
    let group = '';
    for (const e of current) {
      const g = e.source ?? '기타';
      if (g !== group) rows.push(h('div', { class: 'group' }, (group = g)));
      rows.push(writingRow(e));
    }
    mount(listEl, rows.length ? rows : h('p', { class: 'muted center', style: 'padding:20px' }, '문장이 없어요'));
  };
  refresh();
  const practice = () => {
    const ids = current.filter((e) => e.status !== 'excluded' && e.korean).map((e) => e.pageId);
    // 덜 나온 문장부터 최대 10개
    const order = new Map((state.lib?.writing ?? []).map((e) => [e.pageId, e.quizCount]));
    startWriting(ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).slice(0, 10), '골라서 영작');
  };
  return [
    h('div', { class: 'topbar' }, h('h1', null, 'Writing 문장'), toggleAdd()),
    ui.showAdd && h('div', { class: 'card', style: 'margin-bottom:12px' }, addForm('writing')),
    h('input', {
      type: 'search',
      placeholder: '영어·한국어 검색',
      'aria-label': '문장 검색',
      value: ui.wq,
      oninput: (e: Event) => {
        ui.wq = (e.target as HTMLInputElement).value;
        refresh();
      },
    }),
    h(
      'div',
      { class: 'chips', style: 'margin-top:10px' },
      ['', ...sources].map((s) =>
        h(
          'button',
          {
            class: `chip${ui.wSource === s ? ' on' : ''}`,
            onclick: () => {
              ui.wSource = s;
              rerender();
            },
          },
          s || '전체'
        )
      )
    ),
    h(
      'div',
      { class: 'row', style: 'margin:6px 2px 10px' },
      countEl,
      h(
        'button',
        {
          class: 'btn ghost sm',
          'aria-pressed': String(ui.wHide),
          onclick: () => {
            ui.wHide = !ui.wHide;
            rerender();
          },
        },
        ui.wHide ? '영어 보이기' : '영어 가리기'
      ),
      h('button', { class: 'btn sm', onclick: practice }, '이 목록 영작')
    ),
    listEl,
    ui.wOpen && writingSheet(ui.wOpen),
  ];
}

function writingRow(e: WritingEntry): HTMLElement {
  return h(
    'button',
    {
      class: 'item',
      onclick: () => {
        ui.wOpen = e.pageId;
        rerender();
      },
    },
    h('span', { class: 't', style: 'font-weight:600' }, e.korean ?? '(한국어 채우는 중)'),
    h('span', { class: 'badge' }, e.status === 'excluded' ? '제외' : `${e.quizCount}회`),
    h('span', { class: 'm', lang: 'en' }, e.text)
  );
}

function writingSheet(pageId: string): Child {
  const e = state.lib?.writing.find((x) => x.pageId === pageId);
  if (!e) return null;
  const update = async (body: Record<string, unknown>, done: string) => {
    const res = await act<{ entry: WritingEntry; today: TodayPayload }>('/writing/update', { pageId, ...body });
    if (res) {
      upsertWriting(res.entry);
      ui.wOpen = undefined;
      toast(done);
    }
    rerender();
  };
  const form = h('div', { class: 'stack' }, field('영어 문장', 'text', e.text, 3), field('한국어 (문제)', 'korean', e.korean, 2), field('메모', 'note', e.note, 3), field('출처', 'source', e.source));
  return sheet(
    h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'font-size:18px' }, '문장 고치기'), h('button', { class: 'x', 'aria-label': '닫기', onclick: closeSheet }, '✕')),
    h('div', { class: 'small muted' }, `출제 ${e.quizCount}회`, e.lastQuizzed && ` · 마지막 ${md(e.lastQuizzed)}`),
    form,
    h(
      'div',
      { class: 'row wrap' },
      e.status === 'excluded'
        ? h('button', { class: 'btn ghost sm', onclick: () => void update({ action: 'include' }, '다시 출제해요') }, '다시 출제')
        : h('button', { class: 'btn ghost sm', onclick: () => void update({ action: 'exclude' }, '출제에서 뺐어요') }, '출제에서 빼기'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => void update({ fields: formValues(form) }, '고쳤어요 (Notion에도 반영)') }, '저장')
    )
  );
}
