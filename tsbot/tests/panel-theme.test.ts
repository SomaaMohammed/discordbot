import { ButtonStyle, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_CUSTOM_ID_LIMIT,
  PANEL_PRESETS,
  RESOURCE_PANEL_LIMITS,
  SAFE_PANEL_ALLOWED_MENTIONS,
  SUPERIOR_PANEL_COLOR,
  SUPERIOR_PANEL_FOOTER_TEXT,
  TICKET_OPEN_CUSTOM_ID_PREFIX,
  TICKET_PANEL_TOKEN_LIMITS,
  createSuperiorEmbed,
  createTicketOpenCustomId,
  isPanelPreset,
  isTicketPanelToken,
  normalizeResourcePanelInput,
  parseTicketOpenCustomId,
  renderHelpPanel,
  renderPanelHowToGuide,
  renderResourcesPanel,
  renderServerInfoPanel,
  renderSuperiorPanel,
  renderSafetyLauncherPanel,
  renderTicketLauncherPanel,
  type PanelFeatureState,
  type SuperiorPanelPayload,
} from "../src/discord/panel-theme.js";

const DISABLED_FEATURES: PanelFeatureState = {
  chat: false,
  replyModeration: false,
  greetings: false,
  activityMetrics: false,
  tickets: false,
};

function createGuild(): Guild {
  return {
    id: "123456789012345678",
    name: "Superior *Test* Server",
    ownerId: "223456789012345678",
    memberCount: 987,
    premiumSubscriptionCount: 12,
    premiumTier: 2,
    createdTimestamp: 1_700_000_000_000,
    channels: { cache: { size: 24 } },
    roles: { cache: { size: 9 } },
    iconURL: vi.fn(() => "https://cdn.discordapp.com/icons/example.png"),
  } as unknown as Guild;
}

function embedJson(payload: SuperiorPanelPayload) {
  return payload.embeds[0].toJSON();
}

function expectSafePayload(payload: SuperiorPanelPayload): void {
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.allowedMentions).toBe(SAFE_PANEL_ALLOWED_MENTIONS);
  expect(Object.isFrozen(payload.allowedMentions)).toBe(true);
  expect(Object.isFrozen(payload.allowedMentions.parse)).toBe(true);
}

