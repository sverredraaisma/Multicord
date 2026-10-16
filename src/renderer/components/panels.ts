import { MAX_MESSAGE_LENGTH, MAX_NEW_POLL_ANSWER, MAX_NEW_POLL_ANSWERS, MAX_NEW_POLL_QUESTION, MIN_NEW_POLL_ANSWERS, type NativeForumPost, type NativeListedMessage, type NativeMessageList, type AudioRoute, type AudioRoutes, type NativeVoiceSession } from "../../shared/native";
import { avatar } from "./avatar";
import { countBadge, el } from "./dom";
import { formatSize, formatTime } from "./format";

type VoiceFlags = Pick<NativeVoiceSession, "mute" | "deaf" | "video" | "stream">;

/** What the phone calls each audio route. */
const ROUTE_NAMES: Record<AudioRoute, string> = { earpiece: "Earpiece", speaker: "Speaker", wired: "Headset", bluetooth: "Bluetooth" };

/** Where the host differs from the desktop's (a phone): no screen sharing, and audio routes to switch between. */
export interface VoicePanelOptions {
  /** Whether screen sharing exists here; a phone's WebView has no getDisplayMedia. Default true. */
  screenShare?: boolean;
  /** The phone's audio routes; a button switches to the next available one. */
  audio?: { routes: AudioRoutes; onRoute(route: AudioRoute): void };
  /**
   * Phones only: compact call controls over the open conversation (callStrip), since the full panel sits
   * in the conversation list, a pane away. `onReturn` goes back to the call.
   */
  strip?: { onReturn(): void };
}

export type VoiceHandlers = { onChange(flags: VoiceFlags): void; onLeave(): void };

/** A call toggle: pressed while `on`, off until the voice server has connected us; reports the flags after the change. */
function voiceToggle(doc: Document, voice: NativeVoiceSession, handlers: VoiceHandlers, label: string, on: boolean, change: Partial<VoiceFlags>): HTMLButtonElement {
  const current: VoiceFlags = { mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: voice.stream };
  const button = el(doc, "button", undefined, label);
  button.type = "button";
  button.classList.toggle("on", on);
  button.setAttribute("aria-pressed", String(on));
  button.disabled = !voice.token;
  button.addEventListener("click", () => handlers.onChange({ ...current, ...change }));
  return button;
}

/** The phone's audio route button, switching to the next available route; none with only one. */
function routeButton(doc: Document, audio: VoicePanelOptions["audio"]): HTMLButtonElement[] {
  if (!audio || audio.routes.available.length <= 1) return [];
  const { current: playing, available } = audio.routes;
  const next = available[(available.indexOf(playing) + 1) % available.length]!;
  const route = el(doc, "button", "audio-route", ROUTE_NAMES[playing]);
  route.type = "button";
  route.title = `Playing through the ${ROUTE_NAMES[playing].toLowerCase()}; switch to the ${ROUTE_NAMES[next].toLowerCase()}`;
  route.addEventListener("click", () => audio.onRoute(next));
  return [route];
}

/** The call controls: connection status, where, and toggles that report the new flags. */
export function voicePanel(doc: Document, voice: NativeVoiceSession, handlers: VoiceHandlers, options: VoicePanelOptions = {}): HTMLElement[] {
  const status = el(doc, "div", "voice-status", voice.token ? "Voice connected" : "Connecting…");
  status.classList.toggle("connected", Boolean(voice.token));
  const where = el(doc, "div", "voice-where", voice.guildName ? `${voice.channelName} / ${voice.guildName}` : voice.channelName);
  const controls = el(doc, "div", "voice-controls");
  const toggle = (label: string, on: boolean, change: Partial<VoiceFlags>) => controls.append(voiceToggle(doc, voice, handlers, label, on, change));
  toggle(voice.mute ? "Unmute" : "Mute", voice.mute, { mute: !voice.mute });
  toggle(voice.deaf ? "Undeafen" : "Deafen", voice.deaf, { deaf: !voice.deaf });
  toggle(voice.video ? "Camera off" : "Camera", voice.video, { video: !voice.video });
  if (options.screenShare !== false) toggle(voice.stream ? "Stop sharing" : "Share screen", voice.stream, { stream: !voice.stream });
  controls.append(...routeButton(doc, options.audio));
  const leave = el(doc, "button", "leave", "Leave");
  leave.addEventListener("click", handlers.onLeave);
  controls.append(leave);
  return [status, where, controls];
}

/**
 * A phone's compact call controls over the open conversation: back to the call (named after it, green once
 * connected), mute, camera, the audio route and hang up. The full panel stays in the conversation list.
 */
