import { screenAudioPatch } from "../shared/screenAudio";
import { SCREEN_AUDIO_END_EVENT, VIRTUAL_MIC } from "../shared/ipc";
import type { NativeApi } from "../preload/native";
import type { FavouritesAction, FavouritesState } from "../shared/favourites";
import type { NativeChannelCan, NativeMessage, NativeViewState, PickerEmoji } from "../shared/native";
import { channelCan, customEmojiList, emojiUrls, gifResults, MAX_MESSAGE_LENGTH, memberList, memberProfile, stickerPacks, unreadMarker, type NativeUnread } from "../shared/native";
import type { VoiceCommand, VoiceSettings } from "../shared/settings";
import { loginForm, mfaForm, promptForm, setFormMessage, setIdentityKind, type LoginForm } from "./components/auth";
import { channelList } from "./components/channels";
import { el, icon, ICONS } from "./components/dom";
import { emojiPicker, type SourceBadge } from "./components/emojiPicker";
import { MediaPicker, type MediaPickerData, type MediaPickerHandlers, type RecentMedia } from "./components/mediaPicker";
import { typingText } from "./components/format";
import { memberPanel, profileCard, type ProfileCardData } from "./components/members";
import { matchMentions, mentionCandidates, mentionOptionId, mentionOptions, mentionQuery, type MentionCandidate } from "./components/mentions";
import { autoLoads, favouriteKind, messageItem, type MessageHandlers } from "./components/message";
import { forumPosts, pendingFiles, postForm, replyBar, voicePanel } from "./components/panels";
import { isOwnReaction } from "./components/reactions";
import { VoiceCall } from "./voice";

export { formatSize, formatTime, typingText } from "./components/format";
export { QUICK_REACTIONS } from "./components/reactions";

type ChatState = Extract<NativeViewState, { screen: "chat" }>;

/** GIFs seen in a conversation that the picker offers again. */
export const MAX_RECENT_GIFS = 24;
/** Media that loads by itself: at most this many asked of the engine at once. */
export const MAX_AUTO_LOADS = 3;
/** An automatic load the engine has not answered in this long frees its place; it is not asked again. */
export const AUTO_LOAD_TIMEOUT_MS = 60_000;
/** Pages of older messages "Jump to unread" loads at most, looking for the first unread one. */
export const MAX_UNREAD_PAGES = 10;

