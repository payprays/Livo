import type { DiscoverSearchPlatform } from './discover-search'

export const queryKeys = {
  discover: {
    all: () => ['discover'] as const,
    search: (query: string, platform: DiscoverSearchPlatform) =>
      [...queryKeys.discover.all(), 'search', platform, query.trim()] as const,
  },
}
