import { workspaceApiPath } from "./state/devices";
import type { AgentImageAttachment } from "./state/store";

const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 20_000_000;

const normalizeImageType = (value: string) => value.toLowerCase() === "public.jpeg"
  ? "image/jpeg"
  : value.toLowerCase() === "public.jpg"
    ? "image/jpeg"
    : value.toLowerCase() === "public.png"
      ? "image/png"
      : value.toLowerCase() === "org.webmproject.webp"
        ? "image/webp"
        : value.toLowerCase();

export function pastedChatImages(data: DataTransfer): File[] {
  return Array.from(data.items)
    .filter((item) => IMAGE_MIMES.has(normalizeImageType(item.type)))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export async function uploadChatImage(file: File, signal?: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<AgentImageAttachment> {
  const mimeType = normalizeImageType(file.type) || "image/png";
  if (!IMAGE_MIMES.has(mimeType)) throw new Error("unsupported image type");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("invalid image size");
  const response = await fetcher(workspaceApiPath(`/api/paste-image?type=${encodeURIComponent(mimeType)}`), {
    method: "POST",
    body: file,
    signal,
  });
  const payload = await response.json().catch(() => ({})) as { path?: string; error?: string };
  if (!response.ok || !payload.path) throw new Error(payload.error || `upload failed (${response.status})`);
  return { id: crypto.randomUUID(), kind: "image", path: payload.path, mimeType };
}