export function callStrip(doc: Document, voice: NativeVoiceSession, handlers: VoiceHandlers & { onReturn(): void }, options: VoicePanelOptions = {}): HTMLElement[] {
  const back = el(doc, "button", "call-return", voice.channelName);
  back.type = "button";
  back.classList.toggle("connected", Boolean(voice.token));
  back.title = voice.token ? `In a call in ${voice.channelName}; return to the call` : `Connecting to ${voice.channelName}; return to the call`;
  back.addEventListener("click", handlers.onReturn);
  const hangUp = el(doc, "button", "leave", "Hang up");
  hangUp.type = "button";
  hangUp.addEventListener("click", handlers.onLeave);
  return [
    back,
    voiceToggle(doc, voice, handlers, voice.mute ? "Unmute" : "Mute", voice.mute, { mute: !voice.mute }),
    voiceToggle(doc, voice, handlers, voice.video ? "Camera off" : "Camera", voice.video, { video: !voice.video }),
    ...routeButton(doc, options.audio),
    hangUp,
  ];
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

/** A poll the form made, as a createPoll action takes it. */
export interface NewPoll {
  question: string;
  answers: string[];
  multiple: boolean;
  anonymous?: boolean;
}

/** A line typed or pasted into the form: control characters (a pasted tab) become spaces, and the ends are trimmed. */
const pollLine = (value: string): string => value.replace(/\p{Cc}/gu, " ").trim();

/**
 * The new poll form: a question, MIN_NEW_POLL_ANSWERS to
 * MAX_NEW_POLL_ANSWERS answers (added one by one, the empty ones left out),
 * whether more than one may be chosen and, where `anonymity` offers the
 * choice, whether votes stay anonymous (on at first). It says what is
 * missing rather than handing on a poll the module would drop.
 */
export function pollForm(doc: Document, anonymity: boolean, handlers: { onCreate(poll: NewPoll): void; onCancel(): void }): HTMLFormElement {
  const form = el(doc, "form", "poll-form");
  const title = el(doc, "h3", "profile-name", "New poll");
  title.id = "poll-title";
  const question = el(doc, "input", "poll-question-input");
  question.name = "question";
  question.placeholder = "Question";
  question.setAttribute("aria-label", "Question");
  question.maxLength = MAX_NEW_POLL_QUESTION;
  const answers = el(doc, "ol", "poll-answers");
  const add = el(doc, "button", "link poll-add", "Add answer");
  add.type = "button";
  const fields = () => [...answers.querySelectorAll<HTMLInputElement>("input")];
  // Each answer is numbered by its place; one can go while more than the fewest remain.
  const renumber = () => {
    const rows = fields();
    rows.forEach((input, i) => {
      input.placeholder = `Answer ${i + 1}`;
      input.setAttribute("aria-label", `Answer ${i + 1}`);
      const remove = input.nextElementSibling as HTMLButtonElement;
      remove.setAttribute("aria-label", `Remove answer ${i + 1}`);
      remove.hidden = rows.length <= MIN_NEW_POLL_ANSWERS;
    });
    add.hidden = rows.length >= MAX_NEW_POLL_ANSWERS;
  };
  const addAnswer = () => {
    const li = el(doc, "li", "poll-answer");
    const input = el(doc, "input");
    input.maxLength = MAX_NEW_POLL_ANSWER;
    const remove = el(doc, "button", "link", "×");
    remove.type = "button";
    remove.addEventListener("click", () => {
      li.remove();
      renumber();
    });
    li.append(input, remove);
    answers.append(li);
    renumber();
    return input;
  };
  for (let i = 0; i < MIN_NEW_POLL_ANSWERS; i++) addAnswer();
  add.addEventListener("click", () => addAnswer().focus());
  const check = (label: string, checked: boolean) => {
    const box = el(doc, "input");
    box.type = "checkbox";
    box.checked = checked;
    const row = el(doc, "label", "poll-check");
    row.append(box, doc.createTextNode(` ${label}`));
    return { box, row };
  };
  const multiple = check("Allow more than one answer", false);
  const anonymous = anonymity ? check("Anonymous votes", true) : undefined;
  const error = el(doc, "p", "member-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const cancel = el(doc, "button", "link", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => handlers.onCancel());
  const submit = el(doc, "button", "primary", "Create poll");
  submit.type = "submit";
  const buttons = el(doc, "div", "poll-form-buttons");
  buttons.append(cancel, submit);
  form.append(title, question, answers, add, multiple.row, ...(anonymous ? [anonymous.row] : []), error, buttons);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") handlers.onCancel();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const asked = pollLine(question.value);
    const given = fields().map((input) => pollLine(input.value)).filter((answer) => answer !== "");
    const problem = asked === "" ? "Write a question." : given.length < MIN_NEW_POLL_ANSWERS ? `Give at least ${MIN_NEW_POLL_ANSWERS} answers.` : new Set(given).size < given.length ? "Each answer can be given only once." : undefined;
    error.textContent = problem ?? "";
    error.hidden = !problem;
    if (problem) return;
    handlers.onCreate({ question: asked, answers: given, multiple: multiple.box.checked, ...(anonymous ? { anonymous: anonymous.box.checked } : {}) });
  });
  return form;
}
