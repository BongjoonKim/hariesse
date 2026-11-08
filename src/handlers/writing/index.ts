import { getConfig, getTelegramBotToken, getNotionToken, type AppConfig } from '../../lib/config';
import { getWritingQuizState, updateWritingQuizState } from '../../lib/dynamo';
import { enrichWriting } from '../../lib/bedrock';
import { listWritingNeedingEnrichment, listWritingCandidates, updateWritingPage, type WritingFields } from '../../lib/notion-writing';
import { sendMessage, formatWritingQuiz } from '../../lib/telegram';
import { kstDate } from '../../domain/vocab';
import {
  normalizeWritingKey,
  needsWritingEnrichment,
  detectWritingCorrection,
  fillWritingFromEnrichment,
  pickQuizEntries,
  applyQuizSent,
} from '../../domain/writing';
import { DEFAULTS } from '../../lib/constants';
import type { WritingEntry } from '../../lib/types';

/**
 * TOEFL Writing 문장 연습 Lambda. 원본 저장소는 Notion "TOEFL Writing" DB — 사용자가 교재 연습을 하며 쓴 영어 문장을 '문장'에만 적는다.
 * 매일 낮 12:00 KST (EventBridge) 또는 /writing 명령:
 *   ① 한국어가 빈 행을 Bedrock으로 채운다 (한국어 뜻 = 문제, 교정 = 문법·철자를 고친 모범 문장, 메모 = 왜 고쳤나). 사용자가 직접 쓴 칸은 안 덮는다.
 *   ② 덜 나온 문장부터 `writing-quiz-size`(기본 5)개를 한 메시지로 보낸다 — 한국어만 보이고 영어 정답은 스포일러. 버튼·채점은 없다.
 *   ③ 보낸 문장의 출제 횟수·마지막 출제를 갱신한다.
 * 정기 실행은 같은 KST 날짜에 1번만 (Profile 테이블 pk='WRITING'). `{"force":true}`는 언제든. `{"enrichOnly":true}`는 ①만 (운영용).
 */

export interface WritingEvent {
  force?: boolean;
  /** 한국어·교정 채우기만 하고 출제는 안 한다 (처음 문장을 많이 넣었을 때 운영용) */
  enrichOnly?: boolean;
  // EventBridge 스케줄 이벤트 (source 있음) → 정기 출제
  source?: string;
}

interface WritingResult {
  enriched: number;
  sent: number;
  reason?: string;
}

export const handler = async (event: WritingEvent = {}): Promise<WritingResult> => {
  const cfg = await getConfig();
  if (!cfg.writingNotionDatabaseId) {
    console.log('writing: Notion DB 미설정 → 건너뜀');
    return { enriched: 0, sent: 0, reason: 'no-database' };
  }
  const force = Boolean(event.force);
  const today = kstDate();
  const now = new Date().toISOString();

  if (!force && !event.enrichOnly) {
    const state = await getWritingQuizState(cfg.profileTable);
    if (state?.lastSentDate === today) {
      console.log(`writing: 오늘(${today}) 이미 보냄 → 건너뜀`);
      return { enriched: 0, sent: 0, reason: 'already-sent-today' };
    }
  }

  const notionToken = await getNotionToken();
  const enriched = await enrichPending(cfg, notionToken);
  if (event.enrichOnly) {
    console.log(`writing: 채움 ${enriched} (enrichOnly)`);
    return { enriched, sent: 0, reason: 'enrich-only' };
  }

  const candidates = await listWritingCandidates(notionToken, cfg.writingNotionDatabaseId, 500);
  const picked = pickQuizEntries(candidates, cfg.writingQuizSize);
  const botToken = await getTelegramBotToken();

  if (picked.length > 0) {
    for (const message of formatWritingQuiz(picked)) {
      await sendMessage(botToken, cfg.telegramChatId, message, undefined, true);
    }
    await markSent(notionToken, picked, today);
  } else if (force) {
    await sendMessage(botToken, cfg.telegramChatId, '✍️ 출제할 문장이 없어요. Notion "TOEFL Writing"에 영어 문장을 적어 주세요.');
  }

  // 정기 실행만 기록 — /writing으로 미리 봤다고 낮 출제가 빠지면 안 된다
  if (!force) await updateWritingQuizState(cfg.profileTable, { lastSentDate: today, updatedAt: now });

  console.log(`writing: 채움 ${enriched}, 후보 ${candidates.length}, 발송 ${picked.length}`);
  return { enriched, sent: picked.length };
};

/** 보낸 문장의 출제 횟수·마지막 출제 갱신. 하나 실패해도 나머지는 진행 (다음 날 같은 문장이 또 나올 뿐). */
async function markSent(notionToken: string, picked: WritingEntry[], today: string): Promise<void> {
  for (const entry of picked) {
    try {
      await updateWritingPage(notionToken, entry.pageId, applyQuizSent(entry, today));
    } catch (err) {
      console.warn(`출제 기록 실패 "${entry.text}": ${(err as Error).message}`);
    }
  }
}

/**
 * Notion에 직접 넣은 행(상태 빈칸)과 채우기에 실패했던 행을 채운다. 사용자가 직접 쓴 한국어·교정·메모는 안 덮는다.
 * 교정이 사용자 문장과 대소문자·문장부호만 다르면 교정으로 치지 않는다 (정답 = 쓴 그대로).
 */
async function enrichPending(cfg: AppConfig, notionToken: string): Promise<number> {
  let pending: WritingEntry[];
  try {
    pending = await listWritingNeedingEnrichment(notionToken, cfg.writingNotionDatabaseId, DEFAULTS.WRITING_ENRICH_CAP);
  } catch (err) {
    console.warn(`채울 행 조회 실패 (출제는 계속): ${(err as Error).message}`);
    return 0;
  }

  let done = 0;
  for (const entry of pending) {
    if (!needsWritingEnrichment(entry)) continue;
    let e;
    try {
      e = await enrichWriting(cfg.bedrockModelId, cfg.bedrockRegion, entry.text, entry.korean);
    } catch (err) {
      console.warn(`writing enrich 실패 "${entry.text}": ${(err as Error).message}`);
      continue;
    }
    const filled = fillWritingFromEnrichment(entry, { ...e, corrected: detectWritingCorrection(entry.text, e.corrected) });
    // 채우고 나면 '출제 중'으로 — '새로 추가'로 두면 다음 실행 때 또 채우기 대상이 되어 Bedrock을 반복 호출한다 (2026-11-08 실측 버그)
    const fields: WritingFields = {
      ...filled,
      key: entry.key ?? normalizeWritingKey(entry.text),
      status: 'active',
      quizCount: entry.quizCount,
    };
    try {
      await updateWritingPage(notionToken, entry.pageId, fields);
      done++;
    } catch (err) {
      console.warn(`채우기 저장 실패 "${entry.text}": ${(err as Error).message}`);
    }
  }
  return done;
}
