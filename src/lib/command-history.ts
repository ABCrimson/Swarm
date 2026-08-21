/**
 * Undo/Redo command history system.
 *
 * Implements the Command pattern with bounded stack sizes,
 * async execute/undo/redo, and subscriber notifications for
 * reactive UI integration.
 *
 * @module command-history
 */

/** A reversible command that can be executed and undone. */
export interface Command {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly timestamp: number;
  readonly execute: () => Promise<void>;
  readonly undo: () => Promise<void>;
}

/** Callback signature for history change subscribers. */
type HistoryListener = () => void;

/**
 * Bounded command history supporting undo/redo with subscriber notifications.
 *
 * Commands are pushed onto the undo stack on execute. Redo stack is cleared
 * on each new execute. Stack size is capped at `maxSize` (default 50).
 */
export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private readonly maxSize: number;
  private readonly listeners: Set<HistoryListener> = new Set();

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /** Execute a command and push it onto the undo stack. Clears the redo stack. */
  async execute(cmd: Command): Promise<void> {
    await cmd.execute();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.notify();
  }

  /** Undo the most recent command. Moves it to the redo stack. */
  async undo(): Promise<void> {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    await cmd.undo();
    this.redoStack.push(cmd);
    this.notify();
  }

  /** Redo the most recently undone command. Moves it back to the undo stack. */
  async redo(): Promise<void> {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    await cmd.execute();
    this.undoStack.push(cmd);
    this.notify();
  }

  /** Whether there are commands available to undo. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there are commands available to redo. */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns a shallow copy of the undo history (oldest first). */
  getHistory(): Command[] {
    return [...this.undoStack];
  }

  /** Subscribe to history changes. Returns an unsubscribe function. */
  subscribe(listener: HistoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Singleton command history instance for the application. */
export const commandHistory = new CommandHistory();