describe("Superior panel theme and presets", () => {
  it("uses one fixed rich-gold theme and restrained footer", () => {
    expect(createSuperiorEmbed().toJSON()).toMatchObject({
      color: 0xd4af37,
      footer: { text: "Superior" },
    });
    expect(SUPERIOR_PANEL_COLOR).toBe(0xd4af37);
    expect(SUPERIOR_PANEL_FOOTER_TEXT).toBe("Superior");
  });

  it("renders every typed preset with the fixed theme and safe mentions", () => {
    const requests = {
      help: { preset: "help", features: DISABLED_FEATURES },
      "server-info": { preset: "server-info", guild: createGuild() },
      resources: {
        preset: "resources",
        resource: { title: "Resources", body: "Useful server information." },
      },
      tickets: { preset: "tickets", panelToken: "PanelToken_1234" },
      suggestions: { preset: "suggestions", panelToken: "PanelToken_1234" },
      applications: {
        preset: "applications",
        panelToken: "PanelToken_1234",
      },
      safety: {
        preset: "safety",
        panelToken: "PanelToken_1234",
        reportsEnabled: true,
        appealsEnabled: true,
      },
      verification: {
        preset: "verification",
        customId: "superior:verify:PanelToken_1234:1",
        rulesVersion: 1,
        rulesTitle: "Server Rules",
        rulesBody: "Treat members with respect.",
        reacceptanceRequested: false,
      },
      roles: {
        preset: "roles",
        customId: "superior:rolemenu:MenuToken_1234:PostToken_1234:1",
        title: "Member Roles",
        description: "Choose the roles you want.",
        mode: "toggle",
        minSelections: 0,
        maxSelections: 1,
        requiredRoleId: null,
        options: [
          {
            optionId: "OptionToken_1234",
            label: "Updates",
            description: null,
            emoji: null,
          },
        ],
      },
    } as const;

    expect(Object.keys(requests)).toEqual(PANEL_PRESETS);
    for (const preset of PANEL_PRESETS) {
      const payload = renderSuperiorPanel(requests[preset]);
      const embed = embedJson(payload);
      expect(embed).toMatchObject({ color: SUPERIOR_PANEL_COLOR });
      expect(embed.footer?.text).toMatch(/^How to use:/);
      expectSafePayload(payload);
      expect(isPanelPreset(preset)).toBe(true);
    }
    expect(isPanelPreset("custom")).toBe(false);
  });

  it("changes active-service copy while showing member and delegated families", () => {
    const inactive = embedJson(renderHelpPanel(DISABLED_FEATURES));
    const active = embedJson(
      renderHelpPanel({
        chat: true,
        replyModeration: true,
        greetings: true,
        activityMetrics: true,
        tickets: true,
      }),
    );
    const inactiveCopy = JSON.stringify(inactive.fields);
    const activeCopy = JSON.stringify(active.fields);

    expect(inactiveCopy).not.toContain("/greetings send");
    expect(inactiveCopy).not.toContain("/fun stats");
    expect(inactiveCopy).toContain("Core member services are active");
    expect(activeCopy).toContain("/greetings send");
    expect(activeCopy).toContain("/fun stats");
    expect(activeCopy).toContain("Natural chat");
    expect(activeCopy).toContain("Reply moderation");
    expect(activeCopy).toContain("Support tickets are active");
    for (const command of [
      "`/access`",
      "`/ticket`",
      "`/suggestion`",
      "`/application`",
    ]) {
      expect(inactiveCopy).toContain(command);
      expect(activeCopy).toContain(command);
    }
    expect(inactive.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Owner / Administrator commands",
          value: expect.stringContaining("`/access`"),
        }),
        expect.objectContaining({
          name: "Member and delegated commands",
          value: expect.stringContaining("`/suggestion`"),
        }),
      ]),
    );
  });

  it("renders a practical creation guide with settings, limits, and examples", () => {
    const guide = embedJson(renderPanelHowToGuide());
    const fields = JSON.stringify(guide.fields);
    for (const category of [
      "Choose a path",
      "Fixed-preset workflow",
      "`/panel post` settings",
      "Preset readiness",
      "Private-message panels",
      "Role-button panels",
      "Voting panels: required settings",
      "Voting panels: optional settings and limits",
      "Common setups",
      "Not sure what to choose?",
    ]) {
      expect(fields).toContain(category);
    }
    expect(guide.title).toBe("Create a Server Panel");
    expect(fields).toContain("replace_existing");
    expect(fields).toContain("resource_title");
    expect(fields).toContain("duration_minutes");
    expect(fields).toContain("/panel dmpanel");
    expect(fields).toContain("/panel vote");
    expect(guide.description).toContain("/panel list");
    expect(
      (guide.fields ?? []).every(
        (field: { name?: string; value?: string }) =>
          (field.name?.length ?? 0) <= 256 &&
          (field.value?.length ?? 0) <= 1_024,
      ),
    ).toBe(true);
    expect(
      (guide.description?.length ?? 0) +
        (guide.title?.length ?? 0) +
        (guide.footer?.text?.length ?? 0) +
        (guide.fields ?? []).reduce(
          (total: number, field: { name?: string; value?: string }) =>
            total + (field.name?.length ?? 0) + (field.value?.length ?? 0),
          0,
        ),
    ).toBeLessThanOrEqual(6_000);
    expect(guide.footer?.text).toMatch(/^How to use:/);
  });

  it("renders safety controls independently without exposing private records", () => {
    const payload = renderSafetyLauncherPanel("PanelToken_1234", true, false);
    const serialized = JSON.stringify(payload);
    const buttons = payload.components[0]!.toJSON().components;
    expect(buttons[0]).toMatchObject({
      label: "Submit Report",
      disabled: false,
      custom_id: "superior:report:open:PanelToken_1234",
    });
    expect(buttons[1]).toMatchObject({
      label: "Submit Appeal",
      disabled: true,
      custom_id: "superior:appeal:open:PanelToken_1234",
    });
    expect(serialized).toContain("Privacy");
    expect(serialized).not.toContain("Reporter ID");
    expectSafePayload(payload);
  });

  it("builds a bounded server snapshot from aggregate Guild properties", () => {
    const guild = createGuild();
    const payload = renderServerInfoPanel(guild);
    const embed = embedJson(payload);

    expect(embed.description).toBe("Superior \\*Test\\* Server");
    expect(embed.fields).toHaveLength(7);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Members", value: "`987`" }),
        expect.objectContaining({ name: "Channels", value: "`24`" }),
        expect.objectContaining({ name: "Roles", value: "`8`" }),
      ]),
    );
    expect(embed.thumbnail?.url).toContain("cdn.discordapp.com");
    expect(guild.iconURL).toHaveBeenCalledTimes(1);
    expectSafePayload(payload);
  });
});

