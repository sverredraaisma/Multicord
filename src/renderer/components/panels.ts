import { MAX_MESSAGE_LENGTH, type NativeForumPost, type NativeListedMessage, type NativeMessageList, type NativeVoiceSession } from "../../shared/native";
import { avatar } from "./avatar";
import { countBadge, el } from "./dom";
import { formatSize, formatTime } from "./format";

type VoiceFlags = Pick<NativeVoiceSession, "mute" | "deaf" | "video" | "stream">;

/** The call controls: connection status, where, and toggles that report the new flags. */
export function voicePanel(
  doc: Document,
  voice: NativeVoiceSession,
  handlers: { onChange(flags: VoiceFlags): void; onLeave(): void },
): HTMLElement[] {
  const status = el(doc, "div", "voice-status", voice.token ? "Voice connected" : "Connecting…");
  status.classList.toggle("connected", Boolean(voice.token));
  const where = el(doc, "div", "voice-where", voice.guildName ? `${voice.channelName} / ${voice.guildName}` : voice.channelName);
  const controls = el(doc, "div", "voice-controls");
  const current: VoiceFlags = { mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: voice.stream };
  const toggle = (label: string, on: boolean, change: Partial<VoiceFlags>) => {
    const button = el(doc, "button", undefined, label);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.disabled = !voice.token;
    button.addEventListener("click", () => handlers.onChange({ ...current, ...change }));
    controls.append(button);
  };
  toggle(voice.mute ? "Unmute" : "Mute", voice.mute, { mute: !voice.mute });
  toggle(voice.deaf ? "Undeafen" : "Deafen", voice.deaf, { deaf: !voice.deaf });
  toggle(voice.video ? "Camera off" : "Camera", voice.video, { video: !voice.video });
  toggle(voice.stream ? "Stop sharing" : "Share screen", voice.stream, { stream: !voice.stream });
  const leave = el(doc, "button", "leave", "Leave");
  leave.addEventListener("click", handlers.onLeave);
  controls.append(leave);
  return [status, where, controls];
}

/** A forum's posts as buttons, newest activity first; a placeholder when there are none. */
export function forumPosts(doc: Document, posts: NativeForumPost[], onOpen: (postId: string) => void): HTMLElement[] {
  const rows = posts.map((post) => {
    const li = el(doc, "li");
    const button = el(doc, "button", "post");
    button.classList.toggle("unread", post.unread);
    button.append(el(doc, "span", "name", post.name));
    if (post.messageCount !== undefined) {
      button.append(el(doc, "span", "count", `${post.messageCount} ${post.messageCount === 1 ? "reply" : "replies"}`));
    }
    const badge = countBadge(doc, post.mentions);
    if (badge) button.append(badge);
    button.addEventListener("click", () => onOpen(post.id));
    li.append(button);
    return li;
  });
  return rows.length > 0 ? rows : [el(doc, "li", "empty", "No open posts yet.")];
}

/** The new forum post form: a title and the first message. */
export function postForm(doc: Document, onCreate: (name: string, content: string) => void): HTMLFormElement {
  const form = el(doc, "form", "post-form");
  const title = el(doc, "input");
  title.name = "title";
  title.placeholder = "Post title";
  title.maxLength = 100;
  title.required = true;
  const body = el(doc, "textarea");
  body.name = "body";
  body.placeholder = "Write the first message";
  body.maxLength = MAX_MESSAGE_LENGTH;
  body.required = true;
  const submit = el(doc, "button", "primary", "New post");
  submit.type = "submit";
  form.append(title, body, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (title.value.trim() === "" || body.value.trim() === "") return;
    onCreate(title.value.trim(), body.value);
    title.value = "";
    body.value = "";
  });
  return form;
}

/** Files queued for the next message, each removable, plus upload progress. */
export function pendingFiles(
  doc: Document,
  files: { name: string; size: number }[],
  uploading: boolean,
  onRemove: (index: number) => void,
): HTMLElement[] {
  const items = files.map((file, index) => {
    const li = el(doc, "li", "pending-file");
    li.append(el(doc, "span", "name", file.name), el(doc, "span", "size", formatSize(file.size)));
    const remove = el(doc, "button", "link", "×");
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.disabled = uploading;
    remove.addEventListener("click", () => onRemove(index));
    li.append(remove);
    return li;
  });
  if (uploading) items.push(el(doc, "li", "uploading", files.length > 0 ? "Uploading…" : "Sending…"));
  return items;
}

/** Where the reply being written points; null hides it. */
export function replyBar(doc: Document, author: string, onCancel: () => void): HTMLElement[] {
  const cancel = el(doc, "button", "link", "Cancel");
  cancel.addEventListener("click", onCancel);
  return [el(doc, "span", undefined, `Replying to ${author}`), cancel];
}

/**
 * The side panel's list of messages (pinned ones, search results): each a
 * button with the author's picture, name, time and text, which brings the
 * message into sight. A note, loading and errors around it, and `empty`
 * when there is nothing. The list is bounded by messageList().
 */
export function listedMessages(doc: Document, list: NativeMessageList, onOpen: (message: NativeListedMessage) => void, empty: string): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (list.note) parts.push(el(doc, "p", "panel-note", list.note));
  if (list.error) parts.push(el(doc, "p", "member-error", list.error));
  if (list.messages.length > 0) {
    const ul = el(doc, "ul", "listed-messages");
    for (const message of list.messages) {
      const li = el(doc, "li");
      const button = el(doc, "button", "listed-message");
      button.type = "button";
      button.dataset.id = message.id;
      const meta = el(doc, "span", "listed-meta");
      meta.append(el(doc, "strong", "listed-author", message.author), el(doc, "time", undefined, formatTime(message.timestamp)));
      const text = el(doc, "span", "listed-text");
      text.append(meta, el(doc, "span", "listed-content", message.content || "(no text)"));
      button.append(avatar(doc, message.avatarUrl, message.author), text);
      button.addEventListener("click", () => onOpen(message));
      li.append(button);
      ul.append(li);
    }
    parts.push(ul);
  }
  if (list.loading) parts.push(el(doc, "p", "member-note", "Loading…"));
  else if (list.messages.length === 0 && !list.error) parts.push(el(doc, "p", "member-note", empty));
  return parts;
}
