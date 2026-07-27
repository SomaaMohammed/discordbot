import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleButtonInteraction,
  handleModalSubmitInteraction,
} from "../src/discord/commands.js";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";
const MESSAGE_ID = "345678901234567890";
const USER_ID = "456789012345678901";
const BOT_ID = "567890123456789012";
const RETIREMENT_MESSAGE =
  "Anonymous question submissions have been retired. Existing stored data was preserved.";

function createRetirementFixture(): {
  runtime: BotRuntime;
  storageOperations: Array<ReturnType<typeof vi.fn>>;
} {
  const storageOperations = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const [
    getPostRecord,
    markUserAnswered,
    recordAnswerMetric,
    updatePostThreadId,
    updateStateAtomic,
  ] = storageOperations;
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  const guildRuntime = {
    guildId: GUILD_ID,
    settings,
    storage: {
      getPostRecord,
      markUserAnswered,
      recordAnswerMetric,
      updatePostThreadId,
      updateStateAtomic,
    },
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;

  return {
    storageOperations,
    runtime: {
      forGuild: vi.fn(async (guildId: string) =>
        guildId === GUILD_ID ? guildRuntime : null,
      ),
    } as unknown as BotRuntime,
  };
}

describe("retired anonymous submissions", () => {
  it("retires a stale anonymous-answer button without opening a modal or reading storage", async () => {
    const { runtime, storageOperations } = createRetirementFixture();
    const reply = vi.fn(async () => undefined);
    const showModal = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      client: { user: { id: BOT_ID } },
      message: {
        id: MESSAGE_ID,
        guildId: GUILD_ID,
        author: { id: BOT_ID },
      },
      user: { id: USER_ID },
      customId: "court:anonymous_answer",
      reply,
      showModal,
    } as unknown as ButtonInteraction;

    await handleButtonInteraction(interaction, runtime);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      content: RETIREMENT_MESSAGE,
      ephemeral: true,
    });
    expect(showModal).not.toHaveBeenCalled();
    for (const operation of storageOperations) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("retires a stale anonymous-answer modal without reading fields, sending messages, or writing storage", async () => {
    const { runtime, storageOperations } = createRetirementFixture();
    const reply = vi.fn(async () => undefined);
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    const getTextInputValue = vi.fn(() => "A legacy anonymous answer");
    const send = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        channels: { cache: new Map([[MESSAGE_ID, { send }]]) },
      },
      message: { guildId: GUILD_ID },
      user: { id: USER_ID },
      customId: `court:anonymous_answer_modal:${MESSAGE_ID}`,
      fields: { getTextInputValue },
      reply,
      deferReply,
      editReply,
    } as unknown as ModalSubmitInteraction;

    await handleModalSubmitInteraction(interaction, runtime);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      content: RETIREMENT_MESSAGE,
      ephemeral: true,
    });
    expect(getTextInputValue).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    for (const operation of storageOperations) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});
