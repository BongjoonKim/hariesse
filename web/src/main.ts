import { h, mount, type Child } from './dom';
import { load, setRenderer, state } from './app';
import { todayView } from './today';
import { focusSession, sessionKey, sessionView } from './session';
import { vocabView, writingView } from './library';
import { loginView, meView, readView } from './pages';

/** 진입점 — 해시 라우터 + 하단 탭. */

const TABS: [hash: string, icon: string, label: string][] = [
  ['#/', '🎯', '오늘'],
  ['#/vocab', '🧠', '단어장'],
  ['#/writing', '✍️', '문장'],
  ['#/read', '📰', '읽기'],
  ['#/me', '📈', '기록'],
];

const root = document.getElementById('app')!;

function view(route: string): Child {
  switch (route) {
    case '#/vocab': return vocabView();
    case '#/writing': return writingView();
    case '#/read': return readView();
    case '#/me': return meView();
    case '#/session': return sessionView();
    default: return todayView();
  }
}

function render(): void {
  if (state.authed === undefined) return mount(root, h('p', { class: 'boot' }, '불러오는 중…'));
  if (!state.authed) return mount(root, loginView());
  const route = location.hash || '#/';
  const inSession = route === '#/session';
  mount(
    root,
    h('main', { class: 'shell' }, view(route)),
    !inSession &&
      h(
        'div',
        { class: 'tabbar' },
        h('nav', { 'aria-label': '메뉴' }, TABS.map(([hash, icon, label]) => h('a', { href: hash, class: route === hash ? 'on' : '', 'aria-current': route === hash ? 'page' : undefined }, h('span', null, icon), label)))
      )
  );
  if (inSession) focusSession();
}

setRenderer(render);
window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  // 답을 입력하는 중의 Enter·숫자는 단축키가 아니다
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
  sessionKey(e);
});
// 다른 앱(Telegram)에 다녀오면 최신 상태로
document.addEventListener('visibilitychange', () => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '');
  if (document.visibilityState === 'visible' && state.authed && location.hash !== '#/session' && !typing) void load();
});

void load();
