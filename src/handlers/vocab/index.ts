import { getConfig, getTelegramBotToken, getNotionToken, type AppConfig } from '../../lib/config';
import { getVocabReviewState, updateVocabReviewState } from '../../lib/dynamo';
import { enrichVocab, reviseVocab } from '../../lib/bedrock';
import {
  findVocabByKey,
  getVocabPage,
  createVocabPage,
  updateVocabPage,
  listVocabNeedingEnrichment,
  listDueVocab,
  type VocabFields,
} from '../../lib/notion-vocab';
import {
  sendMessage,
  sendReply,
  formatVocabCard,
  formatVocabError,
  formatReviewHeader,
  formatReviewItem,
  buildVocabSavedKeyboard,
  buildReviewKeyboard,
  VOCAB_CORRECTION_TARGET_MISSING,
} from '../../lib/telegram';
import {
  kstDate,
  addDays,
  parseVocabMessage,
  normalizeVocabKey,
  detectKind,
  fillFromEnrichment,
  initialReview,
  applyRepeatCapture,
  applyRevision,
  isCorrectionRequest,
  isWithinCorrectionWindow,
  pickDueEntries,
  needsEnrichment,
  BOX_INTERVAL_DAYS,
  type EnrichedFields,
} from '../../domain/vocab';
import { DEFAULTS } from '../../lib/constants';
import type { VocabEntry, VocabKind } from '../../lib/types';

/**
 * TOEFL 단어장 Lambda. 원본 저장소는 Notion "TOEFL Vocab" DB.
 * - capture: Feedback Lambda가 Telegram 메시지를 받아 비동기로 넘긴다 (Bedrock 호출이 webhook 응답을 막지 않게).
 *   한 줄 = 표현 1건 → 뜻·번역 채워서 Notion에 저장 → 카드로 답장. 이미 있는 표현이면 헷갈린 횟수 +1.
 * - 수정: 카드(저장·복습 메시지)에 답장으로 쓰거나, 답장 없이 한국어로 "~라는 뜻이야"라고 보내면
 *   그 표현(답장 없으면 마지막으로 저장한 표현)의 카드를 요청대로 다시 쓴다. 새 표현으로 저장하지 않는다.
 * - review: 매일 21:00 KST (EventBridge) 또는 /review 명령.
 *   ① Notion에 직접 넣은 행 등 뜻이 빈 행을 채우고 ② 복습할 차례인 표현을 퀴즈로 보낸다.
 *   정기 실행은 같은 KST 날짜에 1번만 (Profile 테이블 pk='VOCAB'). `{"type":"review","force":true}`는 언제든.
 * - 비동기 재시도는 끈다(CDK retryAttempts 0) — 재시도되면 같은 표현이 '또 헷갈림'으로 집계된다.
 */

export type VocabEvent =
  | {
      type: 'capture';
      text: string;
      messageId?: number;
      /** 사용자가 단어장 카드에 답장으로 보냈으면 그 카드의 Notion page id → 수정 요청 */
      replyToPageId?: string;
    }
  | { type: 'review'; force?: boolean }
  // EventBridge 스케줄 이벤트 (type 없음) → 정기 복습
  | { type?: undefined; source?: string };

interface VocabResult {
  type: 'capture' | 'review';
  saved?: number;
  repeated?: number;
  corrected?: number;
  failed?: number;
  enriched?: number;
  sent?: number;
  reason?: string;
}

export const handler = async (event: VocabEvent = {}): Promise<VocabResult> => {
  const cfg = await getConfig();
  if (event.type === 'capture') return capture(cfg, event.text, event.messageId, event.replyToPageId);
  return review(cfg, event.type === 'review' && Boolean(event.force));
};

// ---------------------------------------------------------------- capture

