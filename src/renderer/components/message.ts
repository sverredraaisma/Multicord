import type { FavouriteKind } from "../../shared/favourites";
import { isShownUrl, messageEmbeds, messagePoll, type NativeAttachment, type NativeChannelCan, type NativeEmbed, type NativeMessage, type NativePoll } from "../../shared/native";
import { avatar } from "./avatar";
import { el, setColor } from "./dom";
import { formatSize, formatTime } from "./format";
import { renderMarkdown, type MarkdownOptions } from "./markdown";
import { quickReactions, reactionChip } from "./reactions";

const KIND_LABEL = { image: "image", video: "video", audio: "audio", sticker: "sticker", file: "file" } as const;

/** Gives media its real proportions before it loads, so the conversation does not jump. */
function sized<T extends HTMLImageElement | HTMLVideoElement>(media: T, file: NativeAttachment): T {
  if (file.width && file.height) {
    media.width = file.width;
    media.height = file.height;
  }
  return media;
}

/**
 * Whether media the engine holds back loads by itself under a limit (bytes;
 * Infinity for any size), or why it waits for a click. Stickers always do,
 * as every platform keeps them small; files wait until they are wanted, and
 * so does media of unknown size unless any size may load.
 */
export function autoLoads(file: NativeAttachment, limit: number): true | string {
  if (file.kind === "sticker") return true;
  if (file.kind === "file") return "";
  if (limit === Number.POSITIVE_INFINITY) return true;
  if (limit <= 0) return "Media does not load by itself here (Settings).";
  if (file.size === undefined) return "Its size is unknown, so it does not load by itself.";
  return file.size <= limit ? true : `It is larger than the ${formatSize(limit)} that loads by itself.`;
}

/**
 * An attachment as its kind asks: pictures and stickers inline, videos and
 * sound with players, other files as links (opened in the browser, or saved
 * when the engine made them). Media the engine fetches on request waits for
 * a click, unless `autoLoad` says it loads by itself: then it is marked
 * (data-auto-load, with its key) for the view to ask for once it is in
 * sight. Expired links are greyed out.
 */
