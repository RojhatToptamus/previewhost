// The capability stays in this module; it is never included in rendered data or URLs.
let capability = location.hash.slice(1);
history.replaceState(null, "", "/");
try {
  if (capability) sessionStorage.setItem("previewhost-dashboard", capability);
  else capability = sessionStorage.getItem("previewhost-dashboard") ?? "";
} catch {
  /* A fresh launch still works with browser storage disabled. */
}

export const authenticated = Boolean(capability);

export async function call<T>(body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + capability,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (
    data.error?.code === "NOT_FOUND" &&
    data.error.message === "Unknown control operation." &&
    "action" in body &&
    body.action === "saveConfiguration"
  ) {
    throw new Error(
      "This owner does not support configuration saving. Ask your agent to save preview.yml, or upgrade the owner when you are ready to stop its previews.",
    );
  }
  if (data.error)
    throw new Error(
      data.error.code === "STALE_ATTEMPT"
        ? "This preview changed. Review its current state and try again."
        : data.error.message,
      { cause: data.error },
    );
  return data.result;
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The action failed. Check current status before retrying.";
}

export type Mutate = <T = unknown>(
  body: object,
  success: string | ((result: T) => string),
) => Promise<void>;
