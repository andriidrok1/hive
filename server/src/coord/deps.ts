// Types coord needs from core (brief 01). Kept structural so tests can use small fakes
// and so brief 03's structural `*Like` interfaces stay assignable.

import type { ReadLog } from "../core/index.js";
import type { FileChange } from "../core/index.js";

export { badArgs } from "../core/index.js";

/** The part of core's ReadLog that coord uses. The real ReadLog satisfies it; so does a test fake. */
export type ReadLogLike = Pick<ReadLog, "record" | "readsOf" | "readersOf">;

/** What ProjectStore.onChange delivers (core's FileChange). */
export type StoreChange = FileChange;
