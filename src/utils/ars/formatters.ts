
/**
 * Utility to format numbers consistently (e.g., 1.5k for 1500)
 */
export const formatNumber = (num: number | undefined | null) =>
  new Intl.NumberFormat("es-CL", { notation: "compact" }).format(
    num || 0,
  );

/**
 * Escape HTML characters to prevent XSS
 */
export function escapeHtml(value: string | undefined | null) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Linkify descriptions with Arsmate posts and general URLs
 */
export function linkifyDescription(text: string | undefined | null) {
  if (!text) return "";
  
  // Arsmate post regex: https://arsmate.com/username/post/postId
  const arsmatePostRegex =
    /https:\/\/arsmate\.com\/([^/]+)\/post\/(\d+)/g;
    
  let linkedText = text.replace(
    arsmatePostRegex,
    (match, username, postId) => {
      return `<a href="/ars/${username}/post/${postId}" class="text-blue-600 hover:underline font-medium">${match}</a>`;
    },
  );

  // Arsmate post sin username: https://arsmate.com/post/postId -> /post/postId
  const arsmateShortPostRegex = /https:\/\/arsmate\.com\/post\/(\d+)/g;
  linkedText = linkedText.replace(
    arsmateShortPostRegex,
    (match, postId) => {
      return `<a href="/ars/post/${postId}" class="text-blue-600 hover:underline font-medium">${match}</a>`;
    },
  );

  // General URL regex (matches https?:// urls not already in an href)
  const urlRegex = /(?<!href=")(https?:\/\/[^\s<]+)/g;
  linkedText = linkedText.replace(urlRegex, (match) => {
    if (match.includes("arsmate.com")) return match;
    return `<a href="${match}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline">${match}</a>`;
  });

  // Menciones: @username -> /username. El grupo previo evita capturar @ dentro
  // de emails (precedido por letra/número) o de URLs ya enlazadas (precedido por
  // "/" o comillas).
  const mentionRegex = /(^|[^\w/@"])@([a-zA-Z0-9_]+)/g;
  linkedText = linkedText.replace(
    mentionRegex,
    (_match, prefix, username) =>
      `${prefix}<a href="/ars/${username}" class="text-blue-600 hover:underline font-medium">@${username}</a>`,
  );

  return linkedText;
}
