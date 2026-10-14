import type { NativeApi } from "../preload/native";
import type { NativeMessage, NativeSidebarItem, NativeViewState, NativeVoiceSession } from "../shared/native";
import { MAX_MESSAGE_LENGTH } from "../shared/native";
import { initials } from "./rail";
import { VoiceCall } from "./voice";

type ChatState = Extract<NativeViewState, { screen: "chat" }>;

const CHANNEL_PREFIX: Record<NativeSidebarItem["kind"], string> = {
  category: "",
  text: "# ",
  thread: "↳ ",
  forum: "☰ ",
  voice: "🔊 ",
  dm: "",
};

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
  private call: VoiceCall | undefined;

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
    // Leaving the chat screen (e.g. signing out) ends any call.
    void this.call?.sync(null);
    this.call = undefined;
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
        const label = el(doc, "label", undefined, state.codes === "backup" ? "Backup code" : "Authentication or backup code");
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
    const voicePanel = el(doc, "section", "voice-panel");
    voicePanel.hidden = true;
    sidebar.append(title, list, voicePanel, footer);

    const main = el(doc, "main", "conversation");
    const header = el(doc, "header", "conversation-title");
    const banner = el(doc, "div", "banner");
    const messages = el(doc, "ol", "messages");
    const stage = el(doc, "div", "voice-stage");
    stage.hidden = true;
    const speakers = el(doc, "div", "voice-speakers");
    speakers.hidden = true;
    this.call = new VoiceCall(stage, speakers, (message) => this.api.act({ type: "voiceError", message }));
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
    main.append(header, banner, stage, messages, typing, replyBar, pending, composerRow, speakers);

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
    Object.assign(this.parts, {
      title,
      list,
      me,
      header,
      banner,
      messages,
      typing,
      replyBar,
      pending,
      attach,
      composer,
      editBox,
      voicePanel,
    });
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
    button.classList.add(item.kind);
    button.append(el(doc, "span", "name", `${CHANNEL_PREFIX[item.kind]}${item.name}`));
    if (item.mentions > 0) button.append(el(doc, "span", "badge", item.mentions > 99 ? "99+" : String(item.mentions)));
    button.addEventListener("click", () =>
      this.api.act(item.kind === "voice" ? { type: "joinVoice", channelId: item.id } : { type: "select", channelId: item.id }),
    );
    li.append(button);
    if (item.members?.length) {
      const members = el(doc, "ul", "voice-members");
      for (const member of item.members) {
        const row = el(doc, "li");
        row.classList.toggle("muted", member.muted);
        row.append(avatar(doc, member.avatarUrl, member.name), el(doc, "span", "name", member.name));
        if (member.video) row.append(el(doc, "span", "live", "LIVE"));
        members.append(row);
      }
      li.append(members);
    }
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

  /** The call controls: connection status, channel, and toggles that report the new flags. */
  private renderVoice(voice: NativeVoiceSession | null): void {
    const panel = this.parts.voicePanel!;
    panel.hidden = !voice;
    if (!voice) return panel.replaceChildren();
    const doc = this.doc;
    const status = el(doc, "div", "voice-status", voice.token ? "Voice connected" : "Connecting…");
    status.classList.toggle("connected", Boolean(voice.token));
    const where = el(doc, "div", "voice-where", voice.guildName ? `${voice.channelName} / ${voice.guildName}` : voice.channelName);
    const controls = el(doc, "div", "voice-controls");
    const toggle = (label: string, on: boolean, change: Partial<NativeVoiceSession>) => {
      const button = el(doc, "button", undefined, label);
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      button.disabled = !voice.token;
      button.addEventListener("click", () =>
        this.api.act({ type: "voiceState", mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: voice.stream, ...change }),
      );
      controls.append(button);
    };
    toggle(voice.mute ? "Unmute" : "Mute", voice.mute, { mute: !voice.mute });
    toggle(voice.deaf ? "Undeafen" : "Deafen", voice.deaf, { deaf: !voice.deaf });
    toggle(voice.video ? "Camera off" : "Camera", voice.video, { video: !voice.video });
    toggle(voice.stream ? "Stop sharing" : "Share screen", voice.stream, { stream: !voice.stream });
    const leave = el(doc, "button", "leave", "Leave");
    leave.addEventListener("click", () => this.api.act({ type: "leaveVoice" }));
    controls.append(leave);
    panel.replaceChildren(status, where, controls);
  }

  /** A forum: the new-post form (kept across renders), then its posts. */
  private forumItems(posts: NonNullable<NonNullable<ChatState["channel"]>["posts"]>): HTMLElement[] {
    const doc = this.doc;
    this.parts.postForm ??= this.createPostForm();
    const formRow = el(doc, "li", "post-form-row");
    formRow.append(this.parts.postForm);
    const rows = posts.map((post) => {
      const li = el(doc, "li");
      const button = el(doc, "button", "post");
      button.classList.toggle("unread", post.unread);
      button.append(el(doc, "span", "name", post.name));
      if (post.messageCount !== undefined) {
        button.append(el(doc, "span", "count", `${post.messageCount} ${post.messageCount === 1 ? "reply" : "replies"}`));
      }
      if (post.mentions > 0) button.append(el(doc, "span", "badge", String(post.mentions)));
      button.addEventListener("click", () => this.api.act({ type: "select", channelId: post.id }));
      li.append(button);
      return li;
    });
    if (rows.length === 0) rows.push(el(doc, "li", "empty", "No open posts yet."));
    return [formRow, ...rows];
  }

  private createPostForm(): HTMLElement {
    const doc = this.doc;
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
      this.api.act({ type: "createPost", name: title.value.trim(), content: body.value });
      title.value = "";
      body.value = "";
    });
    return form;
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
    this.renderVoice(state.voice);
    void this.call?.sync(state.voice);
    // Forums take posts through their own form, not the composer.
    if (channel?.posts) (composer as HTMLTextAreaElement).disabled = true;
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
    if (channel?.posts) items.push(...this.forumItems(channel.posts));
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