export function attachment(doc: Document, file: NativeAttachment, onLoad?: (key: string) => void, autoLoad?: (file: NativeAttachment) => true | string): HTMLElement {
  if (!file.url) {
    // Animated vector stickers (Lottie) cannot be drawn here: their still stands in, said to be one, or else their name.
    if (file.kind === "sticker" && !file.mediaKey) {
      if (!file.previewUrl) return el(doc, "span", "attachment sticker-name", `${file.name} (sticker)`);
      const still = el(doc, "figure", "attachment-sticker-still");
      const img = sized(el(doc, "img", "attachment-sticker"), file);
      img.src = file.previewUrl;
      img.alt = file.name;
      still.title = `${file.name}: an animated sticker, shown still`;
      still.append(img, el(doc, "figcaption", "sticker-label", "Animated sticker"));
      return still;
    }
    if (!file.mediaKey || !onLoad) return el(doc, "span", "attachment expired", `${file.name} (${file.unavailable ?? "link expired"})`);
    const key = file.mediaKey;
    const auto = autoLoad?.(file) ?? "";
    if (auto === true) {
      let waiting: HTMLElement;
      if (file.previewUrl && (file.kind === "image" || file.kind === "sticker")) {
        const preview = sized(el(doc, "img", `attachment-${file.kind} loading`), file);
        preview.src = file.previewUrl;
        preview.alt = file.name;
        waiting = preview;
      } else waiting = el(doc, "span", "attachment loading", `Loading ${file.name}…`);
      waiting.dataset.autoLoad = key;
      return waiting;
    }
    const verb = file.kind === "file" ? "⬇" : file.kind === "image" ? "Show" : "▶";
    const load = el(doc, "button", "attachment load", `${verb} ${file.name}${file.size ? ` (${formatSize(file.size)})` : ""}`);
    load.type = "button";
    load.title = `Load this ${KIND_LABEL[file.kind]}${auto ? `. ${auto}` : ""}`;
    load.addEventListener("click", () => {
      load.disabled = true;
      load.textContent = `Loading ${file.name}…`;
      onLoad(key);
    });
    return load;
  }
  switch (file.kind) {
    case "image": {
      const img = sized(el(doc, "img", "attachment-image"), file);
      img.src = file.url;
      img.alt = file.name;
      img.loading = "lazy";
      return img;
    }
    case "sticker": {
      // Video stickers loop silently, as in the apps they come from.
      if (file.mime?.startsWith("video/")) {
        const clip = sized(el(doc, "video", "attachment-sticker"), file);
        Object.assign(clip, { src: file.url, autoplay: true, loop: true, muted: true, playsInline: true });
        clip.title = file.name;
        return clip;
      }
      const img = sized(el(doc, "img", "attachment-sticker"), file);
      img.src = file.url;
      img.alt = file.name;
      img.title = file.name;
      return img;
    }
    case "video": {
      const video = sized(el(doc, "video", "attachment-video"), file);
      if (file.loop) {
        Object.assign(video, { src: file.url, autoplay: true, loop: true, muted: true, playsInline: true });
        video.title = file.name;
        return video;
      }
      Object.assign(video, { src: file.url, controls: true, preload: "metadata" });
      if (file.previewUrl) video.poster = file.previewUrl;
      return video;
    }
    case "audio": {
      const box = el(doc, "div", "attachment-audio");
      const audio = el(doc, "audio");
      Object.assign(audio, { src: file.url, controls: true, preload: "metadata" });
      box.append(el(doc, "span", "attachment-name", file.name), audio);
      return box;
    }
    case "file": {
      const link = el(doc, "a", "attachment", `📎 ${file.name}${file.size ? ` (${formatSize(file.size)})` : ""}`);
      link.href = file.url;
      // The engine's own copies are saved; web links open in the browser.
      if (file.url.startsWith("data:")) link.download = file.name;
      else {
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      return link;
    }
  }
}

/**
 * A link preview the platform made, as a card: the site, the title (a link
 * that opens in the browser where it has one), the description and a
 * picture, beside the text when it is a thumbnail. Pictures the engine
 * holds back load like attachments do. Input comes through messageEmbeds().
 */
export function embedCard(
  doc: Document,
  embed: NativeEmbed,
  onLoad?: (key: string) => void,
  autoLoad?: (file: NativeAttachment) => true | string,
  options: MarkdownOptions = {},
): HTMLElement {
  const card = el(doc, "article", "embed");
  setColor(card, "--embed-color", embed.color);
  const text = el(doc, "div", "embed-text");
  if (embed.site) text.append(el(doc, "div", "embed-site", embed.site));
  if (embed.title) {
    if (embed.url) {
      const link = el(doc, "a", "embed-title", embed.title);
      link.href = embed.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.title = embed.url;
      text.append(link);
    } else text.append(el(doc, "div", "embed-title", embed.title));
  }
  if (embed.description) {
    const description = renderMarkdown(doc, embed.description, options);
    description.classList.add("embed-description");
    text.append(description);
  }
  card.append(text);
  const image = embed.image;
  if (image) {
    const file: NativeAttachment = { name: embed.title ?? embed.site ?? "Preview", kind: "image", url: image.url, mediaKey: image.mediaKey, width: image.width, height: image.height, size: image.size };
    const shown = attachment(doc, file, onLoad, autoLoad);
    shown.classList.add(image.thumbnail ? "embed-thumbnail" : "embed-image");
    card.classList.toggle("with-thumbnail", image.thumbnail === true);
    card.append(shown);
  }
  return card;
}

/**
 * A poll: its question, and each option with its share of the votes where
 * the platform shows them. Where the user may vote, options are buttons: in
 * a single-choice poll the one clicked becomes the vote; in a
 * multiple-choice one it is added to or taken from the user's choice.
 * "Take back vote" clears it.
 */
export function pollCard(doc: Document, poll: NativePoll, onVote?: (options: string[]) => void): HTMLElement {
  const card = el(doc, "div", "poll");
  card.append(el(doc, "div", "poll-question", poll.question));
  const vote = poll.canVote === true && !poll.closed ? onVote : undefined;
  const chosen = poll.options.filter((o) => o.chosen === true).map((o) => o.id);
  const counted = poll.options.reduce((sum, o) => sum + (o.votes ?? 0), 0);
  const total = poll.total ?? counted;
  const list = el(doc, "ul", "poll-options");
  for (const option of poll.options) {
    const row = vote ? el(doc, "button", "poll-option") : el(doc, "div", "poll-option");
    row.classList.toggle("chosen", option.chosen === true);
    row.classList.toggle("correct", option.correct === true);
    row.append(el(doc, "span", "poll-text", option.text));
    if (option.votes !== undefined) {
      const share = total > 0 ? Math.round((option.votes * 100) / total) : 0;
      row.append(el(doc, "span", "poll-share", `${share}%`));
      row.style.setProperty("--share", `${share}%`);
    }
    if (vote) {
      (row as HTMLButtonElement).type = "button";
      row.setAttribute("aria-pressed", String(option.chosen === true));
      row.addEventListener("click", () => {
        if (!poll.multiple) return option.chosen === true ? undefined : vote([option.id]);
        vote(chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : [...chosen, option.id]);
      });
    }
    const li = el(doc, "li");
    li.append(row);
    list.append(li);
  }
  const how = poll.closed ? "Final results" : poll.multiple ? "Choose one or more" : "Choose one";
  const votes = poll.total !== undefined || counted > 0 ? ` · ${total === 1 ? "1 vote" : `${total} votes`}` : "";
  card.append(list, el(doc, "div", "poll-meta", how + votes));
  if (vote && chosen.length > 0) {
    const retract = el(doc, "button", "poll-retract link", "Take back vote");
    retract.type = "button";
    retract.addEventListener("click", () => vote([]));
    card.append(retract);
  }
  return card;
}

/** What a shown attachment would be as a favourite, if it can be one: a sticker, a GIF (or looping video) or a picture. */
export function favouriteKind(file: NativeAttachment): FavouriteKind | undefined {
  // The shell keeps only what it can fetch (https) or is handed (a data: URL of a picture or video).
  if (!file.url || !isShownUrl(file.url)) return undefined;
  if (file.kind === "sticker") return "sticker";
  if (file.kind === "video") return file.loop ? "gif" : undefined;
  if (file.kind !== "image") return undefined;
  return file.mime === "image/gif" ? "gif" : "image";
}

export interface MessageHandlers {
  /** Asks the engine for media it holds back (NativeAttachment.mediaKey). */
  onLoadMedia?(key: string): void;
  /** Whether held-back media loads by itself (autoLoads()), or why not; without it, all of it waits for a click. */
  autoLoad?(file: NativeAttachment): true | string;
  onReply(message: NativeMessage): void;
  onToggleReactionPicker(message: NativeMessage): void;
  onReact(message: NativeMessage, key: string, add: boolean): void;
  /** Opens the full emoji picker for reacting; without it the palette has no "more" button. */
  onMoreReactions?(message: NativeMessage): void;
  onEdit(message: NativeMessage): void;
  onDelete(message: NativeMessage): void;
  /** Pins or unpins it, where the message says it may be (canPin); without it no message offers pinning. */
  onPin?(message: NativeMessage, pin: boolean): void;
  /** Opens the choice of where to forward it, where the conversation can (can.forward). */
  onForward?(message: NativeMessage): void;
  /** Puts its text on the clipboard; the way to take it to another module, which a forward never does. */
  onCopy?(message: NativeMessage): void;
  /** Votes in the message's poll; without it polls only show. */
  onVote?(message: NativeMessage, options: string[]): void;
  /** Opens the author's profile (messages with an authorId); without it the author is plain text. */
  onOpenProfile?(message: NativeMessage): void;
  /** Stars or unstars a GIF, sticker or picture; without it media has no star. */
  onFavourite?(file: NativeAttachment, kind: FavouriteKind): void;
  /** Whether this media is a favourite already. */
  isFavourite?(file: NativeAttachment): boolean;
}

export interface MessageOptions extends MarkdownOptions {
  /** Shown in place of the content while this message is being edited. */
  editor?: HTMLElement[];
  /** Shown under the reactions while choosing one (quick palette plus full picker). */
  reactionPicker?: HTMLElement;
  /** Whether the quick reaction palette is open. */
  reacting?: boolean;
  /** What the conversation allows (NativeChannelView.can); everything when left out. */
  can?: Pick<NativeChannelCan, "reply" | "react"> & Partial<Pick<NativeChannelCan, "forward">>;
  /** The message just jumped to (from the pins or search results), marked until the next jump. */
  highlighted?: boolean;
}

function messageActions(doc: Document, message: NativeMessage, handlers: MessageHandlers, can: MessageOptions["can"]): HTMLElement {
  const bar = el(doc, "div", "message-actions");
  const action = (label: string, run: () => void) => {
    const button = el(doc, "button", undefined, label);
    button.addEventListener("click", run);
    bar.append(button);
  };
  if (can?.reply !== false) action("Reply", () => handlers.onReply(message));
  if (can?.react !== false) action("React", () => handlers.onToggleReactionPicker(message));
  if (message.canEdit) action("Edit", () => handlers.onEdit(message));
  if (message.canDelete) action("Delete", () => handlers.onDelete(message));
  if (message.canPin === true && handlers.onPin) action(message.pinned === true ? "Unpin" : "Pin", () => handlers.onPin!(message, message.pinned !== true));
  if (can?.forward === true && handlers.onForward) action("Forward", () => handlers.onForward!(message));
  if (message.content.trim() !== "" && handlers.onCopy) action("Copy text", () => handlers.onCopy!(message));
  return bar;
}

/**
 * A chat message: avatar, reply preview, author and time, markdown content
 * (or the editor), attachments, reactions and a hover toolbar.
 */
export function messageItem(doc: Document, message: NativeMessage, handlers: MessageHandlers, options: MessageOptions = {}): HTMLElement {
  const li = el(doc, "li", "message");
  li.dataset.id = message.id;
  li.classList.toggle("mine", message.mine);
  li.classList.toggle("jump-target", options.highlighted === true);
  const body = el(doc, "div", "body");
  if (message.reply !== undefined) {
    body.append(
      message.reply
        ? el(doc, "div", "reply", `↪ ${message.reply.author}: ${message.reply.content}`)
        : el(doc, "div", "reply missing", "↪ Original message was deleted"),
    );
  }
  // With an author id, the name and picture open the author's profile.
  const openProfile = message.authorId && handlers.onOpenProfile ? () => handlers.onOpenProfile!(message) : undefined;
  let author: HTMLElement = el(doc, "strong", "author", message.author);
  let picture: HTMLElement = avatar(doc, message.avatarUrl, message.author);
  if (openProfile) {
    const name = el(doc, "button", "author", message.author);
    name.type = "button";
    name.addEventListener("click", openProfile);
    // The name is the keyboard's way in; the picture is a second target for the mouse.
    const face = el(doc, "button", "avatar-button");
    face.type = "button";
    face.tabIndex = -1;
    face.setAttribute("aria-label", `Profile of ${message.author}`);
    face.append(picture);
    face.addEventListener("click", openProfile);
    [author, picture] = [name, face];
  }
  const meta = el(doc, "div", "meta");
  meta.append(author, el(doc, "time", undefined, formatTime(message.timestamp)));
  // Highlighted, and said in words too, not by colour alone.
  if (message.mentionsMe === true) {
    li.classList.add("mentions-me");
    const marker = el(doc, "span", "mention-marker", "@");
    marker.title = "Mentions you";
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", "Mentions you");
    meta.append(marker);
  }
  if (message.pinned === true) {
    const pin = el(doc, "span", "pin-marker", "📌");
    pin.title = "Pinned";
    pin.setAttribute("role", "img");
    pin.setAttribute("aria-label", "Pinned");
    meta.append(pin);
  }
  if (message.edited) meta.append(el(doc, "span", "edited", "(edited)"));
  body.append(meta);

  if (options.editor) {
    body.append(...options.editor);
  } else if (message.content) {
    const content = renderMarkdown(doc, message.content, options);
    content.classList.add("content");
    body.append(content);
  }
  for (const file of message.attachments) {
    const shown = attachment(doc, file, handlers.onLoadMedia, handlers.autoLoad);
    const kind = handlers.onFavourite && favouriteKind(file);
    if (!kind) {
      body.append(shown);
      continue;
    }
    // A star on hover (and on focus) keeps it, cached by the shell.
    const saved = handlers.isFavourite?.(file) === true;
    const wrap = el(doc, "div", "media-wrap");
    const star = el(doc, "button", "favourite-star", saved ? "★" : "☆");
    star.type = "button";
    star.setAttribute("aria-pressed", String(saved));
    star.setAttribute("aria-label", saved ? `Remove ${file.name} from favourites` : `Add ${file.name} to favourites`);
    star.title = saved ? "Remove from favourites" : "Add to favourites";
    star.addEventListener("click", () => handlers.onFavourite!(file, kind));
    wrap.append(shown, star);
    body.append(wrap);
  }
  const poll = messagePoll(message.poll);
  if (poll) body.append(pollCard(doc, poll, handlers.onVote && ((chosen) => handlers.onVote!(message, chosen))));
  for (const embed of messageEmbeds(message.embeds)) body.append(embedCard(doc, embed, handlers.onLoadMedia, handlers.autoLoad, options));

  // Where reactions cannot be given, the ones others gave still show.
  const canReact = options.can?.react !== false;
  const reacting = canReact && options.reacting === true;
  if (message.reactions.length > 0 || reacting) {
    const row = el(doc, "div", "reactions");
    const react = (key: string, add: boolean) => handlers.onReact(message, key, add);
    for (const reaction of message.reactions) row.append(reactionChip(doc, reaction, canReact ? react : undefined));
    if (reacting) {
      const more = handlers.onMoreReactions && (() => handlers.onMoreReactions!(message));
      row.append(quickReactions(doc, message.reactions, react, more));
    }
    body.append(row);
  }
  if (options.reactionPicker && canReact) body.append(options.reactionPicker);

  li.append(picture, body, messageActions(doc, message, handlers, options.can));
  return li;
}
