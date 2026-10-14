import type { NativeApi } from "../preload/native";
import type { NativeMessage, NativeViewState } from "../shared/native";
import { MAX_MESSAGE_LENGTH } from "../shared/native";
import { loginForm, mfaForm, setFormMessage, setIdentityKind, type LoginForm } from "./components/auth";
import { channelList } from "./components/channels";
import { el } from "./components/dom";
import { emojiPicker, type CustomEmoji, type PickedEmoji } from "./components/emojiPicker";
import { typingText } from "./components/format";
import { messageItem, type MessageHandlers } from "./components/message";
import { forumPosts, pendingFiles, postForm, replyBar, voicePanel } from "./components/panels";
import { isOwnReaction } from "./components/reactions";
import { VoiceCall } from "./voice";

export { formatSize, formatTime, typingText } from "./components/format";
export { QUICK_REACTIONS } from "./components/reactions";

type ChatState = Extract<NativeViewState, { screen: "chat" }>;

/** Inserts text at the cursor of a text field, replacing any selection. */
export function insertAtCursor(field: HTMLTextAreaElement, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.selectionStart = field.selectionEnd = start + text.length;
}

/**
 * Renders a native adapter's chat view from the shared components. It owns
 * only view state (reply target, edit in progress, open pickers) and the
 * elements that must survive updates so typing is never lost.
 */
