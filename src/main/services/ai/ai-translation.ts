import type {
  AITranslateEntrySegmentsInput,
  AITranslateEntrySegmentsResult,
  EntryAITranslationSegment,
  EntryAITranslationSession,
  EntryAITranslationSessionStatus,
} from '../../../shared/types'
import { getDb } from '../../database'
import { getEventBus } from '../system/event-bus'
import { settingsProvider } from '../system/settings-provider'
import { runAITranslateTask } from './ai-pipeline'

const TRANSLATION_CONCURRENCY = 10
const TRANSLATION_PROGRESS_EVENT = 'ai:translation-progress'

// Bumped by every run; an older run stops picking up paragraphs once a newer
// one starts (e.g. auto translate on the next article).
// ponytail: one global run, a per-window token if parallel windows matter.
let latestRunId = 0
const CONFIG_CHANGED_ERROR = 'AI 配置已变更，翻译已中止'

function getTranslationConfigFingerprint(): string {
  const { ai } = settingsProvider.get()
  return JSON.stringify({
    provider: ai.provider,
    apiKey: ai.apiKeys?.[ai.provider] ?? ai.apiKey,
    baseUrl: ai.baseUrl ?? '',
    model: ai.model,
    enableSystemPrompt: ai.enableSystemPrompt ?? false,
    systemPromptTemplate: ai.systemPromptTemplate ?? '',
    translationPrompt: ai.translationPrompt ?? '',
  })
}

function getTranslationModel(): string | undefined {
  return settingsProvider.get().ai.model
}

const HAN_RE = /\p{Script=Han}/gu
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HANGUL_RE = /\p{Script=Hangul}/gu
// A Latin word weighs about as much as one CJK character.
const LATIN_WORD_RE = /\p{Script=Latin}+/gu

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0

/**
 * Whether a paragraph is already written in the target language, judged by
 * script: CJK characters must outnumber Latin words (so Chinese text with
 * English terms such as "Kubernetes 的 RBAC" still counts as Chinese).
 * ponytail: Latin-script targets (en, fr, ...) are always translated; add a
 * language detector if that wastes requests.
 */
export function isInTargetLanguage(text: string, targetLanguage: string) {
  const lang = targetLanguage.toLowerCase()
  const latinWords = count(text, LATIN_WORD_RE)
  const han = count(text, HAN_RE)
  const kana = count(text, KANA_RE)
  if (lang.startsWith('zh')) return kana === 0 && han > latinWords
  if (lang.startsWith('ja')) return kana > 0 && kana + han > latinWords
  if (lang.startsWith('ko')) return count(text, HANGUL_RE) > latinWords
  return false
}

const LINK_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
const HEADING_RE = /^\s*<h[1-6]\b/i
const BOLD_RE = /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi
const squash = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/\s+/g, '')

/**
 * Blocks a reader does not need translated: table of contents / navigation
 * entries (the whole block is a link) and short section headings such as
 * "Introduction" or "Lab Demonstration".
 */
function isNavigationOrShortHeading(html: string, plainText: string): boolean {
  const text = squash(plainText)
  const textOf = (re: RegExp, group: number) =>
    [...html.matchAll(re)].map((match) => squash(match[group])).join('')
  if (textOf(LINK_RE, 1) === text) return true
  // A real heading, or a paragraph that is bold from end to end.
  const headingLike = HEADING_RE.test(html) || textOf(BOLD_RE, 2) === text
  return headingLike && count(plainText, LATIN_WORD_RE) <= 3
}

function shouldTranslateParagraph(
  paragraph: string,
  targetLanguage: string,
): boolean {
  const plainText = paragraph.replace(/<[^>]*>/g, '').trim()
  return (
    plainText.length >= 5 &&
    !isInTargetLanguage(plainText, targetLanguage) &&
    !isNavigationOrShortHeading(paragraph, plainText)
  )
}

function buildSegments(
  paragraphs: string[],
  targetLanguage: string,
  results: string[],
  errors: Record<number, string>,
  runningIndex?: number,
): EntryAITranslationSegment[] {
  return paragraphs.map((paragraph, index) => {
    const skipped = !shouldTranslateParagraph(paragraph, targetLanguage)
    const errorMessage = errors[index]
    // Drop translations saved before a rule started skipping this block.
    const translatedText = skipped ? '' : (results[index] ?? '')
    const status: EntryAITranslationSegment['status'] = skipped
      ? 'skipped'
      : errorMessage
        ? 'failed'
        : translatedText
          ? 'succeeded'
          : runningIndex === index
            ? 'running'
            : 'queued'

    return {
      index,
      sourceText: paragraph,
      translatedText,
      status,
      errorMessage,
    }
  })
}

function sessionMatchesInput(
  session: EntryAITranslationSession | null,
  input: AITranslateEntrySegmentsInput,
): session is EntryAITranslationSession {
  if (!session) return false
  if (session.targetLanguage !== input.targetLanguage) return false
  if (session.segments.length !== input.paragraphs.length) return false
  return session.segments.every(
    (segment, index) => segment.sourceText === input.paragraphs[index],
  )
}