describe("resources panel normalization", () => {
  it("normalizes serializable text and HTTPS link data", () => {
    const normalized = normalizeResourcePanelInput({
      title: "  Ｓｅｒｖｅｒ   Resources  ",
      body: " First line  \r\n\r\n\r\nSecond line\t  ",
      links: [
        { label: "  Rules   page ", url: "https://example.com/rules" },
        { label: "FAQ", url: "https://EXAMPLE.com/faq?q=1" },
      ],
    });

    expect(normalized).toEqual({
      title: "Server Resources",
      body: "First line\n\nSecond line",
      links: [
        { label: "Rules page", url: "https://example.com/rules" },
        { label: "FAQ", url: "https://example.com/faq?q=1" },
      ],
    });
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized);
  });

  it("renders at most five HTTPS link buttons without enabling mentions", () => {
    const links = Array.from(
      { length: RESOURCE_PANEL_LIMITS.links },
      (_, i) => ({
        label: `Resource ${i + 1}`,
        url: `https://example.com/resource-${i + 1}`,
      }),
    );
    const payload = renderResourcesPanel({
      title: "@everyone Resources",
      body: "Visit <@&123456789012345678> for help.",
      links,
    });
    const row = payload.components[0]?.toJSON();

    expect(row?.components).toHaveLength(5);
    expect(
      row?.components.every(
        (component) =>
          "url" in component &&
          component.style === ButtonStyle.Link &&
          component.url.startsWith("https://"),
      ),
    ).toBe(true);
    expect(embedJson(payload).title).toContain("@everyone");
    expectSafePayload(payload);
  });

  it.each([
    ["non-HTTPS URL", { label: "Docs", url: "http://example.com" }],
    ["script URL", { label: "Docs", url: "javascript:alert(1)" }],
    ["credential URL", { label: "Docs", url: "https://user@example.com" }],
    ["URL whitespace", { label: "Docs", url: "https://example.com/a b" }],
  ])("rejects %s", (_name, link) => {
    expect(() =>
      normalizeResourcePanelInput({
        title: "Resources",
        body: "Body",
        links: [link],
      }),
    ).toThrow();
  });

  it("rejects missing, oversized, unsafe, duplicate, or excessive content", () => {
    expect(() =>
      normalizeResourcePanelInput({ title: " ", body: "Body" }),
    ).toThrow(/title/i);
    expect(() =>
      normalizeResourcePanelInput({ title: "Title", body: "\u0000Body" }),
    ).toThrow(/control/i);
    expect(() =>
      normalizeResourcePanelInput({
        title: "x".repeat(RESOURCE_PANEL_LIMITS.title + 1),
        body: "Body",
      }),
    ).toThrow(/256/);
    expect(() =>
      normalizeResourcePanelInput({
        title: "Title",
        body: "x".repeat(RESOURCE_PANEL_LIMITS.body + 1),
      }),
    ).toThrow(/4096/);
    expect(() =>
      normalizeResourcePanelInput({
        title: "Title",
        body: "Body",
        links: [
          {
            label: "x".repeat(RESOURCE_PANEL_LIMITS.linkLabel + 1),
            url: "https://example.com",
          },
        ],
      }),
    ).toThrow(/80/);
    expect(() =>
      normalizeResourcePanelInput({
        title: "Title",
        body: "Body",
        links: [
          {
            label: "Link",
            url: "x".repeat(RESOURCE_PANEL_LIMITS.linkUrl + 1),
          },
        ],
      }),
    ).toThrow(/512/);
    expect(() =>
      normalizeResourcePanelInput({
        title: "Title",
        body: "Body",
        links: Array.from({ length: 6 }, (_, index) => ({
          label: `Link ${index}`,
          url: `https://example.com/${index}`,
        })),
      }),
    ).toThrow(/at most 5/i);
    expect(() =>
      normalizeResourcePanelInput({
        title: "Title",
        body: "Body",
        links: [
          { label: "One", url: "https://example.com/same" },
          { label: "Two", url: "https://example.com/same" },
        ],
      }),
    ).toThrow(/unique/i);
  });
});

describe("ticket launcher custom IDs", () => {
  it("renders and parses a short opaque persisted panel token", () => {
    const token = "AbCd_ef-12345678";
    const customId = createTicketOpenCustomId(token);
    const payload = renderTicketLauncherPanel(token);
    const button = payload.components[0]?.toJSON().components[0];

    expect(customId).toBe(`${TICKET_OPEN_CUSTOM_ID_PREFIX}${token}`);
    expect(customId.length).toBeLessThan(DISCORD_CUSTOM_ID_LIMIT);
    expect(parseTicketOpenCustomId(customId)).toBe(token);
    expect(button).toMatchObject({
      custom_id: customId,
      label: "Open Ticket",
      style: ButtonStyle.Primary,
    });
    expectSafePayload(payload);
  });

  it("enforces URL-safe token bounds and rejects stale custom IDs", () => {
    const shortest = "a".repeat(TICKET_PANEL_TOKEN_LIMITS.minimum);
    const longest = "z".repeat(TICKET_PANEL_TOKEN_LIMITS.maximum);
    expect(isTicketPanelToken(shortest)).toBe(true);
    expect(isTicketPanelToken(longest)).toBe(true);
    expect(createTicketOpenCustomId(longest).length).toBeLessThan(100);
    expect(isTicketPanelToken("a".repeat(7))).toBe(false);
    expect(isTicketPanelToken("a".repeat(49))).toBe(false);
    expect(isTicketPanelToken("not opaque!")).toBe(false);
    expect(
      parseTicketOpenCustomId("superior:ticket:claim:abcdefgh"),
    ).toBeNull();
    expect(
      parseTicketOpenCustomId(`${TICKET_OPEN_CUSTOM_ID_PREFIX}bad!token`),
    ).toBeNull();
    expect(() => createTicketOpenCustomId("bad token")).toThrow(/token/i);
    expect(() => createTicketOpenCustomId(" abcdefgh ")).toThrow(/token/i);
  });
});
