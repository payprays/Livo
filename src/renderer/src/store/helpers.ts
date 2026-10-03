import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from 'zustand'
import { useShallow } from 'zustand/react/shallow'

export const createAppStore = <T>(initializer: StateCreator<T, [], []>) =>
  create<T>()(initializer)

export function useStoreShallow<TState, TSlice>(
  store: UseBoundStore<StoreApi<TState>>,
  selector: (state: TState) => TSlice,
) {
  return store(useShallow(selector))
}
