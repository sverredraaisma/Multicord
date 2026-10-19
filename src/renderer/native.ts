import { screenAudioPatch } from "../shared/screenAudio";
import { SCREEN_AUDIO_END_EVENT, VIRTUAL_MIC } from "../shared/ipc";
import type { NativeApi } from "../preload/native";
import type { FavouritesAction, FavouritesState } from "../shared/favourites";
import type { NativeChannelCan, NativeChannelView, NativeListedMessage, NativeMessage, NativeViewState, PickerEmoji } from "../shared/native";
import { channelCan, chatFolders, customEmojiList, emojiUrls, gifResults, incomingCall, isAudioRoutes, voiceConnected, MAX_JOIN_ADDRESS, MAX_MESSAGE_LENGTH, memberList, MAX_SEARCH_QUERY, memberProfile, messageEmbeds, messageList, searchResults, stickerPacks, threadView, unreadMarker, type NativeUnread } from "../shared/native";
import { isTheme, type VoiceCommand, type VoiceSettings } from "../shared/settings";
import { loginForm, mfaForm, promptForm, setFormMessage, setIdentityKind, setPromptQr, type LoginForm } from "./components/auth";
import { channelList, folderTabs } from "./components/channels";
import { applyTheme, el, icon, ICONS } from "./components/dom";
import { emojiPicker, type SourceBadge } from "./components/emojiPicker";
import { MediaPicker, type MediaPickerData, type MediaPickerHandlers, type RecentMedia } from "./components/mediaPicker";
import { typingText } from "./components/format";
import { memberPanel, profileCard, type ProfileCardData } from "./components/members";
import { matchMentions, mentionCandidates, mentionOptionId, mentionOptions, mentionQuery, type MentionCandidate } from "./components/mentions";
import { autoLoads, favouriteKind, messageItem, type MessageHandlers } from "./components/message";
import { callStrip, forumPosts, listedMessages, pendingFiles, pollForm, postForm, replyBar, voicePanel, type VoiceHandlers, type VoicePanelOptions } from "./components/panels";
import { isOwnReaction } from "./components/reactions";
import { attachMobilePanes } from "./mobilePanes";
import { relayWebSockets } from "./relaySockets";
import { PeerCall } from "./peerCall";
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
/** Marks the thread panel's messages in the view's per-message state (editing, reaction pickers), apart from the conversation's. */
const THREAD_KEY = "t:";
/** Pages of older messages a jump to a pinned message or search result loads at most. */
export const MAX_JUMP_PAGES = 20;

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
  /** The open conversation's last message when last drawn, to tell screen readers of the next one. */
  private lastSeen: { channelId: string; messageId: string | undefined; loading: boolean } | undefined;
  private firstMessageId: string | undefined;
  private replyTo: { id: string; author: string } | undefined;
  /** The message being edited, and the reaction palette and full picker open, by message id; in the thread panel, prefixed with THREAD_KEY. */
  private editingId: string | undefined;
  private pickerFor: string | undefined;
  private fullPickerFor: string | undefined;
  private lastState: ChatState | undefined;
  /** Whose profile card is open, as it was opened. */
  private profileFor: ProfileCardData | undefined;
  /** The card just opened: its close button takes focus. */
  private focusProfile = false;
  /** The call ringing now (channel, caller, video), to announce each new one once. */
  private ringingKey: string | undefined;
  /** What opened the profile card or the forward dialog, for focus to return to when it closes. */
  private cardOpener: HTMLElement | undefined;
  private call: VoiceCall | undefined;
  /** Peer-to-peer calls (Nerimity's), beside the voice-server ones. */
  private peerCall: PeerCall | undefined;
  private voiceSettings: VoiceSettings | undefined;
  private voiceOptions: VoicePanelOptions = {};
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
  /**
   * Older pages are being loaded to find the first unread message, or a
   * listed message (`target`) the user jumped to: how many were asked for,
   * and the first message when the last was asked.
   */
  private seeking: { pages: number; from: string | undefined; target?: NativeListedMessage } | undefined;
  /** The message last jumped to from the side panel, marked until the next jump or another conversation. */
  private jumpedId: string | undefined;
  /** Why the last jump did not arrive, shown in the side panel. */
  private jumpNote: string | undefined;
  /** The message being forwarded, while the choice of where is open. */
  private forwardFor: NativeMessage | undefined;
  /** The search panel is open in this conversation. */
  private searchOpen = false;
  /** A search was sent since it opened, so the module has results to drop when it closes. */
  private searched = false;
  /** The thread the side panel shows, by its root message. */
  private threadRoot: string | undefined;
  /** The message in the thread that its composer's reply answers. */
  private threadReplyTo: { id: string; author: string } | undefined;
  /** The new poll form is open, for the open conversation. */
  private pollOpen = false;
  /** The mention being typed in the composer, while it has suggestions: where its "@" is, who fits, and the highlighted one. */
  private mention: { start: number; options: MentionCandidate[]; active: number } | undefined;
  /** Sidebar categories the user folded away (true) or opened (false), by id; the rest start as the module says. */
  private readonly folded = new Map<string, boolean>();

  constructor(
    private readonly root: HTMLElement,
    private readonly api: Pick<NativeApi, "act"> & Partial<Pick<NativeApi, "favourites">>,
    private readonly denoiser?: ConstructorParameters<typeof VoiceCall>[5],
    /** Starts LiveKit's end-to-end encryption worker, for encrypted calls. */
    private readonly e2eeWorker?: ConstructorParameters<typeof VoiceCall>[6],
  ) {}

  /** How the call controls differ on this host (a phone: no screen sharing, audio routes). */
  setVoiceOptions(options: VoicePanelOptions): void {
    this.voiceOptions = options;
    this.rerender();
  }

  /** The favourites changed: stars in messages and the open picker follow. */
  setFavourites(state: FavouritesState): void {
    this.favourites = state;
    this.rerender();
  }

  /** Devices and processing for calls, from the app settings. */
  setVoiceSettings(settings: VoiceSettings): void {
    this.voiceSettings = settings;
    void this.call?.configure(settings);
    void this.peerCall?.configure(settings);
  }

  /** The call in progress, if the voice server has connected us. */
  private get liveCall() {
    const voice = this.screen === "chat" ? this.lastState?.voice : undefined;
    return voice && voiceConnected(voice) ? voice : undefined;
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
        setPromptQr(this.parts.form!, state.prompt.qr);
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
    void this.peerCall?.sync(null);
    this.peerCall = undefined;
    this.screen = state.screen;
    this.promptId = state.screen === "prompt" ? state.prompt.id : undefined;
    this.parts = {};
    this.login = undefined;
    this.channelId = undefined;
    this.firstMessageId = undefined;
    this.mention = undefined;
    // They watched the old messages lists.
    this.observer?.disconnect();
    this.observer = undefined;
    this.threadObserver?.disconnect();
    this.threadObserver = undefined;
    const doc = this.doc;
    // The whole screen: its main landmark.
    const card = el(doc, "main", "card");
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
        // The screen's heading, for screen readers' heading navigation; the status line says the rest.
        card.append(el(doc, "h1", "visually-hidden", "Connecting"), el(doc, "div", "spinner"), status);
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
    // The screen's heading, for screen readers: the sidebar (and its title) is out of sight on a phone's conversation pane.
    // In a banner landmark of its own, as everything on the page sits in one.
    const pageTitle = el(doc, "h1");
    const pageHeader = el(doc, "header", "visually-hidden");
    pageHeader.append(pageTitle);
    const list = el(doc, "ul", "channels");
    const me = el(doc, "span", "me");
    const logout = el(doc, "button", "link", "Sign out");
    logout.addEventListener("click", () => this.api.act({ type: "logout" }));
    const footer = el(doc, "footer", "account");
    footer.append(me, logout);
    const voice = el(doc, "section", "voice-panel");
    voice.hidden = true;
    // Who is in a peer-to-peer call, kept by the call itself and shown in the call panel.
    const roster = el(doc, "ul", "voice-roster");
    roster.setAttribute("aria-label", "In the call");
    roster.hidden = true;
    this.parts.roster = roster;
    // Joining a conversation by its address, where the module offers it; kept across updates so typing is never lost.
    const joinForm = el(doc, "form", "join-form");
    joinForm.hidden = true;
    const joinInput = el(doc, "input", "join-input");
    joinInput.maxLength = MAX_JOIN_ADDRESS;
    joinInput.setAttribute("aria-label", "Join a conversation by its address");
    const joinSubmit = el(doc, "button", "join-submit", "Join");
    joinSubmit.type = "submit";
    joinForm.append(joinInput, joinSubmit);
    joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const address = joinInput.value.trim();
      if (address === "" || /\s/.test(address)) return;
      this.api.act({ type: "joinAddress", address });
      joinInput.value = "";
    });
    // The user's folders, where the module has them: tabs that pick which the sidebar shows.
    const folders = el(doc, "div", "folder-tabs");
    folders.setAttribute("role", "group");
    folders.setAttribute("aria-label", "Folders");
    folders.hidden = true;
    sidebar.append(title, folders, list, joinForm, voice, footer);

    const main = el(doc, "main", "conversation");
    const header = el(doc, "header", "conversation-title");
    const heading = el(doc, "h2", "conversation-name");
    // Shows and hides who is here, where the conversation lists them.
    const membersToggle = el(doc, "button", "members-toggle");
    membersToggle.type = "button";
    membersToggle.title = "Member list";
    membersToggle.setAttribute("aria-label", "Member list");
    membersToggle.setAttribute("aria-controls", "member-panel");
    membersToggle.append(icon(doc, "members-icon", ICONS.members));
    membersToggle.addEventListener("click", () => this.api.act({ type: "members", open: membersToggle.getAttribute("aria-pressed") !== "true" }));
    // Shows and hides the pinned messages, where the conversation lists them.
    const pinsToggle = el(doc, "button", "pins-toggle");
    pinsToggle.type = "button";
    pinsToggle.title = "Pinned messages";
    pinsToggle.setAttribute("aria-label", "Pinned messages");
    pinsToggle.setAttribute("aria-controls", "message-panel");
    pinsToggle.append(icon(doc, "members-icon", ICONS.pin));
    pinsToggle.addEventListener("click", () => {
      const open = pinsToggle.getAttribute("aria-pressed") !== "true";
      if (this.searchOpen) this.closeSearch();
      this.api.act({ type: "pins", open });
    });
    // Searches the conversation, where the module can.
    const searchToggle = el(doc, "button", "search-toggle");
    searchToggle.type = "button";
    searchToggle.title = "Search";
    searchToggle.setAttribute("aria-label", "Search this conversation");
    searchToggle.setAttribute("aria-controls", "message-panel");
    searchToggle.append(icon(doc, "members-icon", ICONS.search));
    searchToggle.addEventListener("click", () => this.toggleSearch());
    // Starts or joins a call in the conversation, where the module can.
    const callButton = el(doc, "button", "call-button");
    callButton.type = "button";
    callButton.title = "Call";
    callButton.setAttribute("aria-label", "Start or join a call here");
    callButton.append(icon(doc, "members-icon", ICONS.call));
    callButton.addEventListener("click", () => {
      const channelId = this.lastState?.channel?.id;
      if (channelId) this.api.act({ type: "joinVoice", channelId });
    });
    header.append(heading, callButton, searchToggle, pinsToggle, membersToggle);
    // The search field, kept across updates so typing is never lost; shown in the side panel.
    const searchForm = el(doc, "form", "search-form");
    searchForm.setAttribute("role", "search");
    const searchInput = el(doc, "input", "search-input");
    searchInput.type = "search";
    searchInput.maxLength = MAX_SEARCH_QUERY;
    searchInput.placeholder = "Search this conversation";
    searchInput.setAttribute("aria-label", "Search this conversation");
    searchForm.append(searchInput);
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = searchInput.value.trim();
      if (query === "") return;
      this.searched = true;
      this.jumpNote = undefined;
      this.api.act({ type: "search", query });
    });
    const banner = el(doc, "div", "banner");
    // A call ringing for the user, with Accept and Decline: above dialogs and side panels, which make room for it.
    const callBar = el(doc, "div", "call-bar");
    callBar.setAttribute("role", "group");
    callBar.setAttribute("aria-label", "Incoming call");
    callBar.hidden = true;
    // Says a new call once, at once: the bar itself is redrawn and hidden, so it cannot be the live region.
    const callAnnouncer = el(doc, "div", "visually-hidden");
    callAnnouncer.setAttribute("role", "alert");
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
    // A peer-to-peer call shows and plays in places of its own, so neither call clears the other's.
    const peerStage = el(doc, "div", "voice-stage");
    peerStage.hidden = true;
    const peerSpeakers = el(doc, "div", "voice-speakers");
    peerSpeakers.hidden = true;
    this.peerCall = new PeerCall(
      peerStage,
      peerSpeakers,
      roster,
      (message, notice) => this.api.act(notice ? { type: "voiceNotice", message, ...notice } : { type: "voiceError", message }),
      (to, signal) => this.api.act({ type: "voiceSignal", to, signal }),
      undefined,
      this.denoiser,
      (signal) => this.api.act({ type: "sfuSignal", signal }),
    );
    if (this.voiceSettings) void this.peerCall.configure(this.voiceSettings);
    const reply = el(doc, "div", "reply-bar");
    reply.hidden = true;

    const composer = el(doc, "textarea", "composer");
    composer.maxLength = MAX_MESSAGE_LENGTH;
    composer.rows = 1;
    // Typing "@" and a name suggests people to mention, from the list below the composer.
    composer.setAttribute("aria-autocomplete", "list");
    // A textarea takes no aria-expanded (no combobox role): the highlighted suggestion is its aria-activedescendant.
    composer.setAttribute("aria-controls", "mention-list");
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
    // New messages, read out by screen readers: the list is redrawn on every update, so it cannot be a live region itself.
    const announcer = el(doc, "div", "visually-hidden");
    announcer.setAttribute("role", "status");
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
    // A new poll, where the conversation takes them.
    const pollButton = el(doc, "button", "poll-button", "📊");
    pollButton.type = "button";
    pollButton.title = "Create a poll";
    pollButton.setAttribute("aria-label", "Create a poll");
    pollButton.setAttribute("aria-haspopup", "dialog");
    pollButton.hidden = true;
    pollButton.addEventListener("click", () => this.setPollOpen(!this.pollOpen));
    const composerRow = el(doc, "div", "composer-row");
    composerRow.append(attach, pollButton, composer, emoji, composerPicker, mentionList);
    // Why the composer is off in a conversation that takes no messages from here.
    const notice = el(doc, "div", "locked-notice");
    notice.hidden = true;
    main.append(header, banner, callBar, callAnnouncer, stage, peerStage, messageArea, typing, announcer, reply, pending, notice, composerRow, speakers, peerSpeakers);

    // One edit box, reused across renders so an edit in progress survives updates.
    const editBox = el(doc, "textarea", "edit-box");
    editBox.maxLength = MAX_MESSAGE_LENGTH;
    editBox.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return this.setEditing(undefined);
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const content = editBox.value;
      if (this.editingId && content.trim() !== "") this.api.act({ type: "edit", messageId: this.editingId.replace(THREAD_KEY, ""), content });
      this.setEditing(undefined);
    });

    const members = el(doc, "aside", "member-panel");
    members.id = "member-panel";
    members.setAttribute("aria-label", "Members");
    members.hidden = true;
    members.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeMembers();
    });
    // Pinned messages, beside the conversation like the members.
    const messagePanel = el(doc, "aside", "member-panel message-panel");
    messagePanel.id = "message-panel";
    messagePanel.hidden = true;
    // Escape closes the search or the pinned messages, with focus back on the button that opened them.
    messagePanel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const toggle = this.searchOpen ? this.parts.searchToggle! : this.parts.pinsToggle!;
      if (this.searchOpen) this.closeSearch();
      else this.api.act({ type: "pins", open: false });
      toggle.focus();
    });
    // The panels sit beside the conversation, or over it where the window is narrow.
    const area = el(doc, "div", "conversation-area");
    // Someone's profile, opened from a message's author or a member row.
    const profile = el(doc, "section", "profile-card");
    profile.setAttribute("role", "dialog");
    profile.setAttribute("aria-labelledby", "profile-name");
    profile.hidden = true;
    profile.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeProfile();
    });
    // Where to forward a message: this module's other conversations.
    const forward = el(doc, "section", "profile-card forward-dialog");
    forward.setAttribute("role", "dialog");
    forward.setAttribute("aria-labelledby", "forward-title");
    forward.hidden = true;
    forward.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeForward();
    });
    // A message's thread: its messages, and a composer of its own, kept across updates so typing is never lost.
    const threadPanel = el(doc, "aside", "member-panel thread-panel");
    threadPanel.id = "thread-panel";
    threadPanel.setAttribute("aria-label", "Thread");
    threadPanel.hidden = true;
    const threadClose = el(doc, "button", "profile-close", "×");
    threadClose.type = "button";
    threadClose.setAttribute("aria-label", "Close thread");
    threadClose.addEventListener("click", () => this.api.act({ type: "thread" }));
    const threadStatus = el(doc, "div", "thread-status");
    const threadMessages = el(doc, "ol", "messages thread-messages");
    const threadNotice = el(doc, "div", "locked-notice");
    const threadReply = el(doc, "div", "reply-bar");
    threadReply.hidden = true;
    const threadComposer = el(doc, "textarea", "composer thread-composer");
    threadComposer.maxLength = MAX_MESSAGE_LENGTH;
    threadComposer.rows = 1;
    threadComposer.placeholder = "Reply in thread";
    threadComposer.setAttribute("aria-label", "Reply in thread");
    threadComposer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return this.threadReplyTo ? this.setThreadReply(undefined) : this.api.act({ type: "thread" });
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const content = threadComposer.value;
      if (content.trim() === "" || !this.threadRoot) return;
      const replyTo = this.threadReplyTo?.id;
      this.api.act(replyTo ? { type: "send", content, thread: this.threadRoot, replyTo } : { type: "send", content, thread: this.threadRoot });
      threadComposer.value = "";
      this.setThreadReply(undefined);
    });
    threadPanel.append(threadClose, el(doc, "h2", "member-section", "Thread"), threadStatus, threadMessages, threadNotice, threadReply, threadComposer);
    // The new poll form, over the conversation like the forward dialog.
    const pollDialog = el(doc, "section", "profile-card poll-dialog");
    pollDialog.setAttribute("role", "dialog");
    pollDialog.setAttribute("aria-labelledby", "poll-title");
    pollDialog.hidden = true;
    area.append(main, messagePanel, threadPanel, members, profile, forward, pollDialog);

    const layout = el(doc, "div", "chat");
    layout.append(pageHeader, sidebar, area);
    this.root.replaceChildren(layout);
    Object.assign(this.parts, {
      title,
      pageTitle,
      list,
      folders,
      joinForm,
      joinInput,
      me,
      heading,
      membersToggle,
      members,
      pinsToggle,
      searchToggle,
      searchForm,
      searchInput,
      messagePanel,
      threadPanel,
      threadStatus,
      threadMessages,
      threadNotice,
      threadReply,
      threadComposer,
      profile,
      forward,
      pollButton,
      pollDialog,
      banner,
      callBar,
      callAnnouncer,
      area,
      callButton,
      unreadBar,
      unreadText,
      jumpPresent,
      messages,
      typing,
      announcer,
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
    this.signalPicker();
    this.picker.show("emoji");
  }

  /** Whether the module was last told that a picker is open. */
  private pickerSignalled = false;

  /**
   * Tells the module when a picker opens or closes: the composer's, or a
   * message's full reaction picker, which lists the same custom emoji.
   */
  private signalPicker(): void {
    const open = this.picker !== undefined || this.fullPickerFor !== undefined;
    if (open === this.pickerSignalled) return;
    this.pickerSignalled = open;
    this.api.act({ type: "picker", open });
  }

  private closePicker(): void {
    const holder = this.parts.composerPicker;
    this.picker?.close();
    this.picker = undefined;
    this.signalPicker();
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
    this.parts.composer!.setAttribute("aria-activedescendant", mentionOptionId(active));
  }

  private closeMention(): void {
    this.mention = undefined;
    const list = this.parts.mentionList!;
    list.hidden = true;
    list.replaceChildren();
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
    if (divider) return this.showAt(divider);
    this.seeking = { pages: 0, from: undefined };
    this.seekOlder();
  }

  /** A loaded message's element, by its id. */
  private messageElement(id: string): HTMLElement | undefined {
    return [...this.parts.messages!.querySelectorAll<HTMLElement>("li.message")].find((li) => li.dataset.id === id);
  }

  /** Brings a listed message (a pinned one, a search result) into sight and marks it, loading older messages until it is there (up to MAX_JUMP_PAGES). */
  private jumpTo(message: NativeListedMessage): void {
    this.jumpedId = message.id;
    this.jumpNote = undefined;
    this.seeking = { pages: 0, from: undefined, target: message };
    this.rerender();
  }

  /**
   * A phone's compact call controls over the conversation, while the user is
   * in a call (only where the host asked for them: the desktop never does).
   * Made on first use, above the ringing bar, and kept with the chat screen.
   */
  private updateCallStrip(state: ChatState, handlers: VoiceHandlers): void {
    if (!this.voiceOptions.strip) return;
    let strip = this.parts.callStrip;
    if (!strip) {
      strip = el(this.doc, "div", "call-strip");
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", "Call");
      this.parts.callBar!.before(strip);
      this.parts.callStrip = strip;
    }
    const voice = state.voice;
    strip.hidden = !voice;
    strip.replaceChildren(...(voice ? callStrip(this.doc, voice, { ...handlers, onReturn: () => this.returnToCall(state, voice.channelId) }, this.voiceOptions) : []));
  }

  /**
   * Back to the call from a phone's strip: the conversation the call is in,
   * where it is one the list opens (a direct message's or a room's call);
   * else the conversation list with the full call panel (a voice channel's).
   */
  private returnToCall(state: ChatState, channelId: string): void {
    const row = state.sidebar.find((item) => item.id === channelId);
    if (row && row.kind !== "voice" && row.kind !== "category" && state.channel?.id !== channelId) {
      this.api.act({ type: "select", channelId });
      return;
    }
    this.voiceOptions.strip?.onReturn();
    const panel = this.parts.voice;
    if (panel && typeof panel.scrollIntoView === "function") panel.scrollIntoView({ block: "nearest" });
  }

  /**
   * The call button, where the conversation takes calls and the user is not
   * in its call already; and the bar for a call ringing for the user.
   */
  private updateCall(): void {
    const state = this.lastState!;
    const channel = state.channel;
    this.parts.callButton!.hidden = !channel || !this.can.call || state.voice?.channelId === channel.id;
    const ringing = incomingCall(state.incomingCall);
    const bar = this.parts.callBar!;
    const area = this.parts.area!;
    bar.hidden = !ringing;
    area.classList.toggle("ringing", Boolean(ringing));
    const key = ringing ? `${ringing.channelId}|${ringing.from}|${ringing.video === true}` : undefined;
    if (key !== this.ringingKey) {
      this.ringingKey = key;
      this.parts.callAnnouncer!.textContent = ringing ? `${ringing.from} is calling${ringing.video ? " with video" : ""}` : "";
    }
    if (!ringing) {
      delete bar.dataset.call;
      return bar.replaceChildren();
    }
    // Dialogs and side panels over the conversation start below the bar.
    area.style.setProperty("--ring-bottom", `${bar.offsetTop + bar.offsetHeight}px`);
    // The same call stays as it is, so focus on Accept or Decline survives updates.
    if (bar.dataset.call === key) return;
    bar.dataset.call = key;
    const button = (label: string, className: string, act: () => void) => {
      const b = el(this.doc, "button", className, label);
      b.type = "button";
      b.addEventListener("click", act);
      return b;
    };
    bar.replaceChildren(
      el(this.doc, "span", "call-from", `${ringing.from} is calling${ringing.video ? " with video" : ""}`),
      button("Accept", "call-accept", () => this.api.act({ type: "joinVoice", channelId: ringing.channelId })),
      button("Decline", "call-decline", () => this.api.act({ type: "declineCall", channelId: ringing.channelId })),
    );
  }

  /** The module's error; else, with no side panel to say it in, why the last jump (from a reply's quote) did not arrive. */
  private updateBanner(): void {
    const banner = this.parts.banner!;
    const text = this.lastState?.screen === "chat" ? (this.lastState.error ?? (this.parts.messagePanel!.hidden ? this.jumpNote : undefined)) : undefined;
    banner.textContent = text ?? "";
    banner.hidden = !text;
  }

  private showAt(element: HTMLElement): void {
    this.seeking = undefined;
    this.parts.messages!.scrollTop = Math.max(0, element.offsetTop - 8);
    this.updateJumps();
  }

  /**
   * One more page while seeking the first unread message or a listed one:
   * asked once the last one has arrived, until there are none older, enough
   * were asked, or messages from before the one sought are loaded without it.
   */
  private seekOlder(): void {
    const seeking = this.seeking!;
    const channel = this.lastState?.channel;
    const first = channel?.messages[0];
    const target = seeking.target;
    const passed = target !== undefined && first !== undefined && Date.parse(first.timestamp) < Date.parse(target.timestamp);
    if (!channel?.hasOlder || seeking.pages >= (target ? MAX_JUMP_PAGES : MAX_UNREAD_PAGES) || passed) {
      this.seeking = undefined;
      if (!target) return;
      this.jumpNote = "That message could not be loaded here.";
      this.updateMessagePanel();
      this.updateBanner();
      return;
    }
    if (channel.loading || (seeking.pages > 0 && first?.id === seeking.from)) return;
    seeking.pages++;
    seeking.from = first?.id;
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

  /** Opens or closes a message's reaction palette, by its key (messageItem). */
  private togglePicker(key: string): void {
    this.pickerFor = this.pickerFor === key ? undefined : key;
    this.fullPickerFor = undefined;
    this.signalPicker();
    this.rerender();
  }

  /** The thread composer's reply: which message of the thread it answers, shown above it. */
  private setThreadReply(target: { id: string; author: string } | undefined): void {
    this.threadReplyTo = target;
    const bar = this.parts.threadReply!;
    bar.hidden = !target;
    if (!target) return bar.replaceChildren();
    bar.replaceChildren(...replyBar(this.doc, target.author, () => this.setThreadReply(undefined)));
    this.parts.threadComposer!.focus();
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
  /** Watch the messages, and the thread panel's, for media that loads by itself coming into sight. */
  private observer: IntersectionObserver | undefined;
  private threadObserver: IntersectionObserver | undefined;

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
    // The panel shows only with a thread to show.
    const thread = this.parts.threadPanel!.hidden ? [] : threadView(channel!.thread)!.messages;
    const held = new Set(
      [...(channel?.messages ?? []), ...thread].flatMap((m) => [...m.attachments, ...messageEmbeds(m.embeds).flatMap((e) => (e.image ? [e.image] : []))].flatMap((a) => (a.mediaKey && !a.url ? [a.mediaKey] : []))),
    );
    this.autoQueue = this.autoQueue.filter((key) => held.has(key));
    for (const key of [...this.autoLoading.keys()]) if (!held.has(key)) this.autoLoaded(key);
    this.observeAutoLoads(scroller, "observer");
    this.observeAutoLoads(this.parts.threadMessages!, "threadObserver");
  }

  /** Asks for a list's media that loads by itself once it comes into sight there (all of it where nothing can tell). */
  private observeAutoLoads(scroller: HTMLElement, slot: "observer" | "threadObserver"): void {
    const waiting = [...scroller.querySelectorAll<HTMLElement>("[data-auto-load]")];
    const Observer: typeof IntersectionObserver | undefined = this.doc.defaultView!.IntersectionObserver;
    if (!Observer) {
      for (const item of waiting) this.queueAutoLoad(item.dataset.autoLoad!);
      return;
    }
    // Made once something waits in this list.
    if (waiting.length === 0 && !this[slot]) return;
    const observer = (this[slot] ??= new Observer(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) this.queueAutoLoad((entry.target as HTMLElement).dataset.autoLoad!);
      },
      { root: scroller, rootMargin: "200px" },
    ));
    observer.disconnect();
    for (const item of waiting) observer.observe(item);
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
    onToggleReactionPicker: (message) => this.togglePicker(message.id),
    onReact: (message, key, add) => {
      const pickerOpen = this.pickerFor !== undefined || this.fullPickerFor !== undefined;
      this.pickerFor = undefined;
      this.fullPickerFor = undefined;
      this.signalPicker();
      this.api.act({ type: "react", messageId: message.id, emoji: key, add });
      if (pickerOpen) this.rerender();
    },
    onMoreReactions: (message) => {
      this.fullPickerFor = message.id;
      this.signalPicker();
      this.rerender();
    },
    onEdit: (message) => this.setEditing(message.id, message.source ?? message.content),
    onDelete: (message) => {
      const win = this.doc.defaultView;
      if (!win?.confirm || win.confirm("Delete this message?")) this.api.act({ type: "delete", messageId: message.id });
    },
    onPin: (message, pin) => this.api.act({ type: "pin", messageId: message.id, pin }),
    onVote: (message, options) => this.api.act({ type: "vote", messageId: message.id, options }),
    onEndPoll: (message) => {
      const win = this.doc.defaultView;
      if (!win?.confirm || win.confirm("End this poll? Voting stops for everyone.")) this.api.act({ type: "endPoll", messageId: message.id });
    },
    onOpenThread: (message) => this.api.act({ type: "thread", rootId: message.id }),
    onForward: (message) => {
      this.cardOpener = this.focused();
      this.forwardFor = message;
      this.updateForward(true);
    },
    // The shell's clipboard, not the module: copied text goes wherever the user pastes it.
    onCopy: (message) => void this.doc.defaultView!.navigator.clipboard?.writeText(message.content).catch(() => undefined),
    onJumpToReply: (original) => this.jumpTo(original),
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

  /**
   * A message of the conversation, or of the thread panel (`inThread`): the
   * same menu, reactions and editing in both, kept apart by key (the root
   * shows in both). In the panel a reply answers within the thread, and
   * nothing is forwarded or opens another thread.
   */
  private messageItem(message: NativeMessage, inThread = false): HTMLElement {
    const key = inThread ? THREAD_KEY + message.id : message.id;
    const editing = key === this.editingId;
    const editBox = this.parts.editBox as HTMLTextAreaElement;
    if (editing) queueMicrotask(() => editBox.focus());
    let handlers = this.favouritesOn ? this.messageHandlers : { ...this.messageHandlers, onFavourite: undefined };
    if (inThread) {
      handlers = {
        ...handlers,
        onReply: (m) => this.setThreadReply({ id: m.id, author: m.author }),
        onToggleReactionPicker: () => this.togglePicker(key),
        onMoreReactions: () => {
          this.fullPickerFor = key;
          this.signalPicker();
          this.rerender();
        },
        onEdit: (m) => this.setEditing(key, m.source ?? m.content),
      };
    }
    const can = this.can;
    return messageItem(this.doc, message, handlers, {
      customEmojiUrl: (id, animated) => this.emojiUrl(id, animated),
      editor: editing ? [editBox, el(this.doc, "p", "edit-hint", "Enter to save, Escape to cancel")] : undefined,
      can: inThread ? { reply: can.reply, react: can.react, forward: false, threads: false } : can,
      highlighted: !inThread && message.id === this.jumpedId,
      reacting: this.pickerFor === key,
      reactionPicker:
        this.fullPickerFor === key
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
    // Its own way out: where the panel lies over the conversation (narrow windows, phones) it covers the toggle.
    const close = el(this.doc, "button", "profile-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close member list");
    close.addEventListener("click", () => this.closeMembers());
    panel.replaceChildren(
      close,
      ...memberPanel(this.doc, list, {
        onOpen: (member) => this.openProfile(member),
        onLoadMore: () => this.api.act({ type: "loadMembers", offset: listed }),
      }),
    );
    if (focusKey === undefined) return;
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.dataset.id ?? b.className) === focusKey && !b.disabled)?.focus();
  }

  private closeForward(): void {
    const hadFocus = this.parts.forward!.contains(this.doc.activeElement);
    this.forwardFor = undefined;
    this.updateForward();
    this.returnFocus(hadFocus);
  }

  /** The focused element, if any. */
  private focused(): HTMLElement | undefined {
    const active = this.doc.activeElement;
    return active instanceof HTMLElement && active !== this.doc.body ? active : undefined;
  }

  /**
   * After a card closed with focus inside it: focus back to what opened it,
   * while that is still on the page (lists are rebuilt on updates), else to the composer.
   */
  private returnFocus(hadFocus: boolean): void {
    const opener = this.cardOpener;
    this.cardOpener = undefined;
    if (!hadFocus) return;
    const composer = this.parts.composer as HTMLTextAreaElement;
    if (opener?.isConnected) opener.focus();
    else if (!composer.disabled) composer.focus();
  }

  /** Closes the member list, from its own button or Escape, with focus back on its toggle. */
  private closeMembers(): void {
    this.api.act({ type: "members", open: false });
    this.parts.membersToggle!.focus();
  }

  /**
   * The choice of where to forward a message: the other conversations in
   * this module's sidebar. Only within the module: another module's engine
   * never gets this one's messages; Copy text takes it anywhere instead.
   * Closed once the message or the conversation's forwarding is gone.
   */
  private updateForward(focus = false): void {
    const doc = this.doc;
    const dialog = this.parts.forward!;
    const channel = this.lastState?.channel;
    const message = this.forwardFor && channel && this.can.forward ? channel.messages.find((m) => m.id === this.forwardFor!.id) : undefined;
    this.forwardFor = message;
    dialog.hidden = !message;
    if (!message) return dialog.replaceChildren();
    const close = el(doc, "button", "profile-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closeForward());
    const title = el(doc, "h2", "profile-name", "Forward to");
    title.id = "forward-title";
    const what = el(doc, "p", "forward-what", `${message.author}: ${message.content.slice(0, 100) || "(attachments)"}`);
    // Not to an invitation the user has not accepted: they are not in that conversation yet.
    const targets = this.lastState!.sidebar.filter((item) => (item.kind === "text" || item.kind === "dm" || item.kind === "thread") && item.id !== channel!.id && !item.invite);
    const list = el(doc, "ul", "forward-targets");
    for (const target of targets) {
      const li = el(doc, "li");
      const button = el(doc, "button", "forward-target", target.name);
      button.type = "button";
      button.addEventListener("click", () => {
        this.api.act({ type: "forward", messageId: message.id, channelId: target.id });
        this.closeForward();
      });
      li.append(button);
      list.append(li);
    }
    const note = el(doc, "p", "member-note", targets.length > 0 ? "Only conversations of this service are listed; Copy text takes a message anywhere." : "No other conversation is listed here to forward to.");
    // Rebuilt on every update: give focus back to the button that had it.
    const focused = doc.activeElement;
    const kept = focused instanceof HTMLButtonElement && dialog.contains(focused) ? `${focused.className}|${focused.textContent}` : undefined;
    dialog.replaceChildren(close, title, what, list, note);
    const again = kept === undefined ? undefined : [...dialog.querySelectorAll("button")].find((b) => `${b.className}|${b.textContent}` === kept);
    if (focus || kept !== undefined) (again ?? dialog.querySelector<HTMLButtonElement>(".forward-target") ?? close).focus();
  }

  /** Opens the new poll form with its question in focus, or closes it, giving focus back to its button. */
  private setPollOpen(open: boolean): void {
    this.pollOpen = open;
    this.updatePoll();
    if (open) this.parts.pollDialog!.querySelector<HTMLInputElement>(".poll-question-input")?.focus();
    else this.parts.pollButton!.focus();
  }

  /**
   * The poll button, where the open conversation takes polls, and the new
   * poll form while it is open. The form is made when it opens and kept
   * across updates, so what is typed survives; it closes when the
   * conversation no longer takes a poll from here.
   */
  private updatePoll(): void {
    const button = this.parts.pollButton as HTMLButtonElement;
    const dialog = this.parts.pollDialog!;
    const channel = this.lastState?.channel;
    const usable = Boolean(channel) && this.can.polls && !channel!.locked && !channel!.posts;
    button.hidden = !usable;
    button.setAttribute("aria-expanded", String(this.pollOpen && usable));
    if (!usable) this.pollOpen = false;
    if (!this.pollOpen) {
      dialog.hidden = true;
      return dialog.replaceChildren();
    }
    if (!dialog.hidden) return;
    dialog.hidden = false;
    dialog.replaceChildren(
      pollForm(this.doc, this.can.anonymousPolls, {
        onCreate: (poll) => {
          this.api.act({ type: "createPoll", ...poll });
          this.setPollOpen(false);
        },
        onCancel: () => this.setPollOpen(false),
      }),
    );
  }

  /** Opens the search panel with its field in focus, or ends the search. */
  private toggleSearch(): void {
    if (this.searchOpen) return this.closeSearch();
    this.searchOpen = true;
    this.updateMessagePanel();
    this.parts.searchInput!.focus();
  }

  /** Ends the search: the module drops its results, if it was asked for any. */
  private closeSearch(): void {
    this.searchOpen = false;
    (this.parts.searchInput as HTMLInputElement).value = "";
    if (this.searched) this.api.act({ type: "search", query: "" });
    this.searched = false;
    this.updateMessagePanel();
  }

  /**
   * The side panel of messages: the search (its field and results) while it
   * is open, else the pinned messages while the module lists them, each
   * where the conversation offers it.
   */
  private updateMessagePanel(): void {
    const doc = this.doc;
    const pinsToggle = this.parts.pinsToggle as HTMLButtonElement;
    const searchToggle = this.parts.searchToggle as HTMLButtonElement;
    const panel = this.parts.messagePanel!;
    const channel = this.lastState?.channel;
    const searching = Boolean(channel) && this.can.search && this.searchOpen;
    const pins = channel && this.can.pins && !searching ? messageList(channel.pins) : undefined;
    pinsToggle.hidden = !channel || !this.can.pins;
    pinsToggle.setAttribute("aria-pressed", String(Boolean(pins)));
    searchToggle.hidden = !channel || !this.can.search;
    searchToggle.setAttribute("aria-pressed", String(searching));
    panel.hidden = !pins && !searching;
    if (panel.hidden) return panel.replaceChildren();
    // Rebuilt on every update: give focus back to the control that had it.
    const focused = doc.activeElement;
    const focusKey = focused instanceof HTMLElement && panel.contains(focused) ? (focused.dataset.id ?? focused.className) : undefined;
    const close = el(doc, "button", "profile-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => (searching ? this.closeSearch() : this.api.act({ type: "pins", open: false })));
    const title = searching ? "Search" : "Pinned messages";
    panel.setAttribute("aria-label", title);
    const parts: HTMLElement[] = [close, el(doc, "h2", "member-section", title)];
    if (searching) parts.push(this.parts.searchForm!);
    if (this.jumpNote) parts.push(el(doc, "p", "member-error", this.jumpNote));
    const excerpts = { customEmojiUrl: (id: string, animated: boolean) => this.emojiUrl(id, animated) };
    if (pins) parts.push(...listedMessages(doc, pins, (message) => this.jumpTo(message), "No pinned messages.", excerpts));
    const results = searching && this.searched ? searchResults(channel!.search) : undefined;
    if (results) parts.push(...listedMessages(doc, results, (message) => this.jumpTo(message), `No messages found for “${results.query}”.`, excerpts));
    panel.replaceChildren(...parts);
    if (focusKey === undefined) return;
    [...panel.querySelectorAll<HTMLElement>("button, input")].find((b) => (b.dataset.id ?? b.className) === focusKey)?.focus();
  }

  /**
   * The thread panel: the open thread's messages, with the conversation's
   * menu (reply within the thread, react, edit and delete the user's own),
   * media that loads by itself as in the conversation, and its composer, or
   * why nothing may be sent; shown while the module lists the thread.
   */
  private updateThread(): void {
    const panel = this.parts.threadPanel!;
    const list = this.parts.threadMessages!;
    const channel = this.lastState?.channel;
    const thread = channel && this.can.threads ? threadView(channel.thread) : undefined;
    panel.hidden = !thread;
    // Another thread, or none: a reply or edit begun in the last one is dropped.
    if (thread?.rootId !== this.threadRoot) {
      if (this.threadReplyTo) this.setThreadReply(undefined);
      if (this.editingId?.startsWith(THREAD_KEY)) this.editingId = undefined;
    }
    if (!thread) {
      this.threadRoot = undefined;
      return list.replaceChildren();
    }
    const doc = this.doc;
    const status = this.parts.threadStatus!;
    status.replaceChildren(...[thread.note && el(doc, "p", "panel-note", thread.note), thread.error && el(doc, "p", "member-error", thread.error)].filter((n): n is HTMLParagraphElement => Boolean(n)));
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const items = thread.messages.map((message) => this.messageItem(message, true));
    if (thread.loading) items.push(el(doc, "li", "older-row", "Loading…"));
    list.replaceChildren(...items);
    const notice = this.parts.threadNotice!;
    notice.textContent = thread.locked ?? "";
    notice.hidden = !thread.locked;
    const composer = this.parts.threadComposer as HTMLTextAreaElement;
    composer.hidden = Boolean(thread.locked);
    // The message answered left the thread, or nothing may be sent: the reply goes.
    if (this.threadReplyTo && (thread.locked || !thread.messages.some((m) => m.id === this.threadReplyTo!.id))) this.setThreadReply(undefined);
    // Another thread: the reply being written was for the last one.
    if (thread.rootId !== this.threadRoot) composer.value = "";
    if (thread.rootId !== this.threadRoot || atBottom) list.scrollTop = list.scrollHeight;
    this.threadRoot = thread.rootId;
  }

  /** Opens someone's card at once with what the view knows, and asks the module for the rest. */
  private openProfile(seed: ProfileCardData): void {
    this.cardOpener = this.focused();
    this.profileFor = seed;
    this.focusProfile = true;
    this.api.act({ type: "profile", id: seed.id });
    this.updateProfile();
  }

  private closeProfile(): void {
    const hadFocus = this.parts.profile!.contains(this.doc.activeElement);
    this.profileFor = undefined;
    this.updateProfile();
    this.returnFocus(hadFocus);
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

  /** The sidebar's rows, with the categories the user folded or opened as they chose. */
  private renderSidebar(list: HTMLElement, state: ChatState): void {
    const items = state.sidebar.map((item) => (item.kind === "category" && this.folded.has(item.id) ? { ...item, collapsed: this.folded.get(item.id) } : item));
    list.replaceChildren(
      ...channelList(this.doc, items, {
        onSelect: (channelId) => this.api.act({ type: "select", channelId }),
        onJoinVoice: (channelId) => this.api.act({ type: "joinVoice", channelId }),
        onMute: (channelId, mute) => this.api.act({ type: "mute", channelId, mute }),
        onArchive: (channelId, archive) => this.api.act({ type: "archive", channelId, archive }),
        onJoin: (channelId) => this.api.act({ type: "join", channelId }),
        onDecline: (channelId) => this.api.act({ type: "decline", channelId }),
        onFold: (categoryId, collapsed) => {
          this.folded.set(categoryId, collapsed);
          this.renderSidebar(list, this.lastState!);
          list.querySelector<HTMLButtonElement>(`.category-toggle[data-id="${CSS.escape(categoryId)}"]`)!.focus();
        },
      }),
    );
  }

  /**
   * Tells screen readers of a message that arrived in the open conversation
   * since the last update: not one of the user's own, not those of a
   * conversation just opened or still loading, nor older ones loaded above.
   */
  private announceNew(channel: NativeChannelView | null): void {
    const last = channel?.messages.at(-1);
    const seen = this.lastSeen;
    if (channel && last && seen && seen.channelId === channel.id && !seen.loading && last.id !== seen.messageId && !last.mine) {
      this.parts.announcer!.textContent = `${last.author}: ${last.content.slice(0, 200) || "(attachments)"}`;
    }
    this.lastSeen = channel ? { channelId: channel.id, messageId: last?.id, loading: channel.loading } : undefined;
  }

  private updateChat(state: ChatState): void {
    this.lastState = state;
    const { title, list, me, heading, messages, composer, attach } = this.parts as Record<string, HTMLElement>;
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
      this.jumpedId = undefined;
      this.jumpNote = undefined;
      // The module drops a search when another conversation opens.
      this.forwardFor = undefined;
      this.pollOpen = false;
      this.searchOpen = false;
      this.searched = false;
      (this.parts.searchInput as HTMLInputElement).value = "";
    }
    title!.textContent = state.title;
    this.parts.pageTitle!.textContent = state.title;
    me!.textContent = state.me;
    this.renderSidebar(list!, state);
    const folders = chatFolders(state.folders);
    this.parts.folders!.hidden = folders.length === 0;
    this.parts.folders!.replaceChildren(...folderTabs(this.doc, folders, (id) => this.api.act({ type: "folder", id })));
    const joinable = typeof state.joinAddress === "string" && state.joinAddress.trim() !== "";
    this.parts.joinForm!.hidden = !joinable;
    (this.parts.joinInput as HTMLInputElement).placeholder = joinable ? state.joinAddress!.slice(0, 100) : "";

    const channel = state.channel;
    heading!.textContent = channel ? channel.name : "Select a conversation";
    this.updateMembers();
    this.updateMessagePanel();
    this.updateBanner();
    this.updateCall();
    this.updateThread();
    this.updateForward();
    this.updatePoll();
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
    // Named also when the placeholder is empty (nothing open, or read only).
    field.setAttribute("aria-label", channel ? `Message ${channel.name}` : "Message");
    this.parts.pending!.replaceChildren(
      ...pendingFiles(this.doc, channel?.pending ?? [], uploading, (index) => this.api.act({ type: "removeAttachment", index })),
    );

    const voice = this.parts.voice!;
    const voiceHandlers: VoiceHandlers = {
      onChange: (flags) => this.api.act({ type: "voiceState", ...flags }),
      onLeave: () => this.api.act({ type: "leaveVoice" }),
    };
    voice.hidden = !state.voice;
    voice.replaceChildren(...(state.voice ? [...voicePanel(this.doc, state.voice, voiceHandlers, this.voiceOptions), this.parts.roster!] : []));
    this.updateCallStrip(state, voiceHandlers);
    // A session is one kind of call or the other; each runtime leaves when it is not its kind (the peer runtime runs SFU calls too).
    const p2p = state.voice?.p2p !== undefined || state.voice?.sfu !== undefined;
    void this.call?.sync(p2p ? null : state.voice);
    void this.peerCall?.sync(p2p ? state.voice : null);

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
        // A list item of its own (a separator role would leave the list with a child that is not an item).
        const divider = el(this.doc, "li", "unread-divider", newMessagesText(unread.count));
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
      this.showAt(divider);
    } else if (switched || atBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (prepended) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    // Loaded without it: it is above, and the bar offers to go there.
    if (channel && !channel.loading && channel.messages.length > 0) this.unreadPending = false;
    this.announceNew(channel);
    this.channelId = channel?.id;
    this.firstMessageId = first;
    if (this.seeking) {
      const found = this.seeking.target ? this.messageElement(this.seeking.target.id) : divider;
      if (found) this.showAt(found);
      else this.seekOlder();
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
  // The phone opens the view's WebSockets (a call's voice server) itself, with the engine's host policy.
  if (api.sockets) relayWebSockets(doc.defaultView!, api.sockets);
  const view = new NativeView(doc.getElementById("app")!, api, denoiser, e2eeWorker);
  api.onState((state) => view.update(state));
  // The phone's bridge: one pane at a time, and the system's back.
  if (api.onBack) {
    const panes = attachMobilePanes(doc, { onState: (cb) => api.onState(cb), onBack: api.onBack });
    // A phone's WebView has no getDisplayMedia: no screen sharing. Calls play where the phone routes them.
    // The full call panel is in the conversation list; over a conversation, compact controls stand in for it.
    const phone = { screenShare: false, strip: { onReturn: () => panes.showList() } };
    view.setVoiceOptions(phone);
    // The theme setting, from the shell through native code (the desktop's comes as prefers-color-scheme).
    api.onTheme?.((theme) => {
      if (isTheme(theme)) applyTheme(doc, theme);
    });
    const { onAudioRoutes, setAudioRoute } = api;
    if (onAudioRoutes && setAudioRoute) {
      onAudioRoutes((routes) => {
        if (isAudioRoutes(routes)) view.setVoiceOptions({ ...phone, audio: { routes, onRoute: (route) => setAudioRoute(route) } });
      });
    }
  }
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
