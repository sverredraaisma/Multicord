// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIDE_GUILD_BAR_CSS,
  STYLE_ID,
  injectStyle,
  navigate,
  parseGuildLabel,
  readGuilds,
  readState,
  targetPath,
} from "../../src/preload/discord/dom";

function guildBar(html: string): void {
  document.body.innerHTML = `<nav class="guilds_abc">${html}</nav>`;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("injectStyle", () => {
  it("adds the guild bar CSS once", () => {
    injectStyle(document);
    injectStyle(document);
    const styles = document.querySelectorAll(`#${STYLE_ID}`);
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(HIDE_GUILD_BAR_CSS);
    expect(styles[0]!.parentElement).toBe(document.head);
  });

  it("falls back to the document element without a head", () => {
    const doc = document.implementation.createDocument(null, "html", null);
    injectStyle(doc);
    expect(doc.documentElement.querySelector("style")).not.toBeNull();
  });
});

describe("parseGuildLabel", () => {
  it.each([
    ["My Server", { name: "My Server", unread: false, mentions: 0 }],
    ["unread, My Server", { name: "My Server", unread: true, mentions: 0 }],
    ["1 mention, My Server", { name: "My Server", unread: true, mentions: 1 }],
    ["unread, 4 mentions, My Server", { name: "My Server", unread: true, mentions: 4 }],
    ["", { name: "", unread: false, mentions: 0 }],
  ])("parses %j", (label, expected) => {
    expect(parseGuildLabel(label)).toEqual(expected);
  });
});

describe("readGuilds", () => {
  it("reads guild items and skips non-guild and duplicate entries", () => {
    guildBar(`
      <div data-list-item-id="guildsnav___home" aria-label="Direct Messages"></div>
      <div class="listItem_x">
        <div data-list-item-id="guildsnav___111" aria-label="unread, Alpha">
          <img src="https://cdn.discordapp.com/icons/111/a.png">
        </div>
      </div>
      <div class="listItem_y">
        <div data-list-item-id="guildsnav___222" aria-label="Beta"><img src="data:image/png;base64,AA"></div>
        <div class="numberBadge_z">7</div>
      </div>
      <div data-list-item-id="guildsnav___333"></div>
      <div data-list-item-id="guildsnav___111" aria-label="Alpha again"></div>
      <div data-list-item-id="guildsnav___create-join-button"></div>
    `);
    expect(readGuilds(document)).toEqual([
      { id: "111", name: "Alpha", iconUrl: "https://cdn.discordapp.com/icons/111/a.png", unread: true, mentions: 0 },
      { id: "222", name: "Beta", iconUrl: undefined, unread: true, mentions: 7 },
      { id: "333", name: "333", iconUrl: undefined, unread: false, mentions: 0 },
    ]);
  });

  it("ignores badges that are not numbers", () => {
    guildBar(`<div class="listItem_a"><div data-list-item-id="guildsnav___9" aria-label="G"></div><div class="numberBadge_b">!</div></div>`);
    expect(readGuilds(document)[0]!.mentions).toBe(0);
  });

  it("combines guilds with the title badge", () => {
    guildBar(`<div data-list-item-id="guildsnav___5" aria-label="Five"></div>`);
    document.title = "(2) Discord";
    expect(readState(document)).toEqual({
      guilds: [{ id: "5", name: "Five", iconUrl: undefined, unread: false, mentions: 0 }],
      badge: { unread: true, mentions: 2 },
    });
  });
});

describe("navigate", () => {
  it("maps targets to routes", () => {
    expect(targetPath("home")).toBe("/channels/@me");
    expect(targetPath("42")).toBe("/channels/42");
  });

  it("clicks the hidden guild item when present", () => {
    guildBar(`<div data-list-item-id="guildsnav___42"></div>`);
    const item = document.querySelector<HTMLElement>('[data-list-item-id="guildsnav___42"]')!;
    const click = vi.fn();
    item.addEventListener("click", click);
    expect(navigate(document, window, "42")).toBe("click");
    expect(click).toHaveBeenCalledOnce();
  });

  it("falls back to pushState plus popstate", () => {
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    expect(navigate(document, window, "home")).toBe("history");
    expect(window.location.pathname).toBe("/channels/@me");
    expect(popstate).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", popstate);
  });
});

describe("DM support", () => {
  it("excludes known DM channels from the guild list", () => {
    guildBar(`
      <div data-list-item-id="guildsnav___111" aria-label="Guild"></div>
      <div data-list-item-id="guildsnav___999" aria-label="2 mentions, Ana"></div>
    `);
    expect(readGuilds(document, new Set(["999"])).map((g) => g.id)).toEqual(["111"]);
    const dm = { id: "999", title: "Ana", unread: true, mentions: 2, lastActivity: 1 };
    const state = readState(document, { dms: [dm], guilds: [] });
    expect(state.guilds.map((g) => g.id)).toEqual(["111"]);
    expect(state.dms).toEqual([dm]);
    expect(readState(document)).not.toHaveProperty("dms");
  });

  it("maps DM targets to their route", () => {
    expect(targetPath("dm:55")).toBe("/channels/@me/55");
  });

  it("prefers a link to the route, then the guild bar blob", () => {
    document.body.innerHTML = `
      <a href="/channels/@me/55">Ana</a>
      <nav class="guilds_a"><div data-list-item-id="guildsnav___55"></div><div data-list-item-id="guildsnav___66"></div></nav>`;
    const link = vi.fn((e: Event) => e.preventDefault());
    document.querySelector("a")!.addEventListener("click", link);
    const blob = vi.fn();
    document.querySelector('[data-list-item-id="guildsnav___66"]')!.addEventListener("click", blob);

    expect(navigate(document, window, "dm:55")).toBe("click");
    expect(link).toHaveBeenCalledOnce();
    expect(navigate(document, window, "dm:66")).toBe("click");
    expect(blob).toHaveBeenCalledOnce();
    expect(navigate(document, window, "dm:77")).toBe("history");
    expect(window.location.pathname).toBe("/channels/@me/77");
  });
});

describe("guild names", () => {
  // Regression: items without an aria-label showed their id instead of a name.
  it("names unlabelled items from GuildStore data", () => {
    guildBar(`<div class="listItem_a"><div data-list-item-id="guildsnav___111"></div></div>`);
    const guilds = readGuilds(
      document,
      new Set(),
      new Map([["111", { id: "111", name: "Gaming Club", iconUrl: "https://cdn/icons/111.png" }]]),
    );
    expect(guilds).toEqual([
      { id: "111", name: "Gaming Club", iconUrl: "https://cdn/icons/111.png", unread: false, mentions: 0 },
    ]);
  });

  it("prefers the store name but keeps unread state and the icon from the DOM", () => {
    guildBar(`<div data-list-item-id="guildsnav___111" aria-label="unread, Old Name"><img src="https://cdn/dom.png"></div>`);
    const state = readState(document, { dms: [], guilds: [{ id: "111", name: "New Name", iconUrl: "https://cdn/store.png" }] });
    expect(state.guilds).toEqual([
      { id: "111", name: "New Name", iconUrl: "https://cdn/dom.png", unread: true, mentions: 0 },
    ]);
  });

  it.each([
    ["a labelled child", `<div data-list-item-id="guildsnav___1"><div aria-label="2 mentions, Child Label"></div></div>`, "Child Label", 2],
    ["visually hidden text", `<div data-list-item-id="guildsnav___1"><span class="hiddenVisually_x">Hidden Name</span></div>`, "Hidden Name", 0],
    ["the drag-and-drop wrapper", `<div data-dnd-name="Dnd Name"><div data-list-item-id="guildsnav___1"></div></div>`, "Dnd Name", 0],
    ["a drag-and-drop child", `<div data-list-item-id="guildsnav___1"><div data-dnd-name="Inner Dnd"></div></div>`, "Inner Dnd", 0],
    ["the icon alt text", `<div data-list-item-id="guildsnav___1"><img alt="Alt Name" src="data:x"></div>`, "Alt Name", 0],
    ["nothing at all", `<div data-list-item-id="guildsnav___1" aria-label="  "></div>`, "1", 0],
  ])("falls back to %s", (_case, html, name, mentions) => {
    guildBar(html);
    expect(readGuilds(document)[0]).toMatchObject({ name, mentions });
  });
});

describe("folders", () => {
  const info = [
    { id: "1", name: "Lone", iconUrl: "https://cdn/1.png" },
    { id: "2", name: "Alpha", iconUrl: "https://cdn/2.png" },
    { id: "3", name: "Beta", unread: true, mentions: 4 },
    { id: "4", name: "Gamma", iconUrl: "https://cdn/4.png" },
  ];

  describe("from the store layout", () => {
    it("nests rendered guilds under an expanded folder", () => {
      guildBar(`
        <div data-list-item-id="guildsnav___1"></div>
        <div data-list-item-id="guildsnav___50" aria-expanded="true"></div>
        <ul id="folder-items-50">
          <div data-list-item-id="guildsnav___2" aria-label="unread, Alpha"></div>
          <div data-list-item-id="guildsnav___3"></div>
        </ul>`);
      const state = readState(document, {
        dms: [],
        guilds: info,
        layout: [{ guildIds: ["1"] }, { folderId: "50", name: "Games", color: "#ff0000", guildIds: ["2", "3"] }],
      });
      expect(state.guilds.map((g) => [g.id, g.folderId])).toEqual([["1", undefined], ["2", "50"], ["3", "50"]]);
      expect(state.guilds[1]).toMatchObject({ name: "Alpha", unread: true });
      expect(state.folders).toEqual([
        {
          id: "50",
          name: "Games",
          color: "#ff0000",
          expanded: true,
          unread: true,
          mentions: 0,
          iconUrls: ["https://cdn/2.png"],
          index: 1,
        },
      ]);
    });

    it("keeps collapsed folders' guilds out of the bar but in the badge and preview", () => {
      guildBar(`<div data-list-item-id="guildsnav___50" aria-expanded="false"><img src="https://cdn/mini.png"></div>`);
      const state = readState(document, {
        dms: [],
        guilds: info,
        layout: [{ folderId: "50", guildIds: ["2", "3", "4"] }],
      });
      expect(state.guilds).toEqual([]);
      expect(state.folders).toEqual([
        {
          id: "50",
          name: "Alpha, Beta, Gamma",
          expanded: false,
          unread: true,
          mentions: 4,
          iconUrls: ["https://cdn/2.png", "https://cdn/4.png"],
          index: 0,
        },
      ]);
    });

    it("prefers the store's expanded flag, else falls back to rendered children", () => {
      guildBar(`<div data-list-item-id="guildsnav___3"></div>`);
      const expanded = (layout: Parameters<typeof readState>[1]) => readState(document, layout).folders![0]!.expanded;
      expect(expanded({ dms: [], guilds: info, layout: [{ folderId: "50", expanded: false, guildIds: ["3"] }] })).toBe(false);
      expect(expanded({ dms: [], guilds: info, layout: [{ folderId: "50", guildIds: ["3"] }] })).toBe(true);
      expect(expanded({ dms: [], guilds: info, layout: [{ folderId: "50", guildIds: ["9"] }] })).toBe(false);
    });

    it("names guilds it knows nothing about by id and uses the header for empty folders", () => {
      guildBar(`<div data-list-item-id="guildsnav___50"><div aria-expanded="false" aria-label="2 mentions, Header Name"></div></div>`);
      const state = readState(document, { dms: [], guilds: [], layout: [{ guildIds: ["8"] }, { folderId: "50", guildIds: [] }] });
      expect(state.guilds).toEqual([{ id: "8", name: "8", iconUrl: undefined, unread: false, mentions: 0 }]);
      expect(state.folders![0]).toMatchObject({ name: "Header Name", expanded: false, unread: true, mentions: 2, index: 1 });
    });

    it("falls back to the DOM when the layout is empty", () => {
      guildBar(`<div data-list-item-id="guildsnav___1"></div>`);
      const state = readState(document, { dms: [], guilds: info, layout: [] });
      expect(state.guilds.map((g) => g.name)).toEqual(["Lone"]);
      expect(state).not.toHaveProperty("folders");
    });
  });

  describe("from the DOM alone", () => {
    it("recognises folder headers and their rendered guilds", () => {
      guildBar(`
        <div data-list-item-id="guildsnav___50" aria-expanded="true" aria-label="Games"></div>
        <ul id="folder-items-50"><div data-list-item-id="guildsnav___2" aria-label="Alpha"></div></ul>
        <div data-list-item-id="guildsnav___60" aria-expanded="false" aria-label="unread, Chill">
          <img src="https://cdn/a.png"><img src="https://cdn/b.png"><img src="data:x">
        </div>
        <div data-list-item-id="guildsnav___1" aria-label="Lone"></div>`);
      const state = readState(document);
      expect(state.guilds.map((g) => [g.name, g.folderId])).toEqual([["Alpha", "50"], ["Lone", undefined]]);
      expect(state.folders).toEqual([
        { id: "50", name: "Games", expanded: true, unread: false, mentions: 0, iconUrls: [], index: 0 },
        {
          id: "60",
          name: "Chill",
          expanded: false,
          unread: true,
          mentions: 0,
          iconUrls: ["https://cdn/a.png", "https://cdn/b.png"],
          index: 1,
        },
      ]);
    });

    it("names unlabelled empty folders generically", () => {
      guildBar(`<div data-list-item-id="guildsnav___50" aria-expanded="false"></div>`);
      expect(readState(document).folders![0]!.name).toBe("Folder");
    });

    it("ignores folder-items containers with unusable ids", () => {
      guildBar(`<ul id="folder-items-abc"><div data-list-item-id="guildsnav___2" aria-label="Alpha"></div></ul>`);
      expect(readGuilds(document)[0]).not.toHaveProperty("folderId");
    });
  });

  describe("toggling", () => {
    it("clicks the hidden folder header", () => {
      guildBar(`<div data-list-item-id="guildsnav___50" aria-expanded="false"></div>`);
      const click = vi.fn();
      document.querySelector("[aria-expanded]")!.addEventListener("click", click);
      expect(navigate(document, window, "folder:50")).toBe("click");
      expect(click).toHaveBeenCalledOnce();
      expect(navigate(document, window, "folder:51")).toBe("none");
    });
  });
});
