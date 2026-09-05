import { describe, expect, it } from "vitest";
import {
  VOTING_PANEL_COMPONENT_PREFIX,
  buildVotingPanelOptionsPayload,
  buildVotingPanelPayload,
  createVotingCancelCustomId,
  createVotingCloseCustomId,
  createVotingOptionCustomId,
  createVotingPanelOptionsCustomId,
  createVotingViewVotersCustomId,
  parseVotingPanelComponentId,
  parseVotingPanelOptions,
  type VotingPanelView,
} from "../src/discord/voting-panel.js";

describe("voting panel rendering and validation", () => {
  it("creates fixed yes/no options and validates custom options", () => {
    expect(parseVotingPanelOptions("yes-no", null)).toEqual([
      { optionId: "option-1", label: "Yes" },
      { optionId: "option-2", label: "No" },
    ]);
    expect(() => parseVotingPanelOptions("yes-no", "Maybe")).toThrow(
      /cannot include custom options/i,
    );
    expect(parseVotingPanelOptions("custom", " One \nTwo\nThree ")).toEqual([
      { optionId: "option-1", label: "One" },
      { optionId: "option-2", label: "Two" },
      { optionId: "option-3", label: "Three" },
    ]);
    expect(() => parseVotingPanelOptions("custom", "One\none")).toThrow(
      /must be unique/i,
    );
    expect(() => parseVotingPanelOptions("custom", "Only one")).toThrow(
      /require 2-10/i,
    );
  });

  it("round-trips opaque component IDs and rejects malformed controls", () => {
    const option = createVotingOptionCustomId("vote_panel", "option_yes");
    expect(parseVotingPanelComponentId(option)).toEqual({
      kind: "option",
      voteId: "vote_panel",
      optionId: "option_yes",
    });
    expect(
      parseVotingPanelComponentId(createVotingViewVotersCustomId("vote_panel")),
    ).toEqual({
      kind: "view-voters",
      voteId: "vote_panel",
    });
    expect(
      parseVotingPanelComponentId(createVotingCloseCustomId("vote_panel")),
    ).toEqual({
      kind: "close",
      voteId: "vote_panel",
    });
    expect(
      parseVotingPanelComponentId(createVotingCancelCustomId("vote_panel")),
    ).toEqual({
      kind: "cancel",
      voteId: "vote_panel",
    });
    expect(
      parseVotingPanelComponentId(
        `${VOTING_PANEL_COMPONENT_PREFIX}vote_panel:option`,
      ),
    ).toBeNull();
  });

  it("renders ten voting buttons over two rows plus voter and management controls", () => {
    const panel = panelView({
      pollType: "custom",
      options: Array.from({ length: 10 }, (_, index) => ({
        optionId: `option_${index + 1}`,
        label: `Option ${index + 1}`,
        voteCount: index,
      })),
    });
    const payload = buildVotingPanelPayload(panel);
    expect(payload.components).toHaveLength(3);
    expect(payload.components.map((row) => row.components)).toHaveLength(3);
    expect(payload.components[0]?.components).toHaveLength(5);
    expect(payload.components[1]?.components).toHaveLength(5);
    expect(payload.components[2]?.components).toHaveLength(2);
    expect(payload.embeds[0].data.footer?.text).toMatch(/^How to use:/);
    expect(payload.allowedMentions.parse).toEqual([]);
  });

  it("keeps the public vote focused and moves administrator controls into a private menu", () => {
    const panel = panelView({
      deadlineAt: "2026-01-01T02:00:00.000Z",
      options: [
        { optionId: "option_yes", label: "Yes", voteCount: 3 },
        { optionId: "option_no", label: "No", voteCount: 1 },
      ],
      totalVoters: 4,
    });
    const publicEmbed = buildVotingPanelPayload(panel).embeds[0].toJSON();
    const publicText = JSON.stringify(publicEmbed);
    const publicControls = buildVotingPanelPayload(panel).components.at(-1);

    expect(publicText).not.toContain("Creator");
    expect(publicText).not.toContain("Poll type");
    expect(publicText).not.toContain("Choose the answer you support");
    expect(publicText).toContain("Ends");
    expect(publicEmbed.author).toEqual({ name: "Voting panel" });
    expect(publicEmbed.description).not.toMatch(/[🟡🟢🔴]/u);
    expect(publicEmbed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Results  •  4 voters" }),
      ]),
    );
    expect(publicControls?.components).toHaveLength(4);
    expect(publicControls?.components[0]?.data).toMatchObject({
      label: "Yes",
    });
    expect(publicControls?.components[1]?.data).toMatchObject({
      label: "No",
    });
    expect(publicControls?.components[2]?.data).toMatchObject({
      label: "View voters",
    });
    expect(publicControls?.components[3]?.data).toMatchObject({
      label: "Panel options",
    });

    const privateOptions = buildVotingPanelOptionsPayload(panel);
    expect(privateOptions.components[0]?.components).toHaveLength(2);
    expect(privateOptions.components[0]?.components[0]?.data).toMatchObject({
      label: "Close vote",
    });
    expect(privateOptions.components[0]?.components[1]?.data).toMatchObject({
      label: "Cancel vote",
    });

    const completedEmbed = buildVotingPanelPayload(
      panelView({
        status: "completed",
        completedAt: "2026-01-01T03:00:00.000Z",
        completedBy: "555555555555555555",
      }),
    ).embeds[0].toJSON();
    expect(JSON.stringify(completedEmbed)).toContain(
      "by <@444444444444444444>",
    );
    expect(JSON.stringify(completedEmbed)).not.toContain(
      "by <@555555555555555555>",
    );
    expect(JSON.stringify(completedEmbed)).toContain("Ended");
    expect(JSON.stringify(completedEmbed)).not.toContain("Ends");
  });

  it("renders yes/no panels as single-select even if input is inconsistent", () => {
    const payload = buildVotingPanelPayload(panelView({ multiSelect: true }));
    const embed = payload.embeds[0].toJSON();

    expect(embed.description).toContain("Choose one");
    expect(embed.description).not.toContain("Choose multiple");
    expect(embed.footer?.text).toContain("select an option");
  });

  it("parses the public options control and source-bound management controls", () => {
    expect(
      parseVotingPanelComponentId(
        createVotingPanelOptionsCustomId("vote_panel"),
      ),
    ).toEqual({ kind: "panel-options", voteId: "vote_panel" });
    expect(
      parseVotingPanelComponentId(
        createVotingCloseCustomId("vote_panel", "333333333333333333"),
      ),
    ).toEqual({
      kind: "close",
      voteId: "vote_panel",
      panelMessageId: "333333333333333333",
    });
  });

  it("reports ties plainly and only permits explicit authorized @everyone content", () => {
    const completed = panelView({
      status: "completed",
      completedAt: "2026-01-01T01:00:00.000Z",
      completedBy: "555555555555555555",
      mentionEveryoneOnCompletion: true,
      options: [
        { optionId: "option_yes", label: "Yes", voteCount: 4 },
        { optionId: "option_no", label: "No", voteCount: 4 },
      ],
      totalVoters: 8,
    });
    const noPermission = buildVotingPanelPayload(completed, {
      phase: "completion",
      allowEveryoneMention: false,
    });
    expect(noPermission.content).toBeUndefined();
    expect(noPermission.allowedMentions.parse).toEqual([]);
    expect(noPermission.embeds[0].data.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Result",
          value: expect.stringMatching(/^Tie:/),
        }),
      ]),
    );
    const allowed = buildVotingPanelPayload(completed, {
      phase: "completion",
      allowEveryoneMention: true,
    });
    expect(allowed.content).toBe("@everyone");
    expect(allowed.allowedMentions.parse).toEqual(["everyone"]);
  });

  it("bounds long tied labels to Discord's embed-field limit", () => {
    const payload = buildVotingPanelPayload(
      panelView({
        pollType: "custom",
        status: "completed",
        completedAt: "2026-01-01T01:00:00.000Z",
        completedBy: "555555555555555555",
        options: Array.from({ length: 10 }, (_, index) => ({
          optionId: `option_${index + 1}`,
          label: `${"*".repeat(79)}${index}`,
          voteCount: Number.MAX_SAFE_INTEGER,
        })),
      }),
    );
    const result = payload.embeds[0].data.fields?.find(
      (field) => field.name === "Result",
    );

    expect(result?.value).toMatch(/^Tie:/);
    expect(result?.value.length).toBeLessThanOrEqual(1_024);
  });

  it("disables voting and management after completion while keeping voter inspection available", () => {
    const completed = buildVotingPanelPayload(
      panelView({
        status: "completed",
        completedAt: "2026-01-01T01:00:00.000Z",
        completedBy: "555555555555555555",
      }),
    );
    const controls = completed.components.flatMap((row) => row.components);
    expect(controls[0]?.data.disabled).toBe(true);
    expect(controls.at(-2)?.data.disabled).toBe(false);
    expect(controls.at(-1)?.data.disabled).toBe(true);

    const cancelled = buildVotingPanelPayload(
      panelView({
        status: "cancelled",
        cancelledAt: "2026-01-01T01:00:00.000Z",
        cancelledBy: "555555555555555555",
      }),
    );
    expect(
      cancelled.components
        .flatMap((row) => row.components)
        .every((button) => button.data.disabled),
    ).toBe(true);
  });
});

function panelView(overrides: Partial<VotingPanelView> = {}): VotingPanelView {
  return {
    voteId: "vote_panel",
    guildId: "111111111111111111",
    channelId: "222222222222222222",
    messageId: "333333333333333333",
    creatorId: "444444444444444444",
    question: "Should the council approve this?",
    title: "Council vote",
    description: "Choose the answer you support.",
    pollType: "yes-no",
    options: [
      { optionId: "option_yes", label: "Yes", voteCount: 0 },
      { optionId: "option_no", label: "No", voteCount: 0 },
    ],
    multiSelect: false,
    mentionEveryoneOnCreation: false,
    mentionEveryoneOnCompletion: false,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: null,
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    totalVoters: 0,
    ...overrides,
  };
}
