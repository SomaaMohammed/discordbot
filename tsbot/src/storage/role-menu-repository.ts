import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import type {
  RoleMenu,
  RoleMenuInput,
  RoleMenuMode,
  RoleMenuOperation,
  RoleMenuOperationCompletionInput,
  RoleMenuOperationItem,
  RoleMenuOperationReservationInput,
  RoleMenuOperationReservationResult,
  RoleMenuOption,
  RoleMenuOptionInput,
  RoleMenuOptionUpdateInput,
  RoleMenuPost,
  RoleMenuPostInput,
  RoleMenuPostState,
  RoleMenuState,
  RoleMenuUpdateInput,
  RoleOperationState,
} from "../types.js";
import {
  MAX_ROLE_MENU_SELECTION_KEY_LENGTH,
  ROLE_MENU_MODES,
  ROLE_MENU_POST_STATES,
  ROLE_MENU_STATES,
  ROLE_OPERATION_STATES,
} from "../types.js";
import { normalizeOptionalUnicodeEmoji } from "../unicode-emoji.js";
import { createOpaqueStorageId } from "./operational-repository.js";
import { normalizeRoleMenuText } from "./role-menu-normalization.js";

export const MAX_ROLE_MENUS_PER_GUILD = 25;
export const MAX_ROLE_MENU_OPTIONS = 25;
export const MAX_ROLE_MENU_POSTS_PER_MENU = 100;
export const MAX_ROLE_MENU_POSTS_PER_GUILD = 500;
export const MAX_ROLE_MENU_OPERATIONS = 100_000;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

interface RoleMenuRow {
  guild_id: string;
  menu_id: string;
  slug: string;
  title: string;
  description: string;
  sort_order: number;
  menu_state: string;
  selection_mode: string;
  min_selections: number;
  max_selections: number;
  required_role_id: string | null;
  definition_version: number;
  bindings_verified_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface RoleMenuOptionRow {
  guild_id: string;
  menu_id: string;
  option_id: string;
  role_id: string;
  label: string;
  description: string | null;
  emoji: string | null;
  sort_order: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface RoleMenuPostRow {
  guild_id: string;
  post_id: string;
  menu_id: string;
  channel_id: string;
  message_id: string;
  definition_version: number;
  bindings_verified_at: string | null;
  post_state: string;
  created_at: string;
  updated_at: string;
}

interface RoleMenuOperationRow {
  guild_id: string;
  operation_id: string;
  interaction_id: string;
  menu_id: string;
  member_id: string;
  definition_version: number;
  selection_key: string;
  operation_state: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RoleMenuOperationItemRow {
  guild_id: string;
  operation_id: string;
  role_id: string;
  role_action: string;
  item_state: string;
  failure_code: string | null;
}

export interface RoleMenuListOptions {
  states?: readonly RoleMenuState[];
  limit?: number;
  offset?: number;
}

export interface RoleMenuPostListOptions {
  menuId?: string;
  states?: readonly RoleMenuPostState[];
  limit?: number;
  offset?: number;
}

export interface RoleMenuOperationListOptions {
  menuId?: string;
  memberId?: string;
  states?: readonly RoleOperationState[];
  limit?: number;
  offset?: number;
}

/** Tenant-bound storage for persistent self-service role menus. */
export class RoleMenuRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public createRoleMenu(input: RoleMenuInput): RoleMenu {
    const normalized = normalizeRoleMenuInput(input, this.guildId);
    if (normalized.state !== "disabled") {
      throw new TypeError("A new role menu must start disabled");
    }
    let result: RoleMenu | null = null;
    const create = this.db.transaction(() => {
      const menuCount = this.countRoleMenus();
      if (menuCount >= MAX_ROLE_MENUS_PER_GUILD) {
        throw new RangeError(
          `A guild supports at most ${MAX_ROLE_MENUS_PER_GUILD} role menus`,
        );
      }
      const sortOrder = normalized.sortOrder ?? menuCount;
      if (sortOrder > menuCount) {
        throw new RangeError(
          `A new role menu position must be between 0 and ${menuCount}`,
        );
      }
      const menuId = normalized.menuId ?? this.allocateMenuId();
      if (this.getRoleMenuById(menuId)) {
        throw new TypeError("Role-menu ID is already in use");
      }
      const now = utcNow();
      this.makeRoleMenuInsertionSlotWithin(
        sortOrder,
        menuCount,
        normalized.actorId,
        now,
      );
      this.db
        .prepare(
          `INSERT INTO role_menus (
             guild_id, menu_id, slug, title, description, sort_order, menu_state,
             selection_mode, min_selections, max_selections,
             required_role_id, definition_version, bindings_verified_at,
             created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'disabled', ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          menuId,
          normalized.slug,
          normalized.title,
          normalized.description,
          sortOrder,
          normalized.mode,
          normalized.minSelections,
          normalized.maxSelections,
          normalized.requiredRoleId,
          normalized.actorId,
          normalized.actorId,
          now,
          now,
        );
      result = this.requireRoleMenu(menuId);
    });
    create.immediate();
    return requireResult<RoleMenu>(result, "Role-menu creation");
  }

  public updateRoleMenu(
    menuId: string,
    input: RoleMenuUpdateInput,
  ): RoleMenu | null {
    const id = requireOpaqueId(menuId, "menu ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    let result: RoleMenu | null | undefined;
    const update = this.db.transaction(() => {
      const current = this.getRoleMenuById(id);
      if (!current) {
        result = null;
        return;
      }
      if (
        input.expectedDefinitionVersion !== undefined &&
        normalizeInteger(
          input.expectedDefinitionVersion,
          1,
          2_147_483_647,
          "expected definition version",
        ) !== current.definitionVersion
      ) {
        throw new Error("Role-menu definition changed before this update");
      }
      const merged = normalizeMergedRoleMenu(current, input, this.guildId);
      const menuCount = this.countRoleMenus();
      if (merged.sortOrder >= menuCount) {
        throw new RangeError(
          `Role-menu position must be between 0 and ${menuCount - 1}`,
        );
      }
      const definitionChanged = !sameRoleMenuDefinition(current, merged);
      const stateChanged =
        current.state !== merged.state ||
        current.bindingsVerifiedAt !== merged.bindingsVerifiedAt;
      const orderChanged = current.sortOrder !== merged.sortOrder;
      if (!definitionChanged && !stateChanged && !orderChanged) {
        result = current;
        return;
      }
      if (current.state === "archived") {
        throw new Error("Archived role menus cannot be edited or re-enabled");
      }
      if (definitionChanged && input.state === "enabled") {
        throw new TypeError(
          "A changed role-menu definition must be verified before it is enabled",
        );
      }
      const now = utcNow();
      if (definitionChanged) {
        if (current.definitionVersion >= 2_147_483_647) {
          throw new RangeError("Role-menu definition version is exhausted");
        }
        this.db
          .prepare(
            `UPDATE role_menus
             SET slug = ?, title = ?, description = ?, menu_state = 'disabled',
                 selection_mode = ?, min_selections = ?, max_selections = ?,
                 required_role_id = ?, definition_version = definition_version + 1,
                 bindings_verified_at = NULL, updated_by = ?, updated_at = ?
             WHERE guild_id = ? AND menu_id = ?
               AND definition_version = ?`,
          )
          .run(
            merged.slug,
            merged.title,
            merged.description,
            merged.mode,
            merged.minSelections,
            merged.maxSelections,
            merged.requiredRoleId,
            actorId,
            now,
            this.guildId,
            id,
            current.definitionVersion,
          );
        this.markPostsStaleWithin(id, now);
      } else if (stateChanged) {
        this.assertMenuCanEnterState(
          current,
          merged.state,
          merged.bindingsVerifiedAt,
        );
        this.db
          .prepare(
            `UPDATE role_menus
             SET menu_state = ?, bindings_verified_at = ?,
                 updated_by = ?, updated_at = ?
             WHERE guild_id = ? AND menu_id = ?`,
          )
          .run(
            merged.state,
            merged.bindingsVerifiedAt,
            actorId,
            now,
            this.guildId,
            id,
          );
        if (merged.state === "archived") this.markPostsStaleWithin(id, now);
      }
      if (orderChanged) {
        this.moveRoleMenuWithin(
          id,
          current.sortOrder,
          merged.sortOrder,
          actorId,
          now,
        );
      }
      result = this.requireRoleMenu(id);
    });
    update.immediate();
    return requireDefinedResult(result, "Role-menu update");
  }

  public setRoleMenuState(
    menuId: string,
    state: RoleMenuState,
    actorId: string,
    bindingsVerifiedAt: string | null = null,
  ): RoleMenu | null {
    return this.updateRoleMenu(menuId, {
      state: normalizeRoleMenuState(state),
      bindingsVerifiedAt,
      actorId,
    });
  }

  public getRoleMenuById(menuId: string): RoleMenu | null {
    const id = normalizeOpaqueId(menuId);
    if (!id) return null;
    const row = this.db
      .prepare("SELECT * FROM role_menus WHERE guild_id = ? AND menu_id = ?")
      .get(this.guildId, id) as RoleMenuRow | undefined;
    return row ? parseRoleMenu(row) : null;
  }

  public getRoleMenuBySlug(slug: string): RoleMenu | null {
    const normalized = normalizeSlug(slug);
    const row = this.db
      .prepare("SELECT * FROM role_menus WHERE guild_id = ? AND slug = ?")
      .get(this.guildId, normalized) as RoleMenuRow | undefined;
    return row ? parseRoleMenu(row) : null;
  }

  public listRoleMenus(options: RoleMenuListOptions = {}): RoleMenu[] {
    const states = normalizeEnumList(
      options.states,
      ROLE_MENU_STATES,
      "role-menu state",
    );
    const limit = normalizeListLimit(
      options.limit ?? MAX_ROLE_MENUS_PER_GUILD,
      MAX_ROLE_MENUS_PER_GUILD,
    );
    const offset = normalizeOffset(options.offset ?? 0);
    if (states === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM role_menus WHERE guild_id = ?
             ORDER BY sort_order, menu_id LIMIT ? OFFSET ?`,
          )
          .all(this.guildId, limit, offset) as RoleMenuRow[]
      ).map(parseRoleMenu);
    }
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT * FROM role_menus
           WHERE guild_id = ? AND menu_state IN (${placeholders})
           ORDER BY sort_order, menu_id LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, ...states, limit, offset) as RoleMenuRow[]
    ).map(parseRoleMenu);
  }

