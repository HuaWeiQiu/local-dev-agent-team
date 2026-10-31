/** Copy through the clipboard API, then the legacy selection path. */
export async function copyText(text: string): Promise<boolean> {
  if (await modernCopy(text)) return true;
  return legacyCopy(text);
}

async function modernCopy(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Non-secure contexts and some webviews have no clipboard API.
    return false;
  }
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
