import OpenAI from 'openai'
import { sendToAllWindows } from '../system/event-bus'
import { settingsProvider } from '../system/settings-provider'
import { validateAIConfig } from './ai-client'
import { runAICompletion, runAICompletionText } from './ai-completion'
import { normalizeAIError } from './provider-protocol'
import {
  buildSummaryPrompt,
  buildTranslatePrompt,
  clampContentToBudget,
} from './ai-prompts'
import {
  buildDigestBatchMessages,
  buildDigestBudgetPlan,
  buildDigestReduceMessages,
  buildDigestRerankMessages,
  dedupeDigestCandidates,
  digestArticleTokens,
  estimateTokens,
  fitDigestCandidatesToBudget,
  takeDigestArticlesWithinTokens,
  DIGEST_ARTICLE_CHARS,
  DIGEST_ARTICLE_TOKEN_BUDGET,
  DIGEST_BATCH_OUTPUT_TOKENS,
  DIGEST_REDUCE_OUTPUT_TOKENS,
  getDigestPresetLabel,
  normalizeDigestPreset,
  selectValidDigestRerankIds,
} from './ai-digest'
import type { TaskRunContext } from '../system/task-runner'
import type {
  AiSummarizeTaskPayload,
  AiTranslateTaskPayload,
} from '../system/task-contracts'
import { getDb } from '../../database'
import { fetchAndPersistReadableContent } from '../entry/readability-fetch'
import type {
  AIDigestCandidate,
  AIDigestGenerateResult,
  AIDigestPreset,
  AIConfig,
} from '../../../shared/types'

// ── Types ────────────────────────────────────────────────────────────────────

export type AIDigestGenerateInput = {
  preset?: AIDigestPreset
  feedId?: string
  folder?: string
}

export type AISummarizeResult = { success: true; summary: string }
export type AITranslateResult = { success: true; translation: string }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Same cut as the reader: feed text this short is an excerpt.
const DIGEST_EXCERPT_CHARS = 500

/**
 * Fetch the original page for picked articles whose feed text is only an
 * excerpt (link aggregators, "read more" feeds). Posts (view 1) stay as they
 * are. A failed fetch, or a page no longer than the feed, keeps the feed text.
 */
// At most this many pages per digest, a few at a time: picking every
// candidate of a busy folder must not mean hundreds of page loads.
const DIGEST_MAX_FETCHES = 30
const DIGEST_FETCH_CONCURRENCY = 6
const DIGEST_BATCH_CONCURRENCY = 4

async function withFullText<T extends AIDigestCandidate>(
  candidates: T[],
): Promise<T[]> {
  const result = [...candidates]
  const due = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.feedView === 0 &&
        candidate.url &&
        (candidate.content || candidate.summary || '').length <
          DIGEST_EXCERPT_CHARS,
    )
    .slice(0, DIGEST_MAX_FETCHES)
  for (let i = 0; i < due.length; i += DIGEST_FETCH_CONCURRENCY) {
    await Promise.all(
      due
        .slice(i, i + DIGEST_FETCH_CONCURRENCY)
        .map(async ({ candidate, index }) => {
          result[index] = await fetchFullText(candidate)
        }),
    )
  }
  return result
}

