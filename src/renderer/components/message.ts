import type { NativeAttachment, NativeMessage } from "../../shared/native";
import { avatar } from "./avatar";
import { el } from "./dom";
import { formatTime } from "./format";
import { renderMarkdown, type MarkdownOptions } from "./markdown";
import { quickReactions, reactionChip } from "./reactions";

/** Images inline; other files as links that open in the browser; expired links greyed out. */
export function attachment(doc: Document, file: NativeAttachment): HTMLElement {
  if (file.image && file.url) {
    const img = el(doc, "img", "attachment-image");
    img.src = file.url;
    img.alt = file.name;
    return img;
  }
  if (file.url) {
    const link = el(doc, "a", "attachment", file.name);
    link.href = file.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  }
  return el(doc, "span", "attachment expired", `${file.name} (link expired)`);
}

export interface MessageHandlers {
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
}

function messageActions(doc: Document, message: NativeMessage, handlers: MessageHandlers): HTMLElement {
  const bar = el(doc, "div", "message-actions");
  const action = (label: string, run: () => void) => {
    const button = el(doc, "button", undefined, label);
    button.addEventListener("click", run);
    bar.append(button);
  };
  action("Reply", () => handlers.onReply(message));
  action("React", () => handlers.onToggleReactionPicker(message));
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
  for (const file of message.attachments) body.append(attachment(doc, file));

  if (message.reactions.length > 0 || options.reacting) {
    const row = el(doc, "div", "reactions");
    const react = (key: string, add: boolean) => handlers.onReact(message, key, add);
    for (const reaction of message.reactions) row.append(reactionChip(doc, reaction, react));
    if (options.reacting) {
      const more = handlers.onMoreReactions && (() => handlers.onMoreReactions!(message));
      row.append(quickReactions(doc, message.reactions, react, more));
    }
    body.append(row);
  }
  if (options.reactionPicker) body.append(options.reactionPicker);

  li.append(avatar(doc, message.avatarUrl, message.author), body, messageActions(doc, message, handlers));
  return li;
}
