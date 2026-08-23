// Shared by every module that builds markup from captured text. Intake names
// come from files and pasted pages, so they are escaped at the point of
// render rather than trusted anywhere upstream of it.
export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}