/** What the unread bar and divider say: how many messages are new, where the module knows. */
export function newMessagesText(count: number | undefined): string {
  if (count === undefined) return "New messages";
  return count === 1 ? "1 new message" : `${count} new messages`;
}

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
  /** The prompt step on screen; a new step gets a fresh form. */
  private promptId: string | undefined;
  private parts: Record<string, HTMLElement> = {};
  private login: LoginForm | undefined;
  private channelId: string | undefined;
  private firstMessageId: string | undefined;
  private replyTo: { id: string; author: string } | undefined;
  private editingId: string | undefined;
  private pickerFor: string | undefined;
  private fullPickerFor: string | undefined;
  private lastState: ChatState | undefined;
  /** Whose profile card is open, as it was opened. */
  private profileFor: ProfileCardData | undefined;
  /** The card just opened: its close button takes focus. */
  private focusProfile = false;
  private call: VoiceCall | undefined;
  private voiceSettings: VoiceSettings | undefined;
  /** The shell's favourites, as last sent; the module never sees them. */
  private favourites: FavouritesState | undefined;
  /** The composer's picker, while open. */
  private picker: MediaPicker | undefined;
  /** The open conversation's unread marker, as last rendered. */
  private unread: NativeUnread | undefined;
  /** The view still has to bring the open conversation's first unread message into sight, once it is loaded. */
  private unreadPending = false;
  /** Where the news starts has been in sight. */
  private dividerSeen = false;
  /** The user dismissed the unread bar, or read on to the latest messages after the news started: it stays away. */
  private unreadDone = true;
  /** "Jump to unread" is loading older pages to find the first unread message: how many it asked for, and the first message when it last asked. */
  private seeking: { pages: number; from: string | undefined } | undefined;
  /** The mention being typed in the composer, while it has suggestions: where its "@" is, who fits, and the highlighted one. */
  private mention: { start: number; options: MentionCandidate[]; active: number } | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: Pick<NativeApi, "act"> & Partial<Pick<NativeApi, "favourites">>,
    private readonly denoiser?: ConstructorParameters<typeof VoiceCall>[5],
    /** Starts LiveKit's end-to-end encryption worker, for encrypted calls. */
    private readonly e2eeWorker?: ConstructorParameters<typeof VoiceCall>[6],
  ) {}

  /** The favourites changed: stars in messages and the open picker follow. */
  setFavourites(state: FavouritesState): void {
    this.favourites = state;
    this.rerender();
  }

  /** Devices and processing for calls, from the app settings. */
  setVoiceSettings(settings: VoiceSettings): void {
    this.voiceSettings = settings;
    void this.call?.configure(settings);
  }

  /** The call in progress, if the voice server has connected us. */
  private get liveCall() {
    const voice = this.screen === "chat" ? this.lastState?.voice : undefined;
    return voice?.token ? voice : undefined;
  }

  private setVoice(change: { mute?: boolean; deaf?: boolean }): void {
    const voice = this.liveCall;
    if (!voice) return;
    const flags = { mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: voice.stream, ...change };
    if (flags.mute === voice.mute && flags.deaf === voice.deaf) return;
    this.api.act({ type: "voiceState", ...flags });
  }

  /** A global shortcut toggles mute or deafen; the background push-to-talk key talks. */
  voiceCommand(command: VoiceCommand): void {
    if (command === "talkStart" || command === "talkStop") {
      if (this.voiceSettings?.pushToTalk) this.setVoice({ mute: command === "talkStop" });
      return;
    }
    const voice = this.liveCall;
    if (!voice) return;
    this.setVoice(command === "toggleMute" ? { mute: !voice.mute } : { deaf: !voice.deaf });
  }

  /**
   * Push to talk while Multicord is in front: the key held unmutes, released
   * (or the window losing focus, which hides the release) mutes again.
   */
  pushToTalk(code: string, down: boolean): void {
    if (!this.voiceSettings?.pushToTalk || code !== this.voiceSettings.pushToTalk) return;
    this.setVoice({ mute: !down });
  }

  /** The window lost focus: a held push-to-talk key's release will not arrive, unless the background hook sees it. */
  releaseTalk(): void {
    if (this.voiceSettings?.pushToTalk && !this.voiceSettings.pushToTalkGlobal) this.setVoice({ mute: true });
  }

  update(state: NativeViewState): void {
    if (state.screen !== this.screen || (state.screen === "prompt" && state.prompt.id !== this.promptId)) this.mount(state);
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
      case "prompt":
        (this.parts.submit as HTMLButtonElement).disabled = state.busy;
        setFormMessage(this.parts.form!, "status", state.status);
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
    this.promptId = state.screen === "prompt" ? state.prompt.id : undefined;
    this.parts = {};
    this.login = undefined;
    this.channelId = undefined;
    this.firstMessageId = undefined;
    this.mention = undefined;
    // It watched the old messages list.
    this.observer?.disconnect();
    this.observer = undefined;
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
      case "prompt": {
        const { id } = state.prompt;
        const prompt = promptForm(doc, state.prompt, {
          onSubmit: (values) => this.api.act({ type: "prompt", id, values }),
          onCancel: () => this.api.act({ type: "cancelPrompt", id }),
        });
        card.append(prompt.form);
        Object.assign(this.parts, prompt);
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
    const heading = el(doc, "span", "conversation-name");
    // Shows and hides who is here, where the conversation lists them.
    const membersToggle = el(doc, "button", "members-toggle");
    membersToggle.type = "button";
    membersToggle.title = "Member list";
    membersToggle.setAttribute("aria-label", "Member list");
    membersToggle.setAttribute("aria-controls", "member-panel");
    membersToggle.append(icon(doc, "members-icon", ICONS.members));
    membersToggle.addEventListener("click", () => this.api.act({ type: "members", open: membersToggle.getAttribute("aria-pressed") !== "true" }));
    header.append(heading, membersToggle);
    const banner = el(doc, "div", "banner");
    // Where the news starts, while it is out of sight: a bar above the messages.
    const unreadBar = el(doc, "div", "unread-bar");
    unreadBar.hidden = true;
    const unreadText = el(doc, "span", "unread-text");
    const jumpUnread = el(doc, "button", "jump-unread", "Jump to unread");
    jumpUnread.type = "button";
    jumpUnread.addEventListener("click", () => this.jumpToUnread());
    const dismissUnread = el(doc, "button", "dismiss-unread", "×");
    dismissUnread.type = "button";
    dismissUnread.title = "Dismiss";
    dismissUnread.setAttribute("aria-label", "Dismiss");
    dismissUnread.addEventListener("click", () => {
      this.unreadDone = true;
      this.updateJumps();
    });
    unreadBar.append(unreadText, jumpUnread, dismissUnread);
    const messages = el(doc, "ol", "messages");
    messages.addEventListener("scroll", () => this.updateJumps());
    // Back to the latest messages, while scrolled up.
    const jumpPresent = el(doc, "button", "jump-present", "Jump to present");
    jumpPresent.type = "button";
    jumpPresent.hidden = true;
    jumpPresent.addEventListener("click", () => {
      messages.scrollTop = messages.scrollHeight;
      this.updateJumps();
    });
    const messageArea = el(doc, "div", "message-area");
    messageArea.append(unreadBar, messages, jumpPresent);
    const stage = el(doc, "div", "voice-stage");
    stage.hidden = true;
    const speakers = el(doc, "div", "voice-speakers");
    speakers.hidden = true;
    this.call = new VoiceCall(stage, speakers, (message, notice) => this.api.act(notice ? { type: "voiceNotice", message, ...notice } : { type: "voiceError", message }), undefined, undefined, this.denoiser, this.e2eeWorker);
    if (this.voiceSettings) void this.call.configure(this.voiceSettings);
    const reply = el(doc, "div", "reply-bar");
    reply.hidden = true;

    const composer = el(doc, "textarea", "composer");
    composer.maxLength = MAX_MESSAGE_LENGTH;
    composer.rows = 1;
    // Typing "@" and a name suggests people to mention, from the list below the composer.
    composer.setAttribute("aria-autocomplete", "list");
    composer.setAttribute("aria-controls", "mention-list");
    composer.setAttribute("aria-expanded", "false");
    composer.addEventListener("keydown", (event) => {
      if (this.mention && this.mentionKey(event)) return;
      if (event.key === "Escape" && this.replyTo) return this.setReply(undefined);
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const content = composer.value;
      const hasFiles = (this.lastState?.channel?.pending.length ?? 0) > 0;
      if (content.trim() === "" && !hasFiles) return;
      this.api.act(this.replyTo ? { type: "send", content, replyTo: this.replyTo.id } : { type: "send", content });
      composer.value = "";
      this.closeMention();
      this.setReply(undefined);
    });
    composer.addEventListener("input", () => {
      if (composer.value.trim() !== "" && this.can.typing) this.api.act({ type: "typing" });
      this.updateMention();
    });
    // Moving the cursor into or out of an "@name" shows or hides its suggestions.
    composer.addEventListener("click", () => this.updateMention());
    composer.addEventListener("keyup", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.updateMention();
    });
    composer.addEventListener("blur", () => this.closeMention());
    const mentionList = el(doc, "ul", "mention-list");
    mentionList.id = "mention-list";
    mentionList.setAttribute("role", "listbox");
    mentionList.setAttribute("aria-label", "People to mention");
    mentionList.hidden = true;
    const typing = el(doc, "div", "typing");
    const pending = el(doc, "ul", "pending-files");
    const attach = el(doc, "button", "attach", "+");
    attach.title = "Attach files";
    attach.setAttribute("aria-label", "Attach files");
    attach.addEventListener("click", () => this.api.act({ type: "attach" }));
    const emoji = el(doc, "button", "emoji-button", "😊");
    emoji.title = "Emoji, stickers and GIFs";
    emoji.setAttribute("aria-label", "Emoji, stickers and GIFs");
    emoji.setAttribute("aria-haspopup", "dialog");
    emoji.addEventListener("click", () => this.toggleComposerPicker());
    const composerPicker = el(doc, "div", "composer-picker");
    composerPicker.hidden = true;
    const composerRow = el(doc, "div", "composer-row");
    composerRow.append(attach, composer, emoji, composerPicker, mentionList);
    // Why the composer is off in a conversation that takes no messages from here.
    const notice = el(doc, "div", "locked-notice");
    notice.hidden = true;
    main.append(header, banner, stage, messageArea, typing, reply, pending, notice, composerRow, speakers);

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

    const members = el(doc, "aside", "member-panel");
    members.id = "member-panel";
    members.setAttribute("aria-label", "Members");
    members.hidden = true;
    // The panel sits beside the conversation, or over it where the window is narrow.
    const area = el(doc, "div", "conversation-area");
    // Someone's profile, opened from a message's author or a member row.
    const profile = el(doc, "section", "profile-card");
    profile.setAttribute("role", "dialog");
    profile.setAttribute("aria-labelledby", "profile-name");
    profile.hidden = true;
    profile.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeProfile();
    });
    area.append(main, members, profile);

    const layout = el(doc, "div", "chat");
    layout.append(sidebar, area);
    this.root.replaceChildren(layout);
    Object.assign(this.parts, {
      title,
      list,
      me,
      heading,
      membersToggle,
      members,
      profile,
      banner,
      unreadBar,
      unreadText,
      jumpPresent,
      messages,
      typing,
      reply,
      pending,
      attach,
      emoji,
      composer,
      composerPicker,
      mentionList,
      notice,
      editBox,
      voice,
    });
  }

  /** Custom emoji usable in the open conversation, as the module lists them. */
  private customEmoji(): PickerEmoji[] {
    return customEmojiList(this.lastState?.customEmoji, this.lastState?.emojiBase);
  }

  /** A message's custom emoji picture: the module's own for it, or one under the emoji base for a snowflake id; else none. */
  private emojiUrl(id: string, animated: boolean): string | undefined {
    const own = emojiUrls(this.lastState?.emojiUrls).get(id);
    if (own) return own;
    const base = this.lastState?.emojiBase;
    return base && /^\d{1,20}$/.test(id) ? `${base}/${id}.${animated ? "gif" : "webp"}?size=48` : undefined;
  }

  /** This view's module, for the badges on its own emoji and stickers. */
  private get badge(): SourceBadge | undefined {
    return this.favourites?.module;
  }

  /** GIFs and looping videos in the open conversation's messages, newest first, once each. */
  private recentGifs(): RecentMedia[] {
    const seen = new Map<string, RecentMedia>();
    for (const message of [...(this.lastState?.channel?.messages ?? [])].reverse()) {
      for (const file of message.attachments) {
        if (favouriteKind(file) === "gif" && !seen.has(file.url!)) seen.set(file.url!, { url: file.url!, name: file.name, video: file.kind === "video" });
      }
    }
    return [...seen.values()].slice(0, MAX_RECENT_GIFS);
  }

  private pickerData(): MediaPickerData {
    const state = this.lastState!;
    const can = this.can;
    const data: MediaPickerData = {
      emoji: this.customEmoji(),
      stickers: stickerPacks(state.stickers),
      nativeStickers: can.stickers,
      files: can.attach && this.favouritesOn,
      gifSearch: can.gifs,
      gifs: gifResults(state.gifs),
      recent: this.recentGifs(),
      favourites: this.favourites,
    };
    if (this.badge) data.module = this.badge;
    return data;
  }

  /** Favourites and stickers as files need the shell's channel, which a test view may lack. */
  private get favouritesOn(): boolean {
    return this.api.favourites !== undefined;
  }

  private favouritesAct(action: FavouritesAction): void {
    this.api.favourites?.(action);
  }

  /** The reply in progress, taken: something is being sent with it. */
  private takeReply(): string | undefined {
    const id = this.replyTo?.id;
    if (id) this.setReply(undefined);
    return id;
  }

  private readonly pickerHandlers: MediaPickerHandlers = {
    onEmoji: (picked) => {
      insertAtCursor(this.parts.composer as HTMLTextAreaElement, picked.text);
      this.closePicker();
      this.parts.composer!.focus();
    },
    onSticker: (sticker) => {
      const replyTo = this.takeReply();
      // The module's own sticker goes as a sticker where it may; otherwise as a picture or video file.
      if (this.can.stickers) this.api.act(replyTo ? { type: "sendSticker", stickerId: sticker.id, replyTo } : { type: "sendSticker", stickerId: sticker.id });
      else this.favouritesAct(replyTo ? { type: "sendMedia", url: sticker.url!, name: sticker.name, replyTo } : { type: "sendMedia", url: sticker.url!, name: sticker.name });
      this.closePicker();
    },
    onGif: (gif) => {
      const replyTo = this.takeReply();
      this.api.act(replyTo ? { type: "send", content: gif.url, replyTo } : { type: "send", content: gif.url });
      this.closePicker();
    },
    onRecent: (media) => {
      const replyTo = this.takeReply();
      this.favouritesAct(replyTo ? { type: "sendMedia", url: media.url, name: media.name, replyTo } : { type: "sendMedia", url: media.url, name: media.name });
      this.closePicker();
    },
    onFavourite: (item) => {
      const replyTo = this.takeReply();
      this.favouritesAct(replyTo ? { type: "send", id: item.id, replyTo } : { type: "send", id: item.id });
      this.closePicker();
    },
    onSearchGifs: (query) => this.api.act({ type: "searchGifs", query }),
    onLoadMedia: (key) => this.messageHandlers.onLoadMedia!(key),
    onFavourites: (action) => this.favouritesAct(action),
    onClose: () => {
      this.closePicker();
      this.parts.emoji!.focus();
    },
  };

  private toggleComposerPicker(): void {
    if (this.picker) return this.closePicker();
    const holder = this.parts.composerPicker!;
    this.picker = new MediaPicker(this.doc, this.pickerHandlers, this.pickerData());
    holder.replaceChildren(this.picker.element);
    holder.hidden = false;
    this.parts.emoji!.setAttribute("aria-expanded", "true");
    this.api.act({ type: "picker", open: true });
    this.picker.show("emoji");
  }

  private closePicker(): void {
    const holder = this.parts.composerPicker;
    if (this.picker) {
      this.picker.close();
      this.api.act({ type: "picker", open: false });
    }
    this.picker = undefined;
    if (!holder) return;
    holder.hidden = true;
    holder.replaceChildren();
    this.parts.emoji!.setAttribute("aria-expanded", "false");
  }

  /**
   * Suggestions for the "@name" before the composer's cursor: the open
   * conversation's recent authors and listed members whose name fits. The
   * highlighted one stays while the same mention is refreshed.
   */
  private updateMention(keepActive = false): void {
    const field = this.parts.composer as HTMLTextAreaElement;
    const channel = this.lastState?.channel;
    const typed = field.disabled || !channel ? undefined : mentionQuery(field.value, field.selectionStart);
    const options = typed ? matchMentions(mentionCandidates(channel!.messages, this.can.members ? memberList(channel!.members) : undefined), typed.query) : [];
    if (!typed || options.length === 0) return this.closeMention();
    const kept = keepActive && this.mention?.start === typed.start ? this.mention.options[this.mention.active]!.id : undefined;
    const active = Math.max(0, options.findIndex((option) => option.id === kept));
    this.mention = { start: typed.start, options, active };
    this.renderMention();
  }

  private renderMention(): void {
    const { start, options, active } = this.mention!;
    const list = this.parts.mentionList!;
    list.hidden = false;
    list.replaceChildren(...mentionOptions(this.doc, options, active, (picked) => this.pickMention(picked, start)));
    this.parts.composer!.setAttribute("aria-expanded", "true");
    this.parts.composer!.setAttribute("aria-activedescendant", mentionOptionId(active));
  }

  private closeMention(): void {
    this.mention = undefined;
    const list = this.parts.mentionList!;
    list.hidden = true;
    list.replaceChildren();
    this.parts.composer!.setAttribute("aria-expanded", "false");
    this.parts.composer!.removeAttribute("aria-activedescendant");
  }

  /** Puts the module's mention for someone in place of the "@name" typed, followed by a space. */
  private pickMention(picked: MentionCandidate, start: number): void {
    const field = this.parts.composer as HTMLTextAreaElement;
    const cursor = field.selectionStart;
    const value = `${field.value.slice(0, start)}${picked.text} ${field.value.slice(cursor)}`;
    this.closeMention();
    if (value.length > MAX_MESSAGE_LENGTH) return;
    field.value = value;
    field.selectionStart = field.selectionEnd = start + picked.text.length + 1;
    field.focus();
  }

  /** The suggestion list's keys: arrows move, Enter or Tab picks, Escape closes. Whether the key was the list's. */
  private mentionKey(event: KeyboardEvent): boolean {
    const mention = this.mention!;
    const count = mention.options.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        mention.active = (mention.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        this.renderMention();
        break;
      case "Enter":
      case "Tab":
        if (event.shiftKey) return false;
        this.pickMention(mention.options[mention.active]!, mention.start);
        break;
      case "Escape":
        this.closeMention();
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  }

  /** The divider before the first unread message, where it is rendered. */
  private get unreadDivider(): HTMLElement | null {
    return this.parts.messages!.querySelector<HTMLElement>(".unread-divider");
  }

  /** Brings the first unread message into sight, loading older messages until it is there (up to MAX_UNREAD_PAGES). */
  private jumpToUnread(): void {
    const divider = this.unreadDivider;
    if (divider) return this.showUnread(divider);
    this.seeking = { pages: 0, from: undefined };
    this.seekUnread();
  }

  private showUnread(divider: HTMLElement): void {
    this.seeking = undefined;
    this.parts.messages!.scrollTop = Math.max(0, divider.offsetTop - 8);
    this.updateJumps();
  }

  /** One more page while seeking the first unread message: asked once the last one has arrived, until there are none older or enough were asked. */
  private seekUnread(): void {
    const seeking = this.seeking!;
    const channel = this.lastState?.channel;
    const first = channel?.messages[0]?.id;
    if (!channel?.hasOlder || seeking.pages >= MAX_UNREAD_PAGES) {
      this.seeking = undefined;
      return;
    }
    if (channel.loading || (seeking.pages > 0 && first === seeking.from)) return;
    seeking.pages++;
    seeking.from = first;
    this.api.act({ type: "loadOlder" });
  }

  /**
   * The unread bar shows while where the news starts is above what is in
   * sight (or not loaded yet), until dismissed or read on from there to the
   * latest messages; "Jump to present" while the latest messages are more
   * than a screen below.
   */
  private updateJumps(): void {
    const scroller = this.parts.messages!;
    const below = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const divider = this.unreadDivider;
    const inSight = divider !== null && divider.offsetTop + divider.offsetHeight >= scroller.scrollTop;
    if (inSight) this.dividerSeen = true;
    if (this.dividerSeen && below < 40) this.unreadDone = true;
    this.parts.unreadBar!.hidden = !this.unread || this.unreadDone || inSight;
    this.parts.unreadText!.textContent = newMessagesText(this.unread?.count);
    this.parts.jumpPresent!.hidden = below <= scroller.clientHeight;
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

  /** Media already asked of the engine: the view re-renders often, the engine needs asking once (and a failed load is not asked again). */
  private readonly mediaAsked = new Set<string>();
  /** This service's limit for media that loads by itself, in bytes; nothing until the shell says. */
  private autoLoadLimit = 0;
  /** Media in sight that loads by itself, waiting for a place. */
  private autoQueue: string[] = [];
  /** Media loading by itself now, each with the timer that frees its place if the engine never answers. */
  private readonly autoLoading = new Map<string, ReturnType<typeof setTimeout>>();
  /** Watches the messages for media that loads by itself coming into sight. */
  private observer: IntersectionObserver | undefined;

  /** The shell's limit for media that loads by itself changed. */
  setMediaAutoLoad(limit: number): void {
    this.autoLoadLimit = limit;
    this.rerender();
  }

  private queueAutoLoad(key: string): void {
    if (this.mediaAsked.has(key) || this.autoQueue.includes(key)) return;
    this.autoQueue.push(key);
    this.pumpAutoLoads();
  }

  /** Asks for waiting media, MAX_AUTO_LOADS at a time, so a conversation full of it does not ask for everything at once. */
  private pumpAutoLoads(): void {
    while (this.autoLoading.size < MAX_AUTO_LOADS && this.autoQueue.length > 0) {
      const key = this.autoQueue.shift()!;
      this.autoLoading.set(key, setTimeout(() => this.autoLoaded(key), AUTO_LOAD_TIMEOUT_MS));
      this.messageHandlers.onLoadMedia!(key);
    }
  }

  private autoLoaded(key: string): void {
    clearTimeout(this.autoLoading.get(key));
    this.autoLoading.delete(key);
    this.pumpAutoLoads();
  }

  /**
   * After a render: media the engine has answered (shown, or failed) or that
   * left the conversation frees its place, and media that loads by itself
   * is asked for once it comes into sight (all of it where nothing can tell).
   */
  private watchAutoLoads(scroller: HTMLElement, channel: ChatState["channel"]): void {
    const held = new Set((channel?.messages ?? []).flatMap((m) => m.attachments.flatMap((a) => (a.mediaKey && !a.url ? [a.mediaKey] : []))));
    this.autoQueue = this.autoQueue.filter((key) => held.has(key));
    for (const key of [...this.autoLoading.keys()]) if (!held.has(key)) this.autoLoaded(key);
    const waiting = [...scroller.querySelectorAll<HTMLElement>("[data-auto-load]")];
    const Observer: typeof IntersectionObserver | undefined = this.doc.defaultView!.IntersectionObserver;
    if (!Observer) {
      for (const item of waiting) this.queueAutoLoad(item.dataset.autoLoad!);
      return;
    }
    this.observer ??= new Observer(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) this.queueAutoLoad((entry.target as HTMLElement).dataset.autoLoad!);
      },
      { root: scroller, rootMargin: "200px" },
    );
    this.observer.disconnect();
    for (const item of waiting) this.observer.observe(item);
  }

  private readonly messageHandlers: MessageHandlers = {
    onLoadMedia: (key) => {
      if (this.mediaAsked.has(key)) return;
      this.mediaAsked.add(key);
      // Asked for now (e.g. by the picker): it no longer waits for a place.
      this.autoQueue = this.autoQueue.filter((queued) => queued !== key);
      this.api.act({ type: "loadMedia", key });
    },
    autoLoad: (file) => autoLoads(file, this.autoLoadLimit),
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
    onOpenProfile: (message) => this.openProfile({ id: message.authorId!, name: message.author, avatarUrl: message.avatarUrl }),
    isFavourite: (file) => this.favourites?.items.some((i) => i.origin === file.url) === true,
    onFavourite: (file, kind) => {
      const saved = this.favourites?.items.find((i) => i.origin === file.url);
      if (saved) return this.favouritesAct({ type: "remove", id: saved.id });
      const name = file.name.trim().slice(0, 100) || "Media";
      const place = this.lastState?.channel?.name.trim().slice(0, 100);
      this.favouritesAct(place ? { type: "add", url: file.url!, kind, name, place } : { type: "add", url: file.url!, kind, name });
    },
  };

  /** What the open conversation allows; nothing while none is open. */
  private get can(): Required<NativeChannelCan> {
    return channelCan(this.lastState?.channel?.can);
  }

  private messageItem(message: NativeMessage): HTMLElement {
    const editing = message.id === this.editingId;
    const editBox = this.parts.editBox as HTMLTextAreaElement;
    if (editing) queueMicrotask(() => editBox.focus());
    const handlers = this.favouritesOn ? this.messageHandlers : { ...this.messageHandlers, onFavourite: undefined };
    return messageItem(this.doc, message, handlers, {
      customEmojiUrl: (id, animated) => this.emojiUrl(id, animated),
      editor: editing ? [editBox, el(this.doc, "p", "edit-hint", "Enter to save, Escape to cancel")] : undefined,
      can: this.can,
      reacting: this.pickerFor === message.id,
      reactionPicker:
        this.fullPickerFor === message.id
          ? emojiPicker(
              this.doc,
              (picked) => this.messageHandlers.onReact(message, picked.key, !isOwnReaction(message.reactions, picked.key)),
              this.customEmoji().filter((e) => e.react),
              this.badge,
            )
          : undefined,
    });
  }

  /** The member panel: shown while the module lists the open conversation's members, where it can. */
  private updateMembers(): void {
    const toggle = this.parts.membersToggle as HTMLButtonElement;
    const panel = this.parts.members!;
    const channel = this.lastState?.channel;
    const list = channel && this.can.members ? memberList(channel.members) : undefined;
    toggle.hidden = !channel || !this.can.members;
    toggle.setAttribute("aria-pressed", String(Boolean(list)));
    panel.hidden = !list;
    if (!list) return panel.replaceChildren();
    // Rebuilt on every update: give focus back to the control that had it.
    const focused = this.doc.activeElement;
    const focusKey = focused instanceof HTMLElement && panel.contains(focused) ? (focused.dataset.id ?? focused.className) : undefined;
    const listed = list.sections.reduce((sum, section) => sum + section.members.length, 0);
    panel.replaceChildren(
      ...memberPanel(this.doc, list, {
        onOpen: (member) => this.openProfile(member),
        onLoadMore: () => this.api.act({ type: "loadMembers", offset: listed }),
      }),
    );
    if (focusKey === undefined) return;
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.dataset.id ?? b.className) === focusKey && !b.disabled)?.focus();
  }

  /** Opens someone's card at once with what the view knows, and asks the module for the rest. */
  private openProfile(seed: ProfileCardData): void {
    this.profileFor = seed;
    this.focusProfile = true;
    this.api.act({ type: "profile", id: seed.id });
    this.updateProfile();
  }

  private closeProfile(): void {
    this.profileFor = undefined;
    this.updateProfile();
  }

  /** The profile card: what it was opened with, plus the module's answer once it is about the same person. */
  private updateProfile(): void {
    const card = this.parts.profile!;
    const seed = this.profileFor;
    card.hidden = !seed;
    if (!seed) return card.replaceChildren();
    const answer = memberProfile(this.lastState?.profile);
    const data: ProfileCardData = answer?.id === seed.id ? { ...seed, ...answer, name: answer.name ?? seed.name } : seed;
    const focus = this.focusProfile || card.contains(this.doc.activeElement);
    this.focusProfile = false;
    card.replaceChildren(...profileCard(this.doc, data, () => this.closeProfile()));
    if (focus) card.querySelector<HTMLButtonElement>(".profile-close")!.focus();
  }

  private updateChat(state: ChatState): void {
    this.lastState = state;
    const { title, list, me, heading, banner, messages, composer, attach } = this.parts as Record<string, HTMLElement>;
    if (state.channel?.id !== this.channelId) {
      // A reply, edit or open picker belongs to the channel it started in.
      this.replyTo = undefined;
      this.parts.reply!.hidden = true;
      this.editingId = undefined;
      this.pickerFor = undefined;
      this.fullPickerFor = undefined;
      this.profileFor = undefined;
      this.closePicker();
      this.closeMention();
    }
    title!.textContent = state.title;
    me!.textContent = state.me;
    banner!.textContent = state.error ?? "";
    banner!.hidden = !state.error;
    list!.replaceChildren(
      ...channelList(this.doc, state.sidebar, {
        onSelect: (channelId) => this.api.act({ type: "select", channelId }),
        onJoinVoice: (channelId) => this.api.act({ type: "joinVoice", channelId }),
        onMute: (channelId, mute) => this.api.act({ type: "mute", channelId, mute }),
      }),
    );

    const channel = state.channel;
    heading!.textContent = channel ? channel.name : "Select a conversation";
    this.updateMembers();
    this.updateProfile();
    this.parts.typing!.textContent = typingText(channel?.typing ?? []);

    const uploading = channel?.uploading ?? false;
    const locked = channel?.locked;
    const notice = this.parts.notice!;
    notice.textContent = locked ?? "";
    notice.hidden = !locked;
    const field = composer as HTMLTextAreaElement;
    // Forums take posts through their own form, not the composer.
    field.disabled = !channel || uploading || Boolean(channel.posts) || Boolean(locked);
    (attach as HTMLButtonElement).disabled = !channel || uploading || Boolean(locked);
    // Hidden, not just off, where the module takes no files at all.
    attach!.hidden = Boolean(channel) && !this.can.attach;
    (this.parts.emoji as HTMLButtonElement).disabled = field.disabled;
    if (field.disabled) this.closePicker();
    this.picker?.update(this.pickerData());
    // New messages or members may change who fits the mention being typed.
    if (this.mention) this.updateMention(true);
    field.placeholder = channel && !locked ? `Message ${channel.name}` : "";
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
    const unread = channel ? unreadMarker(channel.unread, channel.messages) : undefined;
    for (const message of channel?.messages ?? []) {
      // Where the news started when the conversation was opened.
      if (message.id === unread?.firstId) {
        const divider = el(this.doc, "li", "unread-divider", newMessagesText(unread.count));
        divider.setAttribute("role", "separator");
        items.push(divider);
      }
      items.push(this.messageItem(message));
    }
    scroller.replaceChildren(...items);
    this.watchAutoLoads(scroller, channel);

    const first = channel?.messages[0]?.id;
    const switched = channel?.id !== this.channelId;
    const prepended = !switched && first !== this.firstMessageId;
    if (switched) {
      // A conversation opened with news: its first unread message comes into sight once loaded.
      this.unreadPending = unread !== undefined;
      this.unreadDone = unread === undefined;
      this.dividerSeen = false;
      this.seeking = undefined;
    }
    this.unread = unread;
    const divider = this.unreadDivider;
    if (this.unreadPending && divider) {
      this.unreadPending = false;
      this.showUnread(divider);
    } else if (switched || atBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (prepended) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    // Loaded without it: it is above, and the bar offers to go there.
    if (channel && !channel.loading && channel.messages.length > 0) this.unreadPending = false;
    this.channelId = channel?.id;
    this.firstMessageId = first;
    if (this.seeking) {
      if (divider) this.showUnread(divider);
      else this.seekUnread();
    }
    this.updateJumps();
  }
}

