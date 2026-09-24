export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  const previousFocus = document.activeElement as HTMLElement | null;
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  previousFocus?.focus();
  if (!copied) throw new Error("Copy failed. Select the text and copy it manually.");
}
