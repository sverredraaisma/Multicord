import type { PickerRequest } from "../shared/ipc";
import type { ShellApi } from "../preload/shell";

/** Renders the screen share picker; Discord's own picker is not in the web build. */
export function renderPicker(root: HTMLElement, request: PickerRequest, api: Pick<ShellApi, "choose">): void {
  const doc = root.ownerDocument;
  const grid = doc.createElement("div");
  grid.className = "sources";

  const audio = doc.createElement("input");
  audio.type = "checkbox";
  audio.id = "share-audio";
  audio.checked = request.audioSupported;
  audio.disabled = !request.audioSupported;

  for (const source of request.sources) {
    const button = doc.createElement("button");
    button.className = "source";
    button.dataset.id = source.id;
    const img = doc.createElement("img");
    img.src = source.thumbnail;
    img.alt = "";
    const name = doc.createElement("span");
    name.textContent = source.name;
    button.append(img, name);
    button.addEventListener("click", () => api.choose({ id: source.id, audio: audio.checked }));
    grid.append(button);
  }

  const audioLabel = doc.createElement("label");
  audioLabel.append(audio, request.audioSupported ? " Share system audio" : " System audio not supported on this platform yet");

  const cancel = doc.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => api.choose(null));

  const footer = doc.createElement("footer");
  footer.append(audioLabel, cancel);

  const title = doc.createElement("h1");
  title.textContent = "Choose what to share";
  root.replaceChildren(title, grid, footer);
}

export function startPicker(doc: Document, api: ShellApi): void {
  const root = doc.getElementById("picker")!;
  api.onPickerRequest((request) => renderPicker(root, request, api));
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api.choose(null);
  });
}
