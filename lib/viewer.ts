/**
 * How the signed-in viewer is named in the header's account menu.
 *
 * Auth.js gives us whatever Google chose to hand over: a display name
 * sometimes, an email nearly always, and — for an expired or malformed session
 * that still rendered a page — neither. Deciding that in the component would
 * be three nested `??` inside JSX; here it is two functions with a test.
 */

/** The name to print. Falls back to the email, and then to something neutral. */
export function viewerLabel(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  // The local part only. A header is not the place for
  // `someone@a-very-long-domain.example`, and the full address is one click
  // away inside the menu.
  const localPart = email?.trim().split("@")[0];
  if (localPart) return localPart;
  return "Account";
}

/**
 * One or two letters for the avatar disc — Wikipedia has a photo there and we
 * have initials, which is the whole extent of the departure.
 *
 * Two words give two initials ("Rose Bennett" → "RB"); anything else gives the
 * first letter. Uppercased, because a disc of lowercase looks like a mistake.
 */
export function viewerInitials(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const label = viewerLabel(name, email);
  // Split on any run of whitespace, and on the separators a mail local part
  // uses instead of a space, so `rose.bennett@…` initials as "RB" too.
  const words = label.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return label.slice(0, 1).toUpperCase();
}
