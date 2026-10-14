import type { NativeApi } from "../preload/native";
import type { NativeMessage, NativeSidebarItem, NativeViewState } from "../shared/native";
import { MAX_MESSAGE_LENGTH } from "../shared/native";
import { initials } from "./rail";

type ChatState = Extract<NativeViewState, { screen: "chat" }>;

/** Reactions offered on a message without opening a full emoji picker. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
type LoginState = Extract<NativeViewState, { screen: "login" }>;
type MfaState = Extract<NativeViewState, { screen: "mfa" }>;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function avatar(doc: Document, url: string | undefined, name: string): HTMLElement {
  if (url) {
    const img = el(doc, "img", "avatar");
    img.src = url;
    img.alt = "";
    return img;
  }
  return el(doc, "span", "avatar initials", initials(name));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Ana is typing…", "Ana and Bo are typing…", or a summary for more people. */
export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are typing…`;
  return "Several people are typing…";
}

export function formatTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Renders a native adapter's chat view. Message text is only ever set via
 * textContent; links open in the browser through the main process. Screens
 * keep their inputs between updates so typing is never lost.
 */
export class NativeView {
  private screen: NativeViewState["screen"] | undefined;
  private parts: Record<string, HTMLElement> = {};
  private channelId: string | undefined;
  private firstMessageId: string | undefined;
  private replyTo: { id: string; author: string } | undefined;
  private editingId: string | undefined;
  private pickerFor: string | undefined;
  private lastState: ChatState | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: Pick<NativeApi, "act">,
  ) {}

  update(state: NativeViewState): void {
    if (state.screen !== this.screen) this.mount(state);
    switch (state.screen) {
      case "login":
        return this.updateLogin(state);
      case "mfa":
        return this.updateMfa(state);
      case "connecting":
        this.parts.status!.textContent = state.status;
        return;
      case "chat":
        return this.updateChat(state);
    }
  }

  private get doc(): Document {
    return this.root.ownerDocument;
  }

  private mount(state: NativeViewState): void {
    this.screen = state.screen;
    this.parts = {};
    this.channelId = undefined;
    this.firstMessageId = undefined;
    const doc = this.doc;
    const card = el(doc, "section", "card");
    switch (state.screen) {
      case "login": {
        const form = el(doc, "form", "auth");
        const title = el(doc, "h1", undefined, `Sign in to ${state.platform}`);
        const identity = el(doc, "input");
        identity.name = "identity";
        identity.required = true;
        identity.autocomplete = "username";
        const password = el(doc, "input");
        password.name = "password";
        password.type = "password";
        password.required = true;
        password.autocomplete = "current-password";
        const identityLabel = el(doc, "label");
        const passwordLabel = el(doc, "label", undefined, "Password");
        passwordLabel.append(password);
        const submit = el(doc, "button", "primary", "Sign in");
        submit.type = "submit";
        const note = el(
          doc,
          "p",
          "note",
          `Multicord is a third-party client. Your password is sent only to ${state.platform}, and your session is stored encrypted on this device.`,
        );
        form.append(title, identityLabel, passwordLabel, submit, el(doc, "p", "status"), el(doc, "p", "error"), note);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          this.api.act({ type: "login", identity: identity.value.trim(), password: password.value });
        });
        card.append(form);
        Object.assign(this.parts, { form, identity, identityLabel, password, submit });
        break;
      }
      case "mfa": {
        const form = el(doc, "form", "auth");
        const code = el(doc, "input");
        code.name = "code";
        code.required = true;
        code.autocomplete = "one-time-code";
        code.inputMode = "numeric";
        const label = el(doc, "label", undefined, "Authentication or backup code");
        label.append(code);
        const submit = el(doc, "button", "primary", "Verify");
        submit.type = "submit";
        const cancel = el(doc, "button", "link", "Back");
        cancel.type = "button";
        cancel.addEventListener("click", () => this.api.act({ type: "cancelMfa" }));
        form.append(el(doc, "h1", undefined, "Two-factor authentication"), label, submit, cancel, el(doc, "p", "error"));
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          this.api.act({ type: "mfa", code: code.value.trim() });
        });
        card.append(form);
        Object.assign(this.parts, { form, code, submit });
        break;
      }
      case "connecting": {
        const status = el(doc, "p", "status");
        card.append(el(doc, "div", "spinner"), status);
        this.parts.status = status;
        break;
      }
      case "chat":
        return this.mountChat();
    }
    this.root.replaceChildren(card);
  }

  private setMessage(form: HTMLElement, selector: string, text: string | undefined): void {
    const node = form.querySelector(selector)!;
    node.textContent = text ?? "";
  }

  private updateLogin(state: LoginState): void {
    const { form, identity, identityLabel, submit } = this.parts as Record<string, HTMLInputElement>;
    const isEmail = state.identity === "email";
    identity!.type = isEmail ? "email" : "text";
    identityLabel!.replaceChildren(isEmail ? "Email" : "Username", identity!);
    submit!.disabled = state.busy;
    this.setMessage(form!, ".status", state.status);
    this.setMessage(form!, ".error", state.error);
  }

  private updateMfa(state: MfaState): void {
    const { form, submit } = this.parts as Record<string, HTMLButtonElement>;
    submit!.disabled = state.busy;
    this.setMessage(form!, ".error", state.error);
  }

  private mountChat(): void {
    const doc = this.doc;
    const sidebar = el(doc, "nav", "sidebar");
    const title = el(doc, "h2", "sidebar-title");
    const list = el(doc, "ul", "channels");
    const me = el(doc, "span", "me");
    const logout = el(doc, "button", "link", "Sign out");
    logout.addEventListener("click", () => this.api.act({ type: "logout" }));
    const footer = el(doc, "footer", "account");
    footer.append(me, logout);
    sidebar.append(title, list, footer);

    const main = el(doc, "main", "conversation");
    const header = el(doc, "header", "conversation-title");
    const banner = el(doc, "div", "banner");
    const messages = el(doc, "ol", "messages");
    const replyBar = el(doc, "div", "reply-bar");
    replyBar.hidden = true;
    const composer = el(doc, "textarea", "composer");
    composer.maxLength = MAX_MESSAGE_LENGTH;
    composer.rows = 1;
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.replyTo) return this.setReply(undefined);
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const content = composer.value;
      const hasFiles = (this.lastState?.channel?.pending.length ?? 0) > 0;
      if (content.trim() === "" && !hasFiles) return;
      this.api.act(this.replyTo ? { type: "send", content, replyTo: this.replyTo.id } : { type: "send", content });
      composer.value = "";
      this.setReply(undefined);
    });
    composer.addEventListener("input", () => {
      if (composer.value.trim() !== "") this.api.act({ type: "typing" });
    });
    const typing = el(doc, "div", "typing");
    const pending = el(doc, "ul", "pending-files");
    const attach = el(doc, "button", "attach", "+");
    attach.title = "Attach files";
    attach.setAttribute("aria-label", "Attach files");
    attach.addEventListener("click", () => this.api.act({ type: "attach" }));
    const composerRow = el(doc, "div", "composer-row");
    composerRow.append(attach, composer);
    main.append(header, banner, messages, typing, replyBar, pending, composerRow);

    // One edit box, reused across renders so an edit in progress survives updates.
    const editBox = el(doc, "textarea", "edit-box");
    editBox.maxLength = MAX_MESSAGE_LENGTH;
    editBox.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return this.setEditing(undefined);
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const content = editBox.value;
      if (this.editingId && content.trim() !== "") this.api.act({ type: "edit", messageId: this.editingId, content });
      this.setEditing(undefined);
    });

    const layout = el(doc, "div", "chat");
    layout.append(sidebar, main);
    this.root.replaceChildren(layout);
    Object.assign(this.parts, { title, list, me, header, banner, messages, typing, replyBar, pending, attach, composer, editBox });
  }

  private setReply(target: { id: string; author: string } | undefined): void {
    this.replyTo = target;
    const bar = this.parts.replyBar!;
    bar.hidden = !target;
    if (!target) return bar.replaceChildren();
    const cancel = el(this.doc, "button", "link", "Cancel");
    cancel.addEventListener("click", () => this.setReply(undefined));
    bar.replaceChildren(el(this.doc, "span", undefined, `Replying to ${target.author}`), cancel);
    this.parts.composer!.focus();
  }

  private setEditing(messageId: string | undefined, source = ""): void {
    this.editingId = messageId;
    (this.parts.editBox as HTMLTextAreaElement).value = source;
    this.rerender();
  }

  private rerender(): void {
    if (this.lastState) this.updateChat(this.lastState);
  }

  private sidebarItem(item: NativeSidebarItem): HTMLElement {
    const doc = this.doc;
    if (item.kind === "category") return el(doc, "li", "category", item.name);
    const li = el(doc, "li");
    const button = el(doc, "button", "channel");
    button.dataset.id = item.id;
    button.classList.toggle("active", item.active);
    button.classList.toggle("unread", item.unread);
    if (item.kind === "dm") button.append(avatar(doc, item.iconUrl, item.name));
    button.append(el(doc, "span", "name", item.kind === "text" ? `# ${item.name}` : item.name));
    if (item.mentions > 0) button.append(el(doc, "span", "badge", item.mentions > 99 ? "99+" : String(item.mentions)));
    button.addEventListener("click", () => this.api.act({ type: "select", channelId: item.id }));
    li.append(button);
    return li;
  }

  private messageItem(message: NativeMessage): HTMLElement {
    const doc = this.doc;
    const li = el(doc, "li", "message");
    li.classList.toggle("mine", message.mine);
    const body = el(doc, "div", "body");
    const meta = el(doc, "div", "meta");
    meta.append(el(doc, "strong", "author", message.author), el(doc, "time", undefined, formatTime(message.timestamp)));
    if (message.edited) meta.append(el(doc, "span", "edited", "(edited)"));
    if (message.reply !== undefined) {
      body.append(
        message.reply
          ? el(doc, "div", "reply", `↪ ${message.reply.author}: ${message.reply.content}`)
          : el(doc, "div", "reply missing", "↪ Original message was deleted"),
      );
    }
    body.append(meta);
    if (message.id === this.editingId) {
      const editBox = this.parts.editBox as HTMLTextAreaElement;
      body.append(editBox, el(doc, "p", "edit-hint", "Enter to save, Escape to cancel"));
      queueMicrotask(() => editBox.focus());
    } else if (message.content) {
      body.append(el(doc, "p", "content", message.content));
    }
    for (const attachment of message.attachments) {
      if (attachment.image && attachment.url) {
        const img = el(doc, "img", "attachment-image");
        img.src = attachment.url;
        img.alt = attachment.name;
        body.append(img);
      } else if (attachment.url) {
        const link = el(doc, "a", "attachment", attachment.name);
        link.href = attachment.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        body.append(link);
      } else {
        body.append(el(doc, "span", "attachment expired", `${attachment.name} (link expired)`));
      }
    }
    if (message.reactions.length > 0 || this.pickerFor === message.id) body.append(this.reactionRow(message));
    li.append(avatar(doc, message.avatarUrl, message.author), body, this.messageActions(message));
    return li;
  }

  /** Files queued for the next message, each removable, plus upload progress. */
  private renderPending(channel: ChatState["channel"]): void {
    const doc = this.doc;
    const files = channel?.pending ?? [];
    const uploading = channel?.uploading ?? false;
    (this.parts.composer as HTMLTextAreaElement).disabled = !channel || uploading;
    (this.parts.attach as HTMLButtonElement).disabled = !channel || uploading;
    const items = files.map((file, index) => {
      const li = el(doc, "li", "pending-file");
      li.append(el(doc, "span", "name", file.name), el(doc, "span", "size", formatSize(file.size)));
      const remove = el(doc, "button", "link", "×");
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.disabled = uploading;
      remove.addEventListener("click", () => this.api.act({ type: "removeAttachment", index }));
      li.append(remove);
      return li;
    });
    if (uploading) items.push(el(doc, "li", "uploading", files.length > 0 ? "Uploading…" : "Sending…"));
    this.parts.pending!.replaceChildren(...items);
  }

  private reactionRow(message: NativeMessage): HTMLElement {
    const doc = this.doc;
    const row = el(doc, "div", "reactions");
    for (const reaction of message.reactions) {
      const button = el(doc, "button", "reaction");
      button.classList.toggle("me", reaction.me);
      button.title = reaction.label;
      if (reaction.imageUrl) {
        const img = el(doc, "img");
        img.src = reaction.imageUrl;
        img.alt = reaction.label;
        button.append(img);
      } else {
        button.append(el(doc, "span", undefined, reaction.label));
      }
      button.append(el(doc, "span", "count", String(reaction.count)));
      button.addEventListener("click", () =>
        this.api.act({ type: "react", messageId: message.id, emoji: reaction.key, add: !reaction.me }),
      );
      row.append(button);
    }
    if (this.pickerFor === message.id) {
      const palette = el(doc, "span", "quick-reactions");
      for (const emoji of QUICK_REACTIONS) {
        const own = message.reactions.find((r) => r.key === emoji)?.me ?? false;
        const button = el(doc, "button", "reaction", emoji);
        button.addEventListener("click", () => {
          this.pickerFor = undefined;
          this.api.act({ type: "react", messageId: message.id, emoji, add: !own });
        });
        palette.append(button);
      }
      row.append(palette);
    }
    return row;
  }

  private messageActions(message: NativeMessage): HTMLElement {
    const doc = this.doc;
    const bar = el(doc, "div", "message-actions");
    const action = (label: string, run: () => void) => {
      const button = el(doc, "button", undefined, label);
      button.addEventListener("click", run);
      bar.append(button);
    };
    action("Reply", () => this.setReply({ id: message.id, author: message.author }));
    action("React", () => {
      this.pickerFor = this.pickerFor === message.id ? undefined : message.id;
      this.rerender();
    });
    if (message.canEdit) action("Edit", () => this.setEditing(message.id, message.source ?? message.content));
    if (message.canDelete) {
      action("Delete", () => {
        const win = this.doc.defaultView;
        if (!win?.confirm || win.confirm("Delete this message?")) this.api.act({ type: "delete", messageId: message.id });
      });
    }
    return bar;
  }

  private updateChat(state: ChatState): void {
    this.lastState = state;
    const { title, list, me, header, banner, messages, composer } = this.parts as Record<string, HTMLElement>;
    if (state.channel?.id !== this.channelId) {
      // A reply or edit belongs to the channel it started in.
      this.replyTo = undefined;
      this.parts.replyBar!.hidden = true;
      this.editingId = undefined;
      this.pickerFor = undefined;
    }
    title!.textContent = state.title;
    me!.textContent = state.me;
    banner!.textContent = state.error ?? "";
    banner!.hidden = !state.error;
    list!.replaceChildren(...state.sidebar.map((item) => this.sidebarItem(item)));

    const channel = state.channel;
    header!.textContent = channel ? channel.name : "Select a conversation";
    this.parts.typing!.textContent = typingText(channel?.typing ?? []);
    this.renderPending(channel);
    (composer as HTMLTextAreaElement).placeholder = channel ? `Message ${channel.name}` : "";

    const scroller = messages!;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    const items: HTMLElement[] = [];
    if (channel?.hasOlder) {
      const older = el(this.doc, "button", "older", channel.loading ? "Loading…" : "Load older messages");
      older.disabled = channel.loading;
      older.addEventListener("click", () => this.api.act({ type: "loadOlder" }));
      items.push(el(this.doc, "li", "older-row"));
      items[0]!.append(older);
    } else if (channel?.loading) {
      items.push(el(this.doc, "li", "older-row", "Loading…"));
    }
    items.push(...(channel?.messages ?? []).map((m) => this.messageItem(m)));
    scroller.replaceChildren(...items);

    const first = channel?.messages[0]?.id;
    const switched = channel?.id !== this.channelId;
    const prepended = !switched && first !== this.firstMessageId;
    if (switched || atBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (prepended) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    this.channelId = channel?.id;
    this.firstMessageId = first;
  }
}

export function startNative(doc: Document, api: NativeApi): void {
  const view = new NativeView(doc.getElementById("app")!, api);
  api.onState((state) => view.update(state));
  api.act({ type: "ready" });
}
