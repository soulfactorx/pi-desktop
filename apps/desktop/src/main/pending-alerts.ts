import type { NotificationRoute } from "./app-notification";

/**
 * 사용자가 아직 보지 않은 알림 (트레이 아이콘의 빨간 점·알림 목록, 작업 표시줄 표시).
 * 앱 창을 보지 않을 때 띄운 OS 알림을 모아 두고, 앱 창으로 돌아오거나 그 알림을 누르면 지운다.
 * Electron 없이 시험할 수 있게 순수한 목록으로 둔다.
 */
export interface PendingAlert {
  id: number;
  title: string;
  body: string;
  route?: NotificationRoute;
  at: number;
}

/** 기억하는 알림 수 (오래된 것부터 버린다). 수는 그대로 센다 */
const KEEP = 20;

export class PendingAlerts {
  private items: PendingAlert[] = [];
  private total = 0;
  private next = 1;
  private readonly listeners = new Set<() => void>();

  /** 새 알림 수 (목록보다 많을 수 있다) */
  get count(): number {
    return this.total;
  }

  /** 최근 것부터 */
  get list(): readonly PendingAlert[] {
    return this.items;
  }

  add(alert: Omit<PendingAlert, "id">): PendingAlert {
    const item = { ...alert, id: this.next++ };
    this.items = [item, ...this.items].slice(0, KEEP);
    this.total++;
    this.emit();
    return item;
  }

  /** 그 알림 하나를 본 것으로 친다 (알림·트레이 목록에서 누름) */
  remove(id: number): void {
    const before = this.items.length;
    this.items = this.items.filter((a) => a.id !== id);
    if (this.items.length === before) return;
    this.total = Math.max(this.items.length, this.total - 1);
    this.emit();
  }

  clear(): void {
    if (this.total === 0) return;
    this.items = [];
    this.total = 0;
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 앱 전체가 함께 쓰는 목록 */
export const pendingAlerts = new PendingAlerts();
