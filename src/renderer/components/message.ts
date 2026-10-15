import type { NativeAttachment, NativeChannelCan, NativeMessage } from "../../shared/native";
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
    // Animated vector stickers (Lottie) have no picture to show: their name stands in.
    if (file.kind === "sticker" && !file.mediaKey) return el(doc, "span", "attachment sticker-name", `${file.name} (sticker)`);
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
  const meta = el(doc, "div", "meta");
  meta.append(el(doc, "strong", "author", message.author), el(doc, "time", undefined, formatTime(message.timestamp)));
  if (message.edited) meta.append(el(doc, "span", "edited", "(edited)"));
  body.append(meta);

  if (options.editor) {
    body.append(...options.editor);
  } else if (message.content) {
    const content = renderMarkdown(doc, message.content, options);
    content.classList.add("content");
    body.append(content);
  }
  for (const file of message.attachments) body.append(attachment(doc, file, handlers.onLoadMedia));

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

  li.append(avatar(doc, message.avatarUrl, message.author), body, messageActions(doc, message, handlers, options.can));
  return li;
}
