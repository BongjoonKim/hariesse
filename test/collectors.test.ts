import {
  toYoutubeFeedUrl,
  extractYoutubeDescription,
  toYoutubeItem,
  toRedditFeedUrl,
  parseRedditLinks,
  stripRedditChrome,
  toRedditItem,
  toBlogItem,
  resolveFeedUrl,
  policyFor,
  sourceType,
  stripHtml,
} from '../src/lib/collectors';
import type { Source } from '../src/lib/types';

const CHANNEL = 'UCsBjURrPoezykLs9EqgamOA';

function source(over: Partial<Source>): Source {
  return {
    siteId: 's1',
    domain: 'example.com',
    name: '예시',
    category: 'dev-ai',
    weight: 1,
    likeCount: 0,
    skipCount: 0,
    status: 'active',
    ...over,
  };
}

describe('sourceType', () => {
  it('type 미지정이면 blog', () => {
    expect(sourceType({})).toBe('blog');
    expect(sourceType({ type: 'reddit' })).toBe('reddit');
  });
});

describe('stripHtml', () => {
  it('태그를 지우고 엔티티를 되돌린다', () => {
    expect(stripHtml('<p>안녕 &amp; 반가워</p><p>둘째 줄</p>')).toBe('안녕 & 반가워\n둘째 줄');
  });

  it('script/style 내용은 통째로 버린다', () => {
    expect(stripHtml('<style>p{color:red}</style><p>본문</p>')).toBe('본문');
  });
});

describe('toYoutubeFeedUrl', () => {
  it('채널 ID를 피드 URL로', () => {
    expect(toYoutubeFeedUrl(CHANNEL)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`
    );
  });

  it('채널 URL도 받는다', () => {
    expect(toYoutubeFeedUrl(`https://www.youtube.com/channel/${CHANNEL}`)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`
    );
  });

  it('이미 피드 URL이면 그대로', () => {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;
    expect(toYoutubeFeedUrl(url)).toBe(url);
  });

  it('재생목록도 지원', () => {
    expect(toYoutubeFeedUrl('https://www.youtube.com/playlist?list=PLabcdefghijk')).toBe(
      'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghijk'
    );
  });

  it('@handle은 네트워크가 필요하므로 거부 (add-source가 미리 해석)', () => {
    expect(() => toYoutubeFeedUrl('@fireship')).toThrow(/해석할 수 없음/);
  });
});

describe('YouTube 항목 변환', () => {
  const longDesc = '이 영상은 서버리스 아키텍처의 비용 구조를 실측 데이터로 뜯어본다. 콜드스타트와 동시성 제한까지 다룬다.';

  it('media:group에서 설명을 꺼낸다', () => {
    expect(
      extractYoutubeDescription({ 'media:group': { 'media:description': [longDesc] } })
    ).toBe(longDesc);
  });

  it('설명이 객체({_: ...}) 형태여도 꺼낸다', () => {
    expect(
      extractYoutubeDescription({ 'media:group': { 'media:description': { _: longDesc } } })
    ).toBe(longDesc);
  });

  it('media:group이 없으면 contentSnippet 폴백', () => {
    expect(extractYoutubeDescription({ contentSnippet: longDesc })).toBe(longDesc);
  });

  it('제목·채널·설명을 본문으로 만들고 추출은 시도하지 않는다', () => {
    const item = toYoutubeItem(
      {
        title: '서버리스 비용의 진실',
        link: 'https://www.youtube.com/watch?v=abc',
        'media:group': { 'media:description': [longDesc] },
      },
      'Fireship'
    );
    expect(item).not.toBeNull();
    expect(item!.url).toBe('https://www.youtube.com/watch?v=abc');
    expect(item!.extractUrl).toBeUndefined();
    expect(item!.preferSourceTitle).toBe(true);
    expect(item!.text).toContain('Fireship');
    expect(item!.text).toContain(longDesc);
  });

  it('설명이 너무 짧으면 스킵', () => {
    expect(
      toYoutubeItem(
        { title: '짧은 영상', link: 'https://youtu.be/x', 'media:group': { 'media:description': ['ㅋㅋ'] } },
        'Fireship'
      )
    ).toBeNull();
  });

  it('링크 없으면 스킵', () => {
    expect(toYoutubeItem({ title: '제목만' }, 'Fireship')).toBeNull();
  });
});

describe('toRedditFeedUrl', () => {
  it('r/<sub> → top/day RSS', () => {
    expect(toRedditFeedUrl('r/aws')).toBe('https://www.reddit.com/r/aws/top/.rss?t=day');
  });

  it('서브레딧 URL도 받는다', () => {
    expect(toRedditFeedUrl('https://www.reddit.com/r/LocalLLaMA/')).toBe(
      'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day'
    );
  });

  it('정렬/기간을 바꿀 수 있다', () => {
    expect(toRedditFeedUrl('r/devops', 'hot', 'week')).toBe(
      'https://www.reddit.com/r/devops/hot/.rss?t=week'
    );
  });

  it('이미 .rss URL이면 그대로', () => {
    const url = 'https://www.reddit.com/r/rust/new/.rss';
    expect(toRedditFeedUrl(url)).toBe(url);
  });

  it('알 수 없는 형태는 거부', () => {
    expect(() => toRedditFeedUrl('https://example.com/feed')).toThrow(/해석할 수 없음/);
  });
});

