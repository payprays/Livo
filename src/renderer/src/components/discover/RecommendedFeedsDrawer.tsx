import { useTranslation } from 'react-i18next'
import { X, Rss, ExternalLink, Check, Plus, Loader2 } from 'lucide-react'
import { openExternalUrlSafe } from '../../services/external-url'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CuratedFeedInfo {
  title: string
  url: string
  siteUrl: string
  description: string
  category: string
  language: string
  imageUrl?: string
}

export interface DiscoverCategory {
  id: string
  name: string
  nameEn: string
  icon: string
  description: string
}

// ── Sub-component ────────────────────────────────────────────────────────────

export function CuratedFeedRow({
  feed,
  subscribed,
  subscribing,
  onPreview,
  onToggleSubscribe,
}: {
  feed: CuratedFeedInfo
  subscribed: boolean
  subscribing: boolean
  onPreview: () => void
  onToggleSubscribe: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPreview}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPreview()
        }
      }}
      className="hover:border-accent/30 hover:bg-surface-secondary/50 focus:ring-accent/50 group flex cursor-pointer items-center gap-3 rounded-xl border bg-white p-3.5 transition-all duration-200 focus:outline-none focus:ring-2 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
    >
      <div className="bg-accent/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg">
        <Rss size={16} className="text-accent" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="block min-w-0 truncate text-sm font-medium">
            {feed.title}
          </span>
          <span className="bg-surface-secondary text-text-tertiary flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/10 dark:text-white/40">
            {feed.language === 'Chinese' ? '中' : 'EN'}
          </span>
        </div>
        {feed.description && (
          <p className="text-text-secondary mt-0.5 truncate text-xs dark:text-white/50">
            {feed.description}
          </p>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        <a
          href={feed.siteUrl || feed.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void openExternalUrlSafe(feed.siteUrl || feed.url)
          }}
          className="text-text-tertiary hover:bg-surface-secondary hover:text-text-secondary rounded-lg p-1.5 opacity-0 transition-colors focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
          title={t('discover.viewSource')}
        >
          <ExternalLink size={14} />
        </a>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSubscribe()
          }}
          disabled={subscribing}
          className={`group/btn flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 ${
            subscribed
              ? 'bg-green-100 text-green-600 hover:bg-red-100 hover:text-red-600 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-red-900/30 dark:hover:text-red-400'
              : 'bg-accent hover:bg-accent-hover text-white active:scale-95'
          } disabled:cursor-default disabled:opacity-70`}
        >
          {subscribing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : subscribed ? (
            <>
              <Check size={12} className="group-hover/btn:hidden" />
              <X size={12} className="hidden group-hover/btn:block" />
              <span className="group-hover/btn:hidden">
                {t('common.subscribed')}
              </span>
              <span className="hidden group-hover/btn:block">
                {t('discover.unsubscribeAction')}
              </span>
            </>
          ) : (
            <>
              <Plus size={12} />
              <span>{t('common.subscribe')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
