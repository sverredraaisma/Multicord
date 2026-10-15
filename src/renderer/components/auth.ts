import { promptQr, type NativePrompt } from "../../shared/native";
import { el } from "./dom";
import { qrPicture } from "./qr";

export interface LoginForm {
  form: HTMLFormElement;
  identity: HTMLInputElement;
  identityLabel: HTMLLabelElement;
  password: HTMLInputElement;
  submit: HTMLButtonElement;
}

/** Sign-in form; the caller keeps the returned inputs so typing survives state updates. */
export function loginForm(doc: Document, platform: string, onSubmit: (identity: string, password: string) => void): LoginForm {
  const form = el(doc, "form", "auth");
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
    `Multicord is a third-party client. Your password is sent only to ${platform}, and your session is stored encrypted on this device.`,
  );
  form.append(el(doc, "h1", undefined, `Sign in to ${platform}`), identityLabel, passwordLabel, submit, el(doc, "p", "status"), el(doc, "p", "error"), note);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit(identity.value.trim(), password.value);
  });
  return { form, identity, identityLabel, password, submit };
}

/** Shows the identity field as email or username. */
export function setIdentityKind(login: LoginForm, kind: "email" | "username"): void {
  login.identity.type = kind === "email" ? "email" : "text";
  login.identityLabel.replaceChildren(kind === "email" ? "Email" : "Username", login.identity);
}

/** Two-factor form: authenticator codes (which also take backup codes), or backup codes only. */
export function mfaForm(
  doc: Document,
  codes: "totp" | "backup",
  handlers: { onSubmit(code: string): void; onCancel(): void },
): { form: HTMLFormElement; submit: HTMLButtonElement } {
  const form = el(doc, "form", "auth");
  const code = el(doc, "input");
  code.name = "code";
  code.required = true;
  code.autocomplete = "one-time-code";
  code.inputMode = "numeric";
  const label = el(doc, "label", undefined, codes === "backup" ? "Backup code" : "Authentication or backup code");
  label.append(code);
  const submit = el(doc, "button", "primary", "Verify");
  submit.type = "submit";
  const cancel = el(doc, "button", "link", "Back");
  cancel.type = "button";
  cancel.addEventListener("click", handlers.onCancel);
  form.append(el(doc, "h1", undefined, "Two-factor authentication"), label, submit, cancel, el(doc, "p", "error"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.onSubmit(code.value.trim());
  });
  return { form, submit };
}

/** Sets a form's status or error line. */
export function setFormMessage(form: HTMLElement, kind: "status" | "error", text: string | undefined): void {
  form.querySelector(`.${kind}`)!.textContent = text ?? "";
}

/** Shows a prompt form's QR code for this text, drawn here; none for text the view does not take. */
export function setPromptQr(form: HTMLElement, value: unknown): void {
  const box = form.querySelector<HTMLElement>(".prompt-qr")!;
  const text = promptQr(value);
  const picture = text === undefined ? undefined : qrPicture(form.ownerDocument, text, "QR code to scan");
  box.hidden = picture === undefined;
  box.replaceChildren(...(picture ? [picture] : []));
}

/**
 * A sign-in step defined by the module: its fields, a submit button and
 * optionally a secondary one. Status and error lines as in the login form.
 */
export function promptForm(
  doc: Document,
  prompt: NativePrompt,
  handlers: { onSubmit(values: Record<string, string>): void; onCancel(): void },
): { form: HTMLFormElement; submit: HTMLButtonElement } {
  const form = el(doc, "form", "auth");
  form.dataset.prompt = prompt.id;
  form.append(el(doc, "h1", undefined, prompt.title));
  if (prompt.description) form.append(el(doc, "p", "note prompt-description", prompt.description));
  // Opens in the browser: the view sends every link outside the app. Modules only get to link to https pages.
  if (prompt.link && /^https:\/\//i.test(prompt.link.url)) {
    const link = el(doc, "a", "prompt-link", prompt.link.label);
    link.href = prompt.link.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const line = el(doc, "p");
    line.append(link);
    form.append(line);
  }
  // A code to scan, where the step has one; it may change while the step lasts.
  const qr = el(doc, "div", "prompt-qr");
  form.append(qr);
  setPromptQr(form, prompt.qr);
  const inputs = prompt.fields.map((field) => {
    const input = el(doc, "input");
    input.name = field.name;
    input.type = field.type === "number" ? "text" : field.type;
    if (field.type === "number") input.inputMode = "numeric";
    input.required = true;
    if (field.autocomplete) input.autocomplete = field.autocomplete as AutoFill;
    if (field.placeholder) input.placeholder = field.placeholder;
    const label = el(doc, "label", undefined, field.label);
    label.append(input);
    form.append(label);
    return input;
  });
  const submit = el(doc, "button", "primary", prompt.submit);
  submit.type = "submit";
  form.append(submit);
  if (prompt.cancel) {
    const cancel = el(doc, "button", "link", prompt.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", handlers.onCancel);
    form.append(cancel);
  }
  form.append(el(doc, "p", "status"), el(doc, "p", "error"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.onSubmit(Object.fromEntries(inputs.map((input) => [input.name, input.type === "password" ? input.value : input.value.trim()])));
  });
  inputs[0]?.focus();
  return { form, submit };
}
