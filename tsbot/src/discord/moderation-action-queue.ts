import { KeyedSerialQueue } from "./keyed-serial-queue.js";

const queue = new KeyedSerialQueue();

export function runModerationTargetAction<T>(
  guildId: string,
  targetUserId: string,
  task: () => Promise<T>,
): Promise<T> {
  return queue.run(`${guildId}:${targetUserId}`, task);
}
