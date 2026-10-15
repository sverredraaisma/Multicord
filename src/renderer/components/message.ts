import type { FavouriteKind } from "../../shared/favourites";
import { isShownUrl, type NativeAttachment, type NativeChannelCan, type NativeMessage } from "../../shared/native";
import { avatar } from "./avatar";
import { el } from "./dom";
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
 * An attachment as its kind asks: pictures and stickers inline, videos and
 * sound with players, other files as links (opened in the browser, or saved
 * when the engine made them). Media the engine fetches on request: pictures
 * are asked for at once, sound and video only when the user wants them, as
 * they can be large. Expired links are greyed out.
 */
export function attachment(doc: Document, file: NativeAttachment, onLoad?: (key: string) => void): HTMLElement {
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
    if (file.kind === "image" || file.kind === "sticker") {
      onLoad(key);
      if (file.previewUrl) {
        const preview = sized(el(doc, "img", `attachment-${file.kind} loading`), file);
        preview.src = file.previewUrl;
        preview.alt = file.name;
        return preview;
      }
      return el(doc, "span", "attachment loading", `Loading ${file.name}…`);
    }
    const load = el(doc, "button", "attachment load", `${file.kind === "file" ? "⬇" : "▶"} ${file.name}${file.size ? ` (${formatSize(file.size)})` : ""}`);
    load.type = "button";
    load.title = `Load this ${KIND_LABEL[file.kind]}`;
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
  onReply(message: NativeMessage): void;
  onToggleReactionPicker(message: NativeMessage): void;
  onReact(message: NativeMessage, key: string, add: boolean): void;
  /** Opens the full emoji picker for reacting; without it the palette has no "more" button. */
  onMoreReactions?(message: NativeMessage): void;
  onEdit(message: NativeMessage): void;
  onDelete(message: NativeMessage): void;
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
  can?: Pick<NativeChannelCan, "reply" | "react">;
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
    const shown = attachment(doc, file, handlers.onLoadMedia);
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
