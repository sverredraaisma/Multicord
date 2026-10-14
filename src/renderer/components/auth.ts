import { el } from "./dom";

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