function createOrResetSession(
  input: AITranslateEntrySegmentsInput,
  fingerprint: string,
): EntryAITranslationSession {
  const current = getDb().aiTranslationSessions.getLatestSessionByEntryId(
    input.entryId,
  )
  if (sessionMatchesInput(current, input)) {
    return current
  }

  return getDb().aiTranslationSessions.createSession({
    entryId: input.entryId,
    targetLanguage: input.targetLanguage,
    status: 'running',
    segments: buildSegments(input.paragraphs, input.targetLanguage, [], {}),
    model: getTranslationModel(),
    configFingerprint: fingerprint,
  })
}

function sessionToResultState(session: EntryAITranslationSession): {
  translatedParagraphs: string[]
  errorMap: Record<number, string>
} {
  const translatedParagraphs: string[] = []
  const errorMap: Record<number, string> = {}
  for (const segment of session.segments) {
    translatedParagraphs[segment.index] = segment.translatedText || ''
    if (segment.status === 'failed' && segment.errorMessage) {
      errorMap[segment.index] = segment.errorMessage
    }
  }
  return { translatedParagraphs, errorMap }
}

function updateSession(
  sessionId: string,
  input: AITranslateEntrySegmentsInput,
  status: EntryAITranslationSessionStatus,
  results: string[],
  errors: Record<number, string>,
  patch: {
    errorCode?: string
    errorMessage?: string
    finishedAt?: number
  } = {},
): EntryAITranslationSession {
  const next =
    getDb().aiTranslationSessions.updateSession(sessionId, {
      targetLanguage: input.targetLanguage,
      status,
      segments: buildSegments(
        input.paragraphs,
        input.targetLanguage,
        results,
        errors,
      ),
      errorCode: patch.errorCode,
      errorMessage: patch.errorMessage,
      model: getTranslationModel(),
      configFingerprint: getTranslationConfigFingerprint(),
      finishedAt: patch.finishedAt,
    }) ?? getDb().aiTranslationSessions.getSessionById(sessionId)

  if (!next) throw new Error('AI translation session update failed')
  return next
}

export async function translateEntrySegments(
  input: AITranslateEntrySegmentsInput,
): Promise<AITranslateEntrySegmentsResult> {
  const entryId = input.entryId.trim()
  const targetLanguage = input.targetLanguage.trim() || 'zh-CN'
  const paragraphs = input.paragraphs

  if (!entryId) return { success: false, error: 'entry_id_required' }
  if (paragraphs.length === 0) return { success: false, error: 'empty_content' }

  const normalizedInput = { ...input, entryId, targetLanguage, paragraphs }
  const expectedFingerprint = getTranslationConfigFingerprint()
  let session = createOrResetSession(normalizedInput, expectedFingerprint)
  const previous = sessionToResultState(session)
  const results = [...previous.translatedParagraphs]
  const errors: Record<number, string> = { ...previous.errorMap }

  const requestedIndexes =
    normalizedInput.indexes && normalizedInput.indexes.length > 0
      ? new Set(normalizedInput.indexes)
      : null
  const queue = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) => {
      if (requestedIndexes) {
        if (!requestedIndexes.has(index)) return false
      } else if (results[index]) {
        return false // already translated in this session
      }
      return shouldTranslateParagraph(paragraph, targetLanguage)
    })
  const runId = ++latestRunId

  session = updateSession(
    session.id,
    normalizedInput,
    'running',
    results,
    errors,
  )

  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length && runId === latestRunId) {
      const item = queue[cursor++]
      if (getTranslationConfigFingerprint() !== expectedFingerprint) {
        errors[item.index] = CONFIG_CHANGED_ERROR
        continue
      }

      try {
        session = updateSession(
          session.id,
          normalizedInput,
          'running',
          results,
          errors,
        )
        results[item.index] = ''
        delete errors[item.index]
        const result = await runAITranslateTask({
          content: item.paragraph,
          targetLanguage,
        })
        if (result.success) {
          results[item.index] = result.translation
          delete errors[item.index]
        }
      } catch (error) {
        results[item.index] = ''
        errors[item.index] =
          error instanceof Error ? error.message : String(error)
      }
      getEventBus().send(TRANSLATION_PROGRESS_EVENT, {
        entryId,
        index: item.index,
        translation: results[item.index] || '',
        error: errors[item.index],
      })
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(TRANSLATION_CONCURRENCY, queue.length) },
      () => worker(),
    ),
  )

  const configChanged = Object.values(errors).includes(CONFIG_CHANGED_ERROR)
  const hasErrors = Object.keys(errors).length > 0
  const superseded = runId !== latestRunId && cursor < queue.length
  session = updateSession(
    session.id,
    normalizedInput,
    configChanged
      ? 'config_changed'
      : hasErrors || superseded
        ? 'failed'
        : 'succeeded',
    results,
    errors,
    {
      errorCode: configChanged
        ? 'config_changed'
        : superseded
          ? 'superseded'
          : undefined,
      errorMessage: configChanged
        ? CONFIG_CHANGED_ERROR
        : hasErrors
          ? '部分段落翻译失败'
          : superseded
            ? '已切换到其他文章，翻译暂停'
            : undefined,
      finishedAt: Date.now(),
    },
  )

  const state = sessionToResultState(session)
  return { success: true, session, ...state }
}