  public countRoleMenus(states?: readonly RoleMenuState[]): number {
    const normalized = normalizeEnumList(
      states,
      ROLE_MENU_STATES,
      "role-menu state",
    );
    if (normalized === undefined) {
      return this.countRows("role_menus");
    }
    if (normalized.length === 0) return 0;
    const placeholders = normalized.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM role_menus
         WHERE guild_id = ? AND menu_state IN (${placeholders})`,
      )
      .get(this.guildId, ...normalized) as { count: number };
    return Number(row.count);
  }

  public createRoleMenuOption(
    menuId: string,
    input: RoleMenuOptionInput,
  ): RoleMenuOption {
    const id = requireOpaqueId(menuId, "menu ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    let result: RoleMenuOption | null = null;
    const create = this.db.transaction(() => {
      const menu = this.requireEditableRoleMenu(id);
      const current = this.listRoleMenuOptions(id);
      if (current.length >= MAX_ROLE_MENU_OPTIONS) {
        throw new RangeError(
          `A role menu supports at most ${MAX_ROLE_MENU_OPTIONS} options`,
        );
      }
      const normalized = normalizeRoleMenuOptionInput(
        input,
        current.length,
        current.length,
        this.guildId,
      );
      const optionId = normalized.optionId ?? this.allocateOptionId(id);
      if (this.getRoleMenuOption(id, optionId)) {
        throw new TypeError("Role-menu option ID is already in use");
      }
      if (current.some((option) => option.roleId === normalized.roleId)) {
        throw new TypeError("Each role may appear only once in a role menu");
      }
      const now = utcNow();
      const created: RoleMenuOption = {
        guildId: this.guildId,
        menuId: id,
        optionId,
        roleId: normalized.roleId,
        label: normalized.label,
        description: normalized.description,
        emoji: normalized.emoji,
        sortOrder: normalized.sortOrder,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      };
      const ordered = [...current];
      ordered.splice(normalized.sortOrder, 0, created);
      this.rewriteOptionsWithin(id, ordered, actorId, now);
      this.bumpDefinitionWithin(menu, actorId, now);
      result = this.requireRoleMenuOption(id, optionId);
    });
    create.immediate();
    return requireResult<RoleMenuOption>(result, "Role-menu option creation");
  }

  public updateRoleMenuOption(
    menuId: string,
    optionId: string,
    input: RoleMenuOptionUpdateInput,
  ): RoleMenuOption | null {
    const normalizedMenuId = requireOpaqueId(menuId, "menu ID");
    const normalizedOptionId = requireOpaqueId(optionId, "option ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    let result: RoleMenuOption | null | undefined;
    const update = this.db.transaction(() => {
      const menu = this.requireEditableRoleMenu(normalizedMenuId);
      const current = this.listRoleMenuOptions(normalizedMenuId);
      const existing = current.find(
        (option) => option.optionId === normalizedOptionId,
      );
      if (!existing) {
        result = null;
        return;
      }
      const merged = normalizeMergedRoleMenuOption(
        existing,
        input,
        current.length,
        this.guildId,
      );
      if (
        current.some(
          (option) =>
            option.optionId !== normalizedOptionId &&
            option.roleId === merged.roleId,
        )
      ) {
        throw new TypeError("Each role may appear only once in a role menu");
      }
      if (sameRoleMenuOption(existing, merged)) {
        result = existing;
        return;
      }
      const now = utcNow();
      const remaining = current.filter(
        (option) => option.optionId !== normalizedOptionId,
      );
      remaining.splice(merged.sortOrder, 0, {
        ...existing,
        roleId: merged.roleId,
        label: merged.label,
        description: merged.description,
        emoji: merged.emoji,
        sortOrder: merged.sortOrder,
        updatedBy: actorId,
        updatedAt: now,
      });
      this.rewriteOptionsWithin(normalizedMenuId, remaining, actorId, now);
      this.bumpDefinitionWithin(menu, actorId, now);
      result = this.requireRoleMenuOption(normalizedMenuId, normalizedOptionId);
    });
    update.immediate();
    return requireDefinedResult(result, "Role-menu option update");
  }

  public moveRoleMenuOption(
    menuId: string,
    optionId: string,
    sortOrder: number,
    actorId: string,
  ): RoleMenuOption | null {
    return this.updateRoleMenuOption(menuId, optionId, {
      sortOrder,
      actorId,
    });
  }

  public reorderRoleMenuOptions(
    menuId: string,
    optionIds: readonly string[],
    actorId: string,
  ): RoleMenuOption[] {
    const id = requireOpaqueId(menuId, "menu ID");
    const actor = assertDiscordSnowflake(actorId, "actor ID");
    const normalizedIds = normalizeOpaqueIdOrder(optionIds, "option ID");
    let result: RoleMenuOption[] | null = null;
    const reorder = this.db.transaction(() => {
      const menu = this.requireEditableRoleMenu(id);
      const current = this.listRoleMenuOptions(id);
      if (
        !sameIdSet(
          current.map((option) => option.optionId),
          normalizedIds,
        )
      ) {
        throw new TypeError(
          "Option order must include every current menu option exactly once",
        );
      }
      if (
        current.every(
          (option, index) => option.optionId === normalizedIds[index],
        )
      ) {
        result = current;
        return;
      }
      const byId = new Map(current.map((option) => [option.optionId, option]));
      const ordered = normalizedIds.map((optionId) => byId.get(optionId)!);
      const now = utcNow();
      this.rewriteOptionsWithin(id, ordered, actor, now);
      this.bumpDefinitionWithin(menu, actor, now);
      result = this.listRoleMenuOptions(id);
    });
    reorder.immediate();
    return requireResult<RoleMenuOption[]>(result, "Role-menu option reorder");
  }

  public removeRoleMenuOption(
    menuId: string,
    optionId: string,
    actorId: string,
  ): boolean {
    const normalizedMenuId = requireOpaqueId(menuId, "menu ID");
    const normalizedOptionId = requireOpaqueId(optionId, "option ID");
    const actor = assertDiscordSnowflake(actorId, "actor ID");
    let removed = false;
    const remove = this.db.transaction(() => {
      const menu = this.requireEditableRoleMenu(normalizedMenuId);
      const current = this.listRoleMenuOptions(normalizedMenuId);
      if (!current.some((option) => option.optionId === normalizedOptionId)) {
        return;
      }
      const now = utcNow();
      this.rewriteOptionsWithin(
        normalizedMenuId,
        current.filter((option) => option.optionId !== normalizedOptionId),
        actor,
        now,
      );
      this.bumpDefinitionWithin(menu, actor, now);
      removed = true;
    });
    remove.immediate();
    return removed;
  }

  public getRoleMenuOption(
    menuId: string,
    optionId: string,
  ): RoleMenuOption | null {
    const normalizedMenuId = normalizeOpaqueId(menuId);
    const normalizedOptionId = normalizeOpaqueId(optionId);
    if (!normalizedMenuId || !normalizedOptionId) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM role_menu_options
         WHERE guild_id = ? AND menu_id = ? AND option_id = ?`,
      )
      .get(this.guildId, normalizedMenuId, normalizedOptionId) as
      RoleMenuOptionRow | undefined;
    return row ? parseRoleMenuOption(row) : null;
  }

  public listRoleMenuOptions(menuId: string): RoleMenuOption[] {
    const id = requireOpaqueId(menuId, "menu ID");
    const rows = this.db
      .prepare(
        `SELECT * FROM role_menu_options
         WHERE guild_id = ? AND menu_id = ?
         ORDER BY sort_order, option_id LIMIT ?`,
      )
      .all(this.guildId, id, MAX_ROLE_MENU_OPTIONS + 1) as RoleMenuOptionRow[];
    if (rows.length > MAX_ROLE_MENU_OPTIONS) {
      throw new RangeError("Stored role-menu options exceed the safety limit");
    }
    return rows.map(parseRoleMenuOption);
  }

  public countRoleMenuOptions(menuId: string): number {
    const id = requireOpaqueId(menuId, "menu ID");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM role_menu_options
         WHERE guild_id = ? AND menu_id = ?`,
      )
      .get(this.guildId, id) as { count: number };
    return Number(row.count);
  }

  public createRoleMenuPost(input: RoleMenuPostInput): RoleMenuPost {
    const normalized = this.normalizePostInput(input);
    let result: RoleMenuPost | null = null;
    const create = this.db.transaction(() => {
      this.assertPostCapacity(normalized.menuId);
      const postId = normalized.postId ?? this.allocatePostId();
      if (this.getRoleMenuPostById(postId)) {
        throw new TypeError("Role-menu post ID is already in use");
      }
      if (
        this.findRoleMenuPostByMessage(
          normalized.channelId,
          normalized.messageId,
        )
      ) {
        throw new TypeError("That Discord message is already a role-menu post");
      }
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO role_menu_posts (
             guild_id, post_id, menu_id, channel_id, message_id,
             definition_version, bindings_verified_at, post_state,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          postId,
          normalized.menuId,
          normalized.channelId,
          normalized.messageId,
          normalized.definitionVersion,
          normalized.bindingsVerifiedAt,
          normalized.state,
          now,
          now,
        );
      result = this.requireRoleMenuPost(postId);
    });
    create.immediate();
    return requireResult<RoleMenuPost>(result, "Role-menu post creation");
  }

  public upsertRoleMenuPost(input: RoleMenuPostInput): RoleMenuPost {
    const normalized = this.normalizePostInput(input);
    let result: RoleMenuPost | null = null;
    const upsert = this.db.transaction(() => {
      const byId =
        normalized.postId === null
          ? null
          : this.getRoleMenuPostById(normalized.postId);
      const byMessage = this.findRoleMenuPostByMessage(
        normalized.channelId,
        normalized.messageId,
      );
      if (byId && byMessage && byId.postId !== byMessage.postId) {
        throw new TypeError(
          "Role-menu post ID and message identify different rows",
        );
      }
      const existing = byId ?? byMessage;
      if (!existing) {
        result = this.createRoleMenuPost(input);
        return;
      }
      if (existing.menuId !== normalized.menuId) {
        throw new TypeError(
          "A role-menu post cannot be rebound to another menu",
        );
      }
      this.db
        .prepare(
          `UPDATE role_menu_posts
           SET channel_id = ?, message_id = ?, definition_version = ?,
               bindings_verified_at = ?, post_state = ?, updated_at = ?
           WHERE guild_id = ? AND post_id = ?`,
        )
        .run(
          normalized.channelId,
          normalized.messageId,
          normalized.definitionVersion,
          normalized.bindingsVerifiedAt,
          normalized.state,
          utcNow(),
          this.guildId,
          existing.postId,
        );
      result = this.requireRoleMenuPost(existing.postId);
    });
    upsert.immediate();
    return requireResult<RoleMenuPost>(result, "Role-menu post update");
  }

  public setRoleMenuPostState(
    postId: string,
    state: RoleMenuPostState,
    bindingsVerifiedAt: string | null = null,
  ): RoleMenuPost | null {
    const id = requireOpaqueId(postId, "post ID");
    const current = this.getRoleMenuPostById(id);
    if (!current) return null;
    return this.upsertRoleMenuPost({
      postId: id,
      menuId: current.menuId,
      channelId: current.channelId,
      messageId: current.messageId,
      definitionVersion: current.definitionVersion,
      bindingsVerifiedAt,
      state: normalizeRoleMenuPostState(state),
    });
  }

  public getRoleMenuPostById(postId: string): RoleMenuPost | null {
    const id = normalizeOpaqueId(postId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM role_menu_posts WHERE guild_id = ? AND post_id = ?",
      )
      .get(this.guildId, id) as RoleMenuPostRow | undefined;
    return row ? parseRoleMenuPost(row) : null;
  }

  public findRoleMenuPostByMessage(
    channelId: string,
    messageId: string,
  ): RoleMenuPost | null {
    const channel = assertDiscordSnowflake(channelId, "channel ID");
    const message = assertDiscordSnowflake(messageId, "message ID");
    const row = this.db
      .prepare(
        `SELECT * FROM role_menu_posts
         WHERE guild_id = ? AND channel_id = ? AND message_id = ?`,
      )
      .get(this.guildId, channel, message) as RoleMenuPostRow | undefined;
    return row ? parseRoleMenuPost(row) : null;
  }

  public listRoleMenuPosts(
    options: RoleMenuPostListOptions = {},
  ): RoleMenuPost[] {
    const clauses = ["guild_id = ?"];
    const parameters: Array<string | number> = [this.guildId];
    if (options.menuId !== undefined) {
      clauses.push("menu_id = ?");
      parameters.push(requireOpaqueId(options.menuId, "menu ID"));
    }
    const states = normalizeEnumList(
      options.states,
      ROLE_MENU_POST_STATES,
      "role-menu post state",
    );
    if (states !== undefined) {
      if (states.length === 0) return [];
      clauses.push(`post_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    parameters.push(
      normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT),
      normalizeOffset(options.offset ?? 0),
    );
    return (
      this.db
        .prepare(
          `SELECT * FROM role_menu_posts
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC, post_id LIMIT ? OFFSET ?`,
        )
        .all(...parameters) as RoleMenuPostRow[]
    ).map(parseRoleMenuPost);
  }

  public countRoleMenuPosts(menuId?: string): number {
    if (menuId === undefined) return this.countRows("role_menu_posts");
    const id = requireOpaqueId(menuId, "menu ID");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM role_menu_posts
         WHERE guild_id = ? AND menu_id = ?`,
      )
      .get(this.guildId, id) as { count: number };
    return Number(row.count);
  }

  public getRoleMenuOperationById(
    operationId: string,
  ): RoleMenuOperation | null {
    const id = normalizeOpaqueId(operationId);
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM role_menu_operations
         WHERE guild_id = ? AND operation_id = ?`,
      )
      .get(this.guildId, id) as RoleMenuOperationRow | undefined;
    return row ? this.parseRoleMenuOperation(row) : null;
  }

  public getRoleMenuOperation(operationId: string): RoleMenuOperation | null {
    return this.getRoleMenuOperationById(operationId);
  }

  public getRoleMenuOperationByInteraction(
    interactionId: string,
  ): RoleMenuOperation | null {
    const interaction = assertDiscordSnowflake(interactionId, "interaction ID");
    const row = this.db
      .prepare(
        `SELECT * FROM role_menu_operations
         WHERE guild_id = ? AND interaction_id = ?`,
      )
      .get(this.guildId, interaction) as RoleMenuOperationRow | undefined;
    return row ? this.parseRoleMenuOperation(row) : null;
  }

  public reserveRoleMenuOperation(
    input: RoleMenuOperationReservationInput,
  ): RoleMenuOperationReservationResult {
    const normalized = normalizeOperationReservationInput(input, this.guildId);
    let result: RoleMenuOperationReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const existing = this.getRoleMenuOperationByInteraction(
        normalized.interactionId,
      );
      if (existing) {
        if (!sameOperationReservation(existing, normalized)) {
          throw new Error(
            "Interaction ID is already bound to different role-menu work",
          );
        }
        result = { status: "duplicate", operation: existing };
        return;
      }
      const menu = this.getRoleMenuById(normalized.menuId);
      if (!menu) throw new Error("Role menu was not found");
      if (
        menu.state !== "enabled" ||
        menu.definitionVersion !== normalized.definitionVersion ||
        menu.bindingsVerifiedAt === null
      ) {
        throw new Error(
          "Role-menu definition is disabled, stale, or unverified",
        );
      }
      this.trimOperations(MAX_ROLE_MENU_OPERATIONS - 1);
      if (this.countRows("role_menu_operations") >= MAX_ROLE_MENU_OPERATIONS) {
        throw new RangeError(
          "Role-menu operation storage is full while work remains active",
        );
      }
      const operationId = normalized.operationId ?? this.allocateOperationId();
      if (this.getRoleMenuOperationById(operationId)) {
        throw new TypeError("Role-menu operation ID is already in use");
      }
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO role_menu_operations (
             guild_id, operation_id, interaction_id, menu_id, member_id,
             definition_version, selection_key, operation_state,
             failure_code, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?, NULL)`,
        )
        .run(
          this.guildId,
          operationId,
          normalized.interactionId,
          normalized.menuId,
          normalized.memberId,
          normalized.definitionVersion,
          normalized.selectionKey,
          now,
          now,
        );
      const insertItem = this.db.prepare(
        `INSERT INTO role_menu_operation_items (
           guild_id, operation_id, role_id, role_action,
           item_state, failure_code
         ) VALUES (?, ?, ?, ?, 'planned', NULL)`,
      );
      for (const roleId of normalized.plannedAdds) {
        insertItem.run(this.guildId, operationId, roleId, "add");
      }
      for (const roleId of normalized.plannedRemovals) {
        insertItem.run(this.guildId, operationId, roleId, "remove");
      }
      result = {
        status: "reserved",
        operation: this.requireRoleMenuOperation(operationId),
      };
    });
    reserve.immediate();
    return requireResult<RoleMenuOperationReservationResult>(
      result,
      "Role-menu operation reservation",
    );
  }

  public completeRoleMenuOperation(
    operationId: string,
    input: RoleMenuOperationCompletionInput,
  ): RoleMenuOperation {
    const id = requireOpaqueId(operationId, "operation ID");
    const normalized = normalizeOperationCompletionInput(input);
    let result: RoleMenuOperation | null = null;
    const complete = this.db.transaction(() => {
      const current = this.getRoleMenuOperationById(id);
      if (!current) throw new Error("Role-menu operation was not found");
      validateOperationCompletion(current, normalized);
      if (current.state !== "reserved") {
        if (sameOperationCompletion(current, normalized)) {
          result = current;
          return;
        }
        throw new Error("Role-menu operation is already complete");
      }
      const now = utcNow();
      const changed = this.db
        .prepare(
          `UPDATE role_menu_operations
           SET operation_state = ?, failure_code = ?,
               updated_at = ?, completed_at = ?
           WHERE guild_id = ? AND operation_id = ?
             AND operation_state = 'reserved'`,
        )
        .run(
          normalized.state,
          normalized.failureCode,
          now,
          now,
          this.guildId,
          id,
        ).changes;
      if (changed !== 1) throw new Error("Role-menu completion raced");
      this.db
        .prepare(
          `UPDATE role_menu_operation_items
           SET item_state = 'skipped', failure_code = NULL
           WHERE guild_id = ? AND operation_id = ?`,
        )
        .run(this.guildId, id);
      const completeItem = this.db.prepare(
        `UPDATE role_menu_operation_items
         SET item_state = 'completed', failure_code = NULL
         WHERE guild_id = ? AND operation_id = ?
           AND role_id = ? AND role_action = ?`,
      );
      for (const roleId of normalized.addedRoleIds) {
        completeItem.run(this.guildId, id, roleId, "add");
      }
      for (const roleId of normalized.removedRoleIds) {
        completeItem.run(this.guildId, id, roleId, "remove");
      }
      const failItem = this.db.prepare(
        `UPDATE role_menu_operation_items
         SET item_state = 'failed', failure_code = ?
         WHERE guild_id = ? AND operation_id = ? AND role_id = ?`,
      );
      for (const roleId of normalized.failedRoleIds) {
        failItem.run(normalized.failureCode, this.guildId, id, roleId);
      }
      result = this.requireRoleMenuOperation(id);
    });
    complete.immediate();
    return requireResult<RoleMenuOperation>(
      result,
      "Role-menu operation completion",
    );
  }

  public listRoleMenuOperations(
    options: RoleMenuOperationListOptions = {},
  ): RoleMenuOperation[] {
    const clauses = ["guild_id = ?"];
    const parameters: Array<string | number> = [this.guildId];
    if (options.menuId !== undefined) {
      clauses.push("menu_id = ?");
      parameters.push(requireOpaqueId(options.menuId, "menu ID"));
    }
    if (options.memberId !== undefined) {
      clauses.push("member_id = ?");
      parameters.push(assertDiscordSnowflake(options.memberId, "member ID"));
    }
    const states = normalizeEnumList(
      options.states,
      ROLE_OPERATION_STATES,
      "role-menu operation state",
    );
    if (states !== undefined) {
      if (states.length === 0) return [];
      clauses.push(`operation_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    parameters.push(
      normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT),
      normalizeOffset(options.offset ?? 0),
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM role_menu_operations
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, operation_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters) as RoleMenuOperationRow[];
    return rows.map((row) => this.parseRoleMenuOperation(row));
  }

  public invalidateRoleMenuRole(roleId: string): {
    menusChanged: number;
    postsChanged: number;
  } {
    const role = assertDiscordSnowflake(roleId, "role ID");
    let menusChanged = 0;
    let postsChanged = 0;
    const invalidate = this.db.transaction(() => {
      const menuRows = this.db
        .prepare(
          `SELECT DISTINCT menu.menu_id
           FROM role_menus AS menu
           LEFT JOIN role_menu_options AS option
             ON option.guild_id = menu.guild_id AND option.menu_id = menu.menu_id
           WHERE menu.guild_id = ?
             AND (menu.required_role_id = ? OR option.role_id = ?)`,
        )
        .all(this.guildId, role, role) as Array<{ menu_id: string }>;
      if (menuRows.length === 0) return;
      const timestamp = utcNow();
      const disable = this.db.prepare(
        `UPDATE role_menus
         SET menu_state = CASE WHEN menu_state = 'archived' THEN 'archived' ELSE 'disabled' END,
             bindings_verified_at = NULL, updated_at = ?
         WHERE guild_id = ? AND menu_id = ?`,
      );
      const stale = this.db.prepare(
        `UPDATE role_menu_posts
         SET post_state = 'stale', bindings_verified_at = NULL, updated_at = ?
         WHERE guild_id = ? AND menu_id = ? AND post_state <> 'stale'`,
      );
      for (const { menu_id: menuId } of menuRows) {
        menusChanged += disable.run(timestamp, this.guildId, menuId).changes;
        postsChanged += stale.run(timestamp, this.guildId, menuId).changes;
      }
    });
    invalidate.immediate();
    return { menusChanged, postsChanged };
  }

  public markRoleMenuChannelMissing(channelId: string): number {
    const channel = assertDiscordSnowflake(channelId, "channel ID");
    return this.db
      .prepare(
        `UPDATE role_menu_posts
         SET post_state = 'missing', bindings_verified_at = NULL, updated_at = ?
         WHERE guild_id = ? AND channel_id = ? AND post_state <> 'missing'`,
      )
      .run(utcNow(), this.guildId, channel).changes;
  }

  public markRoleMenuMessageMissing(
    channelId: string,
    messageId: string,
  ): number {
    const channel = assertDiscordSnowflake(channelId, "channel ID");
    const message = assertDiscordSnowflake(messageId, "message ID");
    return this.db
      .prepare(
        `UPDATE role_menu_posts
         SET post_state = 'missing', bindings_verified_at = NULL, updated_at = ?
         WHERE guild_id = ? AND channel_id = ? AND message_id = ?
           AND post_state <> 'missing'`,
      )
      .run(utcNow(), this.guildId, channel, message).changes;
  }

  private normalizePostInput(input: RoleMenuPostInput): {
    postId: string | null;
    menuId: string;
    channelId: string;
    messageId: string;
    definitionVersion: number;
    bindingsVerifiedAt: string | null;
    state: RoleMenuPostState;
  } {
    if (!input || typeof input !== "object") {
      throw new TypeError("Role-menu post input is required");
    }
    const menuId = requireOpaqueId(input.menuId, "menu ID");
    const menu = this.getRoleMenuById(menuId);
    if (!menu) throw new Error("Role menu was not found");
    if (menu.state === "archived") {
      throw new Error("Archived role menus cannot be posted or rebound");
    }
    const definitionVersion = normalizeInteger(
      input.definitionVersion,
      1,
      2_147_483_647,
      "post definition version",
    );
    if (definitionVersion > menu.definitionVersion) {
      throw new TypeError(
        "Post definition version is newer than its role menu",
      );
    }
    const state = normalizeRoleMenuPostState(input.state ?? "active");
    const bindingsVerifiedAt = normalizeNullableTimestamp(
      input.bindingsVerifiedAt ?? null,
      "post binding verification time",
    );
    if (state === "active") {
      if (
        bindingsVerifiedAt === null ||
        menu.state !== "enabled" ||
        menu.bindingsVerifiedAt === null ||
        definitionVersion !== menu.definitionVersion
      ) {
        throw new TypeError(
          "An active post requires the current verified enabled menu definition",
        );
      }
    } else if (bindingsVerifiedAt !== null) {
      throw new TypeError("A missing or stale post cannot remain verified");
    }
    return {
      postId:
        input.postId === undefined
          ? null
          : requireOpaqueId(input.postId, "post ID"),
      menuId,
      channelId: assertDiscordSnowflake(input.channelId, "channel ID"),
      messageId: assertDiscordSnowflake(input.messageId, "message ID"),
      definitionVersion,
      bindingsVerifiedAt,
      state,
    };
  }

  private assertMenuCanEnterState(
    menu: RoleMenu,
    state: RoleMenuState,
    bindingsVerifiedAt: string | null,
  ): void {
    if (state !== "enabled") {
      if (bindingsVerifiedAt !== null) {
        throw new TypeError(
          "A disabled or archived role menu cannot be verified",
        );
      }
      return;
    }
    if (bindingsVerifiedAt === null) {
      throw new TypeError("An enabled role menu requires verified bindings");
    }
    const optionCount = this.countRoleMenuOptions(menu.menuId);
    if (optionCount < 1) {
      throw new RangeError(
        "A role menu requires at least one option before enabling",
      );
    }
    if (menu.minSelections > optionCount || menu.maxSelections > optionCount) {
      throw new RangeError(
        "Role-menu selection bounds cannot exceed its option count",
      );
    }
  }

  private requireEditableRoleMenu(menuId: string): RoleMenu {
    const menu = this.getRoleMenuById(menuId);
    if (!menu) throw new Error("Role menu was not found");
    if (menu.state === "archived") {
      throw new Error("Archived role menus cannot be edited");
    }
    return menu;
  }

  private rewriteOptionsWithin(
    menuId: string,
    options: readonly RoleMenuOption[],
    actorId: string,
    now: string,
  ): void {
    if (options.length > MAX_ROLE_MENU_OPTIONS) {
      throw new RangeError("Role-menu options exceed the safety limit");
    }
    this.db
      .prepare(
        "DELETE FROM role_menu_options WHERE guild_id = ? AND menu_id = ?",
      )
      .run(this.guildId, menuId);
    const insert = this.db.prepare(
      `INSERT INTO role_menu_options (
         guild_id, menu_id, option_id, role_id, label, description, emoji,
         sort_order, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    options.forEach((option, sortOrder) => {
      const moved = option.sortOrder !== sortOrder;
      insert.run(
        this.guildId,
        menuId,
        option.optionId,
        option.roleId,
        option.label,
        option.description,
        option.emoji,
        sortOrder,
        option.createdBy,
        moved ? actorId : option.updatedBy,
        option.createdAt,
        moved ? now : option.updatedAt,
      );
    });
  }

  private bumpDefinitionWithin(
    menu: RoleMenu,
    actorId: string,
    now: string,
  ): void {
    if (menu.definitionVersion >= 2_147_483_647) {
      throw new RangeError("Role-menu definition version is exhausted");
    }
    const changed = this.db
      .prepare(
        `UPDATE role_menus
         SET menu_state = 'disabled', definition_version = definition_version + 1,
             bindings_verified_at = NULL, updated_by = ?, updated_at = ?
         WHERE guild_id = ? AND menu_id = ? AND definition_version = ?`,
      )
      .run(
        actorId,
        now,
        this.guildId,
        menu.menuId,
        menu.definitionVersion,
      ).changes;
    if (changed !== 1) throw new Error("Role-menu definition update raced");
    this.markPostsStaleWithin(menu.menuId, now);
  }

  private markPostsStaleWithin(menuId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE role_menu_posts
         SET post_state = 'stale', bindings_verified_at = NULL, updated_at = ?
         WHERE guild_id = ? AND menu_id = ? AND post_state <> 'stale'`,
      )
      .run(now, this.guildId, menuId);
  }

  private makeRoleMenuInsertionSlotWithin(
    sortOrder: number,
    menuCount: number,
    actorId: string,
    now: string,
  ): void {
    const shift = this.db.prepare(
      `UPDATE role_menus
       SET sort_order = ?, updated_by = ?, updated_at = ?
       WHERE guild_id = ? AND sort_order = ?`,
    );
    for (let current = menuCount - 1; current >= sortOrder; current -= 1) {
      if (
        shift.run(current + 1, actorId, now, this.guildId, current).changes !==
        1
      ) {
        throw new Error("Role-menu insertion ordering is inconsistent");
      }
    }
  }

  private moveRoleMenuWithin(
    menuId: string,
    currentSortOrder: number,
    targetSortOrder: number,
    actorId: string,
    now: string,
  ): void {
    if (currentSortOrder === targetSortOrder) return;

    // The schema's unique guild position has no spare integer when all 25
    // slots are occupied. Park the target at a transaction-local fractional
    // value that satisfies the SQL range check, rotate integers one at a time,
    // then restore an integer before this transaction can commit. Startup and
    // backup validation reject any fractional value that could ever persist.
    const parkedSortOrder = 0.5;
    const park = this.db
      .prepare(
        `UPDATE role_menus
         SET sort_order = ?, updated_by = ?, updated_at = ?
         WHERE guild_id = ? AND menu_id = ? AND sort_order = ?`,
      )
      .run(
        parkedSortOrder,
        actorId,
        now,
        this.guildId,
        menuId,
        currentSortOrder,
      ).changes;
    if (park !== 1) throw new Error("Role-menu move ordering is stale");

    const shift = this.db.prepare(
      `UPDATE role_menus
       SET sort_order = ?, updated_by = ?, updated_at = ?
       WHERE guild_id = ? AND sort_order = ?`,
    );
    if (currentSortOrder < targetSortOrder) {
      for (
        let current = currentSortOrder + 1;
        current <= targetSortOrder;
        current += 1
      ) {
        if (
          shift.run(current - 1, actorId, now, this.guildId, current)
            .changes !== 1
        ) {
          throw new Error("Role-menu move ordering is inconsistent");
        }
      }
    } else {
      for (
        let current = currentSortOrder - 1;
        current >= targetSortOrder;
        current -= 1
      ) {
        if (
          shift.run(current + 1, actorId, now, this.guildId, current)
            .changes !== 1
        ) {
          throw new Error("Role-menu move ordering is inconsistent");
        }
      }
    }

    const place = this.db
      .prepare(
        `UPDATE role_menus
         SET sort_order = ?
         WHERE guild_id = ? AND menu_id = ? AND sort_order = ?`,
      )
      .run(targetSortOrder, this.guildId, menuId, parkedSortOrder).changes;
    if (place !== 1) throw new Error("Role-menu move ordering is stale");
  }

  private assertPostCapacity(menuId: string): void {
    if (this.countRows("role_menu_posts") >= MAX_ROLE_MENU_POSTS_PER_GUILD) {
      throw new RangeError(
        `A guild retains at most ${MAX_ROLE_MENU_POSTS_PER_GUILD} role-menu posts`,
      );
    }
    if (this.countRoleMenuPosts(menuId) >= MAX_ROLE_MENU_POSTS_PER_MENU) {
      throw new RangeError(
        `A role menu retains at most ${MAX_ROLE_MENU_POSTS_PER_MENU} posts`,
      );
    }
  }

  private trimOperations(maximum: number): void {
    const count = this.countRows("role_menu_operations");
    const excess = Math.max(0, count - maximum);
    if (excess === 0) return;
    this.db
      .prepare(
        `DELETE FROM role_menu_operations
         WHERE guild_id = ? AND operation_id IN (
           SELECT operation_id FROM role_menu_operations
           WHERE guild_id = ? AND operation_state <> 'reserved'
           ORDER BY updated_at ASC LIMIT ?
         )`,
      )
      .run(this.guildId, this.guildId, excess);
  }

  private parseRoleMenuOperation(row: RoleMenuOperationRow): RoleMenuOperation {
    const items = (
      this.db
        .prepare(
          `SELECT * FROM role_menu_operation_items
           WHERE guild_id = ? AND operation_id = ?
           ORDER BY role_action, role_id LIMIT ?`,
        )
        .all(
          this.guildId,
          row.operation_id,
          MAX_ROLE_MENU_OPTIONS + 1,
        ) as RoleMenuOperationItemRow[]
    ).map(parseRoleMenuOperationItem);
    if (items.length > MAX_ROLE_MENU_OPTIONS) {
      throw new RangeError(
        "Stored role-menu operation items exceed their limit",
      );
    }
    return {
      guildId: row.guild_id,
      operationId: row.operation_id,
      interactionId: row.interaction_id,
      menuId: row.menu_id,
      memberId: row.member_id,
      definitionVersion: row.definition_version,
      selectionKey: row.selection_key,
      state: row.operation_state as RoleOperationState,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      items,
    };
  }

  private countRows(
    table: "role_menus" | "role_menu_posts" | "role_menu_operations",
  ): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`)
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  private requireRoleMenu(menuId: string): RoleMenu {
    const menu = this.getRoleMenuById(menuId);
    if (!menu) throw new Error("Role menu was not persisted");
    return menu;
  }

  private requireRoleMenuOption(
    menuId: string,
    optionId: string,
  ): RoleMenuOption {
    const option = this.getRoleMenuOption(menuId, optionId);
    if (!option) throw new Error("Role-menu option was not persisted");
    return option;
  }

  private requireRoleMenuPost(postId: string): RoleMenuPost {
    const post = this.getRoleMenuPostById(postId);
    if (!post) throw new Error("Role-menu post was not persisted");
    return post;
  }

  private requireRoleMenuOperation(operationId: string): RoleMenuOperation {
    const operation = this.getRoleMenuOperationById(operationId);
    if (!operation) throw new Error("Role-menu operation was not persisted");
    return operation;
  }

  private allocateMenuId(): string {
    return allocateOpaqueId((id) => this.getRoleMenuById(id) !== null);
  }

  private allocateOptionId(menuId: string): string {
    return allocateOpaqueId(
      (id) => this.getRoleMenuOption(menuId, id) !== null,
    );
  }

  private allocatePostId(): string {
    return allocateOpaqueId((id) => this.getRoleMenuPostById(id) !== null);
  }

  private allocateOperationId(): string {
    return allocateOpaqueId((id) => this.getRoleMenuOperationById(id) !== null);
  }
}

function normalizeRoleMenuInput(
  input: RoleMenuInput,
  guildId: string,
): Required<Omit<RoleMenuInput, "menuId" | "sortOrder">> & {
  menuId: string | null;
  sortOrder: number | null;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Role-menu input is required");
  }
  const state = normalizeRoleMenuState(input.state ?? "disabled");
  const mode = normalizeRoleMenuMode(input.mode);
  const minSelections = normalizeInteger(
    input.minSelections,
    0,
    MAX_ROLE_MENU_OPTIONS,
    "minimum selections",
  );
  const maxSelections = normalizeInteger(
    input.maxSelections,
    1,
    MAX_ROLE_MENU_OPTIONS,
    "maximum selections",
  );
  validateSelectionBounds(mode, minSelections, maxSelections);
  const requiredRoleId = normalizeNullableSnowflake(
    input.requiredRoleId ?? null,
    "required role ID",
  );
  if (requiredRoleId === guildId) {
    throw new TypeError(
      "The @everyone role cannot be a role-menu prerequisite",
    );
  }
  const bindingsVerifiedAt = normalizeNullableTimestamp(
    input.bindingsVerifiedAt ?? null,
    "menu binding verification time",
  );
  if ((state === "enabled") !== (bindingsVerifiedAt !== null)) {
    throw new TypeError(
      "Only an enabled role menu may contain verified bindings",
    );
  }
  return {
    menuId:
      input.menuId === undefined
        ? null
        : requireOpaqueId(input.menuId, "menu ID"),
    slug: normalizeSlug(input.slug),
    title: normalizeRoleMenuText(input.title, 1, 256, "role-menu title"),
    description: normalizeRoleMenuText(
      input.description,
      1,
      1_000,
      "role-menu description",
    ),
    sortOrder:
      input.sortOrder === undefined
        ? null
        : normalizeInteger(
            input.sortOrder,
            0,
            MAX_ROLE_MENUS_PER_GUILD - 1,
            "role-menu position",
          ),
    state,
    mode,
    minSelections,
    maxSelections,
    requiredRoleId,
    bindingsVerifiedAt,
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
  };
}

function normalizeMergedRoleMenu(
  current: RoleMenu,
  input: RoleMenuUpdateInput,
  guildId: string,
): {
  slug: string;
  title: string;
  description: string;
  sortOrder: number;
  state: RoleMenuState;
  mode: RoleMenuMode;
  minSelections: number;
  maxSelections: number;
  requiredRoleId: string | null;
  bindingsVerifiedAt: string | null;
} {
  const mode =
    input.mode === undefined ? current.mode : normalizeRoleMenuMode(input.mode);
  const sortOrder =
    input.sortOrder === undefined
      ? current.sortOrder
      : normalizeInteger(
          input.sortOrder,
          0,
          MAX_ROLE_MENUS_PER_GUILD - 1,
          "role-menu position",
        );
  const minSelections =
    input.minSelections === undefined
      ? current.minSelections
      : normalizeInteger(
          input.minSelections,
          0,
          MAX_ROLE_MENU_OPTIONS,
          "minimum selections",
        );
  const maxSelections =
    input.maxSelections === undefined
      ? current.maxSelections
      : normalizeInteger(
          input.maxSelections,
          1,
          MAX_ROLE_MENU_OPTIONS,
          "maximum selections",
        );
  validateSelectionBounds(mode, minSelections, maxSelections);
  const requiredRoleId =
    input.requiredRoleId === undefined
      ? current.requiredRoleId
      : normalizeNullableSnowflake(input.requiredRoleId, "required role ID");
  if (requiredRoleId === guildId) {
    throw new TypeError(
      "The @everyone role cannot be a role-menu prerequisite",
    );
  }
  const state =
    input.state === undefined
      ? current.state
      : normalizeRoleMenuState(input.state);
  let bindingsVerifiedAt =
    input.bindingsVerifiedAt === undefined
      ? current.bindingsVerifiedAt
      : normalizeNullableTimestamp(
          input.bindingsVerifiedAt,
          "menu binding verification time",
        );
  if (state !== "enabled" && input.bindingsVerifiedAt === undefined) {
    bindingsVerifiedAt = null;
  }
  const definitionChanged =
    (input.slug !== undefined && normalizeSlug(input.slug) !== current.slug) ||
    (input.title !== undefined &&
      normalizeRoleMenuText(input.title, 1, 256, "role-menu title") !==
        current.title) ||
    (input.description !== undefined &&
      normalizeRoleMenuText(
        input.description,
        1,
        1_000,
        "role-menu description",
      ) !== current.description) ||
    mode !== current.mode ||
    minSelections !== current.minSelections ||
    maxSelections !== current.maxSelections ||
    requiredRoleId !== current.requiredRoleId;
  if (definitionChanged) bindingsVerifiedAt = null;
  if (
    !definitionChanged &&
    (state === "enabled") !== (bindingsVerifiedAt !== null)
  ) {
    throw new TypeError(
      "Only an enabled role menu may contain verified bindings",
    );
  }
  return {
    slug: input.slug === undefined ? current.slug : normalizeSlug(input.slug),
    title:
      input.title === undefined
        ? current.title
        : normalizeRoleMenuText(input.title, 1, 256, "role-menu title"),
    description:
      input.description === undefined
        ? current.description
        : normalizeRoleMenuText(
            input.description,
            1,
            1_000,
            "role-menu description",
          ),
    sortOrder,
    state: definitionChanged ? "disabled" : state,
    mode,
    minSelections,
    maxSelections,
    requiredRoleId,
    bindingsVerifiedAt,
  };
}

function normalizeRoleMenuOptionInput(
  input: RoleMenuOptionInput,
  defaultSortOrder: number,
  maximumSortOrder: number,
  guildId: string,
): Required<Omit<RoleMenuOptionInput, "optionId">> & {
  optionId: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Role-menu option input is required");
  }
  const roleId = assertDiscordSnowflake(input.roleId, "option role ID");
  if (roleId === guildId) {
    throw new TypeError("The @everyone role cannot be self-service");
  }
  return {
    optionId:
      input.optionId === undefined
        ? null
        : requireOpaqueId(input.optionId, "option ID"),
    roleId,
    label: normalizeRoleMenuText(input.label, 1, 100, "option label"),
    description:
      input.description == null
        ? null
        : normalizeRoleMenuText(
            input.description,
            1,
            100,
            "option description",
          ),
    emoji: normalizeOptionalUnicodeEmoji(input.emoji, "Option emoji"),
    sortOrder: normalizeInteger(
      input.sortOrder ?? defaultSortOrder,
      0,
      maximumSortOrder,
      "option sort order",
    ),
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
  };
}

function normalizeMergedRoleMenuOption(
  current: RoleMenuOption,
  input: RoleMenuOptionUpdateInput,
  optionCount: number,
  guildId: string,
): {
  roleId: string;
  label: string;
  description: string | null;
  emoji: string | null;
  sortOrder: number;
} {
  const roleId =
    input.roleId === undefined
      ? current.roleId
      : assertDiscordSnowflake(input.roleId, "option role ID");
  if (roleId === guildId) {
    throw new TypeError("The @everyone role cannot be self-service");
  }
  return {
    roleId,
    label:
      input.label === undefined
        ? current.label
        : normalizeRoleMenuText(input.label, 1, 100, "option label"),
    description:
      input.description === undefined
        ? current.description
        : input.description === null
          ? null
          : normalizeRoleMenuText(
              input.description,
              1,
              100,
              "option description",
            ),
    emoji:
      input.emoji === undefined
        ? current.emoji
        : normalizeOptionalUnicodeEmoji(input.emoji, "Option emoji"),
    sortOrder:
      input.sortOrder === undefined
        ? current.sortOrder
        : normalizeInteger(
            input.sortOrder,
            0,
            optionCount - 1,
            "option sort order",
          ),
  };
}

function normalizeOperationReservationInput(
  input: RoleMenuOperationReservationInput,
  guildId: string,
): {
  operationId: string | null;
  interactionId: string;
  menuId: string;
  memberId: string;
  definitionVersion: number;
  selectionKey: string;
  plannedAdds: string[];
  plannedRemovals: string[];
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Role-menu operation reservation input is required");
  }
  const plannedAdds = normalizeRoleIdList(
    input.plannedAdds ?? [],
    "planned additions",
    guildId,
  );
  const plannedRemovals = normalizeRoleIdList(
    input.plannedRemovals ?? [],
    "planned removals",
    guildId,
  );
  if (plannedAdds.length + plannedRemovals.length > MAX_ROLE_MENU_OPTIONS) {
    throw new RangeError(
      `A role-menu operation may contain at most ${MAX_ROLE_MENU_OPTIONS} changes`,
    );
  }
  if (plannedAdds.some((roleId) => plannedRemovals.includes(roleId))) {
    throw new TypeError("A role cannot be both added and removed");
  }
  return {
    operationId:
      input.operationId === undefined
        ? null
        : requireOpaqueId(input.operationId, "operation ID"),
    interactionId: assertDiscordSnowflake(
      input.interactionId,
      "interaction ID",
    ),
    menuId: requireOpaqueId(input.menuId, "menu ID"),
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    definitionVersion: normalizeInteger(
      input.definitionVersion,
      1,
      2_147_483_647,
      "operation definition version",
    ),
    selectionKey: normalizeSelectionKey(input.selectionKey),
    plannedAdds,
    plannedRemovals,
  };
}

function normalizeOperationCompletionInput(
  input: RoleMenuOperationCompletionInput,
): RoleMenuOperationCompletionInput & { failureCode: string | null } {
  if (!input || typeof input !== "object") {
    throw new TypeError("Role-menu operation completion input is required");
  }
  const state = normalizeEnum(
    input.state,
    ROLE_OPERATION_STATES.filter(
      (candidate): candidate is Exclude<RoleOperationState, "reserved"> =>
        candidate !== "reserved",
    ),
    "role-menu operation completion state",
  );
  const addedRoleIds = normalizeRoleIdList(
    input.addedRoleIds,
    "added role IDs",
  );
  const removedRoleIds = normalizeRoleIdList(
    input.removedRoleIds,
    "removed role IDs",
  );
  const failedRoleIds = normalizeRoleIdList(
    input.failedRoleIds,
    "failed role IDs",
  );
  const skippedRoleIds = normalizeRoleIdList(
    input.skippedRoleIds,
    "skipped role IDs",
  );
  const all = [
    ...addedRoleIds,
    ...removedRoleIds,
    ...failedRoleIds,
    ...skippedRoleIds,
  ];
  if (new Set(all).size !== all.length) {
    throw new TypeError("Completion role outcomes must be disjoint");
  }
  const failureCode = normalizeNullableShortText(
    input.failureCode ?? null,
    "role-menu failure code",
  );
  const successes = addedRoleIds.length + removedRoleIds.length;
  if (state === "completed" && failedRoleIds.length > 0) {
    throw new TypeError(
      "A completed role-menu operation cannot contain failures",
    );
  }
  if (state === "no-change" && all.length > 0) {
    throw new TypeError("A no-change operation cannot contain role outcomes");
  }
  const incomplete = failedRoleIds.length + skippedRoleIds.length;
  if (state === "failed" && (successes > 0 || incomplete === 0)) {
    throw new TypeError(
      "A failed operation requires incomplete work and no successes",
    );
  }
  if (state === "partial" && (successes === 0 || incomplete === 0)) {
    throw new TypeError(
      "A partial operation requires successes and incomplete work",
    );
  }
  if ((state === "failed" || state === "partial") && failureCode === null) {
    throw new TypeError(
      "Failed or partial role-menu work needs a failure code",
    );
  }
  if (
    (state === "completed" || state === "no-change") &&
    failureCode !== null
  ) {
    throw new TypeError(
      "Successful role-menu work cannot retain a failure code",
    );
  }
  return {
    state,
    addedRoleIds,
    removedRoleIds,
    failedRoleIds,
    skippedRoleIds,
    failureCode,
  };
}

function validateOperationCompletion(
  operation: RoleMenuOperation,
  input: ReturnType<typeof normalizeOperationCompletionInput>,
): void {
  const plannedAdds = new Set(
    operation.items
      .filter((item) => item.action === "add")
      .map((item) => item.roleId),
  );
  const plannedRemovals = new Set(
    operation.items
      .filter((item) => item.action === "remove")
      .map((item) => item.roleId),
  );
  const planned = new Set([...plannedAdds, ...plannedRemovals]);
  if (input.addedRoleIds.some((roleId) => !plannedAdds.has(roleId))) {
    throw new TypeError("Added role was not part of the reserved plan");
  }
  if (input.removedRoleIds.some((roleId) => !plannedRemovals.has(roleId))) {
    throw new TypeError("Removed role was not part of the reserved plan");
  }
  if (input.failedRoleIds.some((roleId) => !planned.has(roleId))) {
    throw new TypeError("Failed role was not part of the reserved plan");
  }
  if (input.skippedRoleIds.some((roleId) => !planned.has(roleId))) {
    throw new TypeError("Skipped role was not part of the reserved plan");
  }
  const accountedCount =
    input.addedRoleIds.length +
    input.removedRoleIds.length +
    input.failedRoleIds.length +
    input.skippedRoleIds.length;
  if (accountedCount !== operation.items.length) {
    throw new TypeError(
      "Role-menu completion must account for every planned role change",
    );
  }
  if (
    input.state === "completed" &&
    (operation.items.length === 0 ||
      input.addedRoleIds.length + input.removedRoleIds.length !==
        operation.items.length)
  ) {
    throw new TypeError(
      "Completed work must confirm every planned role change and cannot be empty",
    );
  }
  if (input.state === "no-change" && operation.items.length !== 0) {
    throw new TypeError("No-change completion requires an empty mutation plan");
  }
}

function sameOperationReservation(
  operation: RoleMenuOperation,
  input: ReturnType<typeof normalizeOperationReservationInput>,
): boolean {
  const adds = operation.items
    .filter((item) => item.action === "add")
    .map((item) => item.roleId);
  const removals = operation.items
    .filter((item) => item.action === "remove")
    .map((item) => item.roleId);
  return (
    operation.menuId === input.menuId &&
    operation.memberId === input.memberId &&
    operation.definitionVersion === input.definitionVersion &&
    operation.selectionKey === input.selectionKey &&
    sameIdSet(adds, input.plannedAdds) &&
    sameIdSet(removals, input.plannedRemovals)
  );
}

function sameOperationCompletion(
  operation: RoleMenuOperation,
  input: ReturnType<typeof normalizeOperationCompletionInput>,
): boolean {
  const completedAdds = operation.items
    .filter((item) => item.action === "add" && item.state === "completed")
    .map((item) => item.roleId);
  const completedRemovals = operation.items
    .filter((item) => item.action === "remove" && item.state === "completed")
    .map((item) => item.roleId);
  const failed = operation.items
    .filter((item) => item.state === "failed")
    .map((item) => item.roleId);
  const skipped = operation.items
    .filter((item) => item.state === "skipped")
    .map((item) => item.roleId);
  return (
    operation.state === input.state &&
    operation.failureCode === input.failureCode &&
    sameIdSet(completedAdds, input.addedRoleIds) &&
    sameIdSet(completedRemovals, input.removedRoleIds) &&
    sameIdSet(failed, input.failedRoleIds) &&
    sameIdSet(skipped, input.skippedRoleIds)
  );
}

function parseRoleMenu(row: RoleMenuRow): RoleMenu {
  return {
    guildId: row.guild_id,
    menuId: row.menu_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    state: row.menu_state as RoleMenuState,
    mode: row.selection_mode as RoleMenuMode,
    minSelections: row.min_selections,
    maxSelections: row.max_selections,
    requiredRoleId: row.required_role_id,
    definitionVersion: row.definition_version,
    bindingsVerifiedAt: row.bindings_verified_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRoleMenuOption(row: RoleMenuOptionRow): RoleMenuOption {
  return {
    guildId: row.guild_id,
    menuId: row.menu_id,
    optionId: row.option_id,
    roleId: row.role_id,
    label: row.label,
    description: row.description,
    emoji: row.emoji,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRoleMenuPost(row: RoleMenuPostRow): RoleMenuPost {
  return {
    guildId: row.guild_id,
    postId: row.post_id,
    menuId: row.menu_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    definitionVersion: row.definition_version,
    bindingsVerifiedAt: row.bindings_verified_at,
    state: row.post_state as RoleMenuPostState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRoleMenuOperationItem(
  row: RoleMenuOperationItemRow,
): RoleMenuOperationItem {
  return {
    guildId: row.guild_id,
    operationId: row.operation_id,
    roleId: row.role_id,
    action: row.role_action as RoleMenuOperationItem["action"],
    state: row.item_state as RoleMenuOperationItem["state"],
    failureCode: row.failure_code,
  };
}

function sameRoleMenuDefinition(
  current: RoleMenu,
  next: ReturnType<typeof normalizeMergedRoleMenu>,
): boolean {
  return (
    current.slug === next.slug &&
    current.title === next.title &&
    current.description === next.description &&
    current.mode === next.mode &&
    current.minSelections === next.minSelections &&
    current.maxSelections === next.maxSelections &&
    current.requiredRoleId === next.requiredRoleId
  );
}

function sameRoleMenuOption(
  current: RoleMenuOption,
  next: ReturnType<typeof normalizeMergedRoleMenuOption>,
): boolean {
  return (
    current.roleId === next.roleId &&
    current.label === next.label &&
    current.description === next.description &&
    current.emoji === next.emoji &&
    current.sortOrder === next.sortOrder
  );
}

function validateSelectionBounds(
  mode: RoleMenuMode,
  minimum: number,
  maximum: number,
): void {
  if (minimum > maximum) {
    throw new RangeError("Minimum selections cannot exceed maximum selections");
  }
  if (mode === "exclusive" && maximum !== 1) {
    throw new RangeError("Exclusive role menus must have a maximum of one");
  }
}

function normalizeRoleMenuState(value: unknown): RoleMenuState {
  return normalizeEnum(value, ROLE_MENU_STATES, "role-menu state");
}

function normalizeRoleMenuMode(value: unknown): RoleMenuMode {
  return normalizeEnum(value, ROLE_MENU_MODES, "role-menu mode");
}

function normalizeRoleMenuPostState(value: unknown): RoleMenuPostState {
  return normalizeEnum(value, ROLE_MENU_POST_STATES, "role-menu post state");
}

function normalizeEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value as string)) {
    throw new TypeError(`Unsupported ${label}: ${String(value)}`);
  }
  return value as T[number];
}

function normalizeEnumList<const T extends readonly string[]>(
  values: readonly T[number][] | undefined,
  allowed: T,
  label: string,
): T[number][] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values))
    throw new TypeError(`${label} filter must be an array`);
  return [...new Set(values)].map((value) =>
    normalizeEnum(value, allowed, label),
  );
}

function normalizeSlug(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("Role-menu slug must be text");
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > 50 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)
  ) {
    throw new RangeError(
      "Role-menu slug must be 1-50 lowercase letters, numbers, or interior hyphens",
    );
  }
  return normalized;
}

function normalizeRoleIdList(
  values: readonly string[],
  label: string,
  guildId?: string,
): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (values.length > MAX_ROLE_MENU_OPTIONS) {
    throw new RangeError(
      `${label} cannot exceed ${MAX_ROLE_MENU_OPTIONS} roles`,
    );
  }
  const normalized = values.map((value) =>
    assertDiscordSnowflake(value, "role ID"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  if (guildId !== undefined && normalized.includes(guildId)) {
    throw new TypeError("The @everyone role cannot be changed by a role menu");
  }
  return normalized;
}

function normalizeOpaqueIdOrder(
  values: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(values))
    throw new TypeError(`${label} order must be an array`);
  if (values.length > MAX_ROLE_MENU_OPTIONS) {
    throw new RangeError(
      `${label} order exceeds ${MAX_ROLE_MENU_OPTIONS} values`,
    );
  }
  const normalized = values.map((value) => requireOpaqueId(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} order must not contain duplicates`);
  }
  return normalized;
}

function normalizeSelectionKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Role-menu selection key must be text");
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) return "-";
  if (normalized.length > MAX_ROLE_MENU_SELECTION_KEY_LENGTH) {
    throw new RangeError(
      `Role-menu selection key cannot exceed ${MAX_ROLE_MENU_SELECTION_KEY_LENGTH} characters`,
    );
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new TypeError("Role-menu selection key contains control characters");
  }
  return normalized;
}

function normalizeNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return assertDiscordSnowflake(value, label);
}

function normalizeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeNullableTimestamp(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeNullableShortText(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : normalizeRoleMenuText(value, 1, 100, label);
}

function normalizeListLimit(value: number, maximum = MAX_LIST_LIMIT): number {
  return normalizeInteger(value, 1, maximum, "list limit");
}

function normalizeOffset(value: number): number {
  return normalizeInteger(value, 0, 2_147_483_647, "list offset");
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 24 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function normalizeOpaqueId(value: unknown): string | null {
  return isOpaqueId(value) ? value : null;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = normalizeOpaqueId(value);
  if (!normalized) {
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  }
  return normalized;
}

function allocateOpaqueId(exists: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createOpaqueStorageId();
    if (!exists(id)) return id;
  }
  throw new Error("Unable to allocate a unique opaque storage ID");
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} completed without a result`);
  return value;
}

function requireDefinedResult<T>(
  value: T | null | undefined,
  label: string,
): T | null {
  if (value === undefined)
    throw new Error(`${label} completed without a result`);
  return value;
}
