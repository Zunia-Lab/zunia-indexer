import { DEFAULT_LCD_ENDPOINTS } from "../config.js";
import type { HistoryConfig, LcdEndpoint } from "../types.js";
import type { HistoryStore } from "../store/memory.js";
import { TxEventConsumer, type NotifyWakeUp } from "./consumer.js";
import { LcdPollDetector } from "./poll.js";
import {
  CompositeTxEventPublisher,
  LocalTxEventQueue,
  VercelTxEventPublisher,
} from "./queue.js";
import { SubscriptionRegistry } from "./subscriptions.js";
import {
  DEFAULT_RPC_ENDPOINTS,
  loadRealtimeConfig,
  type RealtimeConfig,
  type RpcEndpoint,
} from "./types.js";
import { CometWsDetector } from "./ws.js";

export interface RealtimeRuntime {
  start(): void;
  stop(): void;
  registry: SubscriptionRegistry;
  config: RealtimeConfig;
}

export function createRealtimeRuntime(options: {
  store: HistoryStore;
  historyConfig: HistoryConfig;
  lcdEndpoints?: LcdEndpoint[];
  rpcEndpoints?: RpcEndpoint[];
  notify?: NotifyWakeUp;
}): RealtimeRuntime {
  const rt = loadRealtimeConfig();
  const lcd = options.lcdEndpoints ?? DEFAULT_LCD_ENDPOINTS;
  const rpc = options.rpcEndpoints ?? DEFAULT_RPC_ENDPOINTS;
  const registry = new SubscriptionRegistry(options.store);

  const consumer = new TxEventConsumer(
    options.store,
    options.historyConfig,
    lcd,
    options.notify,
  );

  const local = new LocalTxEventQueue((e) => consumer.handle(e));
  const publishers: import("./queue.js").TxEventPublisher[] = [local];
  if (rt.useVercelQueue) {
    publishers.push(new VercelTxEventPublisher(rt.queueTopic));
  }
  const bus = new CompositeTxEventPublisher(publishers);

  let poll: LcdPollDetector | undefined;
  let ws: CometWsDetector | undefined;

  return {
    registry,
    config: rt,
    start() {
      if (!rt.enabled) {
        console.log("[realtime] disabled");
        return;
      }
      if (rt.mode === "poll" || rt.mode === "hybrid") {
        poll = new LcdPollDetector(
          registry,
          options.store,
          bus,
          lcd,
          rt.pollIntervalSec,
          rt.pollLimitPerWallet,
        );
        poll.start();
        console.log(
          `[realtime] LCD poll every ${rt.pollIntervalSec}s (subscribed wallets only)`,
        );
      }
      if (rt.mode === "ws" || rt.mode === "hybrid") {
        ws = new CometWsDetector(registry, bus, rpc);
        ws.start();
        console.log("[realtime] CometBFT WS for subscribed wallets");
      }
      if (rt.useVercelQueue) {
        console.log(`[realtime] Vercel Queues topic=${rt.queueTopic}`);
      }
    },
    stop() {
      poll?.stop();
      ws?.stop();
    },
  };
}