async function fetchFullText<T extends AIDigestCandidate>(
  candidate: T,
): Promise<T> {
  try {
    const result = await fetchAndPersistReadableContent({
      url: candidate.url!,
      entryId: candidate.id,
    })
    return { ...candidate, content: htmlToText(result.content) }
  } catch {
    return candidate
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function persistAISummarySessionPatch(
  sessionId: string | undefined,
  patch: Parameters<
    ReturnType<typeof getDb>['aiSummarySessions']['updateSession']
  >[1],
): void {
  if (!sessionId) return
  getDb().aiSummarySessions.updateSession(sessionId, patch)
}

function persistEntryAISummary(
  entryId: string | undefined,
  summary: string,
): void {
  if (!entryId) return
  getDb().entries.updateEntry(entryId, {
    aiSummary: summary,
    aiSummaryGeneratedAt: Date.now(),
    aiSummaryError: undefined,
  })
}

async function requestDigestText(
  aiConfig: AIConfig,
  messages: OpenAI.ChatCompletionMessageParam[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  // Routes through the shared completion seam, which owns client creation,
  // empty-result retry, and the DeepSeek thinking-disabled quirk. Config is
  // already validated by generateAIDigest, so skip the redundant check and let
  // raw provider errors bubble up to its catch for normalization.
  return runAICompletionText({
    aiConfig,
    messages,
    temperature,
    maxTokens,
    validateConfig: false,
  })
}

// ── Digest pipeline ──────────────────────────────────────────────────────────

export async function generateAIDigest(
  input?: AIDigestGenerateInput,
  context?: TaskRunContext,
): Promise<AIDigestGenerateResult> {
  const settings = settingsProvider.get()
  const aiConfig = settings.ai
  const preset = normalizeDigestPreset(input?.preset)
  const folder = input?.folder?.trim() || undefined
  const presetLabel = folder
    ? `${getDigestPresetLabel(preset)} · ${folder}`
    : getDigestPresetLabel(preset)
  const now = Date.now()

  context?.reportProgress({
    completed: 0,
    total: 4,
    message: '筛选候选文章',
    data: { preset, feedId: input?.feedId },
  })

  const { windowStartAt, windowEndAt } = getDb().digests.getDigestWindow(
    preset,
    now,
  )
  const rawCandidates = getDb().digests.listDigestCandidates({
    preset,
    feedId: input?.feedId,
    folder,
    now,
  })
  const candidates = fitDigestCandidatesToBudget(
    dedupeDigestCandidates(rawCandidates),
  )
  const run = getDb().digests.upsertAIDigestRun({
    preset,
    feedId: input?.feedId,
    folder,
    title: presetLabel,
    status: 'running',
    windowStartAt,
    windowEndAt,
    sourceEntryIds: [],
    candidateCount: candidates.length,
    content: '',
    error: undefined,
  })

  context?.reportProgress({
    completed: 1,
    total: 4,
    message: '候选文章已就绪',
    data: {
      preset,
      feedId: input?.feedId,
      digestRunId: run.id,
      rawCandidateCount: rawCandidates.length,
      candidateCount: candidates.length,
    },
  })

  if (candidates.length === 0) {
    const failed = getDb().digests.updateAIDigestRun(run.id, {
      status: 'failed',
      error: '当前时间窗内没有可用于生成简报的文章',
    })
    context?.reportProgress({
      completed: 4,
      total: 4,
      message: '没有可用于生成简报的文章',
      data: { preset, feedId: input?.feedId, digestRunId: run.id },
    })
    return {
      success: false,
      error: failed?.error || '当前时间窗内没有可用于生成简报的文章',
      run: failed || run,
    }
  }

  const configError = validateAIConfig(aiConfig)
  if (configError) {
    const failed = getDb().digests.updateAIDigestRun(run.id, {
      status: 'failed',
      error: configError,
    })
    context?.reportProgress({
      completed: 4,
      total: 4,
      message: 'AI 配置不可用',
      data: { preset, feedId: input?.feedId, digestRunId: run.id },
    })
    return { success: false, error: configError, run: failed || run }
  }

  try {
    const topic = presetLabel
    // Every candidate when they all fit the token budget; otherwise the AI
    // ranks them and the digest takes them in that order until it is full.
    let budget = DIGEST_ARTICLE_TOKEN_BUDGET
    let ranked = candidates
    const allFit =
      candidates.reduce((sum, c) => sum + digestArticleTokens(c), 0) <= budget

    if (!allFit && candidates.length > 1) {
      context?.reportProgress({
        completed: 2,
        total: 4,
        message: '重排候选文章',
        data: { preset, feedId: input?.feedId, digestRunId: run.id },
      })
      const messages = buildDigestRerankMessages({
        topic,
        candidates,
        maxIds: candidates.length,
      })
      // ~20 tokens per returned id.
      const outputTokens = Math.min(16_000, candidates.length * 20 + 200)
      budget -= estimateTokens(JSON.stringify(messages)) + outputTokens
      const rerankRaw = await requestDigestText(
        aiConfig,
        messages,
        outputTokens,
        0,
      )
      const selection = selectValidDigestRerankIds(
        rerankRaw,
        candidates.map((candidate) => candidate.id),
      )
      if (selection.ids.length === 0) {
        throw new Error('AI 未返回有效候选文章 id')
      }
      const candidateById = new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
      )
      ranked = selection.ids.map((id) => candidateById.get(id)!)
    }

    const selectedCandidates = takeDigestArticlesWithinTokens(
      await withFullText(ranked),
      budget,
    )
    const selectedIds = selectedCandidates.map((candidate) => candidate.id)
    const plan = buildDigestBudgetPlan(selectedCandidates, {
      totalContextChars: Number.MAX_SAFE_INTEGER,
      maxArticleChars: DIGEST_ARTICLE_CHARS,
    })
    const batchNotes: string[] = []

    context?.reportProgress({
      completed: 3,
      total: 4,
      message: '生成批次摘要',
      data: {
        preset,
        feedId: input?.feedId,
        digestRunId: run.id,
        selectedCount: selectedCandidates.length,
      },
    })

    // A few batches at a time: a full folder can be ~75 batches.
    for (let i = 0; i < plan.batches.length; i += DIGEST_BATCH_CONCURRENCY) {
      const notes = await Promise.all(
        plan.batches
          .slice(i, i + DIGEST_BATCH_CONCURRENCY)
          .map((batch) =>
            requestDigestText(
              aiConfig,
              buildDigestBatchMessages({ topic, presetLabel, batch }),
              DIGEST_BATCH_OUTPUT_TOKENS,
              0.2,
            ),
          ),
      )
      batchNotes.push(...notes)
    }

    const content = await requestDigestText(
      aiConfig,
      buildDigestReduceMessages({
        topic,
        presetLabel,
        windowStartAt,
        windowEndAt,
        batchNotes,
      }),
      DIGEST_REDUCE_OUTPUT_TOKENS,
      0.3,
    )
    const completed = getDb().digests.updateAIDigestRun(run.id, {
      status: 'completed',
      title: presetLabel,
      sourceEntryIds: selectedIds,
      content,
      error: undefined,
    })

    context?.reportProgress({
      completed: 4,
      total: 4,
      message: '简报生成完成',
      data: { preset, feedId: input?.feedId, digestRunId: run.id },
    })

    return {
      success: true,
      run: completed || run,
      candidates: selectedCandidates,
    }
  } catch (error) {
    const normalized = normalizeAIError(error, aiConfig)
    const failed = getDb().digests.updateAIDigestRun(run.id, {
      status: 'failed',
      error: normalized,
    })
    context?.reportProgress({
      completed: 4,
      total: 4,
      message: '简报生成失败',
      data: { preset, feedId: input?.feedId, digestRunId: run.id },
    })
    return { success: false, error: normalized, run: failed || run }
  }
}

// ── Summarize pipeline ───────────────────────────────────────────────────────

export async function runAISummarizeTask(
  payload: AiSummarizeTaskPayload,
  context?: TaskRunContext,
): Promise<AISummarizeResult> {
  const settings = settingsProvider.get()
  const aiConfig = settings.ai
  const { content, language, requestId, entryId, sessionId, sourceHash } =
    payload

  const lang = language || settings.general.language || 'zh-CN'
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: buildSummaryPrompt(lang, aiConfig.summaryPrompt),
    },
    {
      role: 'user',
      content: `Please summarize the following article:\n\n${clampContentToBudget(content, 8000)}`,
    },
  ]

  const summary = await runAICompletion({
    aiConfig,
    messages,
    temperature: 0.3,
    maxTokens: 500,
    requestId,
    eventPrefix: 'ai:summary',
    sendEvent: sendToAllWindows,
    context,
    progress: {
      start: {
        completed: 0,
        total: 1,
        message: '生成摘要',
        data: { streaming: Boolean(requestId), contentLength: content.length },
      },
      done: (streaming) => ({
        completed: 1,
        total: 1,
        message: '摘要已生成',
        data: { streaming, contentLength: content.length },
      }),
    },
    hooks: {
      onStart: () => {
        persistAISummarySessionPatch(sessionId, {
          status: 'running',
          model: aiConfig.model,
          sourceHash,
          runId: context?.runId,
        })
      },
      onChunk: ({ text }) => {
        persistAISummarySessionPatch(sessionId, {
          status: 'running',
          draftText: text,
        })
      },
      onSuccess: (summary) => {
        persistAISummarySessionPatch(sessionId, {
          status: 'succeeded',
          draftText: summary,
          finalText: summary,
          errorCode: undefined,
          errorMessage: undefined,
          rawErrorMessage: undefined,
          finishedAt: Date.now(),
        })
        persistEntryAISummary(entryId, summary)
      },
      onError: (normalized, raw) => {
        persistAISummarySessionPatch(sessionId, {
          status: 'failed',
          errorCode: 'provider_error',
          errorMessage: normalized,
          rawErrorMessage: raw instanceof Error ? raw.message : String(raw),
          finishedAt: Date.now(),
        })
        if (entryId) {
          getDb().entries.updateEntry(entryId, { aiSummaryError: normalized })
        }
      },
    },
  })

  return { success: true, summary }
}

