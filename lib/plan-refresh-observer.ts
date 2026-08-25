import type { PlanResponse } from "@/lib/api";

export interface PlanRefreshObserver {
  (plan: PlanResponse): void | Promise<void>;
}

const observers = new Set<PlanRefreshObserver>();

export function registerPlanRefreshObserver(observer: PlanRefreshObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export async function notifyPlanRefreshObservers(plan: PlanResponse): Promise<void> {
  await Promise.all([...observers].map(async (observer) => {
    try {
      await observer(plan);
    } catch {
      // A lifecycle observer must not turn a successful authoritative plan fetch
      // into a failed refresh for unrelated plan consumers.
    }
  }));
}
