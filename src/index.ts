export {
  DEFAULT_HISTORY_CONFIG,
  type HistoryConfig,
  type TxRecord,
  type WatchedWallet,
  type GetHistoryResult,
  type LcdEndpoint,
} from "./types.js";

export {
  loadHistoryConfig,
  DEFAULT_LCD_ENDPOINTS,
  resolveLcd,
} from "./config.js";

export { MemoryHistoryStore, compareTxNewestFirst } from "./store/memory.js";
export type { HistoryStore } from "./store/memory.js";

export { fetchLcdTxs } from "./lcd/client.js";
export { TxHistoryService } from "./service/history.js";

export { createRealtimeRuntime } from "./realtime/runtime.js";
export type { RealtimeRuntime } from "./realtime/runtime.js";
export { loadRealtimeConfig } from "./realtime/types.js";
export type {
  TxDetectedEvent,
  WakeUpNotification,
  RealtimeConfig,
} from "./realtime/types.js";
export { extractTxHash } from "./realtime/ws.js";
export {
  LocalTxEventQueue,
  VercelTxEventPublisher,
  CompositeTxEventPublisher,
  dedupeKey,
} from "./realtime/queue.js";
export { TxEventConsumer } from "./realtime/consumer.js";