describe('Reddit 항목 변환', () => {
  const linkPost =
    ' submitted by <a href="https://www.reddit.com/user/u1"> /u/u1 </a> <br/>' +
    '<span><a href="https://zach.example.com/blog/bad-code/">[link]</a></span>' +
    '<span><a href="https://www.reddit.com/r/programming/comments/abc/bad_code/">[comments]</a></span>';

  it('[link]/[comments] 앵커를 뽑는다', () => {
    expect(parseRedditLinks(linkPost)).toEqual({
      link: 'https://zach.example.com/blog/bad-code/',
      comments: 'https://www.reddit.com/r/programming/comments/abc/bad_code/',
    });
  });

  it('링크글: 원문 URL로 저장하고 토론 링크를 따로 남긴다', () => {
    const item = toRedditItem({ title: 'There is no limit', content: linkPost }, 'r/programming');
    expect(item).not.toBeNull();
    expect(item!.url).toBe('https://zach.example.com/blog/bad-code/');
    expect(item!.extractUrl).toBe('https://zach.example.com/blog/bad-code/');
    expect(item!.discussionUrl).toBe(
      'https://www.reddit.com/r/programming/comments/abc/bad_code/'
    );
    expect(item!.title).toBe('There is no limit');
  });

  it('자기글: 퍼머링크로 저장하고 본문은 selftext', () => {
    const body = '내가 3년간 운영한 서버리스 파이프라인의 비용 구조를 공유한다. '.repeat(8);
    const content =
      `<div class="md"><p>${body}</p></div> submitted by <a href="https://www.reddit.com/user/u2"> /u/u2 </a>` +
      '<span><a href="https://www.reddit.com/r/aws/comments/xyz/cost/">[comments]</a></span>';
    const item = toRedditItem({ title: '비용 회고', content }, 'r/aws');
    expect(item).not.toBeNull();
    expect(item!.url).toBe('https://www.reddit.com/r/aws/comments/xyz/cost/');
    expect(item!.extractUrl).toBeUndefined();
    expect(item!.discussionUrl).toBeUndefined();
    expect(item!.text).toContain('서버리스 파이프라인');
  });

  it('자기글 본문이 짧으면 스킵 (제목뿐인 질문글 방지)', () => {
    const content =
      '<div class="md"><p>어떻게 생각해?</p></div>' +
      '<span><a href="https://www.reddit.com/r/aws/comments/q/short/">[comments]</a></span>';
    expect(toRedditItem({ title: '질문', content }, 'r/aws')).toBeNull();
  });

  it('stripRedditChrome은 submitted by / [link] 꼬리표를 지운다', () => {
    expect(stripRedditChrome(linkPost)).toBe('');
  });

  it('제목 없으면 스킵', () => {
    expect(toRedditItem({ content: linkPost }, 'r/programming')).toBeNull();
  });
});

describe('toBlogItem', () => {
  it('원문 URL을 추출 대상으로 삼고 스니펫은 폴백', () => {
    const item = toBlogItem({
      title: '글 제목',
      link: 'https://toss.tech/article/1',
      contentSnippet: '요약',
    });
    expect(item).toEqual({
      url: 'https://toss.tech/article/1',
      title: '글 제목',
      extractUrl: 'https://toss.tech/article/1',
      text: '요약',
    });
  });

  it('링크 없으면 스킵', () => {
    expect(toBlogItem({ title: '제목만' })).toBeNull();
  });
});

describe('policyFor', () => {
  it('Reddit은 호출 간격을 크게 잡는다 (429 방지)', () => {
    const policy = policyFor('https://www.reddit.com/r/aws/top/.rss?t=day');
    expect(policy.minIntervalMs).toBeGreaterThanOrEqual(20000);
    expect(policy.backoffMs.length).toBeGreaterThan(0);
  });

  it('그 외 호스트는 간격 없이 바로 호출', () => {
    expect(policyFor('https://toss.tech/rss.xml').minIntervalMs).toBe(0);
    // reddit이 도메인 일부로 들어간 남의 호스트에 정책이 새면 안 된다
    expect(policyFor('https://reddit.com.evil.example/feed').minIntervalMs).toBe(0);
  });
});

describe('resolveFeedUrl', () => {
  it('타입별로 정규화한다', () => {
    expect(resolveFeedUrl(source({ type: 'reddit', feedUrl: 'r/aws' }))).toBe(
      'https://www.reddit.com/r/aws/top/.rss?t=day'
    );
    expect(resolveFeedUrl(source({ type: 'youtube', feedUrl: CHANNEL }))).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`
    );
    expect(resolveFeedUrl(source({ feedUrl: 'https://toss.tech/rss.xml' }))).toBe(
      'https://toss.tech/rss.xml'
    );
  });

  it('feedUrl이 없으면 에러', () => {
    expect(() => resolveFeedUrl(source({}))).toThrow(/feedUrl 없음/);
  });
});
