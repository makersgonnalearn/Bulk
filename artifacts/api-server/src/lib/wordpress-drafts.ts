import { readFile } from "node:fs/promises";

const requestTimeoutMs = 180_000;

export type WordPressDraftConfig = { baseUrl: string; importKey: string };

export type WordPressDraftInput = {
  title: string;
  ref: string;
  pngPath: string;
  pngName: string;
  svgPath: string | null;
  svgName: string;
};

export type WordPressDraftResult = { postId: number; editUrl: string };

export class WordPressDraftError extends Error {}

export function getWordPressDraftConfig(): WordPressDraftConfig | null {
  const rawUrl = process.env.MGL_WP_URL?.trim();
  const importKey = process.env.MGL_WP_IMPORT_KEY?.trim();
  if (!rawUrl || !importKey) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return { baseUrl: url.origin, importKey };
  } catch {
    return null;
  }
}

// "watercolor-fall-wreath-2" -> "Watercolor Fall Wreath 2"
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export async function createWordPressDraft(
  config: WordPressDraftConfig,
  input: WordPressDraftInput,
): Promise<WordPressDraftResult> {
  const form = new FormData();
  form.set("title", input.title);
  form.set("ref", input.ref);
  form.set("png", new Blob([await readFile(input.pngPath)], { type: "image/png" }), input.pngName);
  if (input.svgPath) {
    form.set("svg", new Blob([await readFile(input.svgPath)], { type: "image/svg+xml" }), input.svgName);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(`${config.baseUrl}/wp-json/mgl-cutfile-import/v1/drafts`, {
      method: "POST",
      headers: {
        "X-MGL-Import-Key": config.importKey,
        Accept: "application/json",
        "User-Agent": "MGL Vector Batch Studio",
      },
      body: form,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new WordPressDraftError("The website did not respond. Try sending this design again.");
  }

  const text = await response.text();
  let body: { data?: { post_id?: unknown; edit_url?: unknown }; message?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  // The site's bot protection can answer with a 202 HTML page instead of JSON.
  if (!body) {
    throw new WordPressDraftError(
      `The website answered with an unexpected page (HTTP ${response.status}). Try sending this design again.`,
    );
  }
  if (!response.ok) {
    const message = typeof body.message === "string" && body.message ? body.message : `HTTP ${response.status}`;
    throw new WordPressDraftError(`The website could not create this draft: ${message}`);
  }

  const postId = Number(body.data?.post_id);
  const editUrl = body.data?.edit_url;
  if (!Number.isInteger(postId) || postId <= 0 || typeof editUrl !== "string" || !/^https:\/\/[^/]+\/wp-admin\//.test(editUrl)) {
    throw new WordPressDraftError("The website reply did not include the new draft. Check WordPress before sending again.");
  }
  return { postId, editUrl };
}
