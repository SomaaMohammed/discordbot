import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  parseMudaeRoll,
  type MudaeRollMessage,
} from "../src/mudae-roll-parser.js";

const IMAGE_URL = "https://cdn.discordapp.com/attachments/1/2/lily.png";

function rollMessage(
  options: {
    title?: string | null;
    authorName?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    thumbnailUrl?: string | null;
    footer?: string | null;
    content?: string;
    commandName?: string | null;
    components?: readonly unknown[];
    embeds?: readonly unknown[];
  } = {},
): MudaeRollMessage {
  const embed = {
    title: options.title === undefined ? "Lily (KJN)" : options.title,
    author:
      options.authorName === undefined ? null : { name: options.authorName },
    description:
      options.description === undefined
        ? "Kage no Jitsuryokusha ni Naritakute!\nClaims: #100\nLikes: #200\n250 kakera"
        : options.description,
    image:
      options.imageUrl === null ? null : { url: options.imageUrl ?? IMAGE_URL },
    thumbnail: options.thumbnailUrl ? { url: options.thumbnailUrl } : null,
    footer: options.footer ? { text: options.footer } : null,
  };
  return {
    content: options.content ?? "",
    embeds: (options.embeds ?? [embed]) as Message["embeds"],
    components: (options.components ?? [
      {
        type: 1,
        components: [{ type: 2, customId: "synthetic-claim", disabled: false }],
      },
    ]) as Message["components"],
    interaction: options.commandName
      ? ({ commandName: options.commandName } as Message["interaction"])
      : null,
  };
}

describe("Mudae roll parser", () => {
  it("extracts the screenshot-style character and series", () => {
    expect(parseMudaeRoll(rollMessage())).toEqual({
      characterName: "Lily (KJN)",
      seriesName: "Kage no Jitsuryokusha ni Naritakute!",
      normalizedSeries: "kage no jitsuryokusha ni naritakute!",
      imageUrl: IMAGE_URL,
      sourceEmbedIndex: 0,
    });
  });

  it("accepts author-name cards and harmless whitespace/Markdown changes", () => {
    const parsed = parseMudaeRoll(
      rollMessage({
        title: null,
        authorName: " **Lily** ",
        description:
          "\n\u200b> **  Ｋａｇｅ   no\tJitsuryokusha ni Naritakute!  **\nLikes: #9",
        components: [
          {
            type: 1,
            children: [{ type: 2, custom_id: "raw-claim", disabled: false }],
          },
        ],
      }),
    );

    expect(parsed).toMatchObject({
      characterName: "Lily",
      seriesName: "Kage no Jitsuryokusha ni Naritakute!",
      normalizedSeries: "kage no jitsuryokusha ni naritakute!",
    });
  });

  it("does not depend on Claims, Likes, or kakera fields", () => {
    expect(
      parseMudaeRoll(
        rollMessage({
          description: "Another Series",
        }),
      ),
    ).toMatchObject({ seriesName: "Another Series" });
  });

  it.each([
    ["no embeds", { embeds: [] }],
    ["missing title", { title: null }],
    ["missing description", { description: null }],
    ["missing image", { imageUrl: null }],
    ["thumbnail info card", { thumbnailUrl: IMAGE_URL }],
    [
      "disabled component",
      {
        components: [
          {
            type: 1,
            components: [{ type: 2, customId: "synthetic", disabled: true }],
          },
        ],
      },
    ],
    ["empty series", { description: "\n---\n" }],
    ["stats in series position", { description: "Claims: #1\nSeries" }],
  ])("rejects malformed cards: %s", (_label, options) => {
    expect(parseMudaeRoll(rollMessage(options))).toBeNull();
  });

  it("rejects $im-style image cards without a claim component", () => {
    expect(parseMudaeRoll(rollMessage({ components: [] }))).toBeNull();
    expect(parseMudaeRoll(rollMessage({ commandName: "im" }))).toBeNull();
    expect(parseMudaeRoll(rollMessage({ content: "$im Lily" }))).toBeNull();
  });

  it("rejects informational/list titles, footers, and multi-embed output", () => {
    expect(
      parseMudaeRoll(rollMessage({ title: "Wishlist for a member" })),
    ).toBeNull();
    expect(
      parseMudaeRoll(rollMessage({ footer: "Image 1 / 12 — $im" })),
    ).toBeNull();
    const first = rollMessage().embeds[0]!;
    expect(parseMudaeRoll(rollMessage({ embeds: [first, first] }))).toBeNull();
  });
});
