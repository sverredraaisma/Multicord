// Runs in Discord's main world (via contextBridge.executeInMainWorld), where
// its webpack modules and Flux stores live. The function is serialized, so it
// must not reference anything outside its own body.
//
// It only reads stores and never dispatches actions, so Discord sees nothing
// but its own client's traffic. Output goes to the isolated preload as a JSON
// string on a DOM event, where it is validated again.

export function discordStoreBridge(eventName: string, retryMs: number, maxAttempts: number): void {
  const w = window as any;
  const DISCORD_EPOCH = 1420070400000n;
  const MAX_DMS = 200;
  const MAX_GUILDS = 1000;
  const MAX_TITLE = 200;
  const DEBOUNCE_MS = 250;
  let stores: Record<string, any> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const getRequire = (): any => {
    const chunks = w.webpackChunkdiscord_app;
    if (!chunks || typeof chunks.push !== "function") return undefined;
    let req: any;
    const marker = [Symbol("multicord")];
    chunks.push([marker, {}, (r: any) => (req = r)]);
    if (chunks[chunks.length - 1]?.[0] === marker) chunks.pop();
    return req;
  };

  const findStores = (required: string[], optional: string[]): Record<string, any> | undefined => {
    const names = [...required, ...optional];
    const req = getRequire();
    if (!req?.c) return undefined;
    const found: Record<string, any> = {};
    for (const mod of Object.values<any>(req.c)) {
      const exports = mod?.exports;
      if (!exports || typeof exports !== "object") continue;
      for (const candidate of [exports, ...Object.values<any>(exports)]) {
        if (!candidate || typeof candidate.getName !== "function") continue;
        try {
          const name = candidate.getName();
          if (names.includes(name) && !found[name]) found[name] = candidate;
        } catch {
          // Not a store.
        }
      }
    }
    return required.every((n) => found[n]) ? found : undefined;
  };

  const absolute = (url: unknown): string | undefined => {
    if (typeof url !== "string" || url === "") return undefined;
    try {
      const resolved = new URL(url, w.location.origin);
      return resolved.protocol === "https:" ? resolved.href : undefined;
    } catch {
      return undefined;
    }
  };

  const timestamp = (id: unknown): number => {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return 0;
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  };

  const userName = (user: any): string => user?.globalName || user?.username || "Unknown user";

  const describe = (channel: any): { title: string; avatarUrl?: string } => {
    const { UserStore } = stores!;
    const recipients: string[] = Array.isArray(channel.recipients) ? channel.recipients : [];
    const users = recipients.map((id) => UserStore.getUser(id));
    if (channel.type === 3) {
      const title = channel.name || users.map(userName).join(", ") || "Group DM";
      const avatarUrl = channel.icon
        ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png?size=64`
        : undefined;
      return { title, avatarUrl };
    }
    const user = users[0];
    return { title: userName(user), avatarUrl: absolute(user?.getAvatarURL?.(undefined, 64)) };
  };

  const collectDms = () => {
    const { ChannelStore, ReadStateStore } = stores!;
    const channels: any[] =
      ChannelStore.getSortedPrivateChannels?.() ?? Object.values(ChannelStore.getMutablePrivateChannels?.() ?? {});
    return channels
      .filter((c) => c && typeof c.id === "string" && (c.type === 1 || c.type === 3))
      .map((c) => {
        const { title, avatarUrl } = describe(c);
        const mentions = Number(ReadStateStore.getMentionCount(c.id)) || 0;
        return {
          id: c.id,
          title: String(title).slice(0, MAX_TITLE),
          avatarUrl,
          unread: mentions > 0 || Boolean(ReadStateStore.hasUnread(c.id)),
          mentions,
          lastActivity: timestamp(c.lastMessageId),
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, MAX_DMS);
  };

  // Names and icons, plus read state when GuildReadStateStore offers it.
  const collectGuilds = () => {
    const { GuildStore, GuildReadStateStore } = stores!;
    if (!GuildStore) return [];
    try {
      return Object.values<any>(GuildStore.getGuilds?.() ?? {})
        .filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
        .slice(0, MAX_GUILDS)
        .map((g) => {
          const unread = GuildReadStateStore?.hasUnread?.(g.id);
          const mentions = GuildReadStateStore?.getMentionCount?.(g.id);
          return {
            id: g.id,
            name: g.name.slice(0, MAX_TITLE),
            iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : undefined,
            unread: typeof unread === "boolean" ? unread : undefined,
            mentions: Number.isInteger(mentions) && mentions >= 0 ? mentions : undefined,
          };
        });
    } catch {
      return [];
    }
  };

  const hexColor = (color: unknown): string | undefined =>
    typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xffffff
      ? `#${color.toString(16).padStart(6, "0")}`
      : undefined;

  // The guild bar's slots in order: folders with their guilds, and lone guilds.
  const collectLayout = () => {
    const { SortedGuildStore, ExpandedGuildFolderStore } = stores!;
    if (!SortedGuildStore) return undefined;
    try {
      const folders: any[] = SortedGuildStore.getGuildFolders?.() ?? [];
      return folders
        .filter((f) => f && Array.isArray(f.guildIds))
        .slice(0, MAX_GUILDS)
        .map((f) => {
          const guildIds = f.guildIds.filter((id: unknown) => typeof id === "string" && /^\d{1,20}$/.test(id));
          const folderId = f.folderId == null ? "" : String(f.folderId);
          if (!/^\d{1,20}$/.test(folderId)) return { guildIds };
          const expanded = ExpandedGuildFolderStore?.isFolderExpanded?.(f.folderId);
          return {
            folderId,
            name: typeof f.folderName === "string" ? f.folderName.slice(0, MAX_TITLE) : undefined,
            color: hexColor(f.folderColor),
            expanded: typeof expanded === "boolean" ? expanded : undefined,
            guildIds,
          };
        });
    } catch {
      return undefined;
    }
  };

  // Calls ringing us: CallStore lists active calls with the users being rung.
  const collectCalls = () => {
    const { CallStore, ChannelStore, UserStore } = stores!;
    try {
      const me = UserStore.getCurrentUser?.()?.id;
      if (!CallStore || typeof me !== "string") return [];
      const calls: any[] = CallStore.getCalls?.() ?? [];
      return calls
        .filter((call) => call && /^\d{1,20}$/.test(String(call.channelId)) && Array.isArray(call.ringing) && call.ringing.includes(me))
        .slice(0, 20)
        .map((call) => {
          const channel = ChannelStore.getChannel?.(call.channelId);
          return { channelId: String(call.channelId), from: String(channel ? describe(channel).title : "Someone").slice(0, MAX_TITLE) };
        });
    } catch {
      return [];
    }
  };

  // Who is signed in, for the settings page; null on Discord's login screen.
  const currentUser = () => {
    try {
      const me = stores!.UserStore.getCurrentUser?.();
      return me ? { name: String(userName(me)).slice(0, MAX_TITLE) } : null;
    } catch {
      return undefined;
    }
  };

  const emit = (): void => {
    timer = undefined;
    try {
      const payload = { dms: collectDms(), guilds: collectGuilds(), layout: collectLayout(), user: currentUser(), calls: collectCalls(), stores: Object.keys(stores!) };
      document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(payload) }));
    } catch {
      // A store changed shape; the rail keeps its last good state.
    }
  };

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(emit, DEBOUNCE_MS);
  };

  let attempts = 0;
  const attach = (): void => {
    attempts++;
    try {
      stores = findStores(
        ["ChannelStore", "ReadStateStore", "UserStore"],
        ["GuildStore", "GuildReadStateStore", "SortedGuildStore", "ExpandedGuildFolderStore", "CallStore"],
      );
    } catch {
      stores = undefined;
    }
    if (!stores) {
      if (attempts < maxAttempts) setTimeout(attach, retryMs);
      return;
    }
    for (const store of Object.values(stores)) store.addChangeListener?.(schedule);
    emit();
  };

  attach();
}