// ── Translate pipeline ───────────────────────────────────────────────────────

export async function runAITranslateTask(
  payload: AiTranslateTaskPayload,
  context?: TaskRunContext,
): Promise<AITranslateResult> {
  const settings = settingsProvider.get()
  const aiConfig = settings.ai
  const { content, targetLanguage, requestId } = payload

  const systemPrompt = buildTranslatePrompt(
    targetLanguage,
    aiConfig.translationPrompt,
  )
  const contentBudgets = [6000, 4000, 2500]
  const messages = (attempt: number): OpenAI.ChatCompletionMessageParam[] => {
    const budget = requestId
      ? contentBudgets[0]
      : contentBudgets[Math.min(attempt, contentBudgets.length - 1)]
    return [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: clampContentToBudget(content, budget),
      },
    ]
  }

  const translation = await runAICompletion({
    aiConfig,
    messages,
    temperature: 0.2,
    maxTokens: 4000,
    requestId,
    eventPrefix: 'ai:translate',
    sendEvent: sendToAllWindows,
    context,
    progress: {
      start: {
        completed: 0,
        total: 1,
        message: '生成翻译',
        data: {
          streaming: Boolean(requestId),
          targetLanguage,
          contentLength: content.length,
        },
      },
      done: (streaming) => ({
        completed: 1,
        total: 1,
        message: '翻译已生成',
        data: {
          streaming,
          targetLanguage,
          contentLength: content.length,
        },
      }),
    },
  })

  return { success: true, translation }
}
