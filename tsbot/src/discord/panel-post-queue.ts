import { KeyedSerialQueue } from "./keyed-serial-queue.js";

const panelPostQueue = new KeyedSerialQueue();

export function runPanelPostSerial<T>(
  guildId: string,
  preset: string,
  channelId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return panelPostQueue.run(`${guildId}:${preset}:${channelId}`, operation);
}
