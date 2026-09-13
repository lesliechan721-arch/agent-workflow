import type { CommandReporter } from '../commands/runtime.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { ExternalDraftState, OperationExecuteResult, TuiController } from './controller.js';
import { OperationHistoryStore } from './operation-history.js';

export type SessionNavigation = 'home' | 'reload';

export interface SessionResultRecord {
  epoch: number;
  result: OperationExecuteResult;
}

export type SessionHistoryOwner = OperationHistoryStore;

export class LatestSessionResultHistory extends OperationHistoryStore {
  #latestResult?: SessionResultRecord;

  get latestResult(): SessionResultRecord | undefined {
    return this.#latestResult ? structuredClone(this.#latestResult) : undefined;
  }

  recordResult(record: SessionResultRecord): void {
    this.#latestResult = structuredClone(record);
  }
}

export interface SessionHostSnapshot {
  epoch: number;
  controller: TuiController;
  pendingNavigation?: SessionNavigation;
  pendingNavigationDrafts?: ExternalDraftState[];
  reloading: boolean;
}

export type SessionNavigationResult = 'completed' | 'pending' | 'draftBlocked' | 'busy';

export class SessionHost {
  readonly #listeners = new Set<(snapshot: SessionHostSnapshot) => void>();
  readonly #createSession: () => { controller: TuiController; progressFeed: RebuildProgressFeed };
  readonly history: SessionHistoryOwner;
  #epoch = 1;
  #controller: TuiController;
  #progressFeed: RebuildProgressFeed;
  #controllerUnsubscribe?: () => void;
  #pendingNavigation?: SessionNavigation;
  #pendingNavigationDrafts?: ExternalDraftState[];
  #pendingConsumedDraft?: ExternalDraftState;
  #reloading = false;
  #disposed = false;
  readonly #presentedProjectReminders = new Map<string, string>();

  constructor(options: {
    createSession: () => { controller: TuiController; progressFeed: RebuildProgressFeed };
    history?: SessionHistoryOwner;
  }) {
    this.#createSession = options.createSession;
    this.history = options.history ?? new OperationHistoryStore();
    const session = this.#createSession();
    this.#controller = session.controller;
    this.#progressFeed = session.progressFeed;
    this.#attachOperationHistory();
    this.#subscribeController();
  }