export function startNative(
  doc: Document,
  api: NativeApi,
  denoiser?: ConstructorParameters<typeof VoiceCall>[5],
  e2eeWorker?: ConstructorParameters<typeof VoiceCall>[6],
): void {
  const view = new NativeView(doc.getElementById("app")!, api, denoiser, e2eeWorker);
  api.onState((state) => view.update(state));
  api.onVoiceSettings((settings) => view.setVoiceSettings(settings));
  api.onMediaAutoLoad((limit) => view.setMediaAutoLoad(limit));
  api.onFavourites((favourites) => view.setFavourites(favourites));
  // Beside the unified Messages list, the conversation list here would repeat it.
  api.onCompact((compact) => doc.body.classList.toggle("compact", compact));
  // Screen shares here get system sound the same way Discord's do.
  screenAudioPatch(VIRTUAL_MIC, SCREEN_AUDIO_END_EVENT);
  doc.addEventListener(SCREEN_AUDIO_END_EVENT, () => api.screenAudioEnded());
  api.onVoiceCommand((command) => view.voiceCommand(command));
  doc.addEventListener("keydown", (event) => {
    if (!event.repeat) view.pushToTalk(event.code, true);
  });
  doc.addEventListener("keyup", (event) => view.pushToTalk(event.code, false));
  doc.defaultView!.addEventListener("blur", () => view.releaseTalk());
  api.act({ type: "ready" });
}
