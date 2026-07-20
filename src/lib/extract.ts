import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface Extracted {
  title: string;
  text: string;
}

/**
 * 공백 정규화 — 순수함수, 단위테스트 대상.
 */
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * HTML 문자열 → 본문 텍스트 추출 (네트워크 없음, 순수함수, 단위테스트 대상).
 * Readability가 본문을 못 찾으면 body textContent로 폴백.
 */
export function extractReadable(html: string, url = 'https://example.com'): Extracted {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  let title = doc.title || '';
  let text = '';

  try {
    const article = new Readability(doc).parse();
    if (article) {
      title = article.title || title;
      text = article.textContent || '';
    }
  } catch {
    // 폴백으로 진행
  }

  if (!text.trim()) {
    text = doc.body?.textContent ?? '';
  }

  return { title: normalizeWhitespace(title), text: normalizeWhitespace(text) };
}

/**
 * URL을 fetch해 본문 텍스트 추출. (Node 18+ 전역 fetch 사용)
 */
export async function fetchAndExtract(url: string, timeoutMs = 12000): Promise<Extracted> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HariesseBot/0.1 (+personal curation agent)' },
    });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const html = await res.text();
    return extractReadable(html, url);
  } finally {
    clearTimeout(timer);
  }
}