  get snapshot(): SessionHostSnapshot {
    return Object.freeze({
      epoch: this.#epoch,
      controller: this.#controller,
      ...(this.#pendingNavigation ? { pendingNavigation: this.#pendingNavigation } : {}),
      ...(this.#pendingNavigationDrafts
        ? { pendingNavigationDrafts: structuredClone(this.#pendingNavigationDrafts) }
        : {}),
      reloading: this.#reloading,
    });
  }

  readonly reporter: CommandReporter = {
    event: (event) => this.#progressFeed.addEvent(event),
    notice: (notice) => this.#progressFeed.addNotice(notice),
  };

  subscribe(listener: (snapshot: SessionHostSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  claimProjectIntentReminder(projectRoot: string, signature: string): boolean {
    if (this.#disposed || this.#presentedProjectReminders.get(projectRoot) === signature) {
      return false;
    }
    this.#presentedProjectReminders.set(projectRoot, signature);
    return true;
  }

  async requestNavigation(
    navigation: SessionNavigation,
    options: { discardDrafts?: boolean; draftConfirmation?: ExternalDraftState[] } = {},
  ): Promise<SessionNavigationResult> {
    if (this.#disposed || this.#reloading) return 'busy';
    if (this.#controller.hasActiveWrite) {
      this.#pendingNavigation = navigation;
      this.#pendingNavigationDrafts = undefined;
      this.#pendingConsumedDraft = undefined;
      this.#publish();
      return 'pending';
    }
    if (this.#controller.hasSessionDraft && !options.discardDrafts) return 'draftBlocked';
    if (this.#controller.hasSessionDraft
      && !this.#draftConfirmationMatches(options.draftConfirmation)) return 'draftBlocked';
    this.#pendingNavigation = undefined;
    this.#pendingNavigationDrafts = undefined;
    this.#pendingConsumedDraft = undefined;
    if (navigation === 'home') {
      return this.#controller.goHome(options) ? 'completed' : 'draftBlocked';
    }
    return await this.#reload() ? 'completed' : 'busy';
  }

  cancelPendingNavigation(): boolean {
    if (!this.#pendingNavigation) return false;
    this.#pendingNavigation = undefined;
    this.#pendingNavigationDrafts = undefined;
    this.#pendingConsumedDraft = undefined;
    this.#publish();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controllerUnsubscribe?.();
    this.#controller.dispose();
    this.#listeners.clear();
  }

  async shutdown(): Promise<void> {
    if (this.#disposed) return;
    const controller = this.#controller;
    controller.beginRetirement();
    this.#reloading = true;
    this.#publish();
    await controller.waitForWrites();
    await controller.cancelAndWaitForReads();
    this.dispose();
  }

  async #reload(): Promise<boolean> {
    if (this.#reloading || this.#controller.hasActiveWrite) return false;
    this.#reloading = true;
    const previous = this.#controller;
    previous.beginRetirement();
    this.#publish();
    const ready = await previous.cancelAndWaitForReads();
    if (!ready || previous.hasActiveWrite || this.#disposed) {
      this.#reloading = false;
      this.#publish();
      return false;
    }
    this.#controllerUnsubscribe?.();
    previous.dispose();
    const next = this.#createSession();
    this.#epoch += 1;
    this.#controller = next.controller;
    this.#progressFeed = next.progressFeed;
    this.#attachOperationHistory();
    this.#pendingNavigation = undefined;
    this.#reloading = false;
    this.#subscribeController();
    this.#publish();
    return true;
  }

  #subscribeController(): void {
    const epoch = this.#epoch;
    const controller = this.#controller;
    this.#controllerUnsubscribe = controller.subscribe((snapshot) => {
      if (this.#disposed || epoch !== this.#epoch || controller !== this.#controller) return;
      const pending = this.#pendingNavigation;
      const completedAtDetail = snapshot.router.current.route.name === 'pluginDetail'
        && snapshot.completionNotice?.pluginId === snapshot.router.current.route.pluginId
        && snapshot.completionNotice.operationRecordId === snapshot.result?.operationRecordId;
      if (!pending || (snapshot.router.current.route.name !== 'result' && !completedAtDetail)
        || !snapshot.result) return;
      if (controller.hasActiveWrite) return;
      if (snapshot.result.state !== 'succeeded') {
        this.#pendingNavigation = undefined;
        this.#pendingNavigationDrafts = undefined;
        this.#pendingConsumedDraft = undefined;
        this.#publish();
        return;
      }
      if (this.history instanceof LatestSessionResultHistory) {
        this.history.recordResult({ epoch, result: snapshot.result });
      }
      const externalDrafts = 'externalDrafts' in controller ? controller.externalDrafts : [];
      if (!this.#pendingConsumedDraft) {
        const consumedKind = snapshot.result.operationKind === 'configSave'
          || snapshot.result.operationKind === 'configReset' ? 'configDraft'
          : snapshot.result.operationKind === 'sourceMutation'
            || snapshot.result.operationKind === 'catalogGeneration' ? 'sourceDraft'
            : snapshot.result.operationKind === 'pluginWriteBatch' ? 'batchDraft' : undefined;
        this.#pendingConsumedDraft = externalDrafts.find((draft) => draft.kind === consumedKind);
        if (this.#pendingConsumedDraft) return;
      } else if (externalDrafts.some((draft) =>
        JSON.stringify(draft) === JSON.stringify(this.#pendingConsumedDraft))) return;
      this.#pendingConsumedDraft = undefined;
      if (controller.hasSessionDraft) {
        this.#pendingNavigationDrafts = externalDrafts;
        this.#publish();
        return;
      }
      this.#pendingNavigation = undefined;
      this.#pendingNavigationDrafts = undefined;
      if (pending === 'home') {
        controller.goHome();
        this.#publish();
      } else void this.#reload();
    });
  }

  #draftConfirmationMatches(confirmation?: ExternalDraftState[]): boolean {
    if (!confirmation || !('externalDrafts' in this.#controller)) return false;
    return JSON.stringify(confirmation) === JSON.stringify(this.#controller.externalDrafts);
  }

  #attachOperationHistory(): void {
    const controller = this.#controller as TuiController & {
      attachOperationHistory?: TuiController['attachOperationHistory'];
    };
    controller.attachOperationHistory?.(this.history, this.#epoch);
  }

  #publish(): void {
    if (this.#disposed) return;
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
