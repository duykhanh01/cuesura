export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
