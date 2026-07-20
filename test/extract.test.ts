import { normalizeWhitespace, extractReadable } from '../src/lib/extract';

describe('normalizeWhitespace', () => {
  it('연속 공백/탭을 단일 공백으로', () => {
    expect(normalizeWhitespace('a    b\t\tc')).toBe('a b c');
  });

  it('3줄 이상 빈 줄을 2줄로, 라인 trim', () => {
    expect(normalizeWhitespace('  hello  \n\n\n\n  world  ')).toBe('hello\n\nworld');
  });

  it('캐리지리턴 제거', () => {
    expect(normalizeWhitespace('a\r\nb')).toBe('a\nb');
  });
});

describe('extractReadable', () => {
  it('article 본문 텍스트를 추출한다', () => {
    const html = `
      <html><head><title>테스트 글</title></head>
      <body>
        <nav>메뉴 무시</nav>
        <article>
          <h1>제목입니다</h1>
          <p>이것은 본문 첫 문단입니다. 충분히 길어야 Readability가 본문으로 인식합니다.</p>
          <p>두 번째 문단도 의미 있는 내용을 담고 있어 본문 추출 테스트에 적합합니다.</p>
        </article>
      </body></html>`;
    const result = extractReadable(html, 'https://example.com/post');
    expect(result.text).toContain('본문 첫 문단');
    expect(result.text.length).toBeGreaterThan(20);
  });

  it('본문이 빈약하면 body 텍스트로 폴백한다', () => {
    const html = `<html><head><title>짧은 페이지</title></head><body>간단한 내용</body></html>`;
    const result = extractReadable(html, 'https://example.com');
    expect(result.text).toContain('간단한 내용');
  });
});