async function capture(cfg: AppConfig, text: string, messageId?: number, replyToPageId?: string): Promise<VocabResult> {
  const botToken = await getTelegramBotToken();
  const result: VocabResult = { type: 'capture', saved: 0, repeated: 0, corrected: 0, failed: 0 };
  if (!cfg.vocabNotionDatabaseId) {
    await sendReply(botToken, cfg.telegramChatId, '⚠️ 단어장 Notion DB가 아직 설정되지 않았어요.', messageId);
    return { ...result, reason: 'no-database' };
  }
  const notionToken = await getNotionToken();
  const today = kstDate();

  // 카드에 답장했거나 한국어로 말했으면 새 표현이 아니라 수정 요청이다
  if (replyToPageId || isCorrectionRequest(text)) {
    let targetPageId = replyToPageId;
    if (!targetPageId) {
      const state = await getVocabReviewState(cfg.profileTable);
      if (isWithinCorrectionWindow(state?.lastCaptureAt)) targetPageId = state?.lastCapturePageId;
    }
    if (!targetPageId) {
      await sendReply(botToken, cfg.telegramChatId, VOCAB_CORRECTION_TARGET_MISSING, messageId);
      return { ...result, reason: 'no-correction-target' };
    }
    const ok = await correct(cfg, notionToken, botToken, targetPageId, text, messageId);
    if (ok) result.corrected!++;
    else result.failed!++;
    return result;
  }

  let lastPageId: string | undefined;
  for (const input of parseVocabMessage(text)) {
    try {
      const key = normalizeVocabKey(input.text);
      const existing = await findVocabByKey(notionToken, cfg.vocabNotionDatabaseId, key);

      if (existing) {
        const fields = {
          ...applyRepeatCapture(existing, today),
          tags: [...new Set([...existing.tags, ...input.tags])],
        };
        await updateVocabPage(notionToken, existing.pageId, fields);
        const card = formatVocabCard({ ...existing, ...fields }, { repeated: true });
        await sendReply(botToken, cfg.telegramChatId, card, messageId, buildVocabSavedKeyboard(existing.pageId));
        result.repeated!++;
        lastPageId = existing.pageId;
        continue;
      }

      const enriched = await tryEnrich(cfg, input.text, input.kind, { meaning: input.meaning });
      const fields: VocabFields = {
        text: input.text,
        key,
        kind: input.kind,
        tags: input.tags,
        origin: 'telegram',
        ...(enriched ?? { meaning: input.meaning }),
        ...initialReview(today),
        // 뜻 채우기에 실패하면 '새로 추가'로 두고 다음 복습 실행 때 다시 채운다
        status: enriched ? 'learning' : 'new',
      };
      const pageId = await createVocabPage(notionToken, cfg.vocabNotionDatabaseId, fields);
      const entry: VocabEntry = { pageId, tags: [], box: 0, missCount: 0, text: input.text, ...fields };
      await sendReply(
        botToken,
        cfg.telegramChatId,
        formatVocabCard(entry, { repeated: false }),
        messageId,
        buildVocabSavedKeyboard(pageId)
      );
      result.saved!++;
      lastPageId = pageId;
    } catch (err) {
      console.error(`vocab capture 실패 "${input.text}": ${(err as Error).message}`);
      result.failed!++;
      try {
        await sendReply(botToken, cfg.telegramChatId, formatVocabError(input.text, (err as Error).message), messageId);
      } catch (replyErr) {
        console.warn(`실패 안내 전송 실패: ${(replyErr as Error).message}`);
      }
    }
  }

  if (lastPageId) await rememberLastCapture(cfg, lastPageId);
  console.log(`vocab capture: 저장 ${result.saved}, 중복 ${result.repeated}, 실패 ${result.failed}`);
  return result;
}

/** 답장 없이 온 한국어 수정 요청이 향할 표현. 실패해도 저장은 끝난 뒤라 경고만. */
async function rememberLastCapture(cfg: AppConfig, pageId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    await updateVocabReviewState(cfg.profileTable, { lastCapturePageId: pageId, lastCaptureAt: now, updatedAt: now });
  } catch (err) {
    console.warn(`마지막 저장 표현 기록 실패: ${(err as Error).message}`);
  }
}

/**
 * 수정 요청 반영: 현재 카드 + 요청을 Bedrock에 주고 다시 쓴 카드를 Notion에 덮어쓴다.
 * (enrich와 달리 사용자가 직접 고쳐 달라고 한 것이라 채워진 칸도 바꾼다. 복습 상태는 건드리지 않는다.)
 */
async function correct(
  cfg: AppConfig,
  notionToken: string,
  botToken: string,
  pageId: string,
  instruction: string,
  messageId?: number
): Promise<boolean> {
  try {
    const entry = await getVocabPage(notionToken, pageId);
    if (!entry) {
      await sendReply(botToken, cfg.telegramChatId, '✏️ 고치려는 표현이 이미 삭제됐어요.', messageId);
      return false;
    }
    const revision = await reviseVocab(cfg.bedrockModelId, cfg.bedrockRegion, entry, instruction);
    const fields = applyRevision(entry, revision);
    if (fields.key && fields.key !== entry.key) {
      // 고친 표현이 이미 다른 행에 있으면 표현은 그대로 두고 뜻만 고친다
      const clash = await findVocabByKey(notionToken, cfg.vocabNotionDatabaseId, fields.key);
      if (clash && clash.pageId !== pageId) {
        delete fields.text;
        delete fields.key;
        delete fields.kind;
      }
    }
    await updateVocabPage(notionToken, pageId, fields);
    await rememberLastCapture(cfg, pageId);
    const card = formatVocabCard({ ...entry, ...fields }, { repeated: false, corrected: true });
    await sendReply(botToken, cfg.telegramChatId, card, messageId, buildVocabSavedKeyboard(pageId));
    console.log(`vocab correct: ${pageId} text=${fields.text ? 'changed' : 'kept'}`);
    return true;
  } catch (err) {
    console.error(`vocab correct 실패 ${pageId}: ${(err as Error).message}`);
    try {
      await sendReply(botToken, cfg.telegramChatId, formatVocabError(instruction, (err as Error).message), messageId);
    } catch (replyErr) {
      console.warn(`실패 안내 전송 실패: ${(replyErr as Error).message}`);
    }
    return false;
  }
}