export class NativeView {
  private screen: NativeViewState["screen"] | undefined;
  private parts: Record<string, HTMLElement> = {};
  private login: LoginForm | undefined;
  private channelId: string | undefined;
  private firstMessageId: string | undefined;
  private replyTo: { id: string; author: string } | undefined;
  private editingId: string | undefined;
  private pickerFor: string | undefined;
  private fullPickerFor: string | undefined;
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
        setIdentityKind(this.login!, state.identity);
        this.login!.submit.disabled = state.busy;
        setFormMessage(this.login!.form, "status", state.status);
        setFormMessage(this.login!.form, "error", state.error);
        return;
      case "mfa":
        (this.parts.submit as HTMLButtonElement).disabled = state.busy;
        setFormMessage(this.parts.form!, "error", state.error);
        return;
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
    this.login = undefined;
    this.channelId = undefined;
    this.firstMessageId = undefined;
    const doc = this.doc;
    const card = el(doc, "section", "card");
    switch (state.screen) {
      case "login":
        this.login = loginForm(doc, state.platform, (identity, password) => this.api.act({ type: "login", identity, password }));
        card.append(this.login.form);
        break;
      case "mfa": {
        const mfa = mfaForm(doc, state.codes, {
          onSubmit: (code) => this.api.act({ type: "mfa", code }),
          onCancel: () => this.api.act({ type: "cancelMfa" }),
        });
        card.append(mfa.form);
        Object.assign(this.parts, mfa);
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
    const voice = el(doc, "section", "voice-panel");
    voice.hidden = true;
    sidebar.append(title, list, voice, footer);

    const main = el(doc, "main", "conversation");
    const header = el(doc, "header", "conversation-title");
    const banner = el(doc, "div", "banner");
    const messages = el(doc, "ol", "messages");
    const stage = el(doc, "div", "voice-stage");
    stage.hidden = true;
    const speakers = el(doc, "div", "voice-speakers");
    speakers.hidden = true;
    this.call = new VoiceCall(stage, speakers, (message) => this.api.act({ type: "voiceError", message }));
    const reply = el(doc, "div", "reply-bar");
    reply.hidden = true;

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
    const emoji = el(doc, "button", "emoji-button", "😊");
    emoji.title = "Emoji";
    emoji.setAttribute("aria-label", "Emoji");
    emoji.addEventListener("click", () => this.toggleComposerPicker());
    const composerPicker = el(doc, "div", "composer-picker");
    composerPicker.hidden = true;
    const composerRow = el(doc, "div", "composer-row");
    composerRow.append(attach, composer, emoji, composerPicker);
    main.append(header, banner, stage, messages, typing, reply, pending, composerRow, speakers);

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
      reply,
      pending,
      attach,
      emoji,
      composer,
      composerPicker,
      editBox,
      voice,
    });
  }

  private customEmoji(): CustomEmoji[] {
    const state = this.lastState;
    return (state?.customEmoji ?? []).map((e) => ({ ...e, url: this.emojiUrl(e.id, e.animated) }));
  }

  private emojiUrl(id: string, animated: boolean): string {
    return `${this.lastState?.emojiBase ?? ""}/${id}.${animated ? "gif" : "webp"}?size=48`;
  }

  private toggleComposerPicker(): void {
    const holder = this.parts.composerPicker!;
    holder.hidden = !holder.hidden;
    if (holder.hidden) return holder.replaceChildren();
    holder.replaceChildren(
      emojiPicker(
        this.doc,
        (picked: PickedEmoji) => {
          insertAtCursor(this.parts.composer as HTMLTextAreaElement, picked.text);
          holder.hidden = true;
          holder.replaceChildren();
          this.parts.composer!.focus();
        },
        this.customEmoji(),
      ),
    );
  }

  private setReply(target: { id: string; author: string } | undefined): void {
    this.replyTo = target;
    const bar = this.parts.reply!;
    bar.hidden = !target;
    if (!target) return bar.replaceChildren();
    bar.replaceChildren(...replyBar(this.doc, target.author, () => this.setReply(undefined)));
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

  private readonly messageHandlers: MessageHandlers = {
    onReply: (message) => this.setReply({ id: message.id, author: message.author }),
    onToggleReactionPicker: (message) => {
      this.pickerFor = this.pickerFor === message.id ? undefined : message.id;
      this.fullPickerFor = undefined;
      this.rerender();
    },
    onReact: (message, key, add) => {
      const pickerOpen = this.pickerFor !== undefined || this.fullPickerFor !== undefined;
      this.pickerFor = undefined;
      this.fullPickerFor = undefined;
      this.api.act({ type: "react", messageId: message.id, emoji: key, add });
      if (pickerOpen) this.rerender();
    },
    onMoreReactions: (message) => {
      this.fullPickerFor = message.id;
      this.rerender();
    },
    onEdit: (message) => this.setEditing(message.id, message.source ?? message.content),
    onDelete: (message) => {
      const win = this.doc.defaultView;
      if (!win?.confirm || win.confirm("Delete this message?")) this.api.act({ type: "delete", messageId: message.id });
    },
  };

  private messageItem(message: NativeMessage): HTMLElement {
    const editing = message.id === this.editingId;
    const editBox = this.parts.editBox as HTMLTextAreaElement;
    if (editing) queueMicrotask(() => editBox.focus());
    return messageItem(this.doc, message, this.messageHandlers, {
      customEmojiUrl: (id, animated) => this.emojiUrl(id, animated),
      editor: editing ? [editBox, el(this.doc, "p", "edit-hint", "Enter to save, Escape to cancel")] : undefined,
      reacting: this.pickerFor === message.id,
      reactionPicker:
        this.fullPickerFor === message.id
          ? emojiPicker(
              this.doc,
              (picked) => this.messageHandlers.onReact(message, picked.key, !isOwnReaction(message.reactions, picked.key)),
              this.customEmoji(),
            )
          : undefined,
    });
  }

  private updateChat(state: ChatState): void {
    this.lastState = state;
    const { title, list, me, header, banner, messages, composer, attach } = this.parts as Record<string, HTMLElement>;
    if (state.channel?.id !== this.channelId) {
      // A reply, edit or open picker belongs to the channel it started in.
      this.replyTo = undefined;
      this.parts.reply!.hidden = true;
      this.editingId = undefined;
      this.pickerFor = undefined;
      this.fullPickerFor = undefined;
    }
    title!.textContent = state.title;
    me!.textContent = state.me;
    banner!.textContent = state.error ?? "";
    banner!.hidden = !state.error;
    list!.replaceChildren(
      ...channelList(this.doc, state.sidebar, {
        onSelect: (channelId) => this.api.act({ type: "select", channelId }),
        onJoinVoice: (channelId) => this.api.act({ type: "joinVoice", channelId }),
      }),
    );

    const channel = state.channel;
    header!.textContent = channel ? channel.name : "Select a conversation";
    this.parts.typing!.textContent = typingText(channel?.typing ?? []);

    const uploading = channel?.uploading ?? false;
    const field = composer as HTMLTextAreaElement;
    // Forums take posts through their own form, not the composer.
    field.disabled = !channel || uploading || Boolean(channel.posts);
    (attach as HTMLButtonElement).disabled = !channel || uploading;
    (this.parts.emoji as HTMLButtonElement).disabled = field.disabled;
    field.placeholder = channel ? `Message ${channel.name}` : "";
    this.parts.pending!.replaceChildren(
      ...pendingFiles(this.doc, channel?.pending ?? [], uploading, (index) => this.api.act({ type: "removeAttachment", index })),
    );

    const voice = this.parts.voice!;
    voice.hidden = !state.voice;
    voice.replaceChildren(
      ...(state.voice
        ? voicePanel(this.doc, state.voice, {
            onChange: (flags) => this.api.act({ type: "voiceState", ...flags }),
            onLeave: () => this.api.act({ type: "leaveVoice" }),
          })
        : []),
    );
    void this.call?.sync(state.voice);

    const scroller = messages!;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    const items: HTMLElement[] = [];
    if (channel?.hasOlder) {
      const older = el(this.doc, "button", "older", channel.loading ? "Loading…" : "Load older messages");
      older.disabled = channel.loading;
      older.addEventListener("click", () => this.api.act({ type: "loadOlder" }));
      const row = el(this.doc, "li", "older-row");
      row.append(older);
      items.push(row);
    } else if (channel?.loading) {
      items.push(el(this.doc, "li", "older-row", "Loading…"));
    }
    if (channel?.posts) {
      this.parts.postForm ??= postForm(this.doc, (name, content) => this.api.act({ type: "createPost", name, content }));
      const formRow = el(this.doc, "li", "post-form-row");
      formRow.append(this.parts.postForm);
      items.push(formRow, ...forumPosts(this.doc, channel.posts, (postId) => this.api.act({ type: "select", channelId: postId })));
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