/** Bedrock으로 빈 칸 채우기. 실패해도 저장은 계속하도록 undefined. */
async function tryEnrich(
  cfg: AppConfig,
  text: string,
  kind: VocabKind,
  current: EnrichedFields
): Promise<EnrichedFields | undefined> {
  try {
    const e = await enrichVocab(cfg.bedrockModelId, cfg.bedrockRegion, text, kind, current.meaning);
    return fillFromEnrichment(current, e);
  } catch (err) {
    console.warn(`vocab enrich 실패 "${text}": ${(err as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------- review

async function review(cfg: AppConfig, force: boolean): Promise<VocabResult> {
  if (!cfg.vocabNotionDatabaseId) {
    console.log('vocab review: Notion DB 미설정 → 건너뜀');
    return { type: 'review', sent: 0, reason: 'no-database' };
  }
  const today = kstDate();
  const now = new Date().toISOString();

  if (!force) {
    const state = await getVocabReviewState(cfg.profileTable);
    if (state?.lastReviewDate === today) {
      console.log(`vocab review: 오늘(${today}) 이미 보냄 → 건너뜀`);
      return { type: 'review', sent: 0, reason: 'already-sent-today' };
    }
  }

  const notionToken = await getNotionToken();
  const enriched = await enrichPending(cfg, notionToken, today);

  const due = await listDueVocab(notionToken, cfg.vocabNotionDatabaseId, today, 100);
  const picked = pickDueEntries(due, today, cfg.vocabReviewSize);
  const botToken = await getTelegramBotToken();

  if (picked.length > 0) {
    await sendMessage(botToken, cfg.telegramChatId, formatReviewHeader(picked.length, due.length - picked.length));
    for (let i = 0; i < picked.length; i++) {
      await sendMessage(
        botToken,
        cfg.telegramChatId,
        formatReviewItem(picked[i], i, picked.length),
        buildReviewKeyboard(picked[i].pageId),
        true
      );
    }
  } else if (force) {
    await sendMessage(botToken, cfg.telegramChatId, '🎉 지금 복습할 표현이 없어요.');
  }

  // 정기 실행만 기록 — /review로 미리 봤다고 저녁 복습이 빠지면 안 된다
  if (!force) await updateVocabReviewState(cfg.profileTable, { lastReviewDate: today, updatedAt: now });

  console.log(`vocab review: 뜻 채움 ${enriched}, 복습 대상 ${due.length}, 발송 ${picked.length}`);
  return { type: 'review', enriched, sent: picked.length };
}

/**
 * Notion에 직접 넣은 행(상태 빈칸)과 뜻 채우기에 실패했던 행을 채운다.
 * 복습 일정이 없으면 추가일 다음 날로 잡아준다 (어제 넣은 단어는 오늘 바로 복습 대상).
 */
async function enrichPending(cfg: AppConfig, notionToken: string, today: string): Promise<number> {
  let pending: VocabEntry[];
  try {
    pending = await listVocabNeedingEnrichment(notionToken, cfg.vocabNotionDatabaseId, DEFAULTS.VOCAB_ENRICH_CAP);
  } catch (err) {
    console.warn(`뜻 채울 행 조회 실패 (복습은 계속): ${(err as Error).message}`);
    return 0;
  }

  let done = 0;
  for (const entry of pending) {
    if (!needsEnrichment(entry)) continue;
    const kind = entry.kind ?? detectKind(entry.text);
    const filled = await tryEnrich(cfg, entry.text, kind, entry);
    if (!filled) continue;
    const fields: VocabFields = {
      ...filled,
      key: entry.key ?? normalizeVocabKey(entry.text),
      kind,
      origin: entry.origin ?? 'notion',
      status: 'learning',
    };
    if (!entry.nextReview) {
      Object.assign(fields, {
        box: 0,
        nextReview: addDays(entry.createdDate ?? today, BOX_INTERVAL_DAYS[0]),
        missCount: entry.missCount,
      });
    }
    try {
      await updateVocabPage(notionToken, entry.pageId, fields);
      done++;
    } catch (err) {
      console.warn(`뜻 채우기 저장 실패 "${entry.text}": ${(err as Error).message}`);
    }
  }
  return done;
}
